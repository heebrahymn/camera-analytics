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

## Running as a Service (Background Uptime)

To ensure the worker runs 24/7 in the background, even when you log out or lock your computer, configure it as a system service.

### Windows (Task Scheduler - Recommended)

Using Windows Task Scheduler ensures the worker starts automatically when the system boots up and keeps running when the user session is locked.

#### 1. Setup Helper Scripts
We provide two script helpers in this directory:
- `start_worker.bat`: Stays in the worker folder, starts the python script, and pipes all outputs to `worker.log`.
- `run_hidden.vbs`: A VBScript that launches `start_worker.bat` completely hidden in the background (no visible cmd command prompt window).

#### 2. Create the Scheduled Task
1. Press `Win + R`, type `taskschd.msc`, and press **Enter** to open Task Scheduler.
2. Click **Create Task...** on the right sidebar (do *not* choose Create Basic Task).
3. Under the **General** tab:
   - **Name**: `Carbon Camera Worker`
   - **User Account**: Make sure this is your active administrator account.
   - Select **Run whether user is logged on or not** (this keeps the task running when locked or logged out).
   - Select **Run with highest privileges** (ensures it is not blocked by permissions).
4. Under the **Triggers** tab:
   - Click **New...**
   - **Begin the task**: Choose **At startup** (runs immediately when the PC starts).
   - Click **OK**.
5. Under the **Actions** tab:
   - Click **New...**
   - **Action**: Choose **Start a program**.
   - **Program/script**: Enter `wscript.exe`
   - **Add arguments**: Enter the absolute path to `run_hidden.vbs` (e.g. `C:\Projects\cameraAnalyticsApp\worker\run_hidden.vbs`).
   - **Start in**: Enter the absolute path to the directory containing it (e.g. `C:\Projects\cameraAnalyticsApp\worker`).
   - Click **OK**.
6. Under the **Conditions** tab:
   - Uncheck **Start the task only if the computer is on AC power** (to ensure it runs on laptops or UPS battery backups).
7. Under the **Settings** tab:
   - Uncheck **Stop the task if it runs longer than** (we want it to run indefinitely).
   - **If the task fails, restart every**: Check this and set to `1 minute`. Set attempts to `999`.
8. Click **OK**. You will be prompted to enter your Windows account password to authorize background execution.

#### 3. Monitoring & Controlling the Worker
- **To View Logs**: Look at `worker/worker.log` in this directory to see real-time status and logs.
- **To Stop the Worker**: Open Task Scheduler, click **Active Tasks**, locate `Carbon Camera Worker`, and click **End** in the actions menu. Or run:
  ```cmd
  taskkill /f /im python.exe
  ```

---

### Linux (systemd)

```ini
[Unit]
Description=Carbon Camera Analytics Worker
After=network-online.target

[Service]
WorkingDirectory=/opt/carbon-worker
ExecStart=/usr/bin/python3 worker.py --config config.yaml
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```
