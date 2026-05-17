# VoiceStudio

Clone any voice in minutes. Record yourself, upload a file, or pull audio from YouTube — then generate speech in that voice from any text.

No large model downloads. Everything runs through cloud APIs with free tiers.

---

## Setup (2 minutes)

### 1 — Install (lightweight, no ML libraries)

```bash
cd voice-studio
python -m venv venv

# Windows
venv\Scripts\activate
# macOS / Linux
source venv/bin/activate

pip install -r requirements.txt
```

### 2 — Add API keys

```bash
cp .env.example .env
# then open .env and fill in at least one provider key
```

| Provider | Free tier | Sign up |
|---|---|---|
| **ElevenLabs** | 10,000 chars/month | https://elevenlabs.io |
| **Play.ht** | 12,500 words/month | https://play.ht |
| **Cartesia** | $5 credit/month | https://cartesia.ai |
| **LMNT** | 500 utterances/month | https://lmnt.com |

You only need **one** to get started. Add more and synthesis requests rotate across all of them automatically — so free tiers last much longer.

### 3 — Run

```bash
python run.py
```

Open **http://localhost:5000**

---

## How API rotation works

- All providers you configure are used in round-robin order for every synthesis request
- If a provider returns an error (quota hit, network issue), the next provider is tried automatically
- Voice audio is cloned on **all** configured providers so any of them can generate speech
- When you continue training and add new samples, voices are automatically re-uploaded with the improved audio

## Features

| Feature | Details |
|---|---|
| **Authentication** | Username + password, JWT sessions |
| **Quick Training** | 10 phonetically rich sentences, ~2–3 min to record |
| **Extended Training** | Unlimited extra samples, stop whenever you want |
| **Upload audio** | MP3, WAV, M4A, WEBM, OGG, FLAC — any format |
| **YouTube import** | Paste any YouTube URL; audio extracted automatically |
| **Voice naming** | Each voice saved with its own name |
| **Text-to-Speech** | Type anything, generate instantly, listen or download |
| **Continue Training** | One click from the speak view to keep improving |
| **Provider rotation** | Free tiers spread across all configured APIs |
