"""Exercise preset routes without importing ComfyUI or initializing a device."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
routes = {}


def route(method):
    def decorator(path):
        def register(fn):
            routes[method, path] = fn
            return fn
        return register
    return decorator


def response(value, status=200):
    return types.SimpleNamespace(status=status, text=json.dumps(value))


comfy = types.ModuleType("comfy")
comfy.model_management = types.ModuleType("comfy.model_management")
server = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=route("GET"), post=route("POST")))))
with patch.dict(sys.modules, {
    "torch": types.ModuleType("torch"), "comfy": comfy,
    "comfy.model_management": comfy.model_management, "server": server,
    "aiohttp": types.SimpleNamespace(web=types.SimpleNamespace(json_response=response)),
}):
    spec = importlib.util.spec_from_file_location("elip_storage_test", ROOT / "empty_latent_image_plus.py")
    elip = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(elip)


class Request:
    async def json(self):
        return {"name": "keep", "width": 1001, "height": 1003, "batch_size": 2}


class StorageTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "presets.json"
        setting = patch.object(elip, "PRESETS_PATH", self.path)
        setting.start()
        self.addCleanup(setting.stop)
        self.original = ("\ufeff" + json.dumps({
            "keep": {"width": 512, "height": 768, "batch_size": 1},
            "日本語": {"width": 777, "height": 999, "batch_size": 3},
        }, ensure_ascii=False)).encode("utf-8")
        self.path.write_bytes(self.original)

    def call(self, action):
        return asyncio.run(routes["POST", f"/empty_latent_image_plus/presets/{action}"](Request()))

    def assert_preserved(self, result):
        self.assertEqual(result.status, 500)
        self.assertFalse(json.loads(result.text)["ok"])
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_partial_write_preserves_original_on_save_and_delete(self):
        create = tempfile.NamedTemporaryFile

        class PartialFile:
            def __init__(self, *args, **kwargs):
                self.file = create(*args, **kwargs)

            def __enter__(self):
                self.file.__enter__()
                return self

            def __exit__(self, *args):
                return self.file.__exit__(*args)

            @property
            def name(self):
                return self.file.name

            def write(self, value):
                self.file.write(value[:5])
                raise OSError("injected partial write")

        for action in ("save", "delete"):
            with self.subTest(action=action), patch.object(tempfile, "NamedTemporaryFile", PartialFile):
                self.assert_preserved(self.call(action))

    def test_replace_failure_preserves_original_on_save_and_delete(self):
        for action in ("save", "delete"):
            with self.subTest(action=action), patch.object(elip.os, "replace", side_effect=PermissionError("replace denied")):
                self.assert_preserved(self.call(action))

    def test_flush_failure_preserves_original_on_save_and_delete(self):
        for action in ("save", "delete"):
            with self.subTest(action=action), patch.object(elip.os, "fsync", side_effect=OSError("flush failed")):
                self.assert_preserved(self.call(action))

    def test_success_replaces_a_complete_closed_file_in_the_same_directory(self):
        replace = elip.os.replace
        replacements = []

        def check_replace(source, destination):
            source, destination = Path(source), Path(destination)
            self.assertEqual(source.parent, self.path.parent)
            self.assertEqual(destination, self.path)
            self.assertNotEqual(source, destination)
            self.assertEqual(self.path.read_bytes(), self.original)
            self.assertEqual(json.loads(source.read_text(encoding="utf-8"))["keep"]["width"], 1001)
            replacements.append(source)
            return replace(source, destination)

        with patch.object(elip.os, "replace", side_effect=check_replace):
            result = self.call("save")
        self.assertEqual(result.status, 200)
        self.assertEqual(len(replacements), 1)
        stored = elip._load_presets()
        self.assertEqual(stored["keep"], {"width": 1001, "height": 1003, "batch_size": 2})
        self.assertEqual(stored["日本語"], {"width": 777, "height": 999, "batch_size": 3})
        self.assertEqual(json.loads(result.text)["presets"], stored)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_failed_first_save_leaves_no_preset_or_temporary_file(self):
        self.path.unlink()
        with patch.object(elip.os, "replace", side_effect=OSError("replace failed")):
            result = self.call("save")
        self.assertEqual(result.status, 500)
        self.assertEqual(list(self.path.parent.iterdir()), [])

    def test_serialization_failure_does_not_touch_the_original(self):
        with self.assertRaises(TypeError):
            elip._save_presets({"invalid": object()})
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])


if __name__ == "__main__":
    unittest.main(verbosity=2)
