import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_CLASS = "EmptyLatentImagePlus";
const PRESETS_GET = "/empty_latent_image_plus/presets";
const PRESETS_SAVE = "/empty_latent_image_plus/presets/save";
const PRESETS_DELETE = "/empty_latent_image_plus/presets/delete";

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
  if (!res.ok) return {};
  return await res.json();
}

async function postJson(path, body) {
  const res = await api.fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

function hideWidget(widget, hidden) {
  if (!widget) return;
  if (!widget.__elipOriginalType) widget.__elipOriginalType = widget.type;
  widget.__elipHidden = hidden;
  widget.hidden = hidden;
  widget.type = hidden ? "hidden" : widget.__elipOriginalType;
  widget.computeSize = hidden ? (() => [0, -4]) : widget.__elipOriginalComputeSize;
}

function patchLayoutForHiddenWidgets(node) {
  if (node.__elipLayoutPatched) return;
  node.__elipLayoutPatched = true;

  const oldComputeSize = node.computeSize?.bind(node);
  if (oldComputeSize) {
    node.computeSize = function(out) {
      const widgets = this.widgets;
      if (!widgets) return oldComputeSize(out);
      const visibleWidgets = widgets.filter((w) => !w.__elipHidden);
      this.widgets = visibleWidgets;
      const size = oldComputeSize(out);
      this.widgets = widgets;
      return size;
    };
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
  patchLayoutForHiddenWidgets(node);

  const state = Object.assign({
    presets: {},
    selected: "",
    userPresetOpen: false,
    advancedOpen: false,
  }, node.properties?.empty_latent_image_plus || {});

  const markDirty = () => node.setDirtyCanvas?.(true, true);

  const persistState = () => {
    node.properties = node.properties || {};
    node.properties.empty_latent_image_plus = {
      selected: state.selected || presetSelect?.value || "",
      userPresetOpen: !!state.userPresetOpen,
      advancedOpen: !!state.advancedOpen,
    };
  };

  const oldOnSerialize = node.onSerialize;
  node.onSerialize = function(o) {
    persistState();
    oldOnSerialize?.apply(this, arguments);
  };

  const swapToggle = node.addWidget("toggle", "swap W/H", false, () => {
    if (!swapToggle.value) return;
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
    await postJson(PRESETS_SAVE, body);
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
    await postJson(PRESETS_DELETE, { name });
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
    if (infoWidget) infoWidget.value = getSizeInfo(node);
  }

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
    state.presets = await fetchPresets();
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

  applyFolding();
  refreshPresetList();
}

app.registerExtension({
  name: "empty-latent-image-plus.ui",
  nodeCreated(node) {
    if (node.comfyClass === NODE_CLASS) {
      installPlusWidgets(node);
    }
  },
});
