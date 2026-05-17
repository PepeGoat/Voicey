"""
Voice cloning API providers with round-robin rotation.

Supported: ElevenLabs, Play.ht, Cartesia, LMNT
Each provider is used only if its env-var API key is set.
Synthesis rotates evenly across all configured providers so free
tier quotas are spread out. If one provider fails mid-request the
next one is tried automatically.
"""

from __future__ import annotations

import base64
import os
from abc import ABC, abstractmethod
from pathlib import Path

import requests


# ── Base ──────────────────────────────────────────────────────────────────────
class VoiceProvider(ABC):
    name: str = ""

    @property
    @abstractmethod
    def is_configured(self) -> bool: ...

    @abstractmethod
    def clone_voice(self, name: str, audio_paths: list[str]) -> str:
        """Upload samples; return provider-specific voice ID."""

    @abstractmethod
    def synthesize(self, provider_voice_id: str, text: str) -> bytes:
        """Return raw audio bytes (MP3 or WAV)."""

    @abstractmethod
    def delete_voice(self, provider_voice_id: str) -> None: ...

    @property
    def mime_type(self) -> str:
        return "audio/mpeg"


# ── ElevenLabs ────────────────────────────────────────────────────────────────
class ElevenLabsProvider(VoiceProvider):
    name = "elevenlabs"
    _BASE = "https://api.elevenlabs.io/v1"

    def __init__(self):
        self.api_key = os.environ.get("ELEVENLABS_API_KEY", "")

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key)

    def _h(self, extra: dict | None = None) -> dict:
        h = {"xi-api-key": self.api_key}
        if extra:
            h.update(extra)
        return h

    def clone_voice(self, name: str, audio_paths: list[str]) -> str:
        opened, files = [], []
        try:
            for p in audio_paths[:25]:
                f = open(p, "rb")
                opened.append(f)
                files.append(("files", (Path(p).name, f)))
            r = requests.post(
                f"{self._BASE}/voices/add",
                headers=self._h(),
                data={"name": name, "description": f"VoiceStudio: {name}"},
                files=files,
                timeout=120,
            )
            r.raise_for_status()
            return r.json()["voice_id"]
        finally:
            for f in opened:
                f.close()

    def synthesize(self, vid: str, text: str) -> bytes:
        r = requests.post(
            f"{self._BASE}/text-to-speech/{vid}",
            headers=self._h({"Accept": "audio/mpeg", "Content-Type": "application/json"}),
            json={
                "text": text,
                "model_id": "eleven_multilingual_v2",
                "voice_settings": {
                    "stability": 0.45,
                    "similarity_boost": 0.80,
                    "style": 0.0,
                    "use_speaker_boost": True,
                },
            },
            timeout=120,
        )
        r.raise_for_status()
        return r.content

    def delete_voice(self, vid: str) -> None:
        requests.delete(f"{self._BASE}/voices/{vid}", headers=self._h(), timeout=30)


# ── Play.ht ───────────────────────────────────────────────────────────────────
class PlayHTProvider(VoiceProvider):
    name = "playht"
    _BASE = "https://api.play.ht/api/v2"

    def __init__(self):
        self.secret = os.environ.get("PLAYHT_SECRET_KEY", "")
        self.user_id = os.environ.get("PLAYHT_USER_ID", "")

    @property
    def is_configured(self) -> bool:
        return bool(self.secret and self.user_id)

    def _h(self, extra: dict | None = None) -> dict:
        h = {"Authorization": f"Bearer {self.secret}", "X-USER-ID": self.user_id}
        if extra:
            h.update(extra)
        return h

    def clone_voice(self, name: str, audio_paths: list[str]) -> str:
        with open(audio_paths[0], "rb") as f:
            r = requests.post(
                f"{self._BASE}/cloned-voices/instant",
                headers=self._h(),
                files={"sample_file": (Path(audio_paths[0]).name, f)},
                data={"voice_name": name},
                timeout=120,
            )
        r.raise_for_status()
        d = r.json()
        return d.get("id") or d.get("voice_id") or ""

    def synthesize(self, vid: str, text: str) -> bytes:
        r = requests.post(
            f"{self._BASE}/tts/stream",
            headers=self._h({"Content-Type": "application/json", "Accept": "audio/mpeg"}),
            json={
                "text": text,
                "voice": vid,
                "voice_engine": "PlayHT2.0-turbo",
                "quality": "medium",
                "output_format": "mp3",
                "sample_rate": 24000,
                "speed": 1,
                "temperature": 0.5,
            },
            timeout=120,
        )
        r.raise_for_status()
        return r.content

    def delete_voice(self, vid: str) -> None:
        requests.delete(f"{self._BASE}/cloned-voices/{vid}", headers=self._h(), timeout=30)


# ── Cartesia ──────────────────────────────────────────────────────────────────
class CartesiaProvider(VoiceProvider):
    name = "cartesia"
    _BASE = "https://api.cartesia.ai"
    _VER  = "2024-06-10"

    def __init__(self):
        self.api_key = os.environ.get("CARTESIA_API_KEY", "")

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key)

    def _h(self, extra: dict | None = None) -> dict:
        h = {"X-API-Key": self.api_key, "Cartesia-Version": self._VER}
        if extra:
            h.update(extra)
        return h

    def clone_voice(self, name: str, audio_paths: list[str]) -> str:
        with open(audio_paths[0], "rb") as f:
            r = requests.post(
                f"{self._BASE}/voices/clone",
                headers=self._h(),
                files={"clip": (Path(audio_paths[0]).name, f)},
                data={"name": name, "description": f"VoiceStudio: {name}",
                      "language": "en", "mode": "clip"},
                timeout=120,
            )
        r.raise_for_status()
        return r.json()["id"]

    def synthesize(self, vid: str, text: str) -> bytes:
        r = requests.post(
            f"{self._BASE}/tts/bytes",
            headers=self._h({"Content-Type": "application/json"}),
            json={
                "model_id": "sonic-english",
                "transcript": text,
                "voice": {"mode": "id", "id": vid},
                "output_format": {"container": "mp3", "encoding": "mp3", "sample_rate": 44100},
            },
            timeout=120,
        )
        r.raise_for_status()
        return r.content

    def delete_voice(self, vid: str) -> None:
        requests.delete(f"{self._BASE}/voices/{vid}", headers=self._h(), timeout=30)


# ── LMNT ─────────────────────────────────────────────────────────────────────
class LMNTProvider(VoiceProvider):
    name = "lmnt"
    _BASE = "https://api.lmnt.com/v1"

    def __init__(self):
        self.api_key = os.environ.get("LMNT_API_KEY", "")

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key)

    def _h(self, extra: dict | None = None) -> dict:
        h = {"X-API-Key": self.api_key}
        if extra:
            h.update(extra)
        return h

    def clone_voice(self, name: str, audio_paths: list[str]) -> str:
        opened, files = [], []
        try:
            for p in audio_paths[:5]:
                f = open(p, "rb")
                opened.append(f)
                files.append(("files", (Path(p).name, f)))
            r = requests.post(
                f"{self._BASE}/ai/voice/clone",
                headers=self._h(),
                files=files,
                data={"name": name, "enhance": "false"},
                timeout=120,
            )
            r.raise_for_status()
            return r.json()["id"]
        finally:
            for f in opened:
                f.close()

    def synthesize(self, vid: str, text: str) -> bytes:
        r = requests.post(
            f"{self._BASE}/ai/speech",
            headers=self._h({"Content-Type": "application/json"}),
            json={"voice": vid, "text": text, "format": "mp3", "return_durations": False},
            timeout=120,
        )
        r.raise_for_status()
        ct = r.headers.get("content-type", "")
        if "audio" in ct or "octet" in ct:
            return r.content
        # Fallback: base64 JSON response
        return base64.b64decode(r.json().get("audio", ""))

    def delete_voice(self, vid: str) -> None:
        requests.delete(f"{self._BASE}/ai/voice/{vid}", headers=self._h(), timeout=30)


# ── Rotator ───────────────────────────────────────────────────────────────────
class ProviderRotator:
    """
    Holds all configured providers and distributes work across them.
    Re-reads env on each .refresh() call (called at startup and on reload).
    """
    _ALL = [ElevenLabsProvider, PlayHTProvider, CartesiaProvider, LMNTProvider]

    def __init__(self):
        self._providers: list[VoiceProvider] = []
        self._idx = 0
        self.refresh()

    def refresh(self):
        self._providers = [cls() for cls in self._ALL if cls().is_configured]
        self._idx = 0

    @property
    def configured(self) -> list[VoiceProvider]:
        return list(self._providers)

    @property
    def any_configured(self) -> bool:
        return bool(self._providers)

    def names(self) -> list[str]:
        return [p.name for p in self._providers]

    def get(self, name: str) -> VoiceProvider | None:
        return next((p for p in self._providers if p.name == name), None)

    def synthesize(self, provider_maps: dict[str, str], text: str) -> tuple[bytes, str]:
        """
        provider_maps = {provider_name: provider_voice_id}
        Rotates across available providers; falls back on error.
        Returns (audio_bytes, mime_type).
        """
        available = [(p, provider_maps[p.name])
                     for p in self._providers if p.name in provider_maps]
        if not available:
            raise RuntimeError("No providers have this voice cloned yet.")

        start  = self._idx % len(available)
        self._idx += 1
        errors = []
        for i in range(len(available)):
            p, vid = available[(start + i) % len(available)]
            try:
                return p.synthesize(vid, text), p.mime_type
            except Exception as exc:
                errors.append(f"{p.name}: {exc}")
        raise RuntimeError(f"All providers failed — {'; '.join(errors)}")


rotator = ProviderRotator()
