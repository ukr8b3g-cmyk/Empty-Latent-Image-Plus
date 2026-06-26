import json
import os
from pathlib import Path

import torch

try:
    from server import PromptServer
    from aiohttp import web
except Exception:  # pragma: no cover
    PromptServer = None
    web = None

NODE_DIR = Path(__file__).resolve().parent
PRESETS_PATH = NODE_DIR / "presets.json"
MAX_RESOLUTION = 16384


def _safe_int(value, default, min_value, max_value):
    try:
        value = int(value)
    except Exception:
        value = default
    return max(min_value, min(max_value, value))


def _round_to_step(value, step=8):
    value = _safe_int(value, 512, 16, MAX_RESOLUTION)
    step = _safe_int(step, 8, 1, 1024)
    return max(16, min(MAX_RESOLUTION, int(round(value / step) * step)))


def _load_presets():
    if not PRESETS_PATH.exists():
        PRESETS_PATH.write_text("{}\n", encoding="utf-8")
    try:
        raw = json.loads(PRESETS_PATH.read_text(encoding="utf-8"))
    except Exception:
        raw = {}
    if not isinstance(raw, dict):
        return {}

    presets = {}
    for name, item in raw.items():
        if not isinstance(name, str) or not isinstance(item, dict):
            continue
        clean_name = name.strip()
        if not clean_name:
            continue
        presets[clean_name] = {
            "width": _round_to_step(item.get("width"), 8),
            "height": _round_to_step(item.get("height"), 8),
            "batch_size": _safe_int(item.get("batch_size"), 1, 1, 4096),
        }
    return presets


def _save_presets(presets):
    PRESETS_PATH.write_text(
        json.dumps(presets, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


class EmptyLatentImagePlus:
    """Core Empty Latent Image-compatible node plus WIDTH/HEIGHT INT outputs.

    Frontend-only controls implemented in web/js:
    - swap W/H toggle
    - foldable User Preset section
    - foldable Advanced section
    - preset Save / Load / Delete against presets.json through HTTP routes
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 512, "min": 16, "max": MAX_RESOLUTION, "step": 8}),
                "height": ("INT", {"default": 512, "min": 16, "max": MAX_RESOLUTION, "step": 8}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096, "step": 1}),
            }
        }

    RETURN_TYPES = ("LATENT", "INT", "INT")
    RETURN_NAMES = ("LATENT", "WIDTH", "HEIGHT")
    FUNCTION = "generate"
    CATEGORY = "latent/plus"

    def generate(self, width, height, batch_size=1):
        width = _safe_int(width, 512, 16, MAX_RESOLUTION)
        height = _safe_int(height, 512, 16, MAX_RESOLUTION)
        batch_size = _safe_int(batch_size, 1, 1, 4096)
        latent = torch.zeros([batch_size, 4, height // 8, width // 8])
        return ({"samples": latent}, width, height)


NODE_CLASS_MAPPINGS = {
    "EmptyLatentImagePlus": EmptyLatentImagePlus,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "EmptyLatentImagePlus": "Empty Latent Image Plus",
}


if PromptServer is not None and web is not None:
    @PromptServer.instance.routes.get("/empty_latent_image_plus/presets")
    async def empty_latent_image_plus_get_presets(request):
        return web.json_response(_load_presets())

    @PromptServer.instance.routes.post("/empty_latent_image_plus/presets/save")
    async def empty_latent_image_plus_save_preset(request):
        body = await request.json()
        name = str(body.get("name", "")).strip()
        if not name:
            return web.json_response({"ok": False, "error": "Preset name is required"}, status=400)

        presets = _load_presets()
        presets[name] = {
            "width": _round_to_step(body.get("width"), 8),
            "height": _round_to_step(body.get("height"), 8),
            "batch_size": _safe_int(body.get("batch_size"), 1, 1, 4096),
        }
        _save_presets(presets)
        return web.json_response({"ok": True, "presets": presets})

    @PromptServer.instance.routes.post("/empty_latent_image_plus/presets/delete")
    async def empty_latent_image_plus_delete_preset(request):
        body = await request.json()
        name = str(body.get("name", "")).strip()
        presets = _load_presets()
        if name in presets:
            del presets[name]
            _save_presets(presets)
        return web.json_response({"ok": True, "presets": presets})
