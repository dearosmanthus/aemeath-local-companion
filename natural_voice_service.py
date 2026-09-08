"""Local Qwen3-TTS service using Ling's one fixed cloned voice."""

from __future__ import annotations

import io
import hashlib
import json
import os
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import torch
from qwen_tts import Qwen3TTSModel


HOST = os.environ.get("LING_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("LING_TTS_PORT", "17861"))
MODEL_PATH = Path(
    os.environ.get(
        "LING_TTS_MODEL",
        r"G:\LocalAI\CyberGirlfriend\Models\speech\Qwen3-TTS-12Hz-0.6B-Base",
    )
)
REFERENCE_PATH = Path(
    os.environ.get(
        "LING_TTS_REFERENCE",
        str(Path(__file__).resolve().parent / "data" / "yujie-reference.wav"),
    )
)
REFERENCE_TEXT = os.environ.get(
    "LING_TTS_REFERENCE_TEXT",
    "晚上好。别急，慢慢说，我一直在听。你可以靠近一点，把今天发生的事都告诉我。",
)
LANGUAGE = os.environ.get("LING_TTS_LANGUAGE", "Chinese")
MAX_TEXT_LENGTH = 220
FIXED_SEED = int(os.environ.get("LING_TTS_SEED", "8122026"))
X_VECTOR_ONLY = os.environ.get("LING_TTS_FULL_REFERENCE", "0") != "1"
CACHE_DIR = Path(__file__).resolve().parent / "data" / "tts-cache"
CACHE_VERSION = "ling-fixed-vector-sdpa-v1"
CACHE_MAX_FILES = 256

generation_lock = threading.Lock()
started_at = time.time()
model: Qwen3TTSModel | None = None
voice_clone_prompt = None
load_error: str | None = None


def wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    values = np.asarray(samples, dtype=np.float32).reshape(-1)
    values = np.nan_to_num(values, nan=0.0, posinf=1.0, neginf=-1.0)
    pcm = (np.clip(values, -1.0, 1.0) * 32767.0).astype("<i2")
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(int(sample_rate))
        wav.writeframes(pcm.tobytes())
    return output.getvalue()


def json_bytes(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def cached_audio_path(text: str, language: str, seed: int) -> Path:
    cache_key = json.dumps(
        [CACHE_VERSION, text, language, seed], ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    return CACHE_DIR / f"{hashlib.sha256(cache_key).hexdigest()}.wav"


def prune_cache() -> None:
    files = sorted(CACHE_DIR.glob("*.wav"), key=lambda item: item.stat().st_mtime, reverse=True)
    for old_file in files[CACHE_MAX_FILES:]:
        old_file.unlink(missing_ok=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "LingNaturalVoice/2.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}", flush=True)

    def reply_json(self, status: int, payload: dict) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def reply_wav(self, body: bytes, generation_ms: int, cache_status: str) -> None:
        self.send_response(200)
        self.send_header("content-type", "audio/wav")
        self.send_header("content-length", str(len(body)))
        self.send_header("x-generation-ms", str(generation_ms))
        self.send_header("x-voice-engine", "Qwen3-TTS-Fixed-Clone")
        self.send_header("x-audio-cache", cache_status)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.reply_json(404, {"error": "not found"})
            return
        self.reply_json(
            200 if model is not None and voice_clone_prompt is not None else 503,
            {
                "ready": model is not None and voice_clone_prompt is not None,
                "engine": "Qwen3-TTS-0.6B-Base-VoiceClone",
                "voice": "绫·固定御姐声",
                "language": LANGUAGE,
                "modelPath": str(MODEL_PATH),
                "referencePath": str(REFERENCE_PATH),
                "cloneMode": "speaker-vector" if X_VECTOR_ONLY else "full-reference",
                "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
                "error": load_error,
                "uptimeSeconds": round(time.time() - started_at, 1),
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/tts":
            self.reply_json(404, {"error": "not found"})
            return
        if model is None or voice_clone_prompt is None:
            self.reply_json(503, {"error": load_error or "model is still loading"})
            return
        try:
            content_length = int(self.headers.get("content-length", "0"))
            if content_length <= 0 or content_length > 64 * 1024:
                raise ValueError("invalid request size")
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            text = str(payload.get("text", "")).strip()
            if not text:
                raise ValueError("text is required")
            if len(text) > MAX_TEXT_LENGTH:
                text = text[:MAX_TEXT_LENGTH]
            language = str(payload.get("language") or LANGUAGE)
            seed = int(payload.get("seed", FIXED_SEED))
            cache_path = cached_audio_path(text, language, seed)
            if cache_path.exists():
                self.reply_wav(cache_path.read_bytes(), 0, "hit")
                return
            print(f"TTS chars={len(text)} voice=ling-fixed-yujie seed={seed}", flush=True)
            generated_at = time.time()
            with generation_lock, torch.inference_mode():
                torch.manual_seed(seed)
                torch.cuda.manual_seed_all(seed)
                wavs, sample_rate = model.generate_voice_clone(
                    text=text,
                    language=language,
                    voice_clone_prompt=voice_clone_prompt,
                    non_streaming_mode=False,
                    do_sample=True,
                    top_k=40,
                    top_p=0.9,
                    temperature=0.75,
                    repetition_penalty=1.08,
                )
            body = wav_bytes(wavs[0], sample_rate)
            cache_path.write_bytes(body)
            prune_cache()
            self.reply_wav(body, round((time.time() - generated_at) * 1000), "miss")
        except Exception as error:  # keep the service alive for the next turn
            traceback.print_exc()
            self.reply_json(500, {"error": str(error)})


def load_model() -> Qwen3TTSModel:
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"voice model is missing: {MODEL_PATH}")
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; the natural voice service needs the NVIDIA GPU")
    if not REFERENCE_PATH.exists():
        raise FileNotFoundError(f"fixed voice reference is missing: {REFERENCE_PATH}")
    print(f"Loading {MODEL_PATH} on {torch.cuda.get_device_name(0)}...", flush=True)
    torch.set_float32_matmul_precision("high")
    torch.backends.cuda.matmul.allow_tf32 = True
    return Qwen3TTSModel.from_pretrained(
        str(MODEL_PATH),
        device_map="cuda:0",
        dtype=torch.bfloat16,
        attn_implementation="sdpa",
    )


if __name__ == "__main__":
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        model = load_model()
        print(f"Locking voice identity to {REFERENCE_PATH}...", flush=True)
        voice_clone_prompt = model.create_voice_clone_prompt(
            ref_audio=str(REFERENCE_PATH),
            ref_text=None if X_VECTOR_ONLY else REFERENCE_TEXT,
            x_vector_only_mode=X_VECTOR_ONLY,
        )
        print(f"Natural voice ready: ling-fixed-yujie / http://{HOST}:{PORT}", flush=True)
    except Exception as error:
        load_error = str(error)
        traceback.print_exc()
        print("Voice service will stay online so /health can report the setup error.", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
