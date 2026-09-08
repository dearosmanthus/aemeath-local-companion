"""Generate and benchmark a fixed Mandarin yujie voice with VoxCPM2."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import soundfile as sf
import torch
from voxcpm import VoxCPM


ROOT = Path(__file__).resolve().parent
MODEL_PATH = Path(
    os.environ.get(
        "LING_VOXCPM_MODEL",
        r"G:\LocalAI\CyberGirlfriend\Models\speech\VoxCPM2",
    )
)
OUTPUT_DIR = ROOT / "data" / "voxcpm2-tests"
REFERENCE_TEXT = "晚上好。别急，慢慢说，我一直在听。你可以靠近一点，把今天发生的事都告诉我。"
VOICE_DESCRIPTION = (
    "三十岁成熟女性，标准普通话，没有方言口音，中低音，磁性自然，御姐气质，"
    "从容温柔，略带微笑和亲密感，真实人类说话，呼吸自然，不夹嗓，不播音腔"
)


def save_generation(model: VoxCPM, name: str, text: str, **kwargs) -> dict:
    started = time.perf_counter()
    first_chunk_at = None
    chunks = []
    for chunk in model.generate_streaming(text=text, **kwargs):
        if first_chunk_at is None:
            first_chunk_at = time.perf_counter()
        chunks.append(chunk)
    completed = time.perf_counter()
    wav = __import__("numpy").concatenate(chunks)
    output_path = OUTPUT_DIR / name
    sf.write(output_path, wav, model.tts_model.sample_rate, subtype="PCM_16")
    duration = len(wav) / model.tts_model.sample_rate
    return {
        "file": str(output_path),
        "audioSeconds": round(duration, 3),
        "firstChunkMs": round((first_chunk_at - started) * 1000),
        "totalMs": round((completed - started) * 1000),
        "rtf": round((completed - started) / duration, 3),
        "chunks": len(chunks),
    }


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(8122026)
    torch.cuda.manual_seed_all(8122026)
    loaded_at = time.perf_counter()
    model = VoxCPM.from_pretrained(
        str(MODEL_PATH),
        load_denoiser=False,
        local_files_only=True,
        optimize=False,
        device="cuda:0",
    )
    load_seconds = time.perf_counter() - loaded_at

    reference_path = OUTPUT_DIR / "ling-voxcpm2-reference.wav"
    reference = save_generation(
        model,
        reference_path.name,
        f"({VOICE_DESCRIPTION}){REFERENCE_TEXT}",
        cfg_value=2.2,
        inference_timesteps=10,
        normalize=False,
        retry_badcase=True,
    )

    torch.manual_seed(8122026)
    torch.cuda.manual_seed_all(8122026)
    clone = save_generation(
        model,
        "ling-voxcpm2-ultimate-clone.wav",
        "你终于回来了。过来坐好，让我听听你今天都经历了什么。",
        prompt_wav_path=str(reference_path),
        prompt_text=REFERENCE_TEXT,
        reference_wav_path=str(reference_path),
        cfg_value=2.0,
        inference_timesteps=10,
        normalize=False,
        retry_badcase=True,
    )

    print(
        json.dumps(
            {
                "modelLoadSeconds": round(load_seconds, 3),
                "gpuAllocatedGB": round(torch.cuda.memory_allocated() / 2**30, 3),
                "reference": reference,
                "ultimateClone": clone,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
