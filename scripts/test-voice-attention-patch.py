"""Synthetic attention verification; no TTS weights, audio or network access."""

from __future__ import annotations

import copy
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest import mock

import torch
from voxcpm.modules.minicpm4.config import MiniCPM4Config
from voxcpm.modules.minicpm4.model import MiniCPMModel

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import voice_attention_patch as patch


def tiny_model(device="cpu", dtype=torch.float32):
    cfg = MiniCPM4Config(
        bos_token_id=1, eos_token_id=2, hidden_size=64, intermediate_size=128,
        max_position_embeddings=8192, num_attention_heads=4, num_hidden_layers=2,
        num_key_value_heads=2, rms_norm_eps=1e-5, vocab_size=0, use_mup=False,
        scale_emb=1, dim_model_base=64, scale_depth=1, rope_theta=10000,
        no_rope=True, kv_channels=16,
        rope_scaling={"type": "longrope", "long_factor": [1] * 8,
                      "short_factor": [1] * 8, "original_max_position_embeddings": 8192},
    )
    model = MiniCPMModel(cfg).to(device=device, dtype=dtype).eval()
    model.setup_cache(1, 8192, device, dtype)
    return model


def package_pair(base):
    return SimpleNamespace(base_lm=base, residual_lm=copy.deepcopy(base))


@torch.inference_mode()
def cpu_checks():
    torch.manual_seed(1973)
    torch.set_num_threads(1)
    original = tiny_model()
    package = package_pair(copy.deepcopy(original))
    assert patch.apply_eager_kv_cache_patch(package)["enabled"]
    assert patch.apply_eager_kv_cache_patch(package)["patchedCaches"] == 2
    changed = package.base_lm
    max_error = 0.0
    for filled in (4, 128, 1024, 8191):
        storage = torch.randn_like(original.kv_cache.kv_cache)
        original.kv_cache.kv_cache.copy_(storage)
        changed.kv_cache.kv_cache.copy_(storage)
        original.kv_cache.current_length = changed.kv_cache.current_length = filled
        for _ in range(min(3, 8192 - filled)):
            position = original.kv_cache.step()
            assert position == changed.kv_cache.step()
            assert changed.kv_cache.get_layer_cache(0)[0].shape[2] == position + 1
            inputs = torch.randn(1, 64)
            positions = torch.tensor([position])
            expected = original.forward_step(inputs, positions)
            actual = changed.forward_step(inputs, positions)
            torch.testing.assert_close(actual, expected, atol=2e-6, rtol=2e-5)
            max_error = max(max_error, float((actual - expected).abs().max()))
            torch.testing.assert_close(changed.kv_cache.kv_cache, original.kv_cache.kv_cache, atol=2e-6, rtol=2e-5)
        # Future cache positions must stay untouched; the slice is a storage
        # view, so the active write must reach the original full allocation.
        end = changed.kv_cache.current_length
        torch.testing.assert_close(changed.kv_cache.kv_cache[..., end:, :], storage[..., end:, :], atol=0, rtol=0)

    # Original cache prefill/reset protocol still applies to both instances.
    cache = changed.kv_cache
    prefill = [(torch.randn(1, 2, 7, 16), torch.randn(1, 2, 7, 16)) for _ in range(2)]
    cache.fill_caches(prefill)
    assert cache.current_length == 7
    torch.testing.assert_close(cache.get_layer_cache(0)[0], prefill[0][0])
    cache.current_length = 0
    assert cache.get_layer_cache(0)[0].shape[2] == 8192
    cache.current_length = 8192
    assert cache.get_layer_cache(0)[0].shape[2] == 8192
    try:
        cache.step()
        raise AssertionError("full cache must still reject a new step")
    except ValueError:
        pass
    assert patch.restore_eager_kv_cache_patch(package) == 2
    assert patch.restore_eager_kv_cache_patch(package) == 0

    # Unknown versions/code or a compiled/replaced forward never enable it.
    with mock.patch.object(patch.importlib.metadata, "version", return_value="unknown"):
        assert not patch.apply_eager_kv_cache_patch(package)["enabled"]
    with mock.patch.object(patch, "_source_digest", return_value="unknown"):
        assert not patch.apply_eager_kv_cache_patch(package)["enabled"]
    assert patch.apply_eager_kv_cache_patch(package)["enabled"]
    with mock.patch.object(patch, "_source_digest", return_value="unknown"):
        assert not patch.apply_eager_kv_cache_patch(package)["enabled"]
    assert not hasattr(package.base_lm.kv_cache, patch._ORIGINAL)
    assert not hasattr(package.residual_lm.kv_cache, patch._ORIGINAL)
    forward = package.base_lm.forward_step
    package.base_lm.forward_step = lambda *args: forward(*args)
    assert not patch.apply_eager_kv_cache_patch(package)["enabled"]
    package.base_lm.forward_step = forward
    # Runtime view failure restores the original bound method for this cache.
    assert patch.apply_eager_kv_cache_patch(package)["enabled"]
    cache.current_length = 8
    with mock.patch.object(torch.compiler, "is_compiling", side_effect=RuntimeError("test")):
        assert cache.get_layer_cache(0)[0].shape[2] == 8192
    assert not hasattr(cache, patch._ORIGINAL)
    patch.restore_eager_kv_cache_patch(package)
    return {"cpuMaxAbsError": max_error, "cpuCasesPassed": True}


@torch.inference_mode()
def cuda_comparison():
    if not torch.cuda.is_available():
        return {"cuda": "unavailable"}
    torch.manual_seed(1973)
    original = tiny_model("cuda", torch.bfloat16)
    package = package_pair(copy.deepcopy(original))
    assert patch.apply_eager_kv_cache_patch(package)["enabled"]
    changed = package.base_lm
    storage = torch.randn_like(original.kv_cache.kv_cache)
    original.kv_cache.kv_cache.copy_(storage)
    changed.kv_cache.kv_cache.copy_(storage)
    original.kv_cache.current_length = changed.kv_cache.current_length = 256
    positions = torch.tensor([255], device="cuda")
    inputs = torch.randn(1, 64, device="cuda", dtype=torch.bfloat16)
    expected = original.forward_step(inputs, positions)
    actual = changed.forward_step(inputs, positions)
    torch.testing.assert_close(actual, expected, atol=.008, rtol=.02)

    def elapsed(model):
        for _ in range(5):
            model.forward_step(inputs, positions)
        torch.cuda.synchronize()
        start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
        start.record()
        for _ in range(30):
            model.forward_step(inputs, positions)
        end.record()
        end.synchronize()
        return start.elapsed_time(end) / 30

    full_ms = elapsed(original)
    filled_ms = elapsed(changed)
    return {"cuda": "synthetic-two-layer-forward", "dtype": "bfloat16",
            "fullKVLength": 8192, "filledKVLength": 256,
            "fullStepMs": round(full_ms, 4), "filledStepMs": round(filled_ms, 4),
            "speedup": round(full_ms / filled_ms, 3),
            "cudaMaxAbsError": float((actual - expected).abs().max())}


if __name__ == "__main__":
    print(json.dumps({"cpu": cpu_checks(), "cuda": cuda_comparison()}))
