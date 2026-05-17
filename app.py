"""VoiceStudio — cloud-API-backed voice cloning web application."""

import os
import uuid
import shutil
import tempfile
from pathlib import Path
from datetime import datetime, timedelta
import random

from dotenv import load_dotenv
load_dotenv()

from flask import Flask, request, jsonify, send_file, render_template
from flask_sqlalchemy import SQLAlchemy
from flask_bcrypt import Bcrypt
from flask_jwt_extended import (
    JWTManager, create_access_token,
    jwt_required, get_jwt_identity,
)
from providers import rotator

# ── Paths ──────────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).resolve().parent
DATA_DIR   = BASE_DIR / "data"
VOICES_DIR = DATA_DIR / "voices"
OUTPUT_DIR = DATA_DIR / "output"
TEMP_DIR   = DATA_DIR / "temp"

for _d in (DATA_DIR, VOICES_DIR, OUTPUT_DIR, TEMP_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# ── App ────────────────────────────────────────────────────────────────────────
app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY", "dev-secret-change-in-prod"),
    SQLALCHEMY_DATABASE_URI=f"sqlite:///{DATA_DIR}/app.db",
    SQLALCHEMY_TRACK_MODIFICATIONS=False,
    JWT_SECRET_KEY=os.environ.get("JWT_SECRET", "dev-jwt-change-in-prod"),
    JWT_ACCESS_TOKEN_EXPIRES=timedelta(days=30),
    MAX_CONTENT_LENGTH=200 * 1024 * 1024,
)

db     = SQLAlchemy(app)
bcrypt = Bcrypt(app)
jwt    = JWTManager(app)


# ── Models ──────────────────────────────────────────────────────────────────────
class User(db.Model):
    __tablename__ = "users"
    id            = db.Column(db.Integer, primary_key=True)
    username      = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at    = db.Column(db.DateTime, default=datetime.utcnow)
    voices        = db.relationship("Voice", backref="user", lazy=True,
                                    cascade="all, delete-orphan")


class Voice(db.Model):
    __tablename__          = "voices"
    id                     = db.Column(db.String(36), primary_key=True)
    user_id                = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    name                   = db.Column(db.String(100), nullable=False)
    sample_count           = db.Column(db.Integer, default=0)
    total_duration         = db.Column(db.Float, default=0.0)
    source                 = db.Column(db.String(20), default="microphone")
    uploaded_sample_count  = db.Column(db.Integer, default=0)
    created_at             = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at             = db.Column(db.DateTime, default=datetime.utcnow)
    provider_maps          = db.relationship("VoiceProviderMap", backref="voice",
                                             lazy=True, cascade="all, delete-orphan")

    def __init__(self, **kwargs):
        if "id" not in kwargs:
            kwargs["id"] = str(uuid.uuid4())
        super().__init__(**kwargs)
        (VOICES_DIR / self.id / "samples").mkdir(parents=True, exist_ok=True)

    @property
    def voice_dir(self):   return VOICES_DIR / self.id
    @property
    def samples_dir(self): return self.voice_dir / "samples"

    def get_sample_paths(self) -> list[str]:
        exts = {".wav", ".mp3", ".m4a", ".webm", ".ogg", ".flac", ".aac", ".opus"}
        return sorted(
            str(p) for p in self.samples_dir.iterdir()
            if p.suffix.lower() in exts
        )

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "sample_count": self.sample_count,
            "total_duration": round(self.total_duration, 1),
            "source": self.source,
            "ready": self.sample_count > 0,
            "needs_reupload": self.uploaded_sample_count < self.sample_count,
            "created_at": self.created_at.isoformat(),
        }


class VoiceProviderMap(db.Model):
    __tablename__      = "voice_provider_maps"
    id                 = db.Column(db.Integer, primary_key=True)
    voice_id           = db.Column(db.String(36), db.ForeignKey("voices.id"), nullable=False)
    provider           = db.Column(db.String(50), nullable=False)
    provider_voice_id  = db.Column(db.String(500), nullable=False)
    created_at         = db.Column(db.DateTime, default=datetime.utcnow)


# ── Provider helpers ────────────────────────────────────────────────────────────
def _ensure_on_providers(voice: Voice) -> dict[str, str]:
    """
    Upload all samples to every configured provider (or re-upload if samples
    changed since last upload). Returns {provider_name: provider_voice_id}.
    """
    samples = voice.get_sample_paths()
    if not samples:
        return {}

    existing = {m.provider: m.provider_voice_id for m in voice.provider_maps}

    # Skip if already up to date
    if voice.uploaded_sample_count >= voice.sample_count and existing:
        return existing

    new_maps: dict[str, str] = {}
    for provider in rotator.configured:
        # Delete stale voice on provider
        if provider.name in existing:
            try:
                provider.delete_voice(existing[provider.name])
            except Exception:
                pass

        try:
            pid = provider.clone_voice(voice.name, samples)
            new_maps[provider.name] = pid
        except Exception as exc:
            print(f"[{provider.name}] clone failed: {exc}")

    # Persist mappings
    VoiceProviderMap.query.filter_by(voice_id=voice.id).delete()
    for pname, pid in new_maps.items():
        db.session.add(VoiceProviderMap(voice_id=voice.id, provider=pname, provider_voice_id=pid))
    voice.uploaded_sample_count = voice.sample_count
    db.session.commit()

    return new_maps


def _estimate_duration(path: Path) -> float:
    """Rough duration estimate from file size (no ffprobe needed)."""
    size = path.stat().st_size
    # ~16 kB/s for 128kbps MP3; ~32 kB/s for WAV 16-bit mono 22050Hz
    return size / 16_000


# ── Training sentences ──────────────────────────────────────────────────────────
INITIAL_SENTENCES = [
    "The quick brown fox jumps over the lazy dog.",
    "Pack my box with five dozen liquor jugs.",
    "How vexingly quick daft zebras jump.",
    "Sphinx of black quartz, judge my vow.",
    "The five boxing wizards jump quickly.",
    "She sells seashells by the seashore, and the shells she sells are seashells.",
    "Whether the weather is warm or cold, we always have the weather whether we like it or not.",
    "How much wood would a woodchuck chuck if a woodchuck could chuck wood?",
    "Technology has fundamentally changed the way we communicate with each other every day.",
    "The warm summer breeze carried the scent of blooming flowers all through the garden.",
]

EXTENDED_SENTENCES = INITIAL_SENTENCES + [
    "Walking through the forest at dusk, she heard the distant call of an owl.",
    "His deep voice resonated through the empty concert hall on that quiet evening.",
    "The early morning fog crept quietly through the misty mountain valleys below.",
    "Around the rugged rocks the ragged rascal ran as fast as his legs would carry him.",
    "Peter Piper picked a peck of pickled peppers from a bright red pepper pot.",
    "The children laughed and played in the golden light of the long autumn afternoon.",
    "Red lorry, yellow lorry, red lorry, yellow lorry, over and over again.",
    "Standing by the window, she watched the soft rain fall onto the wet cobblestones.",
    "The sound of live music filled every corner of the small mountain village at dusk.",
    "I scream, you scream, we all scream for ice cream on a hot summer day.",
    "The bright blue butterfly landed gently on the outstretched hand of the young child.",
    "Freshly baked bread from the corner bakery smells absolutely wonderful on a cold morning.",
    "The old wooden clock on the mantle ticked slowly through the silent winter night.",
    "Scientists have discovered a remarkable new species deep in the Amazon rainforest.",
    "The library was completely silent except for the soft rustling of turning pages.",
    "Every single morning she would walk along the beach collecting interesting shells and stones.",
    "The mountain trail was steep and rocky but the view from the very top was breathtaking.",
    "Learning a new language requires daily practice, patience, and a great deal of persistence.",
    "The thunderstorm rolled in quickly from the west, bringing a refreshing and cool breeze.",
    "My grandmother makes the most delicious apple pie every single Thanksgiving without fail.",
]


# ── Auth ────────────────────────────────────────────────────────────────────────
@app.route("/api/auth/register", methods=["POST"])
def register():
    data     = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")
    if not username or not password:
        return jsonify({"error": "Username and password are required."}), 400
    if len(username) < 3:
        return jsonify({"error": "Username must be at least 3 characters."}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters."}), 400
    if User.query.filter_by(username=username).first():
        return jsonify({"error": "That username is already taken."}), 409
    user = User(username=username,
                password_hash=bcrypt.generate_password_hash(password).decode())
    db.session.add(user)
    db.session.commit()
    return jsonify({"token": create_access_token(identity=str(user.id)),
                    "username": user.username}), 201


@app.route("/api/auth/login", methods=["POST"])
def login():
    data     = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")
    user     = User.query.filter_by(username=username).first()
    if not user or not bcrypt.check_password_hash(user.password_hash, password):
        return jsonify({"error": "Invalid username or password."}), 401
    return jsonify({"token": create_access_token(identity=str(user.id)),
                    "username": user.username})


# ── Voices ──────────────────────────────────────────────────────────────────────
@app.route("/api/voices", methods=["GET"])
@jwt_required()
def list_voices():
    uid = int(get_jwt_identity())
    return jsonify([v.to_dict() for v in
                    Voice.query.filter_by(user_id=uid)
                               .order_by(Voice.created_at.desc()).all()])


@app.route("/api/voices", methods=["POST"])
@jwt_required()
def create_voice():
    uid  = int(get_jwt_identity())
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Voice name is required."}), 400
    if len(name) > 100:
        return jsonify({"error": "Name too long (max 100 chars)."}), 400
    voice = Voice(user_id=uid, name=name, source=data.get("source", "microphone"))
    db.session.add(voice)
    db.session.commit()
    return jsonify(voice.to_dict()), 201


@app.route("/api/voices/<voice_id>", methods=["DELETE"])
@jwt_required()
def delete_voice(voice_id):
    uid   = int(get_jwt_identity())
    voice = Voice.query.filter_by(id=voice_id, user_id=uid).first_or_404()

    # Remove from all providers
    for m in voice.provider_maps:
        p = rotator.get(m.provider)
        if p:
            try:
                p.delete_voice(m.provider_voice_id)
            except Exception:
                pass

    if voice.voice_dir.exists():
        shutil.rmtree(voice.voice_dir)

    db.session.delete(voice)
    db.session.commit()
    return jsonify({"success": True})


# ── Training sentences ──────────────────────────────────────────────────────────
@app.route("/api/voices/<voice_id>/sentences", methods=["GET"])
@jwt_required()
def get_sentences(voice_id):
    uid  = int(get_jwt_identity())
    Voice.query.filter_by(id=voice_id, user_id=uid).first_or_404()
    mode = request.args.get("mode", "initial")
    if mode == "initial":
        return jsonify({"sentences": INITIAL_SENTENCES})
    pool = EXTENDED_SENTENCES.copy()
    random.shuffle(pool)
    return jsonify({"sentences": pool})


# ── Sample ingestion (microphone) ───────────────────────────────────────────────
@app.route("/api/voices/<voice_id>/samples", methods=["POST"])
@jwt_required()
def add_sample(voice_id):
    uid   = int(get_jwt_identity())
    voice = Voice.query.filter_by(id=voice_id, user_id=uid).first_or_404()

    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided."}), 400

    f    = request.files["audio"]
    ext  = Path(f.filename or "audio.webm").suffix or ".webm"
    dest = voice.samples_dir / f"{uuid.uuid4()}{ext}"
    f.save(dest)

    voice.sample_count   += 1
    voice.total_duration += _estimate_duration(dest)
    voice.updated_at      = datetime.utcnow()
    db.session.commit()

    return jsonify({
        "success": True,
        "sample_count": voice.sample_count,
        "total_duration": round(voice.total_duration, 1),
    })


# ── Sample ingestion (file upload) ──────────────────────────────────────────────
@app.route("/api/voices/<voice_id>/upload", methods=["POST"])
@jwt_required()
def upload_audio(voice_id):
    uid   = int(get_jwt_identity())
    voice = Voice.query.filter_by(id=voice_id, user_id=uid).first_or_404()

    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided."}), 400

    f    = request.files["audio"]
    ext  = Path(f.filename or "audio.mp3").suffix or ".mp3"
    dest = voice.samples_dir / f"{uuid.uuid4()}{ext}"
    f.save(dest)

    voice.sample_count   += 1
    voice.total_duration += _estimate_duration(dest)
    voice.source          = "upload"
    voice.updated_at      = datetime.utcnow()
    db.session.commit()

    return jsonify({
        "success": True,
        "sample_count": voice.sample_count,
        "total_duration": round(voice.total_duration, 1),
    })


# ── Sample ingestion (YouTube) ──────────────────────────────────────────────────
@app.route("/api/voices/<voice_id>/youtube", methods=["POST"])
@jwt_required()
def youtube_audio(voice_id):
    uid   = int(get_jwt_identity())
    voice = Voice.query.filter_by(id=voice_id, user_id=uid).first_or_404()

    url = (request.get_json() or {}).get("url", "").strip()
    if not url or ("youtube.com" not in url and "youtu.be" not in url):
        return jsonify({"error": "Please provide a valid YouTube URL."}), 400

    stem = TEMP_DIR / str(uuid.uuid4())
    try:
        import yt_dlp  # type: ignore
        ydl_opts = {
            "format": "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio",
            "outtmpl": str(stem) + ".%(ext)s",
            "quiet": True,
            "no_warnings": True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
    except Exception as exc:
        return jsonify({"error": f"Download failed: {exc}"}), 500

    downloaded = next(TEMP_DIR.glob(f"{stem.name}.*"), None)
    if not downloaded:
        return jsonify({"error": "Could not retrieve audio from that URL."}), 500

    dest = voice.samples_dir / f"{uuid.uuid4()}{downloaded.suffix}"
    downloaded.rename(dest)

    voice.sample_count   += 1
    voice.total_duration += _estimate_duration(dest)
    voice.source          = "youtube"
    voice.updated_at      = datetime.utcnow()
    db.session.commit()

    return jsonify({
        "success": True,
        "sample_count": voice.sample_count,
        "total_duration": round(voice.total_duration, 1),
    })


# ── Synthesis ───────────────────────────────────────────────────────────────────
@app.route("/api/voices/<voice_id>/synthesize", methods=["POST"])
@jwt_required()
def synthesize(voice_id):
    uid   = int(get_jwt_identity())
    voice = Voice.query.filter_by(id=voice_id, user_id=uid).first_or_404()

    if not voice.sample_count:
        return jsonify({"error": "This voice has no recordings yet."}), 400

    if not rotator.any_configured:
        return jsonify({
            "error": "No API keys configured. "
                     "Add at least one key to your .env file and restart."
        }), 503

    data = request.get_json() or {}
    text = data.get("text", "").strip()
    if not text:
        return jsonify({"error": "Please provide some text to speak."}), 400
    if len(text) > 1500:
        return jsonify({"error": "Text too long (max 1500 characters)."}), 400

    # Upload to providers if needed
    try:
        provider_maps = _ensure_on_providers(voice)
    except Exception as exc:
        return jsonify({"error": f"Voice upload failed: {exc}"}), 500

    if not provider_maps:
        return jsonify({"error": "Voice cloning failed on all providers."}), 500

    # Synthesize with rotation + fallback
    try:
        audio_bytes, mime = rotator.synthesize(provider_maps, text)
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 500

    ext  = "mp3" if "mpeg" in mime else "wav"
    out  = OUTPUT_DIR / f"{uuid.uuid4()}.{ext}"
    out.write_bytes(audio_bytes)

    return send_file(str(out), mimetype=mime,
                     as_attachment=False, download_name=f"speech.{ext}")


# ── Status ──────────────────────────────────────────────────────────────────────
@app.route("/api/status", methods=["GET"])
def status():
    rotator.refresh()
    return jsonify({
        "providers": rotator.names(),
        "any_configured": rotator.any_configured,
    })


# ── SPA ─────────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


# ── Init ────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    app.run(debug=True, host="0.0.0.0", port=5000, threaded=True)
