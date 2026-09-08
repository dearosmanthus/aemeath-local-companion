"""Local streaming VoxCPM2 service for Ling's fixed Mandarin yujie voice."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import torch
from voxcpm import VoxCPM


ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("LING_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("LING_TTS_PORT", "17861"))
MODEL_PATH = Path(
    os.environ.get(
        "LING_TTS_MODEL",
        r"G:\LocalAI\CyberGirlfriend\Models\speech\VoxCPM2",
    )
)
REFERENCE_PATH = Path(
    os.environ.get(
        "LING_TTS_REFERENCE",
        str(ROOT / "data" / "voxcpm2-tests" / "ling-voxcpm2-reference.wav"),
    )
)
REFERENCE_TEXT = os.environ.get(
    "LING_TTS_REFERENCE_TEXT",
    "因为和学院里的大家关系都还不错，我经常会去给他们的社团帮忙，也算是时常都在体验不同方向的爱好了。非要说的话。",
)
FIXED_SEED = int(os.environ.get("LING_TTS_SEED", "8122026"))
CFG_VALUE = float(os.environ.get("LING_TTS_CFG", "2.0"))
INFERENCE_STEPS = int(os.environ.get("LING_TTS_STEPS", "10"))
MAX_TEXT_LENGTH = 240
CACHE_DIR = ROOT / "data" / "voxcpm2-cache"
CACHE_MAX_FILES = 320
CACHE_VERSION = "ling-voxcpm2-natural-pauses-v2"

generation_lock = threading.Lock()
started_at = time.time()
model: VoxCPM | None = None
prompt_cache = None
load_error: str | None = None
attention_optimization = {"enabled": False, "reason": "not-loaded"}


def json_bytes(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def float_to_pcm(samples: np.ndarray) -> bytes:
    values = np.asarray(samples, dtype=np.float32).reshape(-1)
    values = np.nan_to_num(values, nan=0.0, posinf=1.0, neginf=-1.0)
    return (np.clip(values, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(int(sample_rate))
        wav.writeframes(float_to_pcm(samples))
    return output.getvalue()


def wav_pcm(body: bytes) -> tuple[bytes, int]:
    with wave.open(io.BytesIO(body), "rb") as wav:
        return wav.readframes(wav.getnframes()), wav.getframerate()


def cache_path(text: str, seed: int) -> Path:
    reference_version = REFERENCE_PATH.stat().st_mtime_ns if REFERENCE_PATH.exists() else 0
    key = json.dumps(
        [CACHE_VERSION, text, seed, CFG_VALUE, INFERENCE_STEPS, reference_version],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return CACHE_DIR / f"{hashlib.sha256(key).hexdigest()}.wav"


def prune_cache() -> None:
    files = sorted(CACHE_DIR.glob("*.wav"), key=lambda item: item.stat().st_mtime, reverse=True)
    for old_file in files[CACHE_MAX_FILES:]:
        old_file.unlink(missing_ok=True)


def generate_stream(text: str, seed: int):
    if model is None or prompt_cache is None:
        raise RuntimeError(load_error or "VoxCPM2 is not ready")
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    result = model.tts_model._generate_with_prompt_cache(
        target_text=text,
        prompt_cache=prompt_cache,
        cfg_value=CFG_VALUE,
        inference_timesteps=INFERENCE_STEPS,
        retry_badcase=False,
        streaming=True,
    )
    try:
        for wav, _, _ in result:
            yield wav.squeeze(0).cpu().numpy()
    finally:
        result.close()


def speech_segments(text: str) -> list[tuple[str, float]]:
    parts = re.findall(r"[^，。！？；、,.!?;…]+[，。！？；、,.!?;…]*", text.strip())
    if not parts:
        return [(text.strip(), 0.0)]
    segments: list[tuple[str, float]] = []
    for part in parts:
        value = part.strip()
        if not value:
            continue
        ending = re.search(r"[，。！？；、,.!?;…]+$", value)
        marks = ending.group(0) if ending else ""
        if "…" in marks:
            pause = 0.52
        elif any(mark in marks for mark in "。！？.!?"):
            pause = 0.34
        elif any(mark in marks for mark in "，；、,;"):
            pause = 0.22
        else:
            pause = 0.12 if len(parts) > 1 else 0.0
        segments.append((value, pause))
    if segments:
        segments[-1] = (segments[-1][0], 0.0)
    return segments


def generate_natural_stream(text: str, seed: int):
    sample_rate = int(model.tts_model.sample_rate)
    for index, (segment, pause_seconds) in enumerate(speech_segments(text)):
        yield from generate_stream(segment, seed + index * 17)
        if pause_seconds > 0:
            yield np.zeros(round(sample_rate * pause_seconds), dtype=np.float32)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "AemeathVoxCPM2/1.0"

    def log_message(self, fmt: str, *args) -> None:
        try:
            print(f"[{self.log_date_time_string()}] {fmt % args}", flush=True)
        except (BrokenPipeError, OSError):
            pass

    def reply_json(self, status: int, payload: dict) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def parse_request_payload(self) -> tuple[str, int]:
        content_length = int(self.headers.get("content-length", "0"))
        if content_length <= 0 or content_length > 64 * 1024:
            raise ValueError("invalid request size")
        payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        text = str(payload.get("text", "")).strip()
        if not text:
            raise ValueError("text is required")
        return text[:MAX_TEXT_LENGTH], int(payload.get("seed", FIXED_SEED))

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.reply_json(404, {"error": "not found"})
            return
        ready = model is not None and prompt_cache is not None
        self.reply_json(
            200 if ready else 503,
            {
                "ready": ready,
                "engine": "VoxCPM2-Ultimate-Clone",
                "voice": "爱弥斯 · 授权原创本地声线",
                "model": "VoxCPM2-2B",
                "modelPath": str(MODEL_PATH),
                "referencePath": str(REFERENCE_PATH),
                "cloneMode": "ultimate-clone",
                "streaming": True,
                "sampleRate": 48000,
                "attentionOptimization": attention_optimization,
                "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
                "error": load_error,
                "uptimeSeconds": round(time.time() - started_at, 1),
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in {"/tts", "/tts-stream"}:
            self.reply_json(404, {"error": "not found"})
            return
        if model is None:
            self.reply_json(503, {"error": load_error or "VoxCPM2 is still loading"})
            return
        try:
            text, seed = self.parse_request_payload()
        except Exception as error:
            self.reply_json(400, {"error": str(error)})
            return

        cached = cache_path(text, seed)
        if self.path == "/tts-stream":
            self.stream_tts(text, seed, cached)
        else:
            self.complete_tts(text, seed, cached)

    def complete_tts(self, text: str, seed: int, cached: Path) -> None:
        try:
            started = time.perf_counter()
            if cached.exists():
                body = cached.read_bytes()
                cache_status = "hit"
            else:
                with generation_lock, torch.inference_mode():
                    samples = np.concatenate(list(generate_natural_stream(text, seed)))
                body = wav_bytes(samples, model.tts_model.sample_rate)
                cached.write_bytes(body)
                prune_cache()
                cache_status = "miss"
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(body)))
            self.send_header("x-generation-ms", str(round((time.perf_counter() - started) * 1000)))
            self.send_header("x-voice-engine", "VoxCPM2-Ultimate-Clone")
            self.send_header("x-audio-cache", cache_status)
            self.end_headers()
            self.wfile.write(body)
        except Exception as error:
            traceback.print_exc()
            self.reply_json(500, {"error": str(error)})

    def stream_tts(self, text: str, seed: int, cached: Path) -> None:
        self.send_response(200)
        self.send_header("content-type", "audio/L16; rate=48000; channels=1")
        self.send_header("x-sample-rate", "48000")
        self.send_header("x-voice-engine", "VoxCPM2-Ultimate-Clone")
        self.send_header("x-audio-format", "pcm_s16le")
        self.send_header("connection", "close")
        self.end_headers()
        self.close_connection = True
        started = time.perf_counter()
        first_chunk_ms = None
        try:
            if cached.exists():
                pcm, sample_rate = wav_pcm(cached.read_bytes())
                if sample_rate != 48000:
                    raise RuntimeError(f"unexpected cached sample rate: {sample_rate}")
                for offset in range(0, len(pcm), 24000):
                    self.wfile.write(pcm[offset : offset + 24000])
                    self.wfile.flush()
                first_chunk_ms = 0
                cache_status = "hit"
            else:
                chunks = []
                with generation_lock, torch.inference_mode():
                    for chunk in generate_natural_stream(text, seed):
                        if first_chunk_ms is None:
                            first_chunk_ms = round((time.perf_counter() - started) * 1000)
                        chunks.append(chunk)
                        self.wfile.write(float_to_pcm(chunk))
                        self.wfile.flush()
                samples = np.concatenate(chunks)
                cached.write_bytes(wav_bytes(samples, model.tts_model.sample_rate))
                prune_cache()
                cache_status = "miss"
            print(
                f"stream chars={len(text)} first={first_chunk_ms}ms total={round((time.perf_counter() - started) * 1000)}ms cache={cache_status}",
                flush=True,
            )
        except (BrokenPipeError, ConnectionResetError):
            print("stream client disconnected", flush=True)
        except Exception:
            traceback.print_exc()


def load_model() -> VoxCPM:
    global attention_optimization
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"VoxCPM2 model is missing: {MODEL_PATH}")
    if not REFERENCE_PATH.exists():
        raise FileNotFoundError(f"fixed voice reference is missing: {REFERENCE_PATH}")
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; VoxCPM2 needs the NVIDIA GPU")
    torch.set_float32_matmul_precision("high")
    torch.backends.cuda.matmul.allow_tf32 = True
    print(f"Loading VoxCPM2 on {torch.cuda.get_device_name(0)}...", flush=True)
    loaded = VoxCPM.from_pretrained(
        str(MODEL_PATH),
        load_denoiser=False,
        local_files_only=True,
        optimize=False,
        device="cuda:0",
    )
    # Keep eager attention on filled KV positions only; unknown package builds
    # retain their original implementation. This does not change the voice.
    try:
        from voice_attention_patch import apply_eager_kv_cache_patch
        attention_optimization = apply_eager_kv_cache_patch(loaded.tts_model)
        print(f"Voice attention optimization: {attention_optimization['reason']}", flush=True)
    except Exception:
        attention_optimization = {"enabled": False, "reason": "unavailable"}
        print("Voice attention optimization: unavailable; using original", flush=True)
    return loaded


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address) -> None:
        error = __import__("sys").exc_info()[1]
        if isinstance(error, (BrokenPipeError, ConnectionResetError)):
            return
        traceback.print_exc()


if __name__ == "__main__":
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        model = load_model()
        print(f"Building fixed ultimate-clone prompt cache from {REFERENCE_PATH}...", flush=True)
        prompt_cache = model.tts_model.build_prompt_cache(
            prompt_text=REFERENCE_TEXT,
            prompt_wav_path=str(REFERENCE_PATH),
            reference_wav_path=str(REFERENCE_PATH),
        )
        print(f"VoxCPM2 streaming voice ready: http://{HOST}:{PORT}", flush=True)
    except Exception as error:
        load_error = str(error)
        traceback.print_exc()
        print("Voice service remains online so /health can report the error.", flush=True)
    QuietThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
