# Carbon Camera Analytics

A real-time vehicle counting and analytics dashboard for CCTV camera systems.

## Features

- **Live Feed** — real-time event stream from all cameras
- **Analytics** — hourly/daily entry & exit charts per store
- **Reports** — date-filtered daily PDF reports with vehicle type breakdown
- **Cameras & Stores** — management UI for cameras and locations
- **Worker** — Python background process that reads RTSP streams and counts vehicles using computer vision + GPT-4o Mini vision classification

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React + TypeScript + Vite |
| UI | Tailwind CSS + shadcn/ui |
| Backend | Supabase (Postgres + Edge Functions + Storage) |
| Worker | Python, OpenCV, YOLO-free background subtraction |
| AI Vision | OpenAI GPT-4o Mini |

## Getting Started

### 1. Frontend

```bash
npm install
npm run dev
```

Create a `.env` file (never commit this):
```
VITE_SUPABASE_URL=https://<project-id>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<your-anon-key>
VITE_SUPABASE_PROJECT_ID=<project-id>
```

### 2. Worker

See [`worker/README.md`](worker/README.md) for full setup instructions.

```bash
cd worker
pip install -r requirements.txt
cp config.yaml.example config.yaml   # then fill in your credentials
python worker.py --config config.yaml
```

> **Security:** `config.yaml` is gitignored and must never be committed — it contains RTSP credentials, OpenAI API key, and Supabase service role key.

## Security Notes

- All secrets are loaded from environment variables or the local `config.yaml` (gitignored)
- The Supabase **anon key** (in `.env`) is safe for client-side use — it is scoped by Row Level Security
- The Supabase **service role key** (in `worker/config.yaml`) bypasses RLS — keep it secret
- OpenAI API key is in `worker/config.yaml` only — never in the frontend
- Camera snapshot images are local files and are gitignored

## License

Private — All rights reserved.
