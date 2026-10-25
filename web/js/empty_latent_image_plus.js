import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_CLASS = "EmptyLatentImagePlus";
const PRESETS_GET = "/empty_latent_image_plus/presets";
const PRESETS_SAVE = "/empty_latent_image_plus/presets/save";
const PRESETS_DELETE = "/empty_latent_image_plus/presets/delete";
const DEFAULT_FORMAT = "SDXL / SD1.5 (4ch)";
const FORMATS = [DEFAULT_FORMAT, "Auto", "SD3 / Flux.1 / Lumina2 (16ch)",
  "Anima / Krea2 / Qwen Image (16ch)", "Flux.2 / MOSS-Image (128ch)",
  "Qwen Image 2.1 (64ch)", "Hunyuan Image 2.1 (64ch)", "Pixel-space (RGB)"];

function migrateNodeData(data) {
  const values = data.widgets_values;
  let migrated = false;
  if (Array.isArray(values) && values.length >= 3
      && (values.length === 3 || typeof values[3] === "boolean" || values[3] == null)
      && (data.properties?.empty_latent_image_plus?.version ?? 1) < 2) {
    values.splice(3, 0, DEFAULT_FORMAT);
    migrated = true;
  }
  if (Array.isArray(data.inputs) && !data.inputs.some((input) => input.name === "model")) {
    // Append so old converted width/height inputs retain their slot numbers.
    data.inputs.push({ name: "model", type: "MODEL", link: null });
  }
  return migrated;
}

function migrateGraph(graph) {
  for (const data of graph.nodes ?? []) {
    if (data.type === NODE_CLASS) migrateNodeData(data);
  }
  for (const subgraph of graph.definitions?.subgraphs ?? []) migrateGraph(subgraph);
}

function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name || w.__elipName === name);
}

function asInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = asInt(value, fallback);
  return Math.max(min, Math.min(max, n));
}

function roundToStep(value, step) {
  const v = clampInt(value, 16, 16384, 512);
  const s = clampInt(step, 1, 1024, 8);
  return Math.max(16, Math.min(16384, Math.round(v / s) * s));
}

function setWidgetValue(node, name, value) {
  const w = getWidget(node, name);
  if (!w) return;
  w.value = value;
  if (w.callback) w.callback(value);
}

function getSizeInfo(node) {
  const width = clampInt(getWidget(node, "width")?.value, 16, 16384, 512);
  const height = clampInt(getWidget(node, "height")?.value, 16, 16384, 512);
  const pixels = width * height;
  const mp = (pixels / 1_000_000).toFixed(2);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(width, height) || 1;
  return `${width} x ${height} | ${width / g}:${height / g} | ${mp} MP`;
}

async function fetchPresets() {
  const res = await api.fetchApi(PRESETS_GET);
  const result = await res.json();
  if (!res.ok) {
    alert(result.error || "Unable to read presets.json.");
    return null;
  }
  return result;
}

async function postJson(path, body) {
  const res = await api.fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await res.json();
  if (!res.ok || result.ok === false) {
    alert(result.error || "Unable to update presets.json.");
    return null;
  }
  return result;
}

function hideWidget(widget, hidden) {
  if (!widget) return;
  if (!Object.hasOwn(widget, "__elipOriginalType")) {
    widget.__elipOriginalType = widget.type;
    widget.__elipOriginalComputeSize = widget.computeSize;
    widget.__elipOwnComputeSize = Object.hasOwn(widget, "computeSize");
  }
  widget.__elipHidden = hidden;
  widget.hidden = hidden;
  widget.type = hidden ? "hidden" : widget.__elipOriginalType;
  if (hidden) {
    widget.computeSize = () => [0, -4];
  } else if (widget.__elipOwnComputeSize) {
    widget.computeSize = widget.__elipOriginalComputeSize;
  } else {
    delete widget.computeSize;
  }
}

function resizeNodeForFolding(node) {
  if (!node.computeSize || !node.setSize) return;
  const computed = node.computeSize();
  const current = node.size || computed;
  node.setSize([Math.max(current[0] || 0, computed[0] || 0), computed[1] || current[1] || 0]);
}

function installPlusWidgets(node) {
  if (node.__emptyLatentImagePlusInstalled) return;
  node.__emptyLatentImagePlusInstalled = true;

  const state = Object.assign({
    presets: {},
    selected: "",
    userPresetOpen: false,
    advancedOpen: false,
    manualFormat: DEFAULT_FORMAT,
  }, node.properties?.empty_latent_image_plus || {});

  const markDirty = () => node.setDirtyCanvas?.(true, true);

  const persistState = () => {
    node.properties = node.properties || {};
    node.properties.empty_latent_image_plus = {
      selected: state.selected || presetSelect?.value || "",
      userPresetOpen: !!state.userPresetOpen,
      advancedOpen: !!state.advancedOpen,
      manualFormat: state.manualFormat,
      version: 2,
    };
  };

  const oldOnSerialize = node.onSerialize;
  node.onSerialize = function(o) {
    persistState();
    oldOnSerialize?.apply(this, arguments);
    if (o?.properties) o.properties.empty_latent_image_plus = { ...node.properties.empty_latent_image_plus };
  };

  const swapToggle = node.addWidget("toggle", "swap W/H", false, () => {
    const width = getWidget(node, "width");
    const height = getWidget(node, "height");
    if (!width || !height) return;
    const oldWidth = width.value;
    width.value = height.value;
    height.value = oldWidth;
    width.callback?.(width.value);
    height.callback?.(height.value);
    updateInfo();
    markDirty();
  });
  swapToggle.__elipName = "swap_wh";

  const userFold = node.addWidget("button", "▶ User Preset", null, () => {
    state.userPresetOpen = !state.userPresetOpen;
    applyFolding();
  });
  userFold.__elipName = "user_preset_fold";

  const presetSelect = node.addWidget("combo", "Preset", "", (value) => {
    state.selected = value || "";
    persistState();
  }, { values: [] });
  presetSelect.__elipName = "preset_select";

  const presetName = node.addWidget("text", "Name", "", () => {});
  presetName.__elipName = "preset_name";

  const saveBtn = node.addWidget("button", "Save", null, async () => {
    const name = String(presetName.value || presetSelect.value || "").trim();
    if (!name) return;
    const body = {
      name,
      width: getWidget(node, "width")?.value,
      height: getWidget(node, "height")?.value,
      batch_size: Math.max(1, asInt(getWidget(node, "batch_size")?.value, 1)),
    };
    if (!await postJson(PRESETS_SAVE, body)) return;
    presetSelect.value = name;
    state.selected = name;
    await refreshPresetList();
  });
  saveBtn.__elipName = "preset_save";

  const loadBtn = node.addWidget("button", "Load", null, () => {
    const name = presetSelect.value || state.selected;
    const item = state.presets[name];
    if (!item) return;
    const step = asInt(sizeStep.value || 8, 8);
    const clamp = !!clampOnLoad.value;
    const width = clamp ? roundToStep(item.width, step) : clampInt(item.width, 16, 16384, 512);
    const height = clamp ? roundToStep(item.height, step) : clampInt(item.height, 16, 16384, 512);
    const batch = clampInt(item.batch_size, 1, 4096, 1);
    setWidgetValue(node, "width", width);
    setWidgetValue(node, "height", height);
    setWidgetValue(node, "batch_size", batch);
    updateInfo();
    markDirty();
  });
  loadBtn.__elipName = "preset_load";

  const deleteBtn = node.addWidget("button", "Delete", null, async () => {
    const name = presetSelect.value || state.selected;
    if (!name) return;
    if (!await postJson(PRESETS_DELETE, { name })) return;
    await refreshPresetList();
  });
  deleteBtn.__elipName = "preset_delete";

  const advancedFold = node.addWidget("button", "▶ Advanced", null, () => {
    state.advancedOpen = !state.advancedOpen;
    applyFolding();
  });
  advancedFold.__elipName = "advanced_fold";

  const sizeStep = node.addWidget("combo", "Size Step", "8", () => {}, { values: ["8", "16", "32", "64"] });
  sizeStep.__elipName = "size_step";

  const clampOnLoad = node.addWidget("toggle", "Clamp on Load", true, () => {});
  clampOnLoad.__elipName = "clamp_on_load";

  const showInfo = node.addWidget("toggle", "Show Info", true, () => {
    updateInfo();
    applyFolding();
  });
  showInfo.__elipName = "show_info";

  const infoWidget = node.addWidget("text", "Info", getSizeInfo(node), () => {});
  infoWidget.__elipName = "info";
  infoWidget.disabled = true;

  const userWidgets = [presetSelect, presetName, saveBtn, loadBtn, deleteBtn];
  const advancedWidgets = [sizeStep, clampOnLoad, showInfo, infoWidget];

  function updateInfo() {
    if (infoWidget) {
      const format = getWidget(node, "latent_type")?.value || DEFAULT_FORMAT;
      infoWidget.value = `${getSizeInfo(node)} | ${format}`;
    }
  }

  function syncModelConnection() {
    const format = getWidget(node, "latent_type");
    if (!format) return;
    const connected = node.inputs?.some((input) => input.name === "model" && input.link != null);
    if (connected) {
      if (!format.disabled && format.value !== "Auto" && FORMATS.includes(format.value)) state.manualFormat = format.value;
      format.value = "Auto";
    } else if (format.disabled) {
      format.value = FORMATS.includes(state.manualFormat) && state.manualFormat !== "Auto" ? state.manualFormat : DEFAULT_FORMAT;
    }
    format.disabled = !!connected;
    persistState();
    updateInfo();
    markDirty();
  }

  const format = getWidget(node, "latent_type");
  if (format) {
    const oldCallback = format.callback;
    format.callback = function(value) {
      if (!format.disabled && value !== "Auto" && FORMATS.includes(value)) state.manualFormat = value;
      oldCallback?.apply(this, arguments);
      syncModelConnection();
    };
  }

  const oldOnConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function(type, slot, connected) {
    oldOnConnectionsChange?.apply(this, arguments);
    if (!app.configuringGraph && type === 1 && this.inputs?.[slot]?.name === "model") syncModelConnection();
  };

  const oldOnConfigure = node.onConfigure;
  node.onConfigure = function(data) {
    if (migrateNodeData(data) && Array.isArray(data.widgets_values)) {
      data.widgets_values.forEach((value, i) => {
        if (this.widgets?.[i]) this.widgets[i].value = value;
      });
    }
    if (!this.inputs?.some((input) => input.name === "model")) this.addInput("model", "MODEL");
    oldOnConfigure?.apply(this, arguments);
    Object.assign(state, this.properties?.empty_latent_image_plus || {});
    // A workflow already saved in Auto must keep its remembered manual mode.
    syncModelConnection();
    applyFolding();
  };

  function applyFolding() {
    userFold.name = `${state.userPresetOpen ? "▼" : "▶"} User Preset`;
    advancedFold.name = `${state.advancedOpen ? "▼" : "▶"} Advanced`;
    for (const w of userWidgets) hideWidget(w, !state.userPresetOpen);
    for (const w of advancedWidgets) hideWidget(w, !state.advancedOpen || (w === infoWidget && !showInfo.value));
    persistState();
    updateInfo();
    resizeNodeForFolding(node);
    markDirty();
  }

  async function refreshPresetList() {
    const presets = await fetchPresets();
    if (presets === null) return;
    state.presets = presets;
    const names = Object.keys(state.presets).sort((a, b) => a.localeCompare(b));
    const values = names.length ? names : [""];
    presetSelect.options.values = values;
    if (state.selected && names.includes(state.selected)) {
      presetSelect.value = state.selected;
    } else if (presetSelect.value && names.includes(presetSelect.value)) {
      state.selected = presetSelect.value;
    } else {
      presetSelect.value = values[0];
      state.selected = presetSelect.value;
    }
    persistState();
    markDirty();
  }

  const batch = getWidget(node, "batch_size");
  if (batch) {
    const oldCb = batch.callback;
    batch.callback = function(value) {
      if (asInt(value, 1) < 1) batch.value = 1;
      oldCb?.apply(this, arguments);
    };
  }

  for (const name of ["width", "height", "batch_size"]) {
    const w = getWidget(node, name);
    if (w) {
      const oldCb = w.callback;
      w.callback = function(value) {
        if (name === "batch_size" && asInt(value, 1) < 1) w.value = 1;
        updateInfo();
        oldCb?.apply(this, arguments);
      };
    }
  }

  syncModelConnection();
  applyFolding();
  refreshPresetList();
}

app.registerExtension({
  name: "empty-latent-image-plus.ui",
  beforeConfigureGraph(graphData) {
    migrateGraph(graphData);
  },
  nodeCreated(node) {
    if (node.comfyClass === NODE_CLASS) {
      installPlusWidgets(node);
    }
  },
});
