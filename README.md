# VoiceStudio

Clone any voice in minutes. Record yourself, upload a file, or pull audio from YouTube — then generate speech in that voice from any text.

---

## Setup

### Prerequisites
- Python 3.10+
- [ffmpeg](https://ffmpeg.org/download.html) — must be on your PATH
- ~4 GB free disk space (for the XTTS v2 model, downloaded on first synthesis)

### Install

```bash
cd voice-studio
python -m venv venv

# Windows
venv\Scripts\activate

# macOS / Linux
source venv/bin/activate

pip install -r requirements.txt
```

### Run

```bash
python run.py
```

Open **http://localhost:5000** in your browser.

The XTTS v2 model (~1.9 GB) is downloaded automatically the first time the server starts. A "Loading TTS model…" badge appears in the dashboard until it's ready.

---

## Features

| Feature | Details |
|---|---|
| **Authentication** | Username + password, JWT sessions (30-day tokens) |
| **Quick Training** | 10 curated sentences, ~2–3 min to record |
| **Extended Training** | Unlimited additional samples; press "Done" when satisfied |
| **Upload** | Accepts MP3, WAV, M4A, OGG, FLAC, MP4, and more |
| **YouTube import** | Paste any YouTube URL; audio is extracted automatically |
| **Voice naming** | Each voice has its own name and sample library |
| **Text-to-Speech** | Type any text, generate WAV, listen instantly or download |
| **Continue Training** | One-click from the speak view to keep improving a voice |

## Quality guide

| Audio collected | Expected quality |
|---|---|
| < 30 s | Getting started |
| 30 – 120 s | Good |
| 120 – 300 s | Great |
| 300 s + | Excellent |

---

## Technology

- **TTS engine**: [Coqui XTTS v2](https://github.com/coqui-ai/TTS) — state-of-the-art zero-shot voice cloning
- **Backend**: Flask, SQLAlchemy (SQLite), Flask-JWT-Extended, Flask-Bcrypt
- **Audio processing**: ffmpeg
- **YouTube**: yt-dlp
- **Frontend**: Vanilla JS, Web Audio API, zero dependencies
