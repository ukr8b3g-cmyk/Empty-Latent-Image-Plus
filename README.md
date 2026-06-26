# Empty Latent Image Plus
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

## Typical Use

Use this node as a drop-in replacement for the core `Empty Latent Image` node
when you also want `WIDTH` and `HEIGHT` outputs.

For example, it can be used with workflows that need one shared size value for:

- latent image generation
- canvas or framing helper nodes
- prompt or layout helper nodes
- nodes that accept INT width and height inputs

This node is model-agnostic. It is not limited to SDXL, SD1.5, or Krea-style
workflows.

## Intended Compatibility

This node is intended for ordinary ComfyUI workflows that can use a standard
`Empty Latent Image`-compatible latent input.

Typical targets include:

- SD1.5 workflows
- SDXL workflows
- Pony-based workflows
- Flux-based workflows
- Chroma-based workflows
- Qwen Image-based workflows
- Krea2 workflows
- other normal `Empty Latent Image`-compatible image workflows

It does not replace dedicated video latent nodes or model-specific latent nodes.

## UI Controls

### width / height / batch_size

These behave like the core ComfyUI `Empty Latent Image` node.

### swap W/H

`swap W/H` is a toggle-style control. The default value is `false`.

When set to `true`, it swaps the current `width` and `height` values.
The `WIDTH` and `HEIGHT` outputs follow the swapped values.

Changing it back to `false` does not swap the values again.

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
```

### Outputs

```text
LATENT
WIDTH   INT
HEIGHT  INT
```

### Latent Shape

The backend creates the latent tensor with:

```text
[batch_size, 4, height // 8, width // 8]
```

`batch_size` is clamped to a minimum of `1`.

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
- model auto-detection
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
