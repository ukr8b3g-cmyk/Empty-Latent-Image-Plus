import ast
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import torch

ROOT = Path(__file__).resolve().parents[1]
COMFY = Path(os.environ.get("COMFYUI_ROOT", ROOT.parents[1]))
sys.path.insert(0, str(COMFY))


def no_cuda():
    raise AssertionError("CPU test attempted to initialize CUDA")


torch.cuda._lazy_init = no_cuda
import comfy.latent_formats as lf

# Device policy is supplied by the host at runtime. Tests allocate on CPU only.
management = types.ModuleType("comfy.model_management")
management.intermediate_device = lambda: torch.device("cpu")
management.intermediate_dtype = lambda: torch.float32
routes = {}


def route(method):
    def decorator(path):
        def register(fn):
            routes[method, path] = fn
            return fn
        return register
    return decorator


server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=route("GET"), post=route("POST"))))
with patch.dict(sys.modules, {"comfy.model_management": management, "server": server}):
    spec = importlib.util.spec_from_file_location("elip_test", ROOT / "empty_latent_image_plus.py")
    elip = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(elip)
# import installs this child attribute on the parent package too.
elip.comfy.model_management = management

tree = ast.parse((COMFY / "comfy/supported_models.py").read_text(encoding="utf-8-sig"))
classes = {node.name: node for node in tree.body if isinstance(node, ast.ClassDef)}


def source_attribute(name, attribute):
    cls = classes[name]
    for item in cls.body:
        if isinstance(item, ast.Assign) and any(isinstance(t, ast.Name) and t.id == attribute for t in item.targets):
            return item.value
    for base in cls.bases:
        if isinstance(base, ast.Name) and base.id in classes:
            result = source_attribute(base.id, attribute)
            if result is not None:
                return result


class Model:
    def __init__(self, name):
        # Read actual host assignments/inheritance without importing model code
        # (some optional kernels initialize CUDA at import time).
        format_name = source_attribute(name, "latent_format").attr
        config_node = source_attribute(name, "unet_config")
        config = {}
        for key, value in zip(config_node.keys, config_node.values):
            if isinstance(key, ast.Constant) and isinstance(value, ast.Constant):
                config[key.value] = value.value
        self.config = types.SimpleNamespace(unet_config=config)
        self.format = getattr(lf, format_name)()
        self.calls = []

    def get_model_object(self, key):
        self.calls.append(key)
        return {"latent_format": self.format, "model_config": self.config}[key]


def core_method(path, class_name, method_name, env):
    parsed = ast.parse(path.read_text(encoding="utf-8-sig"))
    cls = next(n for n in parsed.body if isinstance(n, ast.ClassDef) and n.name == class_name)
    fn = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == method_name)
    fn.decorator_list = []
    fn.returns = None
    for arg in fn.args.args:
        arg.annotation = None
    exec(compile(ast.Module(body=[fn], type_ignores=[]), str(path), "exec"), env)
    return env[method_name]


class Tests(unittest.TestCase):
    def setUp(self):
        self.node = elip.EmptyLatentImagePlus()

    def test_schema_and_legacy_api(self):
        schema = self.node.INPUT_TYPES()
        self.assertEqual(list(schema["required"]), ["width", "height", "batch_size"])
        self.assertEqual(self.node.RETURN_NAMES, ("LATENT", "WIDTH", "HEIGHT"))
        self.assertEqual(schema["optional"]["model"][0], "MODEL")
        self.assertIn("Auto", schema["optional"]["latent_type"][0])
        for w, h, b in ((512, 768, 1), (521, 777, 2), (1, 24, 0)):
            result, width, height = self.node.generate(w, h, b)
            expected_w, expected_h, expected_b = max(16, w), max(16, h), max(1, b)
            self.assertEqual((width, height), (expected_w, expected_h))
            self.assertTrue(torch.equal(result["samples"], torch.zeros(expected_b, 4, expected_h // 8, expected_w // 8)))

    def test_manual_formats(self):
        for name, (channels, ratio, dimensions) in elip.LATENT_FORMATS.items():
            with self.subTest(name=name):
                latent, w, h = self.node.generate(1344, 1024, 2, name)
                shape = (2, channels, h//ratio, w//ratio)
                if dimensions == 3:
                    shape = (2, channels, 1, h//ratio, w//ratio)
                self.assertEqual(tuple(latent["samples"].shape), shape)
                self.assertEqual(latent["samples"].device.type, "cpu")
                self.assertEqual(torch.count_nonzero(latent["samples"]).item(), 0)
                self.assertEqual(latent["downscale_ratio_spacial"], ratio)

    def test_auto_actual_host_families(self):
        families = ["SD15", "SDXL", "AuraFlow", "SD3", "Flux", "FluxSchnell", "Flux2", "Flux3",
                    "Lumina2", "ZImage", "Anima", "Krea2", "MOSSImage", "QwenImage", "QwenImage21",
                    "HunyuanImage21", "Chroma", "HiDream", "ChromaRadiance", "ZImagePixelSpace", "JoyImage", "MingImage"]
        for name in families:
            with self.subTest(name=name):
                model = Model(name)
                latent, w, h = self.node.generate(1344, 1024, 1, "Auto", model)
                fmt = model.format
                shape = [1, fmt.latent_channels]
                if fmt.latent_dimensions == 3:
                    shape.append(1)
                shape.extend([h//fmt.spacial_downscale_ratio, w//fmt.spacial_downscale_ratio])
                self.assertEqual(list(latent["samples"].shape), shape)
                self.assertEqual(model.calls, ["latent_format", "model_config"])
                self.assertEqual((w, h), (1344, 1024))

    def test_model_connection_overrides_manual(self):
        model = Model("MOSSImage")
        for manual in (elip.DEFAULT_FORMAT, "Qwen Image 2.1 (64ch)", "not a known manual choice"):
            self.assertEqual(self.node.generate(1024, 1024, model=model, latent_type=manual)[0]["samples"].shape[1], 128)

    def test_auto_and_manual_errors(self):
        with self.assertRaisesRegex(ValueError, "connect MODEL"):
            self.node.generate(512, 512, latent_type="Auto")
        with self.assertRaisesRegex(ValueError, "unknown latent type"):
            self.node.generate(512, 512, latent_type="unknown")

    def test_reject_non_image_models(self):
        for name in ("WAN21", "StableAudio", "StableAudio3", "Trellis2", "SC_Prior"):
            if name not in classes:
                continue
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.node.generate(512, 512, model=Model(name))
        model = Model("QwenImage")
        model.config.unet_config["use_additional_t_cond"] = True
        with self.assertRaisesRegex(ValueError, "Qwen Layered"):
            self.node.generate(512, 512, model=model)

    def test_alignment_and_minimum(self):
        for name, ratio in (("Flux.2 / MOSS-Image (128ch)", 16), ("Qwen Image 2.1 (64ch)", 16), ("Hunyuan Image 2.1 (64ch)", 32)):
            latent, w, h = self.node.generate(1032, 1001, latent_type=name)
            self.assertEqual((w, h), (1032//ratio*ratio, 1001//ratio*ratio))
            self.assertEqual((latent["samples"].shape[-1]*ratio, latent["samples"].shape[-2]*ratio), (w, h))
            latent, w, h = self.node.generate(16, 16, latent_type=name)
            self.assertGreaterEqual(min(latent["samples"].shape[-2:]), 1)
            self.assertEqual((w, h), (max(16, ratio), max(16, ratio)))

    def test_core_flux2_and_sd3_equivalence(self):
        io = types.SimpleNamespace(NodeOutput=lambda value: value)
        for filename, cls, choice in (("nodes_flux.py", "EmptyFlux2LatentImage", "Flux.2 / MOSS-Image (128ch)"),
                                      ("nodes_sd3.py", "EmptySD3LatentImage", "SD3 / Flux.1 / Lumina2 (16ch)")):
            fn = core_method(COMFY / "comfy_extras" / filename, cls, "execute", {"torch": torch, "comfy": elip.comfy, "io": io})
            expected = fn(None, 1344, 1024, 1)["samples"]
            actual = self.node.generate(1344, 1024, latent_type=choice)[0]["samples"]
            self.assertTrue(torch.equal(actual, expected))

    def test_sampler_does_not_resize_correct_latents(self):
        parsed = ast.parse((COMFY / "comfy/sample.py").read_text(encoding="utf-8-sig"))
        fn = next(n for n in parsed.body if isinstance(n, ast.FunctionDef) and n.name == "fix_empty_latent_channels")
        env = {"torch": torch, "comfy": elip.comfy}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), "actual_host_fix_empty_latent_channels", "exec"), env)
        for name in ("SDXL", "Flux", "MOSSImage", "QwenImage21", "QwenImage", "Anima", "Krea2"):
            model = Model(name)
            latent = self.node.generate(512, 512, model=model)[0]
            corrected = env[fn.name](model, latent["samples"], latent["downscale_ratio_spacial"], latent.get("downscale_ratio_temporal"))
            self.assertIs(corrected, latent["samples"])

    def test_presets_routes_keep_old_format(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(elip, "PRESETS_PATH", Path(directory)/"presets.json"):
            original = {"portrait": {"width": 1024, "height": 1344, "batch_size": 1}}
            elip._save_presets(original)
            self.assertEqual(elip._load_presets(), original)
            class Request:
                async def json(self):
                    return {"name": "new", "width": 768, "height": 1024, "batch_size": 2}
            save = routes["POST", "/empty_latent_image_plus/presets/save"]
            response = asyncio.run(save(Request()))
            self.assertEqual(response.status, 200)
            after = json.loads(elip.PRESETS_PATH.read_text(encoding="utf-8"))
            self.assertEqual(after["portrait"], original["portrait"])
            self.assertEqual(set(after["new"]), {"width", "height", "batch_size"})
            asyncio.run(routes["POST", "/empty_latent_image_plus/presets/delete"](Request()))
            self.assertEqual(elip._load_presets(), original)

    def test_cpu_only(self):
        self.assertFalse(torch.cuda.is_initialized())


if __name__ == "__main__":
    unittest.main(verbosity=2)
