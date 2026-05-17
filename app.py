"""VoiceStudio — voice cloning web application."""

import os
import uuid
import shutil
import subprocess
import threading
import tempfile
from pathlib import Path
from datetime import datetime, timedelta
import random

from flask import Flask, request, jsonify, send_file, render_template
from flask_sqlalchemy import SQLAlchemy
from flask_bcrypt import Bcrypt
from flask_jwt_extended import (
    JWTManager, create_access_token,
    jwt_required, get_jwt_identity,
)

# ── Paths ──────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR  = BASE_DIR / "data"
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
    MAX_CONTENT_LENGTH=500 * 1024 * 1024,
)

db     = SQLAlchemy(app)
bcrypt = Bcrypt(app)
jwt    = JWTManager(app)

# ── TTS engine (lazy loaded) ────────────────────────────────────────────────────
_tts      = None
_tts_lock = threading.Lock()
_tts_ready = False
_tts_error = None

def get_tts():
    global _tts, _tts_ready, _tts_error
    with _tts_lock:
        if _tts is not None:
            return _tts
        if _tts_error:
            return None
        try:
            from TTS.api import TTS  # type: ignore
            _tts = TTS(model_name="tts_models/multilingual/multi-dataset/xtts_v2", gpu=False)
            _tts_ready = True
            print("[TTS] XTTS v2 model loaded.")
        except Exception as exc:
            _tts_error = str(exc)
            print(f"[TTS] Failed to load model: {exc}")
        return _tts

def _preload_tts():
    get_tts()

threading.Thread(target=_preload_tts, daemon=True).start()

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
    __tablename__    = "voices"
    id               = db.Column(db.String(36), primary_key=True)
    user_id          = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    name             = db.Column(db.String(100), nullable=False)
    sample_count     = db.Column(db.Integer, default=0)
    total_duration   = db.Column(db.Float, default=0.0)
    source           = db.Column(db.String(20), default="microphone")
    created_at       = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at       = db.Column(db.DateTime, default=datetime.utcnow)

    def __init__(self, **kwargs):
        if "id" not in kwargs:
            kwargs["id"] = str(uuid.uuid4())
        super().__init__(**kwargs)
        (VOICES_DIR / self.id / "samples").mkdir(parents=True, exist_ok=True)

    @property
    def voice_dir(self):
        return VOICES_DIR / self.id

    @property
    def samples_dir(self):
        return self.voice_dir / "samples"

    @property
    def reference_path(self):
        return self.voice_dir / "reference.wav"

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "sample_count": self.sample_count,
            "total_duration": round(self.total_duration, 1),
            "source": self.source,
            "ready": self.sample_count > 0,
            "created_at": self.created_at.isoformat(),
        }


# ── Utility ─────────────────────────────────────────────────────────────────────
def _ffmpeg_available():
    try:
        r = subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False


def _get_duration(path: Path) -> float:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=10,
        )
        return float(r.stdout.strip() or 0)
    except Exception:
        return 0.0


def _to_wav(src: Path, dst: Path) -> bool:
    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", str(src),
             "-ar", "22050", "-ac", "1", "-c:a", "pcm_s16le", str(dst)],
            capture_output=True, timeout=120,
        )
        return r.returncode == 0
    except Exception:
        return False


def _rebuild_reference(voice: Voice):
    """Concatenate all WAV samples into one reference file via ffmpeg concat."""
    samples = sorted(voice.samples_dir.glob("*.wav"))
    if not samples:
        return
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        for s in samples:
            f.write(f"file '{s}'\n")
        list_file = f.name
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
             "-i", list_file, "-ar", "22050", "-ac", "1",
             "-c:a", "pcm_s16le", str(voice.reference_path)],
            capture_output=True, timeout=120,
        )
    finally:
        os.unlink(list_file)


# ── Training sentences ──────────────────────────────────────────────────────────
INITIAL_SENTENCES = [
    "The quick brown fox jumps over the lazy dog.",
    "Pack my box with five dozen liquor jugs.",
    "How vexingly quick daft zebras jump.",
    "Sphinx of black quartz, judge my vow.",
    "The five boxing wizards jump quickly.",
    "She sells seashells by the seashore, and the shells she sells are seashells.",
    "Whether the weather is warm or cold, we always have the weather.",
    "How much wood would a woodchuck chuck if a woodchuck could chuck wood?",
    "Technology has fundamentally changed the way we communicate with each other.",
    "The warm summer breeze carried the scent of blooming flowers through the garden.",
]

EXTENDED_SENTENCES = INITIAL_SENTENCES + [
    "Walking through the forest, she heard the distant call of an owl.",
    "His deep voice resonated through the empty concert hall on that quiet evening.",
    "The early morning fog crept quietly through the misty mountain valleys.",
    "Around the rugged rocks the ragged rascal ran without stopping.",
    "Peter Piper picked a peck of pickled peppers from a pepper pot.",
    "The children laughed and played in the golden light of the autumn afternoon.",
    "Red lorry, yellow lorry, red lorry, yellow lorry, over and over.",
    "She stood by the window watching the soft rain fall onto the cobblestones.",
    "The sound of music filled every corner of the small mountain village at dusk.",
    "I scream, you scream, we all scream for ice cream on a summer day.",
    "The bright blue butterfly landed gently on the outstretched hand of the child.",
    "Freshly made bread from the corner bakery smells wonderful on a cold morning.",
    "The old wooden clock on the mantle ticked slowly through the quiet night.",
    "Scientists have discovered a new species of bird deep in the Amazon rainforest.",
    "The library was silent except for the soft rustling of turning pages.",
    "Every morning she would walk along the beach collecting interesting shells and stones.",
    "The mountain trail was steep and rocky but the view from the top was breathtaking.",
    "Learning a new language requires daily practice, patience, and a lot of persistence.",
    "The thunderstorm rolled in from the west, bringing with it a refreshing cool breeze.",
    "My grandmother makes the most delicious apple pie every Thanksgiving without fail.",
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

    user = User(
        username=username,
        password_hash=bcrypt.generate_password_hash(password).decode(),
    )
    db.session.add(user)
    db.session.commit()

    token = create_access_token(identity=str(user.id))
    return jsonify({"token": token, "username": user.username}), 201


@app.route("/api/auth/login", methods=["POST"])
def login():
    data     = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")

    user = User.query.filter_by(username=username).first()
    if not user or not bcrypt.check_password_hash(user.password_hash, password):
        return jsonify({"error": "Invalid username or password."}), 401

    token = create_access_token(identity=str(user.id))
    return jsonify({"token": token, "username": user.username})


# ── Voices ──────────────────────────────────────────────────────────────────────
@app.route("/api/voices", methods=["GET"])
@jwt_required()
def list_voices():
    uid    = int(get_jwt_identity())
    voices = (Voice.query.filter_by(user_id=uid)
              .order_by(Voice.created_at.desc()).all())
    return jsonify([v.to_dict() for v in voices])


@app.route("/api/voices", methods=["POST"])
@jwt_required()
def create_voice():
    uid  = int(get_jwt_identity())
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    src  = data.get("source", "microphone")

    if not name:
        return jsonify({"error": "Voice name is required."}), 400
    if len(name) > 100:
        return jsonify({"error": "Name too long (max 100 characters)."}), 400

    voice = Voice(user_id=uid, name=name, source=src)
    db.session.add(voice)
    db.session.commit()
    return jsonify(voice.to_dict()), 201


@app.route("/api/voices/<voice_id>", methods=["DELETE"])
@jwt_required()
def delete_voice(voice_id):
    uid   = int(get_jwt_identity())
    voice = Voice.query.filter_by(id=voice_id, user_id=uid).first_or_404()

    if voice.voice_dir.exists():
        shutil.rmtree(voice.voice_dir)

    db.session.delete(voice)
    db.session.commit()
    return jsonify({"success": True})


# ── Training ────────────────────────────────────────────────────────────────────
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


@app.route("/api/voices/<voice_id>/samples", methods=["POST"])
@jwt_required()
def add_sample(voice_id):
    uid   = int(get_jwt_identity())
    voice = Voice.query.filter_by(id=voice_id, user_id=uid).first_or_404()

    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided."}), 400

    audio_file = request.files["audio"]
    sid        = str(uuid.uuid4())
    ext        = Path(audio_file.filename or "audio.webm").suffix or ".webm"
    raw_path   = voice.samples_dir / f"{sid}{ext}"
    audio_file.save(raw_path)

    wav_path = voice.samples_dir / f"{sid}.wav"
    if _to_wav(raw_path, wav_path):
        raw_path.unlink(missing_ok=True)
    else:
        wav_path = raw_path  # use as-is

    duration = _get_duration(wav_path)

    voice.sample_count   += 1
    voice.total_duration += duration
    voice.updated_at      = datetime.utcnow()
    db.session.commit()

    _rebuild_reference(voice)
    return jsonify({
        "success": True,
        "sample_count": voice.sample_count,
        "total_duration": round(voice.total_duration, 1),
    })


@app.route("/api/voices/<voice_id>/upload", methods=["POST"])
@jwt_required()
def upload_audio(voice_id):
    uid   = int(get_jwt_identity())
    voice = Voice.query.filter_by(id=voice_id, user_id=uid).first_or_404()

    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided."}), 400

    audio_file = request.files["audio"]
    ext        = Path(audio_file.filename or "audio").suffix or ".mp3"
    temp_path  = TEMP_DIR / f"{uuid.uuid4()}{ext}"
    audio_file.save(temp_path)

    wav_path = voice.samples_dir / f"{uuid.uuid4()}.wav"
    if not _to_wav(temp_path, wav_path):
        temp_path.rename(wav_path)
    else:
        temp_path.unlink(missing_ok=True)

    duration = _get_duration(wav_path)

    voice.sample_count   += 1
    voice.total_duration += duration
    voice.source          = "upload"
    voice.updated_at      = datetime.utcnow()
    db.session.commit()
    _rebuild_reference(voice)

    return jsonify({
        "success": True,
        "sample_count": voice.sample_count,
        "total_duration": round(voice.total_duration, 1),
    })


@app.route("/api/voices/<voice_id>/youtube", methods=["POST"])
@jwt_required()
def youtube_audio(voice_id):
    uid   = int(get_jwt_identity())
    voice = Voice.query.filter_by(id=voice_id, user_id=uid).first_or_404()

    data = request.get_json() or {}
    url  = data.get("url", "").strip()

    if not url or ("youtube.com" not in url and "youtu.be" not in url):
        return jsonify({"error": "Please provide a valid YouTube URL."}), 400

    out_stem = TEMP_DIR / str(uuid.uuid4())

    try:
        import yt_dlp  # type: ignore
        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": str(out_stem) + ".%(ext)s",
            "quiet": True,
            "no_warnings": True,
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "wav",
                "preferredquality": "192",
            }],
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
    except Exception as exc:
        return jsonify({"error": f"Download failed: {exc}"}), 500

    downloaded = next(TEMP_DIR.glob(f"{out_stem.name}.wav"), None)
    if not downloaded:
        downloaded = next(TEMP_DIR.glob(f"{out_stem.name}.*"), None)

    if not downloaded:
        return jsonify({"error": "Could not retrieve audio from that URL."}), 500

    wav_path = voice.samples_dir / f"{uuid.uuid4()}.wav"
    if not _to_wav(downloaded, wav_path):
        downloaded.rename(wav_path)
    else:
        downloaded.unlink(missing_ok=True)

    duration = _get_duration(wav_path)

    voice.sample_count   += 1
    voice.total_duration += duration
    voice.source          = "youtube"
    voice.updated_at      = datetime.utcnow()
    db.session.commit()
    _rebuild_reference(voice)

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

    if not voice.reference_path.exists():
        return jsonify({"error": "This voice has no recordings yet."}), 400

    data = request.get_json() or {}
    text = data.get("text", "").strip()

    if not text:
        return jsonify({"error": "Please provide some text to speak."}), 400
    if len(text) > 1500:
        return jsonify({"error": "Text too long (max 1500 characters)."}), 400

    tts = get_tts()
    if tts is None:
        return jsonify({
            "error": "TTS engine not available. "
                     "Run: pip install TTS  then restart the server."
        }), 503

    output_path = OUTPUT_DIR / f"{uuid.uuid4()}.wav"
    try:
        tts.tts_to_file(
            text=text,
            speaker_wav=str(voice.reference_path),
            language="en",
            file_path=str(output_path),
        )
    except Exception as exc:
        return jsonify({"error": f"Synthesis failed: {exc}"}), 500

    if not output_path.exists():
        return jsonify({"error": "Synthesis produced no output."}), 500

    return send_file(str(output_path), mimetype="audio/wav",
                     as_attachment=False, download_name="speech.wav")


# ── Status ──────────────────────────────────────────────────────────────────────
@app.route("/api/status", methods=["GET"])
def status():
    return jsonify({
        "tts_ready": _tts is not None,
        "tts_error": _tts_error,
        "ffmpeg": _ffmpeg_available(),
    })


# ── Static / SPA ────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


# ── Init ────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    app.run(debug=True, host="0.0.0.0", port=5000, threaded=True)
