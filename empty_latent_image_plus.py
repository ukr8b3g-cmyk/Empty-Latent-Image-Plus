import json
import os
from pathlib import Path

import torch
import comfy.model_management

try:
    from server import PromptServer
    from aiohttp import web
except Exception:  # pragma: no cover
    PromptServer = None
    web = None

NODE_DIR = Path(__file__).resolve().parent
PRESETS_PATH = NODE_DIR / "presets.json"
MAX_RESOLUTION = 16384
DEFAULT_FORMAT = "SDXL / SD1.5 (4ch)"
LATENT_FORMATS = {
    DEFAULT_FORMAT: (4, 8, 2),
    "SD3 / Flux.1 / Lumina2 (16ch)": (16, 8, 2),
    "Anima / Krea2 / Qwen Image (16ch)": (16, 8, 3),
    "Flux.2 / MOSS-Image (128ch)": (128, 16, 2),
    "Qwen Image 2.1 (64ch)": (64, 16, 2),
    "Hunyuan Image 2.1 (64ch)": (64, 32, 2),
    "Pixel-space (RGB)": (3, 1, 2),
}
IMAGE_FRAME_MODELS = {"anima", "krea2", "qwen_image", "joyimage", "ming_image"}


def _model_format(model):
    latent_format = model.get_model_object("latent_format")
    config = model.get_model_object("model_config")
    family = config.unet_config.get("image_model")
    channels = latent_format.latent_channels
    ratio = latent_format.spacial_downscale_ratio
    dimensions = latent_format.latent_dimensions
    profile = (channels, ratio, dimensions)
    name = type(latent_format).__name__
    if name.startswith(("Trellis", "Tripo", "Hunyuan3D", "SC_")):
        raise ValueError("Empty Latent Image Plus: use the model's dedicated latent node.")
    if dimensions == 3 and (family not in IMAGE_FRAME_MODELS or config.unet_config.get("use_additional_t_cond")):
        raise ValueError("Empty Latent Image Plus: Auto supports still images, not video or Qwen Layered. Use a dedicated latent node.")
    if profile not in LATENT_FORMATS.values():
        raise ValueError(f"Empty Latent Image Plus: unsupported latent format {name} ({channels}ch, /{ratio}, {dimensions}D).")
    temporal_ratio = latent_format.temporal_downscale_ratio if dimensions == 3 else None
    return profile, temporal_ratio


def _safe_int(value, default, min_value, max_value):
    try:
        value = int(value)
    except Exception:
        value = default
    return max(min_value, min(max_value, value))


def _load_presets():
    try:
        raw = json.loads(PRESETS_PATH.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("Preset data must be a JSON object")

    presets = {}
    for name, item in raw.items():
        if not isinstance(name, str) or not isinstance(item, dict):
            continue
        clean_name = name.strip()
        if not clean_name:
            continue
        presets[clean_name] = {
            "width": _safe_int(item.get("width"), 512, 16, MAX_RESOLUTION),
            "height": _safe_int(item.get("height"), 512, 16, MAX_RESOLUTION),
            "batch_size": _safe_int(item.get("batch_size"), 1, 1, 4096),
        }
    return presets


def _save_presets(presets):
    PRESETS_PATH.write_text(
        json.dumps(presets, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _preset_error(error):
    return web.json_response({
        "ok": False,
        "error": f"Cannot read or update presets.json: {error}. Check the file and its permissions before retrying.",
    }, status=500)


class EmptyLatentImagePlus:
    """Empty image latents with optional MODEL detection and WIDTH/HEIGHT outputs.

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
            },
            "optional": {
                "latent_type": ([DEFAULT_FORMAT, "Auto", *list(LATENT_FORMATS)[1:]], {
                    "default": DEFAULT_FORMAT,
                    "tooltip": "MODEL connected: Auto. Otherwise select the latent family. Flux.1 also covers Chroma, Z-Image and HiDream; 4ch also covers AuraFlow.",
                }),
                "model": ("MODEL", {"tooltip": "Connect an upstream loader/LoRA MODEL for Auto. Do not feed back a node that depends on this node's WIDTH/HEIGHT outputs."}),
            },
        }

    RETURN_TYPES = ("LATENT", "INT", "INT")
    RETURN_NAMES = ("LATENT", "WIDTH", "HEIGHT")
    FUNCTION = "generate"
    CATEGORY = "latent/plus"

    def generate(self, width, height, batch_size=1, latent_type=DEFAULT_FORMAT, model=None):
        width = _safe_int(width, 512, 16, MAX_RESOLUTION)
        height = _safe_int(height, 512, 16, MAX_RESOLUTION)
        batch_size = _safe_int(batch_size, 1, 1, 4096)
        legacy = model is None and latent_type == DEFAULT_FORMAT
        temporal_ratio = None
        if model is not None:
            (channels, ratio, dimensions), temporal_ratio = _model_format(model)
        elif latent_type == "Auto":
            raise ValueError("Empty Latent Image Plus: connect MODEL for Auto, or select a manual latent type.")
        elif latent_type in LATENT_FORMATS:
            channels, ratio, dimensions = LATENT_FORMATS[latent_type]
            if dimensions == 3:
                temporal_ratio = 4
        else:
            raise ValueError(f"Empty Latent Image Plus: unknown latent type {latent_type!r}.")

        if not legacy:
            width = max(ratio, width // ratio * ratio)
            height = max(ratio, height // ratio * ratio)
        shape = [batch_size, channels]
        if dimensions == 3:
            shape.append(1)
        shape.extend([height // ratio, width // ratio])
        if legacy:
            latent = torch.zeros(shape)
        else:
            latent = torch.zeros(shape, device=comfy.model_management.intermediate_device(), dtype=comfy.model_management.intermediate_dtype())
        result = {"samples": latent, "downscale_ratio_spacial": ratio}
        if temporal_ratio is not None:
            result["downscale_ratio_temporal"] = temporal_ratio
        return (result, width, height)


NODE_CLASS_MAPPINGS = {
    "EmptyLatentImagePlus": EmptyLatentImagePlus,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "EmptyLatentImagePlus": "Empty Latent Image Plus",
}


if PromptServer is not None and web is not None:
    @PromptServer.instance.routes.get("/empty_latent_image_plus/presets")
    async def empty_latent_image_plus_get_presets(request):
        try:
            return web.json_response(_load_presets())
        except (OSError, ValueError) as error:
            return _preset_error(error)

    @PromptServer.instance.routes.post("/empty_latent_image_plus/presets/save")
    async def empty_latent_image_plus_save_preset(request):
        body = await request.json()
        name = str(body.get("name", "")).strip()
        if not name:
            return web.json_response({"ok": False, "error": "Preset name is required"}, status=400)

        try:
            presets = _load_presets()
            presets[name] = {
                "width": _safe_int(body.get("width"), 512, 16, MAX_RESOLUTION),
                "height": _safe_int(body.get("height"), 512, 16, MAX_RESOLUTION),
                "batch_size": _safe_int(body.get("batch_size"), 1, 1, 4096),
            }
            _save_presets(presets)
        except (OSError, ValueError) as error:
            return _preset_error(error)
        return web.json_response({"ok": True, "presets": presets})

    @PromptServer.instance.routes.post("/empty_latent_image_plus/presets/delete")
    async def empty_latent_image_plus_delete_preset(request):
        body = await request.json()
        name = str(body.get("name", "")).strip()
        try:
            presets = _load_presets()
            if name in presets:
                del presets[name]
                _save_presets(presets)
        except (OSError, ValueError) as error:
            return _preset_error(error)
        return web.json_response({"ok": True, "presets": presets})
