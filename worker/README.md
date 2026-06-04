# Carbon Worker

Python script that reads RTSP streams from a Hikvision NVR, detects vehicles crossing a virtual line, and POSTs entry/exit events to the Carbon ingest endpoint in real time.

---

## Files

| File | Purpose |
|------|---------|
| `worker.py` | Main worker — one thread per camera |
| `config.yaml` | Camera config (RTSP URL, ingest key, line position) |
| `requirements.txt` | Python dependencies |

---

## Quick Start

### 1. Install dependencies
```bash
cd worker
pip install -r requirements.txt
```

> On a headless server (no display), `opencv-python-headless` is already specified.  
> If you want the live debug window on your PC, replace it with `opencv-python`.

### 2. Configure your cameras

Edit `config.yaml`:

```yaml
cameras:
  - name: "Entry Gate - Cam 1"
    rtsp_url: "rtsp://admin:YourPassword@192.168.1.100:554/Streaming/Channels/101"
    ingest_key: "abc123..."   # from Cameras page → eye icon
    ingest_url: "https://hsfkuivammmkzvxfqoin.supabase.co/functions/v1/ingest-events"
    line:
      x1: 0.0   # left end of counting line (normalised)
      y1: 0.5   # 50% down the frame
      x2: 1.0   # right end
      y2: 0.5
```

**Hikvision NVR RTSP URL formula:**
```
rtsp://admin:<password>@<NVR-IP>:554/Streaming/Channels/<ChannelID>
```
- Camera 1 main stream → `101`
- Camera 2 sub stream  → `202`
- Camera 3 main stream → `301`

### 3. Get your ingest key

1. Open Carbon app → **Cameras**
2. Find the camera → click the **eye icon** to reveal the ingest key
3. Copy it into `config.yaml`

### 4. Run

```bash
python worker.py --config config.yaml
```

You'll see log output like:
```
[Entry Gate - Cam 1] stream open: 1920x1080 @ 25.0 fps
[Entry Gate - Cam 1] queued event: entry (track=42)
[Entry Gate - Cam 1] ✓ flushed 1 event(s) → {'ok': True, 'inserted': 1}
```

---

## How Detection Works

1. **Background subtraction** (MOG2) isolates moving objects from the static background.
2. **Contour detection** finds blobs large enough to be vehicles (`min_contour_area`).
3. **Virtual counting line** — each blob's centroid is tracked across frames. When it crosses from one side of the line to the other, an event fires.
4. A **cooldown** (`line_cross_cooldown_s`) prevents the same vehicle triggering multiple events as it slowly crosses the line.
5. Events are queued in memory and **batch-flushed every 2 seconds** over HTTPS.

---

## Counting Line Direction

The line divides the frame into two sides:
- **entry** = object moves from the _positive_ side to the _negative_ side (right-of-line → left-of-line for a vertical line)
- **exit** = opposite direction

For a **horizontal line** (default `y=0.5`):
- Object moving **down** the frame → `entry`
- Object moving **up** the frame → `exit`

Swap entry/exit semantics by flipping the direction of the line:
```yaml
# Instead of left→right (default), define right→left:
line:
  x1: 1.0
  y1: 0.5
  x2: 0.0
  y2: 0.5
```

---

## Tuning Tips

| Symptom | Fix |
|---------|-----|
| False detections (wind, shadows) | Increase `min_contour_area` |
| Missing slow vehicles | Decrease `min_contour_area` |
| Double-counting one vehicle | Increase `line_cross_cooldown_s` |
| High CPU usage | Increase `frame_skip` (e.g., `3` or `4`) |
| Stream keeps disconnecting | Lower your RTSP quality to sub-stream (`102` instead of `101`) |
| No events on dashboard | Check ingest key is correct; check `ingest_url` is reachable |

---

## Debug Window

Set `debug_window: true` in `config.yaml` to open a live OpenCV window showing:
- Yellow line = counting line
- Green rectangles = detected vehicles

Press `q` to stop.

> Requires `opencv-python` (not `opencv-python-headless`) and a display.

---

## Running as a Service (optional)

**Linux (systemd):**
```ini
[Unit]
Description=Carbon Camera Worker
After=network-online.target

[Service]
WorkingDirectory=/opt/carbon-worker
ExecStart=/usr/bin/python3 worker.py --config config.yaml
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**Windows (Task Scheduler):**
- Create a basic task → trigger: "At startup"
- Action: `python.exe` with argument `c:\path\to\worker.py --config c:\path\to\config.yaml`
