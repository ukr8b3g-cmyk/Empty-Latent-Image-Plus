# Empty Latent Image Plus

Version 1.1.1 fixes BOM preset loading, prevents changes after preset read errors,
and preserves saved dimensions when Clamp on Load is off.

Version 1.1.0 added Auto and manual latent formats. The default remains the
original SDXL / SD1.5 format so existing workflows continue to load.
<img width="1110" height="867" alt="ELIP" src="https://github.com/user-attachments/assets/19e1d176-1dae-439e-a61f-55a4a2f4a20c" />


Empty Latent Image Plus is a compact ComfyUI custom node based on the core
`Empty Latent Image` node.

It creates an empty latent image and also outputs the current `WIDTH` and
`HEIGHT` as INT values. This is useful when another node or workflow needs the
same canvas size as separate width and height inputs.

## Installation

Clone this repository into your ComfyUI `custom_nodes` folder:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/ukr8b3g-cmyk/Empty-Latent-Image-Plus.git
```

Then restart ComfyUI.

## Main Features

- Creates a standard ComfyUI latent image.
- Outputs `LATENT`, `WIDTH`, and `HEIGHT`.
- Keeps `width`, `height`, and `batch_size` simple and visible.
- Includes a `swap W/H` toggle that swaps width and height.
- Includes foldable `User Preset` controls.
- Includes foldable `Advanced` controls.
- Stores user presets in `presets.json`.
- Does not include fixed model-specific presets.
- Accepts an optional `MODEL` input for Auto detection and a `latent_type` dropdown for manual selection.

## Typical Use

Use this node as a drop-in replacement for the core `Empty Latent Image` node
when you also want `WIDTH` and `HEIGHT` outputs.

For example, it can be used with workflows that need one shared size value for:

- latent image generation
- canvas or framing helper nodes
- prompt or layout helper nodes
- nodes that accept INT width and height inputs

Presets store canvas dimensions only; selecting or loading a preset does not
change the model connection or latent format.

Presets retain integer dimensions without rounding to a multiple of eight.
`Clamp on Load` rounds only when enabled, using `Size Step`; disabling it loads
the saved dimensions unchanged. Model-specific alignment during generation is
separate and does not rewrite the preset.

UTF-8 presets with or without a BOM are supported. Invalid JSON or a read error
blocks preset changes and displays an error instead of overwriting the file.

## Intended Compatibility

Branch an upstream loader (or LoRA loader) `MODEL` output into this node. A connected
model always takes priority and switches the dropdown to **Auto**. Disconnecting
restores the last manual choice. Explicitly choosing Auto without a model reports
an actionable error rather than guessing from a filename.

If a downstream ModelSampling or layout node uses this node's `WIDTH` / `HEIGHT`,
connect the MODEL **before** that downstream node, not its output. Feeding its
output back into this node creates a graph cycle. Manual selection remains
available when an upstream MODEL connection is inconvenient.

| Manual choice | Channels / spatial divisor | Shape | Other examples |
|---|---|---|---|
| SDXL / SD1.5 | 4 / 8 | B,C,H,W | Pony, AuraFlow |
| SD3 / Flux.1 / Lumina2 | 16 / 8 | B,C,H,W | Chroma, Z-Image, HiDream |
| Anima / Krea2 / Qwen Image | 16 / 8 | B,C,1,H,W | Original Qwen Image and Edit variants; JoyImage, MingImage via Auto |
| Flux.2 / MOSS-Image | 128 / 16 | B,C,H,W | Flux.2 Klein, MOSS Base/SFT |
| Qwen Image 2.1 | 64 / 16 | B,C,H,W | Qwen Image 2.1 / Turbo |
| Hunyuan Image 2.1 | 64 / 32 | B,C,H,W | Base image model, not the dedicated refiner |
| Pixel-space | 3 / 1 | B,C,H,W | Chroma Radiance, pixel-space image models |

Auto reads the host's `latent_format` and image-model configuration. Quantization,
LoRA patches and checkpoint filenames do not determine the geometry. It does not
load model weights onto the GPU, change the model or select its VAE.

This is a still-image node. Video (including Wan), audio, 3D objects, Qwen Layered,
dedicated refiners and unknown formats should use their dedicated latent nodes.
Auto reports unsupported formats rather than silently falling back to 4 channels.

For Auto and non-default manual formats, non-divisible canvas dimensions round
down to the spatial divisor (at least one latent cell). `WIDTH` and `HEIGHT` report
the resulting dimensions. Inputs and saved presets are not rewritten. The
unconnected original default path keeps the old clamping, shapes and INT values.

## UI Controls

### width / height / batch_size

These behave like the core ComfyUI `Empty Latent Image` node.

### swap W/H

`swap W/H` is a toggle-style control. The default value is `false`.

Every toggle click swaps the current `width` and `height` values, regardless
of whether the toggle changes from `false → true` or `true → false`.
The `WIDTH` and `HEIGHT` outputs follow the swapped values.

Example:

```text
Before: width 768, height 1024
After:  width 1024, height 768
```

`batch_size` is not changed.

### User Preset

`User Preset` is foldable.

When expanded, it shows:

```text
Preset
Name
Save
Load
Delete
```

Presets are saved to:

```text
ComfyUI-Empty-Latent-Image-Plus/presets.json
```

Saved preset data:

```json
{
  "Preset Name": {
    "width": 768,
    "height": 1024,
    "batch_size": 1
  }
}
```

### Advanced

`Advanced` is foldable.

It contains:

- `Size Step`
- `Clamp on Load`
- `Show Info`
- `Info`

`Size Step` controls the rounding step used when loading presets with
`Clamp on Load` enabled.

`Clamp on Load` keeps loaded preset values inside safe ranges and rounds
width and height to the selected step.

`Show Info` controls the size information line.

The info line shows:

```text
width x height | aspect ratio | megapixels
```

## Installation

Copy this folder:

```text
ComfyUI-Empty-Latent-Image-Plus
```

into:

```text
ComfyUI/custom_nodes/
```

Then restart ComfyUI.

Expected node:

```text
Empty Latent Image Plus
```

Expected category:

```text
latent/plus
```

## Technical Specification

### Inputs

```text
width       INT  default 512  min 16  max 16384  step 8
height      INT  default 512  min 16  max 16384  step 8
batch_size  INT  default 1    min 1   max 4096   step 1
latent_type optional combo   default SDXL / SD1.5 (4ch)
model       optional MODEL  connected model always uses Auto
```

### Outputs

```text
LATENT
WIDTH   INT
HEIGHT  INT
```

### Latent Shape

The default backend path creates the latent tensor with:

```text
[batch_size, 4, height // 8, width // 8]
```

`batch_size` is clamped to a minimum of `1`.

Other shapes follow the compatibility table. Spatial/temporal downscale metadata
is included to prevent the sampler from resizing a correctly constructed latent.
The new modes use ComfyUI's intermediate device/dtype; the original default keeps
its previous CPU/default-dtype behavior.

### Existing workflows and presets

The node ID and three outputs are unchanged. Old API prompts that supply only
width/height/batch_size remain valid. The frontend migrates old positional widget
values in memory, including clipboard and nested subgraph loads, so the added
dropdown does not shift the old swap/preset/advanced values. Existing links remain
at their original indices. Workflow files are not rewritten by installation.

`presets.json` remains in its old three-field format and is not replaced during
the local update. The preset buttons and width/height swap retain their behavior.

## Backend Files

```text
empty_latent_image_plus.py
__init__.py
presets.json
```

The backend also exposes local preset routes:

```text
GET  /empty_latent_image_plus/presets
POST /empty_latent_image_plus/presets/save
POST /empty_latent_image_plus/presets/delete
```

## Frontend File

```text
web/js/empty_latent_image_plus.js
```

The frontend adds:

- `swap W/H`
- foldable User Preset controls
- foldable Advanced controls
- hidden widget layout handling
- size information display

## Non-goals

This node intentionally does not include:

- SDXL fixed presets
- SD1.5 fixed presets
- Flux fixed presets
- video latent replacement behavior
- ratio lock enabled by default

The node should remain a small, general-purpose latent helper.

## Verification Checklist

- ComfyUI starts without Python import errors.
- The node appears as `Empty Latent Image Plus`.
- The category is `latent/plus`.
- Inputs are `width`, `height`, and `batch_size`.
- Outputs are `LATENT`, `WIDTH`, and `HEIGHT`.
- `LATENT` works like the core `Empty Latent Image` output.
- `WIDTH` matches the current width.
- `HEIGHT` matches the current height.
- `batch_size` cannot execute below `1`.
- `swap W/H` swaps width and height only.
- `User Preset` can save, load, and delete presets.
- `Advanced` can show or hide info controls.
- No fixed model-specific presets are shown by default.

### Local CPU verification (2026-10-25)

Tests cover Auto using the host's real latent formats and source model mappings,
manual shapes, old API calls, native Flux.2/SD3 tensor equivalence, sampler sizing,
unsupported models, preset route round-trips and frontend workflow migration,
connections, serialization and preset operations. They do not load real model
weights or run image generation. Restart, actual canvas display and GPU generation
remain user checks. Tests use existing Python / Node dependencies only.

Run `python tests/test_latent_formats.py` from an installation inside ComfyUI's
`custom_nodes`, or set `COMFYUI_ROOT` to a separate ComfyUI checkout. Run frontend
tests with `node --test tests/test_ui.mjs`. Optionally set `ELIP_LEGACY_WORKFLOW`
to an existing workflow JSON for the additional read-only migration check.

The folding controls preserve original widget sizing when reopened. Advanced and
User Preset repeated open/close operations and Show Info persistence have regression
coverage. Actual canvas verification and GPU image generation remain unverified.
