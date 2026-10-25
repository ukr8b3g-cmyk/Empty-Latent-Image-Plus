import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(root + "web/js/empty_latent_image_plus.js", "utf8");
const defaultFormat = "SDXL / SD1.5 (4ch)";
const manual = "Flux.2 / MOSS-Image (128ch)";
const clone = (v) => JSON.parse(JSON.stringify(v));
let extension;
const app = { configuringGraph: false, registerExtension: (value) => { extension = value; } };
const requests = [];
let presets = { portrait: { width: 1024, height: 1344, batch_size: 1 } };
const context = vm.createContext({
  app,
  api: { async fetchApi(path, options) {
    if (options) {
      const body = JSON.parse(options.body);
      requests.push({ path, body });
      if (path.endsWith("/save")) presets[body.name] = { width: body.width, height: body.height, batch_size: body.batch_size };
      if (path.endsWith("/delete")) delete presets[body.name];
    }
    return { ok: true, json: async () => clone(presets) };
  } },
});
vm.runInContext(source.replace(/^import .* from .*;\r?\n/gm, ""), context);

class Node {
  constructor() {
    this.comfyClass = "EmptyLatentImagePlus";
    this.inputs = [{ name: "model", type: "MODEL", link: null }];
    this.properties = {};
    this.widgets = [];
    this.size = [340, 200];
    this.addWidget("number", "width", 512, () => {});
    this.addWidget("number", "height", 512, () => {});
    this.addWidget("number", "batch_size", 1, () => {});
    this.addWidget("combo", "latent_type", defaultFormat, () => {});
    extension.nodeCreated(this);
  }
  addInput(name, type) { this.inputs.push({ name, type, link: null }); }
  addWidget(type, name, value, callback, options = {}) {
    const widget = { type, name, value, callback, options, computeSize: () => [0, 20] };
    this.widgets.push(widget);
    return widget;
  }
  computeSize() { return [340, this.widgets.reduce((height, widget) => height + (widget.computeSize?.()[1] ?? 20) + 4, 40)]; }
  setSize(size) { this.size = size; }
  setDirtyCanvas() {}
  widget(name) { return this.widgets.find((w) => w.name === name || w.__elipName === name); }
  choose(value) { const w = this.widget("latent_type"); w.value = value; w.callback(value); }
  connect(link = 42) {
    const i = this.inputs.findIndex((input) => input.name === "model");
    this.inputs[i].link = link;
    this.onConnectionsChange(1, i, link != null);
  }
  configure(data) {
    this.properties = clone(data.properties || {});
    this.inputs = clone(data.inputs || []);
    (data.widgets_values || []).forEach((value, i) => { if (this.widgets[i]) this.widgets[i].value = value; });
    this.onConfigure(data);
  }
  serialize() {
    const data = { type: this.comfyClass, inputs: clone(this.inputs), properties: clone(this.properties),
                   widgets_values: this.widgets.map((w) => w.value) };
    this.onSerialize(data);
    return clone(data);
  }
}

function legacy() {
  return { id: 82, type: "EmptyLatentImagePlus",
    inputs: [{ name: "width", type: "INT", widget: { name: "width" }, link: 100 },
             { name: "height", type: "INT", widget: { name: "height" }, link: null },
             { name: "batch_size", type: "INT", widget: { name: "batch_size" }, link: null }],
    widgets_values: [896, 1152, 1, true, null, "896x1152", "896x1152", null, null, null, null, "8", true, true, "896 x 1152 | 7:9 | 1.03 MP"],
    properties: { empty_latent_image_plus: { selected: "896x1152", userPresetOpen: true, advancedOpen: true } },
    outputs: [{ name: "LATENT", type: "LATENT", links: [125] }] };
}

test("new node keeps standard default; model connection auto and disconnect restores manual", () => {
  const node = new Node();
  assert.equal(node.widget("latent_type").value, defaultFormat);
  node.choose(manual);
  node.connect();
  assert.equal(node.widget("latent_type").value, "Auto");
  assert.equal(node.widget("latent_type").disabled, true);
  node.connect(null);
  assert.equal(node.widget("latent_type").value, manual);
  assert.equal(node.widget("latent_type").disabled, false);
});

test("connected MODEL cannot be bypassed by combo callback", () => {
  const node = new Node();
  node.connect();
  node.choose("Qwen Image 2.1 (64ch)");
  assert.equal(node.widget("latent_type").value, "Auto");
  node.connect(null);
  assert.equal(node.widget("latent_type").value, defaultFormat);
});

test("Auto without a model can remain explicitly selected", () => {
  const node = new Node();
  node.choose("Auto");
  assert.equal(node.widget("latent_type").value, "Auto");
  assert.equal(node.widget("latent_type").disabled, false);
});

test("legacy workflow inserts exactly one value, retaining sizes, links and custom widgets", () => {
  const old = legacy();
  const graph = { nodes: [clone(old)], links: [[100, 1, 0, 82, 0, "INT"]] };
  const links = clone(graph.links);
  extension.beforeConfigureGraph(graph);
  const migrated = graph.nodes[0];
  assert.deepEqual(migrated.widgets_values.slice(0, 3), old.widgets_values.slice(0, 3));
  assert.equal(migrated.widgets_values[3], defaultFormat);
  assert.deepEqual(migrated.widgets_values.slice(4), old.widgets_values.slice(3));
  assert.deepEqual(migrated.inputs.slice(0, 3), old.inputs);
  assert.equal(migrated.inputs[3].name, "model");
  assert.deepEqual(graph.links, links);
  const node = new Node();
  node.configure(migrated);
  assert.equal(node.widget("width").value, 896);
  assert.equal(node.widget("height").value, 1152);
  assert.equal(node.widget("swap_wh").value, true); // no extra swap during load
  assert.equal(node.widget("preset_name").value, "896x1152");
  assert.equal(node.widget("size_step").value, "8");
  assert.equal(node.widget("user_preset_fold").name, "▼ User Preset");
  assert.equal(node.widget("advanced_fold").name, "▼ Advanced");
});

test("clipboard configure without graph migration also restores the legacy widget order", () => {
  const node = new Node();
  node.configure(legacy());
  assert.equal(node.widget("latent_type").value, defaultFormat);
  assert.equal(node.widget("swap_wh").value, true);
  assert.equal(node.widget("preset_select").value, "896x1152");
  assert.equal(node.inputs.at(-1).name, "model");
});

test("migration is idempotent and visits subgraphs without altering other nodes", () => {
  const other = { type: "Other", widgets_values: [1, 2, 3, true] };
  const graph = { nodes: [clone(other)], definitions: { subgraphs: [{ nodes: [legacy()] }] } };
  extension.beforeConfigureGraph(graph);
  const once = clone(graph);
  extension.beforeConfigureGraph(graph);
  assert.deepEqual(clone(graph), once);
  assert.deepEqual(graph.nodes[0], other);
});

test("old API-style short widget array gains a default, unknown modern combo is not migrated", () => {
  const short = { type: "EmptyLatentImagePlus", widgets_values: [512, 768, 1] };
  const modern = { type: "EmptyLatentImagePlus", widgets_values: [512, 768, 1, "unknown"] };
  extension.beforeConfigureGraph({ nodes: [short, modern] });
  assert.equal(short.widgets_values[3], defaultFormat);
  assert.equal(modern.widgets_values[3], "unknown");
  assert.equal(modern.widgets_values.length, 4);
});

test("save and reload in Auto remembers manual choice for disconnect", () => {
  const node = new Node();
  node.choose(manual);
  node.connect();
  const data = node.serialize();
  extension.beforeConfigureGraph({ nodes: [data] });
  const restored = new Node();
  restored.configure(data);
  assert.equal(restored.widget("latent_type").value, "Auto");
  assert.equal(restored.widget("latent_type").disabled, true);
  restored.connect(null);
  assert.equal(restored.widget("latent_type").value, manual);
});

test("graph loading connection callbacks do not overwrite saved manual mode", () => {
  const node = new Node();
  node.choose(manual);
  node.connect();
  const data = node.serialize();
  const restored = new Node();
  app.configuringGraph = true;
  restored.properties = clone(data.properties);
  restored.inputs = clone(data.inputs);
  restored.onConnectionsChange(1, 0, true);
  restored.configure(data);
  app.configuringGraph = false;
  restored.connect(null);
  assert.equal(restored.widget("latent_type").value, manual);
});

test("manual choice survives serialization, swap works on both transitions", () => {
  const node = new Node();
  node.choose(manual);
  node.widget("width").value = 768;
  node.widget("height").value = 1024;
  node.widget("swap_wh").callback(true);
  assert.deepEqual([node.widget("width").value, node.widget("height").value], [1024, 768]);
  node.widget("swap_wh").callback(false);
  assert.deepEqual([node.widget("width").value, node.widget("height").value], [768, 1024]);
  const restored = new Node();
  restored.configure(node.serialize());
  assert.equal(restored.widget("latent_type").value, manual);
});

test("preset load keeps format/model link; saving still writes only the old fields", async () => {
  const node = new Node();
  await new Promise((resolve) => setImmediate(resolve));
  node.choose(manual);
  node.connect();
  node.widget("preset_select").value = "portrait";
  node.widget("preset_load").callback();
  assert.deepEqual([node.widget("width").value, node.widget("height").value], [1024, 1344]);
  assert.equal(node.widget("latent_type").value, "Auto");
  assert.equal(node.inputs.find((i) => i.name === "model").link, 42);
  node.widget("preset_name").value = "saved";
  await node.widget("preset_save").callback();
  assert.deepEqual(Object.keys(requests.at(-1).body).sort(), ["batch_size", "height", "name", "width"]);
  assert.equal(node.widget("latent_type").value, "Auto");
});

test("original user workflow node migrates without rewriting its file", { skip: !process.env.ELIP_LEGACY_WORKFLOW }, () => {
  const file = process.env.ELIP_LEGACY_WORKFLOW;
  const original = readFileSync(file, "utf8");
  const graph = JSON.parse(original);
  const old = clone(graph.nodes.find((n) => n.type === "EmptyLatentImagePlus"));
  extension.beforeConfigureGraph(graph);
  const node = new Node();
  node.configure(graph.nodes.find((n) => n.id === old.id));
  assert.deepEqual([node.widget("width").value, node.widget("height").value], old.widgets_values.slice(0, 2));
  assert.equal(node.widget("swap_wh").value, old.widgets_values[3]);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("Advanced and User Preset repeatedly expand with original sizing and stable widget identity", () => {
  const node = new Node();
  const widgets = node.widgets;
  for (const [fold, child] of [["advanced_fold", "size_step"], ["user_preset_fold", "preset_select"]]) {
    const collapsedHeight = node.size[1];
    for (let i = 0; i < 5; i++) {
      node.widget(fold).callback();
      assert.equal(node.widget(child).hidden, false);
      assert.equal(node.widget(child).type, "combo");
      assert.equal(typeof node.widget(child).computeSize, "function");
      assert.equal(node.widget(child).computeSize()[1], 20);
      assert.ok(node.size[1] > collapsedHeight);
      assert.equal(node.widgets, widgets);
      node.widget(fold).callback();
      assert.equal(node.widget(child).hidden, true);
      assert.equal(node.size[1], collapsedHeight);
      assert.equal(node.widgets, widgets);
    }
  }
});

test("Show Info remains hidden when disabled across Advanced collapse and reload", () => {
  const node = new Node();
  node.widget("advanced_fold").callback();
  node.widget("show_info").value = false;
  node.widget("show_info").callback(false);
  assert.equal(node.widget("info").hidden, true);
  node.widget("advanced_fold").callback();
  node.widget("advanced_fold").callback();
  assert.equal(node.widget("info").hidden, true);
  const restored = new Node();
  restored.configure(node.serialize());
  assert.equal(restored.widget("info").hidden, true);
  assert.equal(restored.widget("size_step").hidden, false);
});
