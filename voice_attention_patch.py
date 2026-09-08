"""Conservative eager-only KV views for the installed VoxCPM2 implementation.

The original storage, attention code, masks, precision and diffusion steps stay
unchanged. This only hides unfilled future positions from each attention call.
Unknown implementations retain their original behavior.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import inspect
import textwrap
from types import MethodType


_ORIGINAL = "_aemeath_original_get_layer_cache"
_EXPECTED_VERSION = "2.0.3"
# Pin the exact cache/attention/caller contract, including step-before-read and
# masks derived from key_cache.size(2). A package edit disables this patch.
_SOURCE_DIGESTS = {
    "cache_get": "1ff9aa3ec5a79309efd506ee04803e03a288fc3e349df785d19e937dca361296",
    "cache_step": "92ca2b64fddb1c7a9eef7c8e99e8dbfe90138d0c3bd353cb65bc1f1738aa0638",
    "attention_step": "828840c3515267a3b164bbb1d25dd316992542925a74e1f8d8af2202c4c02bac",
    "model_step": "b3cccfb8cd455c7d5122a7180881bc16ef183b63e604be4b22da266d74597fe4",
    "inference": "aab84a2c4075f28f9478b958a4792cf9673ee40c2d39fba6e1451990ad6d3bcf",
}


def _source_digest(method) -> str:
    source = textwrap.dedent(inspect.getsource(method)).strip().replace("\r", "")
    return hashlib.sha256(source.encode()).hexdigest()


def restore_eager_kv_cache_patch(model) -> int:
    restored = 0
    for name in ("base_lm", "residual_lm"):
        cache = getattr(getattr(model, name, None), "kv_cache", None)
        original = getattr(cache, _ORIGINAL, None)
        if original is not None:
            cache.get_layer_cache = original
            delattr(cache, _ORIGINAL)
            restored += 1
    return restored


def _install_cache_view(cache, torch) -> None:
    if hasattr(cache, _ORIGINAL):
        return
    original = cache.get_layer_cache

    def get_filled_layer_cache(self, layer_idx):
        full_key, full_value = original(layer_idx)
        try:
            length = self.current_length
            # step() already advanced this Python integer to include the new
            # write position. Never read the CUDA position tensor on the CPU.
            if torch.compiler.is_compiling() or type(length) is not int:
                return full_key, full_value
            if not 0 < length < self.max_length:
                return full_key, full_value
            return full_key[..., :length, :], full_value[..., :length, :]
        except Exception:
            # If the guarded view operation ever becomes unavailable, restore
            # this instance and let the original implementation keep running.
            self.get_layer_cache = original
            if hasattr(self, _ORIGINAL):
                delattr(self, _ORIGINAL)
            return full_key, full_value

    setattr(cache, _ORIGINAL, original)
    cache.get_layer_cache = MethodType(get_filled_layer_cache, cache)


def apply_eager_kv_cache_patch(model) -> dict:
    """Patch only two model-owned caches, or return a non-sensitive skip reason."""
    def skip(reason):
        restore_eager_kv_cache_patch(model)
        return {"enabled": False, "reason": reason}

    try:
        if importlib.metadata.version("voxcpm") != _EXPECTED_VERSION:
            return skip("package-version")
        import torch
        from voxcpm.model.voxcpm2 import VoxCPM2Model
        from voxcpm.modules.minicpm4.cache import StaticKVCache
        from voxcpm.modules.minicpm4.model import MiniCPMAttention, MiniCPMModel

        methods = {
            "cache_get": StaticKVCache.get_layer_cache,
            "cache_step": StaticKVCache.step,
            "attention_step": MiniCPMAttention.forward_step,
            "model_step": MiniCPMModel.forward_step,
            "inference": VoxCPM2Model._inference,
        }
        if any(_source_digest(method) != _SOURCE_DIGESTS[name] for name, method in methods.items()):
            return skip("implementation-changed")
        caches = []
        for name in ("base_lm", "residual_lm"):
            lm = getattr(model, name, None)
            cache = getattr(lm, "kv_cache", None)
            if type(lm) is not MiniCPMModel or type(cache) is not StaticKVCache:
                return skip("cache-interface")
            if hasattr(lm, "_orig_mod") or getattr(lm.forward_step, "__func__", None) is not MiniCPMModel.forward_step:
                return skip("compiled-or-replaced-forward")
            original = getattr(cache, _ORIGINAL, cache.get_layer_cache)
            if getattr(original, "__func__", None) is not StaticKVCache.get_layer_cache:
                return skip("replaced-cache-method")
            storage = cache.kv_cache
            if not isinstance(storage, torch.Tensor) or storage.ndim != 6 or storage.shape[0] != 2:
                return skip("cache-shape")
            if storage.shape[1] != cache.num_layers or storage.shape[-2] != cache.max_length or type(cache.current_length) is not int:
                return skip("cache-capacity")
            caches.append(cache)
        for cache in caches:
            _install_cache_view(cache, torch)
        return {"enabled": True, "patchedCaches": len(caches), "reason": "filled-kv-views"}
    except Exception:
        return skip("guard-unavailable")
