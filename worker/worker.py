"""
Carbon Camera Analytics — Vehicle Counting Worker
==================================================
Connects to a Hikvision NVR RTSP stream, runs background-subtraction based
vehicle detection, counts crossings over a configurable virtual line, and
POSTs entry/exit events to the Carbon ingest endpoint.

Usage:
    python worker.py --config config.yaml

Requirements:
    pip install opencv-python-headless requests pyyaml numpy
"""

import argparse
import base64
import json
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Deque, Dict, List, Optional, Tuple, Set

# Force TCP transport and optimal buffer limits for RTSP to prevent packet loss
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|analyzeduration;500000|probesize;5000000"

import cv2
import numpy as np
import requests
import yaml

# ---------------------------------------------------------------------------
# Logging — force UTF-8 on Windows so special chars don't crash the logger
# ---------------------------------------------------------------------------
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("carbon-worker")


# ---------------------------------------------------------------------------
# Config dataclasses
# ---------------------------------------------------------------------------
@dataclass
class LineConfig:
    """Normalised [0,1] counting-line endpoints (matches DB line_config)."""
    x1: float = 0.0
    y1: float = 0.5
    x2: float = 1.0
    y2: float = 0.5


@dataclass
class RoiConfig:
    """Normalised [0,1] region of interest rectangle."""
    left:   float = 0.0
    top:    float = 0.0
    right:  float = 1.0
    bottom: float = 1.0


@dataclass
class CameraConfig:
    name: str
    rtsp_url: str
    ingest_key: str
    ingest_url: str
    line: LineConfig = field(default_factory=LineConfig)
    roi: RoiConfig = field(default_factory=RoiConfig)
    # Detection tuning
    min_contour_area: int = 1_500       # px² — ignore smaller blobs
    line_cross_cooldown_s: float = 3.0  # seconds before SAME track can fire again
    global_cross_cooldown_s: float = 4.0  # camera-level min gap between confirmed events
                                          # in the same direction, regardless of track ID
    reconnect_delay_s: float = 5.0
    frame_skip: int = 2                 # process every Nth frame (1 = all)
    debug_window: bool = False          # live OpenCV window (needs display)
    debug_snapshot: bool = True         # save a PNG on startup to verify line
    # Vision Classifier settings
    vision_classifier: str = "none"
    openai_api_key: str = ""
    vision_image_size: int = 512
    # Auto-calibration flag
    needs_calibration: bool = False
    # Camera management
    enabled: bool = True
    mode: str = "vehicle_counting" # "vehicle_counting" | "monitoring" | "other"
    # Snapshot storage (opt-in) — stores confirmed-vehicle crops in Supabase Storage
    store_snapshots: bool = False
    supabase_url: str = ""
    supabase_service_key: str = ""


def load_config(path: str) -> List[CameraConfig]:
    with open(path) as f:
        raw = yaml.safe_load(f)

    openai_cfg = raw.get("openai", {})
    global_api_key = openai_cfg.get("api_key", "")
    global_classifier = openai_cfg.get("classifier", "none")
    global_image_size = openai_cfg.get("image_size", 512)

    # Global Supabase settings (inherited by each camera unless overridden per-camera)
    supabase_cfg = raw.get("supabase", {})
    global_supabase_url = supabase_cfg.get("url", "")
    global_supabase_service_key = supabase_cfg.get("service_key", "")

    cameras: List[CameraConfig] = []
    for cam in raw.get("cameras", []):
        needs_cal = ("line" not in cam) or ("roi" not in cam)
        lc = LineConfig(**cam.get("line", {})) if "line" in cam else LineConfig()
        rc = RoiConfig(**cam.get("roi", {})) if "roi" in cam else RoiConfig()
        cameras.append(
            CameraConfig(
                name=cam["name"],
                rtsp_url=cam["rtsp_url"],
                ingest_key=cam["ingest_key"],
                ingest_url=cam["ingest_url"],
                line=lc,
                roi=rc,
                min_contour_area=cam.get("min_contour_area", 1_500),
                line_cross_cooldown_s=cam.get("line_cross_cooldown_s", 3.0),
                global_cross_cooldown_s=cam.get("global_cross_cooldown_s", 4.0),
                reconnect_delay_s=cam.get("reconnect_delay_s", 5.0),
                frame_skip=cam.get("frame_skip", 2),
                debug_window=cam.get("debug_window", False),
                debug_snapshot=cam.get("debug_snapshot", True),
                vision_classifier=cam.get("vision_classifier", global_classifier),
                openai_api_key=cam.get("openai_api_key", global_api_key),
                vision_image_size=cam.get("vision_image_size", global_image_size),
                needs_calibration=needs_cal,
                enabled=cam.get("enabled", True),
                mode=cam.get("mode", "vehicle_counting"),
                # Snapshot storage — per-camera opt-in, credentials inherited from global supabase section
                store_snapshots=cam.get("store_snapshots", False),
                supabase_url=cam.get("supabase_url", global_supabase_url),
                supabase_service_key=cam.get("supabase_service_key", global_supabase_service_key),
            )
        )
    return cameras



# ---------------------------------------------------------------------------
# AI Auto-Calibration Helpers
# ---------------------------------------------------------------------------

def grab_single_frame(rtsp_url: str) -> Optional[np.ndarray]:
    """Connect to stream, grab a single frame, and release resource immediately."""
    cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
    if not cap.isOpened():
        return None
    # Read a few frames to let the sensor adjust and clear buffer
    for _ in range(5):
        ret, frame = cap.read()
    cap.release()
    if ret:
        return frame
    return None


def ai_calibrate_line_and_roi(
    frame: np.ndarray, api_key: str, camera_name: str
) -> Optional[Tuple[LineConfig, RoiConfig]]:
    """Send frame to OpenAI Vision to automatically calibrate virtual crossing line and ROI."""
    if not api_key:
        log.warning("[%s] OpenAI API key is missing. Cannot run AI auto-calibration.", camera_name)
        return None

    try:
        # Resize to max 768px to stay inside vision prompt optimal limits and save bandwidth
        h, w = frame.shape[:2]
        max_dim = max(h, w)
        if max_dim > 768:
            scale = 768 / max_dim
            resized = cv2.resize(frame, (int(w * scale), int(h * scale)))
        else:
            resized = frame

        success, buffer = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not success:
            log.error("[%s] Failed to encode frame to JPEG for calibration.", camera_name)
            return None

        base64_image = base64.b64encode(buffer).decode("utf-8")
        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}"
        }

        payload = {
            "model": "gpt-4o-mini",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are an expert computer vision engineer calibrating a virtual counting line and Region of Interest (ROI) "
                        "for a vehicle counting surveillance camera.\n"
                        "Examine the surveillance frame of a driveway, gate, or car park entrance.\n"
                        "1. Identify the driveway/road where vehicles enter and exit.\n"
                        "2. Define a virtual counting line spanning the driveway. The line should be horizontal or slightly slanted "
                        "matching the driveway angle. Return normalized coordinates (0.0 to 1.0) for x1, y1, x2, y2.\n"
                        "3. Define a Region of Interest (ROI) rectangle surrounding the line with 10-20% vertical and horizontal padding to capture vehicle centroids. "
                        "Return left, top, right, bottom (all 0.0 to 1.0).\n\n"
                        "Respond ONLY with valid JSON in this exact format:\n"
                        '{"line": {"x1": 0.31, "y1": 0.19, "x2": 0.61, "y2": 0.19}, '
                        '"roi": {"left": 0.25, "top": 0.10, "right": 0.65, "bottom": 0.45}}\n'
                        "Do not include any markdown format, backticks, or extra text. Respond with the raw JSON string only."
                    )
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "Please calibrate the virtual line and ROI coordinates for this camera stream."
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{base64_image}",
                                # Using high detail is intentional here - calibration requires spatial
                                # precision to correctly place the counting line on the road/gate.
                                "detail": "high"
                            }
                        }
                    ]
                }
            ],
            "max_tokens": 150,
            "temperature": 0.0,
            "response_format": {"type": "json_object"}
        }

        retries = 3
        delay = 2.0
        resp = None
        for attempt in range(retries):
            log.info("[%s] Requesting AI auto-calibration from GPT-4o Mini Vision API (attempt %d/%d)...", camera_name, attempt + 1, retries)
            try:
                resp = requests.post(url, headers=headers, json=payload, timeout=20)
                if resp.status_code == 429 or (500 <= resp.status_code <= 599):
                    log.warning("[%s] Calibration API encountered HTTP %s. Retrying in %.1fs...", camera_name, resp.status_code, delay)
                    time.sleep(delay)
                    delay *= 2
                    continue
                break
            except requests.exceptions.RequestException as e:
                log.warning("[%s] Calibration request exception: %s. Retrying in %.1fs...", camera_name, str(e), delay)
                time.sleep(delay)
                delay *= 2
                continue

        if resp is None or not resp.ok:
            status_code = resp.status_code if resp is not None else "No Response"
            response_text = resp.text if resp is not None else "Exception"
            log.error("[%s] OpenAI Vision calibration request failed after retries: HTTP %s: %s", camera_name, status_code, response_text)
            return None

        result_json = resp.json()
        content = result_json["choices"][0]["message"]["content"].strip()
        data = json.loads(content)

        line_data = data["line"]
        roi_data = data["roi"]

        lc = LineConfig(
            x1=float(line_data["x1"]),
            y1=float(line_data["y1"]),
            x2=float(line_data["x2"]),
            y2=float(line_data["y2"])
        )
        rc = RoiConfig(
            left=float(roi_data["left"]),
            top=float(roi_data["top"]),
            right=float(roi_data["right"]),
            bottom=float(roi_data["bottom"])
        )
        log.info("[%s] AI Auto-Calibration successful!\nLine coordinates: %s\nROI bounds: %s", camera_name, lc, rc)
        return lc, rc

    except Exception as e:
        log.error("[%s] Exception occurred during AI auto-calibration: %s", camera_name, e)
        return None


def save_calibration_to_file(path: str, camera_name: str, lc: LineConfig, rc: RoiConfig):
    """Safely append or rewrite target camera block in config.yaml to persist calibrated line/ROI without losing comments."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()

        new_lines = []
        in_target_cam = False
        skip_mode = False
        injected = False

        for line in lines:
            # Check if this is the start of a camera block
            if line.strip().startswith("- name:"):
                # If we were in the target camera, we are now entering a different camera block
                if in_target_cam and not injected:
                    new_lines.append(f"    line:\n      x1: {lc.x1:.2f}\n      y1: {lc.y1:.2f}\n      x2: {lc.x2:.2f}\n      y2: {lc.y2:.2f}\n")
                    new_lines.append(f"    roi:\n      left:   {rc.left:.2f}\n      top:    {rc.top:.2f}\n      right:  {rc.right:.2f}\n      bottom: {rc.bottom:.2f}\n\n")
                    injected = True
                in_target_cam = False
                
                # Check if this is the target camera
                if camera_name in line:
                    in_target_cam = True

            # If we are inside the target camera block, we want to replace/insert line and roi
            if in_target_cam:
                # If we encounter line: or roi:, we skip them and their indented children
                if line.strip().startswith("line:") or line.strip().startswith("roi:"):
                    skip_mode = True
                    continue
                if skip_mode:
                    if line.strip() == "" or not line.startswith(" "):
                        skip_mode = False
                    else:
                        continue

                # Inject our calibrated line and roi right before detection tuning fields
                if line.strip().startswith("min_contour_area:") or line.strip().startswith("frame_skip:") or line.strip().startswith("reconnect_delay_s:"):
                    if not injected:
                        new_lines.append(f"    line:\n      x1: {lc.x1:.2f}\n      y1: {lc.y1:.2f}\n      x2: {lc.x2:.2f}\n      y2: {lc.y2:.2f}\n")
                        new_lines.append(f"    roi:\n      left:   {rc.left:.2f}\n      top:    {rc.top:.2f}\n      right:  {rc.right:.2f}\n      bottom: {rc.bottom:.2f}\n\n")
                        injected = True

            new_lines.append(line)

        # If we got to the end of file and never injected it
        if in_target_cam and not injected:
            new_lines.append(f"    line:\n      x1: {lc.x1:.2f}\n      y1: {lc.y1:.2f}\n      x2: {lc.x2:.2f}\n      y2: {lc.y2:.2f}\n")
            new_lines.append(f"    roi:\n      left:   {rc.left:.2f}\n      top:    {rc.top:.2f}\n      right:  {rc.right:.2f}\n      bottom: {rc.bottom:.2f}\n\n")

        with open(path, "w", encoding="utf-8") as f:
            f.writelines(new_lines)
        log.info("[%s] Persisted AI-calibrated line and ROI directly into %s", camera_name, path)
    except Exception as e:
        log.error("[%s] Failed to save auto-calibration to config file: %s", camera_name, e)


# ---------------------------------------------------------------------------
# GPT-4o Mini Vision Classifier
# ---------------------------------------------------------------------------
@dataclass
class VisionResult:
    is_vehicle: bool
    type: str
    confidence: float


class VisionClassifier:
    """Uses GPT-4o Mini Vision API to classify if a cropped frame contains a vehicle."""

    def __init__(self, api_key: str, model: str = "gpt-4o-mini", image_size: int = 512):
        self.api_key = api_key
        self.model = model
        self.image_size = image_size
        self.url = "https://api.openai.com/v1/chat/completions"

    def classify(self, crop_frame: np.ndarray, camera_name: str) -> VisionResult:
        """
        Base64-encodes the image and calls the OpenAI Chat Completions API with vision support.
        Fails open if API is unreachable or has an error.
        """
        if not self.api_key:
            log.warning("[%s] OpenAI API key is missing. Failing open.", camera_name)
            return VisionResult(is_vehicle=True, type="unknown", confidence=1.0)

        try:
            # 1. Resize crop_frame to match vision_image_size
            h, w = crop_frame.shape[:2]
            max_dim = max(h, w)
            if max_dim > self.image_size:
                scale = self.image_size / max_dim
                new_w = int(w * scale)
                new_h = int(h * scale)
                resized = cv2.resize(crop_frame, (new_w, new_h))
            else:
                resized = crop_frame

            # 2. Encode to JPEG
            success, buffer = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if not success:
                log.error("[%s] Failed to encode cropped frame to JPEG. Failing open.", camera_name)
                return VisionResult(is_vehicle=True, type="unknown", confidence=1.0)

            # 3. Base64 encode
            base64_image = base64.b64encode(buffer).decode("utf-8")

            # 4. Prepare OpenAI payload
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}"
            }

            payload = {
                "model": self.model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are a vehicle detection classifier for a car park entrance camera. "
                            "Examine the cropped image containing a moving object and determine if a physical vehicle "
                            "(car, truck, bus, van, or motorcycle) is present in the foreground.\n"
                            "CRITICAL INSTRUCTIONS:\n"
                            "- If the crop contains only headlight glare, beams of light, shadows on the pavement, or empty road/ground, "
                            "classify it as is_vehicle: false, type: 'reflection' or 'shadow'.\n"
                            "- Do not classify background vehicles (vehicles parked or driving far away on the main street) as the moving vehicle. "
                            "Only classify the moving vehicle in the foreground.\n"
                            "- If the object is a pedestrian, security guard, or animal, classify as is_vehicle: false.\n"
                            "Respond ONLY with valid JSON:\n"
                            '{"is_vehicle": true, "type": "car", "confidence": 0.95} or\n'
                            '{"is_vehicle": false, "type": "person" | "reflection" | "shadow", "confidence": 0.98}.\n'
                            "Do not use markdown code block formatting. Respond with the raw JSON string only."
                        )
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": "Is this a vehicle? Please classify the object in this cropped frame."
                            },
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/jpeg;base64,{base64_image}",
                                    # Using low detail (2,833 tokens flat vs ~8,500 for high/auto) is sufficient.
                                    # Vehicle detection only needs coarse shape recognition,
                                    # not fine detail, so low is sufficient and ~67% cheaper.
                                    "detail": "low"
                                }
                            }
                        ]
                    }
                ],
                "max_tokens": 100,
                "temperature": 0.0,
                "response_format": {"type": "json_object"}
            }

            # 5. Call API with rate-limiting / server-error retry loop and exponential backoff
            retries = 3
            delay = 2.0
            resp = None
            for attempt in range(retries):
                log.info("[%s] Calling GPT-4o Mini Vision API (attempt %d/%d)...", camera_name, attempt + 1, retries)
                start_time = time.monotonic()
                try:
                    resp = requests.post(self.url, headers=headers, json=payload, timeout=10)
                    elapsed = time.monotonic() - start_time
                    if resp.status_code == 429 or (500 <= resp.status_code <= 599):
                        log.warning(
                            "[%s] OpenAI API encountered HTTP %s. Retrying in %.1fs...",
                            camera_name,
                            resp.status_code,
                            delay
                        )
                        time.sleep(delay)
                        delay *= 2
                        continue
                    log.info("[%s] GPT-4o Mini Vision API completed in %.2fs", camera_name, elapsed)
                    break
                except requests.exceptions.RequestException as e:
                    log.warning(
                        "[%s] OpenAI API request exception: %s. Retrying in %.1fs...",
                        camera_name,
                        str(e),
                        delay
                    )
                    time.sleep(delay)
                    delay *= 2
                    continue

            if resp is None or not resp.ok:
                status_code = resp.status_code if resp is not None else "No Response"
                response_text = resp.text if resp is not None else "Exception"
                log.critical("[%s] CRITICAL: Worker is shutting down because the OpenAI model is not reachable after retries (HTTP %s: %s).", camera_name, status_code, response_text)
                os._exit(1)

            result_json = resp.json()
            content = result_json["choices"][0]["message"]["content"].strip()
            
            # Remove any markdown formatting if present
            if content.startswith("```"):
                lines = content.splitlines()
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines[-1].startswith("```"):
                    lines = lines[:-1]
                content = "\n".join(lines).strip()

            data = json.loads(content)
            is_vehicle = bool(data.get("is_vehicle", True))
             # Validate and sanitize LLM response attributes
            v_type = str(data.get("type", "unknown"))[:32]
            if v_type not in {"car", "truck", "bus", "van", "motorcycle", "person", "reflection", "shadow", "unknown"}:
                v_type = "unknown"
            try:
                confidence = float(data.get("confidence", 1.0))
                if not (0.0 <= confidence <= 1.0):
                    confidence = 1.0
            except (ValueError, TypeError):
                confidence = 1.0

            log.info("[%s] Vision classification: is_vehicle=%s, type=%s, confidence=%.2f", 
                     camera_name, is_vehicle, v_type, confidence)
            return VisionResult(is_vehicle=is_vehicle, type=v_type, confidence=confidence)

        except Exception as e:
            log.error("[%s] Exception during vision classification: %s. Failing open.", camera_name, e)
            return VisionResult(is_vehicle=True, type="unknown", confidence=1.0)


# ---------------------------------------------------------------------------
# Event queue + ingest sender (runs in a background thread)
# ---------------------------------------------------------------------------
@dataclass
class VehicleEvent:
    direction: str           # "entry" | "exit"
    track_id: Optional[str]
    confidence: Optional[float]
    occurred_at: str         # ISO-8601
    # Snapshot fields — only populated when store_snapshots=True and is_vehicle=True
    snapshot_path: Optional[str] = None  # Supabase Storage path
    v_type: Optional[str] = None         # vehicle type from vision classifier


class IngestSender:
    """Thread-safe queue that batches and POSTs events to the ingest endpoint."""

    MAX_BATCH = 50
    FLUSH_INTERVAL_S = 2.0

    def __init__(self, ingest_url: str, ingest_key: str, camera_name: str):
        self.url = ingest_url
        self.key = ingest_key
        self.name = camera_name
        # Bound the queue capacity to prevent memory bloat/OOM if endpoint goes down
        self._queue: Deque[VehicleEvent] = deque(maxlen=5000)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def push(self, event: VehicleEvent) -> None:
        with self._lock:
            if len(self._queue) >= 5000:
                log.warning("[%s] Event queue is FULL! Dropping oldest event to prevent memory exhaustion.", self.name)
            self._queue.append(event)
        log.info("[%s] queued event: %s (track=%s)", self.name, event.direction, event.track_id)

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=10)

    def _run(self) -> None:
        while not self._stop.is_set():
            time.sleep(self.FLUSH_INTERVAL_S)
            self._flush()
        self._flush()  # final flush on shutdown

    def _flush(self) -> None:
        with self._lock:
            if not self._queue:
                return
            batch: List[VehicleEvent] = []
            while self._queue and len(batch) < self.MAX_BATCH:
                batch.append(self._queue.popleft())

        payload = [
            {
                "direction": e.direction,
                **({"track_id": e.track_id} if e.track_id else {}),
                **({"confidence": e.confidence} if e.confidence is not None else {}),
                "occurred_at": e.occurred_at,
                # Include snapshot fields if present (only for confirmed vehicles)
                **({"snapshot_path": e.snapshot_path} if e.snapshot_path else {}),
                **({"v_type": e.v_type} if e.v_type else {}),
            }
            for e in batch
        ]
        try:
            resp = requests.post(
                self.url,
                json=payload,
                headers={"x-ingest-key": self.key, "Content-Type": "application/json"},
                timeout=10,
            )
            if resp.ok:
                log.info("[%s] OK flushed %d event(s) -> %s", self.name, len(batch), resp.json())
            else:
                log.warning("[%s] ingest HTTP %s: %s", self.name, resp.status_code, resp.text[:200])
                with self._lock:
                    for e in reversed(batch):
                        self._queue.appendleft(e)
        except requests.RequestException as exc:
            log.error("[%s] ingest request failed: %s", self.name, exc)
            with self._lock:
                for e in reversed(batch):
                    self._queue.appendleft(e)


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def _line_pixel_coords(
    line: LineConfig, w: int, h: int
) -> Tuple[Tuple[int, int], Tuple[int, int]]:
    """Convert normalised [0,1] line to pixel coordinates in the FULL frame."""
    p1 = (int(line.x1 * w), int(line.y1 * h))
    p2 = (int(line.x2 * w), int(line.y2 * h))
    return p1, p2


def _roi_pixel_coords(roi: RoiConfig, w: int, h: int) -> Tuple[int, int, int, int]:
    """Return (x1, y1, x2, y2) pixel bounds for the ROI."""
    return (
        int(roi.left   * w),
        int(roi.top    * h),
        int(roi.right  * w),
        int(roi.bottom * h),
    )


def _side_of_line(
    px: int, py: int, p1: Tuple[int, int], p2: Tuple[int, int]
) -> float:
    """
    Cross-product sign: which side of directed line p1->p2 is point (px,py) on?
    Positive = one side, negative = other side, 0 = on the line.
    """
    return (p2[0] - p1[0]) * (py - p1[1]) - (p2[1] - p1[1]) * (px - p1[0])


def _centroid(contour) -> Tuple[int, int]:
    M = cv2.moments(contour)
    if M["m00"] == 0:
        return 0, 0
    return int(M["m10"] / M["m00"]), int(M["m01"] / M["m00"])


# ---------------------------------------------------------------------------
# Per-camera worker
# ---------------------------------------------------------------------------

class TrackState:
    def __init__(self, side: float, cx: int, cy: int):
        self.last_side = side
        self.last_event_ts: float = 0.0
        self.last_seen_ts: float = time.monotonic()  # used for TTL-based track pruning
        self.cx = cx
        self.cy = cy


# Seconds to keep a track alive after it was last seen in a frame.
# This prevents a briefly-occluded vehicle from getting a fresh track ID
# (which would bypass the per-track cooldown and cause double-counting).
_TRACK_TTL_S: float = 1.5


class CameraWorker:
    def __init__(self, cfg: CameraConfig):
        self.cfg = cfg
        self.sender = IngestSender(cfg.ingest_url, cfg.ingest_key, cfg.name)
        self.executor = ThreadPoolExecutor(max_workers=3)
        self._tracks: Dict[int, TrackState] = {}
        self._next_track = 0
        self._stop = threading.Event()
        self._snapshot_saved = False
        self._consecutive_vision_failures = 0
        self.is_connected = False
        # Global per-direction crossing timestamps (camera-level cooldown)
        # Keyed by direction string ("entry" | "exit").
        # Updated atomically inside _emit_lock to prevent race conditions from
        # concurrent vision-classifier threads emitting in the same direction.
        self._last_emitted_ts: Dict[str, float] = {}
        self._emitted_tracks: Dict[str, Set[str]] = {"entry": set(), "exit": set()}
        self._emit_lock = threading.Lock()

        # Initialize vision classifier if configured
        if cfg.vision_classifier and cfg.vision_classifier.lower() != "none":
            log.info("[%s] Initializing Vision Classifier: model=%s, size=%d", 
                     cfg.name, cfg.vision_classifier, cfg.vision_image_size)
            self.classifier = VisionClassifier(
                api_key=cfg.openai_api_key,
                model=cfg.vision_classifier if cfg.vision_classifier != "gpt4o-mini" else "gpt-4o-mini",
                image_size=cfg.vision_image_size
            )
        else:
            self.classifier = None

    def report_status(self, status: str) -> None:
        """Sends an explicit status report (e.g. 'online', 'offline') to the database via ingest-events."""
        try:
            resp = requests.post(
                self.cfg.ingest_url,
                json={"status": status},
                headers={"x-ingest-key": self.cfg.ingest_key, "Content-Type": "application/json"},
                timeout=5,
            )
            if resp.ok:
                log.info("[%s] Successfully reported status: %s", self.cfg.name, status)
            else:
                log.warning("[%s] Failed to report status %s: HTTP %s: %s", self.cfg.name, status, resp.status_code, resp.text[:200])
        except Exception as e:
            log.error("[%s] Exception reporting status %s: %s", self.cfg.name, status, e)

    def _upload_snapshot(self, jpeg_bytes: bytes, occurred_at: str) -> Optional[str]:
        """
        Uploads a JPEG snapshot to Supabase Storage bucket 'vision-snapshots'.
        Returns the storage path on success, or None on failure.
        Path format: <camera_id_safe>/<occurred_at_safe>.jpg
        """
        if not self.cfg.supabase_url or not self.cfg.supabase_service_key:
            log.warning("[%s] store_snapshots=true but supabase_url/supabase_service_key are not set.", self.cfg.name)
            return None
        try:
            # Build a filesystem-safe timestamp (colons and + chars are path-unsafe)
            safe_ts = occurred_at.replace(":", "-").replace("+", "Z").replace(" ", "T")
            # Use camera name slug as folder (replace spaces/special chars)
            cam_slug = "".join(c if c.isalnum() or c in "-_" else "_" for c in self.cfg.name)
            path = f"{cam_slug}/{safe_ts}.jpg"
            url = f"{self.cfg.supabase_url.rstrip('/')}/storage/v1/object/vision-snapshots/{path}"
            resp = requests.put(
                url,
                data=jpeg_bytes,
                headers={
                    "Authorization": f"Bearer {self.cfg.supabase_service_key}",
                    "Content-Type": "image/jpeg",
                    "x-upsert": "true",  # overwrite if same path exists
                },
                timeout=15,
            )
            if resp.ok:
                log.info("[%s] Snapshot uploaded: %s", self.cfg.name, path)
                return path
            log.warning("[%s] Snapshot upload failed (HTTP %s): %s", self.cfg.name, resp.status_code, resp.text[:200])
            return None
        except Exception as exc:
            log.error("[%s] Exception uploading snapshot: %s", self.cfg.name, exc)
            return None

    def _classify_and_emit(
        self,
        crop: np.ndarray,
        jpeg_bytes: bytes,
        direction: str,
        track_id: str,
        occurred_at: str,
    ) -> None:
        """
        Runs in a background thread-pool thread.
        1. Checks global cooldown and emitted tracks BEFORE calling classifier.
        2. Calls the OpenAI vision classifier.
        3. If the object is confirmed as a vehicle AND the cooldown passes,
           uploads the snapshot JPEG to Supabase Storage.
        4. Emits a VehicleEvent with the snapshot path attached.
        Rejected objects and cooldown-suppressed events never touch Storage.
        """
        try:
            # Check global cooldown and double-emit BEFORE calling the vision classifier
            with self._emit_lock:
                # 1. Check if this track has already emitted in either direction
                if track_id in self._emitted_tracks["entry"] or track_id in self._emitted_tracks["exit"]:
                    log.info(
                        "[%s] Track %s already emitted. Suppressing duplicate early.",
                        self.cfg.name, track_id
                    )
                    return

                # 2. Check global cooldown
                now = time.monotonic()
                last_emit = self._last_emitted_ts.get(direction, 0.0)
                gap = now - last_emit
                if gap < self.cfg.global_cross_cooldown_s:
                    log.info(
                        "[%s] Global %s cooldown active (%.1fs < %.1fs) before classification. "
                        "Suppressing track %s early.",
                        self.cfg.name, direction, gap,
                        self.cfg.global_cross_cooldown_s, track_id
                    )
                    return

            result = self.classifier.classify(crop, self.cfg.name)
            self._consecutive_vision_failures = 0  # reset on success
            if result.is_vehicle:
                # Apply global per-direction cooldown and double-emit check after classification
                # in case another thread emitted in the meantime
                with self._emit_lock:
                    if track_id in self._emitted_tracks["entry"] or track_id in self._emitted_tracks["exit"]:
                        log.info(
                            "[%s] Track %s already emitted. Suppressing duplicate after classification.",
                            self.cfg.name, track_id
                        )
                        return

                    now = time.monotonic()
                    last_emit = self._last_emitted_ts.get(direction, 0.0)
                    gap = now - last_emit
                    if gap < self.cfg.global_cross_cooldown_s:
                        log.info(
                            "[%s] Global %s cooldown active (%.1fs < %.1fs) after classification. "
                            "Suppressing track %s to prevent double-count.",
                            self.cfg.name, direction, gap,
                            self.cfg.global_cross_cooldown_s, track_id
                        )
                        return  # reject — no snapshot upload
                    self._last_emitted_ts[direction] = now
                    self._emitted_tracks[direction].add(track_id)

                log.info(
                    "[%s] Vision confirmed vehicle (type=%s, confidence=%.2f) for track %s. Emitting event.",
                    self.cfg.name, result.type, result.confidence, track_id
                )

                # --- Upload snapshot AFTER confirmation (never upload rejected objects) ---
                snapshot_path: Optional[str] = None
                if self.cfg.store_snapshots:
                    snapshot_path = self._upload_snapshot(jpeg_bytes, occurred_at)

                self.sender.push(
                    VehicleEvent(
                        direction=direction,
                        track_id=track_id,
                        confidence=result.confidence,
                        occurred_at=occurred_at,
                        snapshot_path=snapshot_path,
                        v_type=result.type,
                    )
                )
            else:
                log.info(
                    "[%s] Vision rejected object (type=%s, confidence=%.2f) for track %s. Discarding event.",
                    self.cfg.name, result.type, result.confidence, track_id
                )
                # No snapshot upload — rejected objects never touch Storage

        except Exception as e:
            self._consecutive_vision_failures += 1
            if self._consecutive_vision_failures % 5 == 0:
                log.critical(
                    "[%s] Vision classifier has failed %d consecutive times! (Latest exception: %s)",
                    self.cfg.name, self._consecutive_vision_failures, e
                )
            else:
                log.error("[%s] Error in background vision classification: %s. Emitting event as fail-open.", self.cfg.name, e)
            # Fail-open: apply global cooldown and double-emit prevention to avoid flooding on repeated failures
            with self._emit_lock:
                if track_id in self._emitted_tracks["entry"] or track_id in self._emitted_tracks["exit"]:
                    return
                now = time.monotonic()
                last_emit = self._last_emitted_ts.get(direction, 0.0)
                if now - last_emit < self.cfg.global_cross_cooldown_s:
                    return
                self._last_emitted_ts[direction] = now
                self._emitted_tracks[direction].add(track_id)
            # Upload snapshot for fail-open events (API error) — useful for debugging
            snapshot_path = None
            if self.cfg.store_snapshots:
                snapshot_path = self._upload_snapshot(jpeg_bytes, occurred_at)
            self.sender.push(
                VehicleEvent(
                    direction=direction,
                    track_id=track_id,
                    confidence=1.0,
                    occurred_at=occurred_at,
                    snapshot_path=snapshot_path,
                    v_type=None,
                )
            )


    def _heartbeat_loop(self) -> None:
        """Sends a periodic heartbeat to Supabase to keep camera status 'online' on live screen."""
        while not self._stop.is_set():
            time.sleep(30)
            if self.is_connected and not self._stop.is_set():
                try:
                    resp = requests.post(
                        self.cfg.ingest_url,
                        json=[],
                        headers={"x-ingest-key": self.cfg.ingest_key, "Content-Type": "application/json"},
                        timeout=5,
                    )
                    if not resp.ok:
                        log.warning("[%s] Heartbeat failed: HTTP %s: %s", self.cfg.name, resp.status_code, resp.text[:200])
                except Exception as e:
                    log.error("[%s] Exception sending heartbeat: %s", self.cfg.name, e)

    def run(self) -> None:
        # Start background heartbeat daemon thread
        threading.Thread(target=self._heartbeat_loop, name=f"heartbeat-{self.cfg.name}", daemon=True).start()

        while not self._stop.is_set():
            log.info("[%s] connecting to %s", self.cfg.name, self.cfg.rtsp_url)
            try:
                self._stream_loop()
            except Exception as exc:
                log.error("[%s] unexpected error: %s", self.cfg.name, exc)
            self.is_connected = False
            self.report_status("offline")
            if not self._stop.is_set():
                log.info("[%s] reconnecting in %.1fs...", self.cfg.name, self.cfg.reconnect_delay_s)
                time.sleep(self.cfg.reconnect_delay_s)

    def stop(self) -> None:
        self._stop.set()
        self.is_connected = False
        self.report_status("offline")
        self.sender.stop()
        self.executor.shutdown(wait=False)

    # ------------------------------------------------------------------
    def _stream_loop(self) -> None:
        cap = cv2.VideoCapture(self.cfg.rtsp_url, cv2.CAP_FFMPEG)
        if not cap.isOpened():
            log.error("[%s] failed to open RTSP stream", self.cfg.name)
            self.is_connected = False
            return

        self.is_connected = True
        self.report_status("online")
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)

        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        log.info("[%s] stream open: %dx%d @ %.1f fps", self.cfg.name, w, h, fps)

        # Pixel coordinates computed once per stream open
        p1, p2 = _line_pixel_coords(self.cfg.line, w, h)
        roi_x1, roi_y1, roi_x2, roi_y2 = _roi_pixel_coords(self.cfg.roi, w, h)

        # Tracking distance threshold scales with frame size
        self._dist_thresh = int(max(w, h) * 0.08)  # ~8% of frame diagonal

        bg_sub = cv2.createBackgroundSubtractorMOG2(
            history=400, varThreshold=50, detectShadows=True
        )

        frame_count = 0
        consecutive_failures = 0
        MAX_FAILURES = 30

        while not self._stop.is_set():
            ret, frame = cap.read()
            if not ret:
                consecutive_failures += 1
                if consecutive_failures >= MAX_FAILURES:
                    log.warning("[%s] too many read failures, reconnecting", self.cfg.name)
                    break
                time.sleep(0.1)
                continue
            consecutive_failures = 0
            frame_count += 1

            # Save a debug snapshot once the stream has stabilized (after 30 frames)
            if self.cfg.debug_snapshot and not self._snapshot_saved and frame_count > 30:
                self._save_snapshot(frame, p1, p2, roi_x1, roi_y1, roi_x2, roi_y2)

            if frame_count % self.cfg.frame_skip != 0:
                continue

            self._process_frame(frame, bg_sub, p1, p2, roi_x1, roi_y1, roi_x2, roi_y2)

        cap.release()
        if self.cfg.debug_window:
            cv2.destroyWindow(self.cfg.name)

    # ------------------------------------------------------------------
    def _save_snapshot(
        self, frame, p1, p2, roi_x1, roi_y1, roi_x2, roi_y2
    ) -> None:
        """Save a JPEG with the counting line and ROI drawn on it."""
        self._snapshot_saved = True
        debug = frame.copy()
        # ROI rectangle — blue
        cv2.rectangle(debug, (roi_x1, roi_y1), (roi_x2, roi_y2), (255, 100, 0), 3)
        # Counting line — yellow, thick
        cv2.line(debug, p1, p2, (0, 230, 255), 4)
        # Labels
        cv2.putText(debug, "ENTRY (down)", (p1[0] + 10, p1[1] + 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 230, 255), 3)
        cv2.putText(debug, "EXIT (up)", (p1[0] + 10, p1[1] - 15),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 200, 255), 3)
        # ROI label
        cv2.putText(debug, "Detection zone", (roi_x1 + 10, roi_y1 + 40),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 100, 0), 3)
        # Path traversal shield: Sanitize camera name to alphanumeric, dash, and underscore
        import re
        safe_name = re.sub(r"[^\w\-]", "_", self.cfg.name)
        fname = f"snapshot_{safe_name}.jpg"
        cv2.imwrite(fname, debug, [cv2.IMWRITE_JPEG_QUALITY, 85])
        log.info("[%s] DEBUG snapshot saved -> %s  (open it to verify line position)", self.cfg.name, fname)

    # ------------------------------------------------------------------
    def _process_frame(
        self,
        frame,
        bg_sub,
        p1: Tuple[int, int],
        p2: Tuple[int, int],
        roi_x1: int,
        roi_y1: int,
        roi_x2: int,
        roi_y2: int,
    ) -> None:
        h_frame, w_frame = frame.shape[:2]

        # 1. Crop to ROI before background subtraction
        roi_crop = frame[roi_y1:roi_y2, roi_x1:roi_x2]
        
        # CPU Optimization: downscale crop to max 640px for faster MOG2 + morphology operations
        h_crop, w_crop = roi_crop.shape[:2]
        target_size = 640
        max_dim = max(h_crop, w_crop)
        if max_dim > target_size:
            scale = target_size / max_dim
            proc_w = int(w_crop * scale)
            proc_h = int(h_crop * scale)
            proc_crop = cv2.resize(roi_crop, (proc_w, proc_h))
        else:
            scale = 1.0
            proc_crop = roi_crop

        blurred = cv2.GaussianBlur(proc_crop, (7, 7), 0)
        mask = bg_sub.apply(blurred)

        # Remove shadows (127) — keep only solid foreground (255)
        _, mask = cv2.threshold(mask, 200, 255, cv2.THRESH_BINARY)

        # Morphological clean-up to merge fragmented vehicle blobs
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=3)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,  kernel, iterations=1)
        mask = cv2.dilate(mask, kernel, iterations=2)

        # 2. Find contours in the ROI
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        active_ids: set = set()

        for cnt in contours:
            # Scale the contour's area back up to check against min_contour_area accurately
            contour_area = cv2.contourArea(cnt) / (scale * scale)
            if contour_area < self.cfg.min_contour_area:
                continue

            # Centroid is relative to processed ROI crop — translate back to original ROI and then to full frame
            cx_proc, cy_proc = _centroid(cnt)
            cx = int(cx_proc / scale) + roi_x1
            cy = int(cy_proc / scale) + roi_y1

            side = _side_of_line(cx, cy, p1, p2)
            track_id = self._assign_track(cx, cy)
            active_ids.add(track_id)

            state = self._tracks[track_id]
            prev_side = state.last_side

            # Crossing detected when sign flips (and neither side is zero)
            if prev_side != 0 and side != 0 and (prev_side > 0) != (side > 0):
                # Ensure the crossing centroid lies within the actual line segment bounds
                line_len = ((p2[0] - p1[0])**2 + (p2[1] - p1[1])**2)**0.5
                margin = max(30, int(line_len * 0.05))
                in_x = (min(p1[0], p2[0]) - margin) <= cx <= (max(p1[0], p2[0]) + margin)
                in_y = (min(p1[1], p2[1]) - margin) <= cy <= (max(p1[1], p2[1]) + margin)

                if in_x and in_y:
                    now_ts = time.monotonic()
                    if now_ts - state.last_event_ts >= self.cfg.line_cross_cooldown_s:
                        # For a horizontal line (left->right), side<0 means below the line
                        # i.e. vehicle moved from above (road) to below (carpark) = ENTRY
                        direction = "entry" if side > 0 else "exit"
                        state.last_event_ts = now_ts
                        log.info(
                            "[%s] crossing detected: %s | centroid=(%d,%d) | prev_side=%.0f side=%.0f",
                            self.cfg.name, direction, cx, cy, prev_side, side
                        )
                        occurred_at = datetime.now(timezone.utc).isoformat()
                        
                        if self.classifier is not None:
                            # Extract the crop safely from the original raw resolution ROI
                            x_cnt_proc, y_cnt_proc, bw_cnt_proc, bh_cnt_proc = cv2.boundingRect(cnt)
                            x_cnt = int(x_cnt_proc / scale)
                            y_cnt = int(y_cnt_proc / scale)
                            bw_cnt = int(bw_cnt_proc / scale)
                            bh_cnt = int(bh_cnt_proc / scale)
                            
                            pad = 15
                            h_roi, w_roi = roi_crop.shape[:2]
                            y1_crop = max(0, y_cnt - pad)
                            y2_crop = min(h_roi, y_cnt + bh_cnt + pad)
                            x1_crop = max(0, x_cnt - pad)
                            x2_crop = min(w_roi, x_cnt + bw_cnt + pad)
                            object_crop = roi_crop[y1_crop:y2_crop, x1_crop:x2_crop].copy()
                            
                            if object_crop.size > 0:
                                # Pre-encode to JPEG here (on the stream thread) so the background
                                # thread receives a ready-to-upload bytes object without holding
                                # a reference to the numpy array (avoids a potential data race).
                                _, jpeg_buf = cv2.imencode(".jpg", object_crop, [cv2.IMWRITE_JPEG_QUALITY, 80])
                                jpeg_bytes = jpeg_buf.tobytes() if _ else b""
                                # Start classification in background thread pool so it doesn't block stream tracking
                                self.executor.submit(
                                    self._classify_and_emit,
                                    object_crop, jpeg_bytes, direction, str(track_id), occurred_at
                                )
                            else:
                                # If crop is somehow empty, fail open
                                log.warning("[%s] Crop size is 0, failing open and emitting event.", self.cfg.name)
                                self.sender.push(
                                    VehicleEvent(
                                        direction=direction,
                                        track_id=str(track_id),
                                        confidence=None,
                                        occurred_at=occurred_at,
                                    )
                                )
                        else:
                            # Standard behaviour when vision is disabled (apply global cooldown and double-emit checks)
                            with self._emit_lock:
                                # 1. Check double emit
                                if str(track_id) in self._emitted_tracks["entry"] or str(track_id) in self._emitted_tracks["exit"]:
                                    log.info(
                                        "[%s] Track %s already emitted (standard mode). Suppressing duplicate.",
                                        self.cfg.name, track_id
                                    )
                                    continue

                                # 2. Check global cooldown
                                now = time.monotonic()
                                last_emit = self._last_emitted_ts.get(direction, 0.0)
                                if now - last_emit < self.cfg.global_cross_cooldown_s:
                                    log.info(
                                        "[%s] Global %s cooldown active (%.1fs < %.1fs) (standard mode). Suppressing track %s.",
                                        self.cfg.name, direction, now - last_emit, self.cfg.global_cross_cooldown_s, track_id
                                    )
                                    continue

                                self._last_emitted_ts[direction] = now
                                self._emitted_tracks[direction].add(str(track_id))

                            self.sender.push(
                                VehicleEvent(
                                    direction=direction,
                                    track_id=str(track_id),
                                    confidence=None,
                                    occurred_at=occurred_at,
                                )
                            )

            state.last_side = side
            state.cx = cx
            state.cy = cy

        # 3. Prune tracks not seen recently (TTL-based — avoids immediate ID churn
        #    when a vehicle blob disappears for a frame or two due to shadows/occlusion).
        prune_cutoff = time.monotonic() - _TRACK_TTL_S
        stale = [
            tid for tid, state in self._tracks.items()
            if tid not in active_ids and state.last_seen_ts < prune_cutoff
        ]
        for tid in stale:
            del self._tracks[tid]
            with self._emit_lock:
                self._emitted_tracks["entry"].discard(str(tid))
                self._emitted_tracks["exit"].discard(str(tid))

        # 4. Optional live debug window
        if self.cfg.debug_window:
            debug = frame.copy()
            # ROI rect
            cv2.rectangle(debug, (roi_x1, roi_y1), (roi_x2, roi_y2), (255, 100, 0), 2)
            # Counting line
            cv2.line(debug, p1, p2, (0, 230, 255), 3)
            # Detections
            for cnt in contours:
                if cv2.contourArea(cnt) >= self.cfg.min_contour_area:
                    x, y, bw, bh = cv2.boundingRect(cnt)
                    cv2.rectangle(
                        debug,
                        (x + roi_x1, y + roi_y1),
                        (x + roi_x1 + bw, y + roi_y1 + bh),
                        (0, 200, 0), 2,
                    )
            cv2.imshow(self.cfg.name, cv2.resize(debug, (1280, 720)))
            if cv2.waitKey(1) & 0xFF == ord("q"):
                self._stop.set()

    # ------------------------------------------------------------------
    def _assign_track(self, cx: int, cy: int) -> int:
        """Nearest-centroid tracker. Returns a stable track ID."""
        best_id: Optional[int] = None
        best_dist = float("inf")

        for tid, state in self._tracks.items():
            d = ((state.cx - cx) ** 2 + (state.cy - cy) ** 2) ** 0.5
            if d < self._dist_thresh and d < best_dist:
                best_dist = d
                best_id = tid

        if best_id is None:
            best_id = self._next_track
            self._next_track += 1
            self._tracks[best_id] = TrackState(side=0.0, cx=cx, cy=cy)
        else:
            # Refresh the TTL so this track isn't pruned while still visible
            self._tracks[best_id].last_seen_ts = time.monotonic()

        return best_id


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Carbon vehicle counting worker")
    parser.add_argument("--config", default="config.yaml", help="Path to YAML config file")
    args = parser.parse_args()

    all_cameras = load_config(args.config)
    if not all_cameras:
        log.error("No cameras found in config. Exiting.")
        sys.exit(1)

    # Filter only enabled cameras that are designated for vehicle counting
    cameras = [cfg for cfg in all_cameras if cfg.enabled and cfg.mode == "vehicle_counting"]
    
    ignored_cameras = [cfg for cfg in all_cameras if not cfg.enabled or cfg.mode != "vehicle_counting"]
    if ignored_cameras:
        log.info("Ignoring %d camera(s) (either disabled or configured for another mode): %s", 
                 len(ignored_cameras), [c.name for c in ignored_cameras])

    if not cameras:
        log.warning("No active vehicle_counting cameras found. Entering idle standby mode.")
    
    # Perform AI auto-calibration on startup for cameras missing line or ROI settings
    for cfg in cameras:
        if cfg.needs_calibration:
            log.info("[%s] Camera is missing custom virtual line/ROI. Initiating AI Auto-Calibration...", cfg.name)
            # Try to grab a frame from the RTSP stream
            frame = grab_single_frame(cfg.rtsp_url)
            if frame is not None:
                cal = ai_calibrate_line_and_roi(frame, cfg.openai_api_key, cfg.name)
                if cal is not None:
                    cfg.line, cfg.roi = cal
                    cfg.needs_calibration = False
                    # Persist it into config.yaml
                    save_calibration_to_file(args.config, cfg.name, cfg.line, cfg.roi)
                else:
                    log.error("[%s] AI Auto-Calibration failed. Falling back to default center line.", cfg.name)
            else:
                log.error("[%s] Could not open RTSP stream to capture calibration frame. Falling back to default.", cfg.name)

    log.info("Starting %d camera worker(s)", len(cameras))
    workers: List[CameraWorker] = []
    threads: List[threading.Thread] = []

    for cfg in cameras:
        w = CameraWorker(cfg)
        workers.append(w)
        t = threading.Thread(target=w.run, name=f"cam-{cfg.name}", daemon=True)
        t.start()
        threads.append(t)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log.info("Shutting down...")
        for w in workers:
            w.stop()
        for t in threads:
            t.join(timeout=5)
        log.info("Done.")


if __name__ == "__main__":
    main()
