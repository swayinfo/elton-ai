/* ============================================================
 *  Test harness
 *
 *  The plugin is one file with everything at the top level of a
 *  single scope, and it exports only the Plugin class — which is
 *  the right shape to ship and the wrong shape to test. So the
 *  harness builds its own copy: the same main.js, with an export
 *  block appended, loaded against a stubbed Obsidian.
 *
 *  Nothing here changes what ships. If a test passes against this
 *  copy it passed against the real code, byte for byte, plus one
 *  line the loader added.
 * ========================================================== */

const fs = require("fs");
const path = require("path");
const os = require("os");
const Module = require("module");

const ROOT = path.join(__dirname, "..");

/* ── the stub ─────────────────────────────────────────────────
 * Only what main.js actually destructures. Classes must be real
 * classes: the plugin extends four of them at load time. */
class Component {
  registerEvent() {}
  registerInterval() {}
  registerDomEvent() {}
  addCommand() {}
  addRibbonIcon() {}
  addSettingTab() {}
  registerView() {}
  async loadData() { return {}; }
  async saveData() {}
}
class Plugin extends Component {
  constructor(app, manifest) { super(); this.app = app; this.manifest = manifest || { id: "elton-ai", dir: "." }; }
}
class ItemView extends Component {
  constructor(leaf) { super(); this.leaf = leaf; }
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class Modal { constructor(app) { this.app = app; this.contentEl = null; } open() {} close() {} }
class TFile { constructor(p) { this.path = p; this.extension = p.split(".").pop(); this.basename = path.basename(p, "." + this.extension); } }
class TFolder { constructor(p) { this.path = p; this.children = []; } }

class Setting {
  constructor(el) { this.settingEl = el; this.controlEl = el; }
  setName() { return this; } setDesc() { return this; } setHeading() { return this; }
  addText() { return this; } addTextArea() { return this; } addToggle() { return this; }
  addDropdown() { return this; } addButton() { return this; } addExtraButton() { return this; }
  addSlider() { return this; }
}

const OBSIDIAN_STUB = {
  Plugin, PluginSettingTab, Setting, ItemView, Modal, Component,
  TFile, TFolder,
  // Remembers what it was told, so a test can assert that a failure actually
  // reached the screen rather than only the console.
  // `setMessage` and `hide` are what a long-running notice uses to follow
  // along and then get out of the way.
  Notice: class {
    constructor(msg) { this.message = msg; (OBSIDIAN_STUB.Notice.seen ||= []).push(String(msg)); }
    setMessage(msg) { this.message = msg; (OBSIDIAN_STUB.Notice.seen ||= []).push(String(msg)); }
    hide() { this.hidden = true; }
  },
  normalizePath: (p) => String(p).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
  requestUrl: async () => { throw new Error("network is not available in tests"); },
  setIcon: () => {},
  MarkdownRenderer: { render: async () => {} },
  debounce: (fn) => fn,
  Platform: { isDesktop: true, isMobile: false },
};

/* ── the globals a browser would have ────────────────────── */
function installGlobals() {
  if (!global.window) global.window = global;
  if (!global.document) {
    global.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  }
  if (!global.navigator) global.navigator = { language: "ru" };
  if (!global.localStorage) global.localStorage = { getItem: () => "ru", setItem() {} };
  if (!global.IntersectionObserver) {
    global.IntersectionObserver = class { observe() {} disconnect() {} };
  }
  global.window.localStorage = global.localStorage;
  global.window.open = (url) => { installGlobals.lastOpened = url; return null; };
  global.window.setTimeout = setTimeout;
  global.window.setInterval = setInterval;
  if (!global.URL.createObjectURL) {
    global.URL.createObjectURL = () => "blob:test";
    global.URL.revokeObjectURL = () => {};
  }
  if (!global.Blob) global.Blob = class { constructor(parts) { this.parts = parts; } };
  if (!global.atob) global.atob = (s) => Buffer.from(s, "base64").toString("binary");
}

/* ── loading ─────────────────────────────────────────────────
 * The names below are the plugin's internals. Adding to this list
 * is how a new thing becomes testable. */
const EXPOSED = [
  "matchScenario", "scenarioPrompt", "normalizePhrase", "scenarioPresets", "newScenario",
  "defaultScenarios", "pinnedScenarios", "scenarioLabel",
  "buildTools", "Agent", "VaultBridge", "AIClient",
  "MODEL_CATALOG", "modelChoices", "canListModels",
  "DEFAULT_SETTINGS", "PROVIDERS", "stripMarkdown", "safeTitle", "todayKey",
  "t", "setLang", "VIEW_TYPE", "base64ToBytes", "WAITING_WAV_B64",
  "pickRecordingType", "formatFromMime", "RECORDING_TYPES", "EltonAI",
  "newStreamAcc", "foldStreamEvent", "readStreamChunk", "finishStreamAcc",
  "SpendTracker", "formatMoney",
  "Speaker", "speechChunks", "sentences", "Ambience", "AMBIENCE_REPEAT_MS",
  "builtinSkillsFor", "builtinSkillText", "BUILTIN_SKILLS",
  "fastModelFor", "FAST_MODELS", "AssistantView",
  "splitForTelegram", "hotkeyFromEvent", "hotkeyMatches", "hotkeyLabel", "TelegramBridge",
  "slugForCommand", "AutomationScheduler", "newAutomation", "siteUrl", "siteLabel",
];

/** Replay a captured SSE body through the parser, in chunks of `size` bytes. */
function replaySSE(text, size = 64) {
  const T = load();
  const acc = T.newStreamAcc();
  const deltas = [];
  let buffer = "";
  let handed = 0;
  for (let i = 0; i < text.length; i += size) {
    buffer = T.readStreamChunk(buffer + text.slice(i, i + size), (json) => {
      T.foldStreamEvent(acc, json);
    });
    if (acc.content.length > handed) { deltas.push(acc.content.slice(handed)); handed = acc.content.length; }
  }
  return { acc, msg: T.finishStreamAcc(acc), deltas };
}

function load() {
  installGlobals();

  const src = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  const exportBlock = "\n\nmodule.exports.__test = { " + EXPOSED.join(", ") + " };\n";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elton-ai-test-"));
  const file = path.join(dir, "plugin-under-test.js");
  fs.writeFileSync(file, src + exportBlock);

  // Give the copy an "obsidian" module to require, without touching anything
  // else Node loads.
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "obsidian") return OBSIDIAN_STUB;
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[file];
    return require(file).__test;
  } finally {
    Module._load = realLoad;
  }
}

/* ── fakes for the things a running Obsidian would provide ── */

/** A workspace with tabs in the main area, plus sidebars that must be ignored. */
function fakeWorkspace(tabs) {
  const leaves = tabs.map((t, i) => {
    const leaf = {
      _i: i,
      detached: false,
      getDisplayText: () => t.title,
      view: { getViewType: () => t.type || "markdown", file: t.path ? new TFile(t.path) : null },
      detach() { this.detached = true; },
      async openFile(f) { this.opened = f; },
      async setViewState(st) { this.viewState = st; },
    };
    return leaf;
  });
  return {
    leaves,
    rootSplit: { __root: true },
    // Only main-area leaves. A sidebar leaf never reaches this callback in
    // Obsidian, and the fake must not hand one over either.
    iterateRootLeaves(cb) { for (const l of this.leaves) if (!l.detached) cb(l); },
    getMostRecentLeaf() { return this.leaves.find((l) => !l.detached) || null; },
    getLeaf(kind) {
      const leaf = {
        created: kind || "current",
        async openFile(f) { this.opened = f; },
        async setViewState(st) { this.viewState = st; },
      };
      this.created = leaf;
      return leaf;
    },
    setActiveLeaf(leaf) { this.active = leaf; },
    getLeavesOfType() { return []; },
    on() { return {}; },
    onLayoutReady(cb) { cb(); },
    getActiveFile() { return null; },
  };
}

function fakeApp({ tabs = [], webviewer = true } = {}) {
  return {
    workspace: fakeWorkspace(tabs),
    vault: { getFiles: () => [], getAbstractFileByPath: () => null, on: () => ({}), adapter: {} },
    metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => null },
    internalPlugins: { getPluginById: (id) => (id === "webviewer" ? { enabled: webviewer } : null) },
    fileManager: {
      async trashFile() {},
      // The real one rewrites every link pointing at the file; the fake only
      // has to move it, so a test can see where it landed.
      async renameFile(f, to) { f.path = to; f.basename = to.split("/").pop().replace(/.md$/, ""); },
    },
  };
}

/** A plugin object with just enough on it for VaultBridge and Agent. */
function fakePlugin(app, settings) {
  const T = load();
  const s = Object.assign({}, T.DEFAULT_SETTINGS, settings || {});
  const plugin = { app, settings: s, manifest: { id: "elton-ai", dir: "." }, lastNote: null };
  plugin.vault = new T.VaultBridge(plugin);
  return plugin;
}

module.exports = { load, fakeApp, fakeWorkspace, fakePlugin, OBSIDIAN_STUB, TFile, installGlobals, replaySSE };
