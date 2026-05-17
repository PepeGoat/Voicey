# VoiceStudio

**Zero install. Just open the link.**

Clone any voice in minutes — record yourself, upload a file, or pull audio from YouTube — then generate speech from any text.

## Use it now

**[https://pepegoat.github.io/Voicey](https://pepegoat.github.io/Voicey)**

> To enable GitHub Pages: repo Settings → Pages → Source: Deploy from branch → `main` → `/ (root)` → Save

---

## First-time setup (30 seconds)

1. Open the link above and create an account
2. Click the **⚙** icon (top right of dashboard)
3. Add an API key for at least one provider — all free:

| Provider | Free / month | Sign up |
|---|---|---|
| **ElevenLabs** | 10,000 characters | https://elevenlabs.io |
| **Play.ht** | 12,500 words | https://play.ht |
| **Cartesia** | $5 credit | https://cartesia.ai |
| **LMNT** | 500 utterances | https://lmnt.com |

The more providers you add, the longer your free tiers last — synthesis rotates between all of them automatically.

---

## How it works

- **No server.** Everything runs in your browser.
- **Data stays on your device.** Audio samples stored in IndexedDB; API keys in localStorage.
- **Quick Training** — 10 sentences, ~2 min, voice is ready immediately after.
- **Extended Training** — record as long as you want; press "Done" to finish.
- **Continue Training** — one click from the speak view; re-uploads all samples to providers for improved quality.
- **Provider rotation** — synthesis requests cycle across ElevenLabs, Play.ht, Cartesia, LMNT so no single free tier runs dry.
