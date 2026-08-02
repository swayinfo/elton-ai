/* ============================================================
 *  Type-ahead for paths
 *
 *  Typing a folder path from memory is how you end up with a
 *  setting that silently matches nothing — a trailing slash, the
 *  wrong dash, a folder you renamed last month. These fields
 *  suggest what actually exists, so a wrong path is hard to save.
 *
 *  Built on a plain dropdown rather than Obsidian's AbstractInput-
 *  Suggest: that class is not in every version this plugin
 *  supports, and a missing base class breaks the settings tab
 *  outright.
 * ========================================================== */

/** Subsequence match, so "5inb" finds "0. Files/5. Inbox". */
function fuzzyScore(needle, haystack) {
  const n = needle.toLowerCase(), h = haystack.toLowerCase();
  if (!n) return 1;
  const direct = h.indexOf(n);
  // A literal run beats a scattered match, and matching the last segment
  // (the folder's own name) beats matching some parent along the way.
  if (direct >= 0) {
    const tail = h.slice(h.lastIndexOf("/") + 1);
    return 1000 - direct + (tail.includes(n) ? 500 : 0) + (h.length === n.length ? 200 : 0);
  }
  let i = 0, score = 0, streak = 0;
  for (let j = 0; j < h.length && i < n.length; j++) {
    if (h[j] === n[i]) { i++; streak++; score += streak; }
    else streak = 0;
  }
  return i === n.length ? score : -1;
}

function fuzzyFilter(query, items, limit = 30) {
  if (!query) return items.slice(0, limit);
  return items
    .map((it) => ({ it, s: fuzzyScore(query, it) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.it.length - b.it.length)
    .slice(0, limit)
    .map((x) => x.it);
}

class PathSuggest {
  /**
   * @param input   the text field to attach to
   * @param getItems returns every candidate path
   * @param onPick  called with the chosen value
   */
  constructor(input, getItems, onPick) {
    this.input = input;
    this.getItems = getItems;
    this.onPick = onPick;
    this.open = false;
    this.index = 0;
    this.items = [];

    input.addClass("oa-suggest-input");
    input.setAttr("autocomplete", "off");
    input.addEventListener("input", () => this.show());
    input.addEventListener("focus", () => this.show());
    input.addEventListener("blur", () => window.setTimeout(() => this.hide(), 150));
    input.addEventListener("keydown", (e) => this.onKey(e));
  }

  show() {
    const q = this.input.value.trim();
    this.items = fuzzyFilter(q, this.getItems());
    if (!this.items.length) return this.hide();

    if (!this.el) {
      this.el = document.body.createDiv({ cls: "oa-suggest" });
      // Stop the blur handler firing before the click registers.
      this.el.addEventListener("mousedown", (e) => e.preventDefault());
    }
    this.el.empty();
    this.index = Math.min(this.index, this.items.length - 1);
    this.items.forEach((it, i) => {
      const row = this.el.createDiv({ cls: "oa-suggest-row" + (i === this.index ? " is-on" : "") });
      // Show the tail bold and the parent muted — you scan by folder name,
      // not by the path that leads to it.
      const cut = it.lastIndexOf("/");
      if (cut > 0) {
        row.createSpan({ cls: "oa-suggest-dim", text: it.slice(0, cut + 1) });
        row.createSpan({ text: it.slice(cut + 1) });
      } else row.createSpan({ text: it });
      row.onclick = () => this.pick(it);
    });

    const r = this.input.getBoundingClientRect();
    this.el.style.left = r.left + "px";
    this.el.style.top = (r.bottom + 4) + "px";
    this.el.style.width = r.width + "px";
    this.open = true;
  }

  hide() {
    this.open = false;
    if (this.el) { this.el.remove(); this.el = null; }
  }

  pick(value) {
    this.input.value = value;
    this.hide();
    this.onPick(value);
  }

  onKey(e) {
    if (!this.open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); this.index = (this.index + 1) % this.items.length; this.show(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); this.index = (this.index - 1 + this.items.length) % this.items.length; this.show(); }
    else if (e.key === "Enter" && this.items[this.index]) { e.preventDefault(); this.pick(this.items[this.index]); }
    else if (e.key === "Escape") this.hide();
  }
}

/** Every folder in the vault, root first. */
function allFolders(app) {
  const out = [""];
  const walk = (f) => {
    for (const c of f.children || []) {
      if (c instanceof TFolder) { out.push(c.path); walk(c); }
    }
  };
  walk(app.vault.getRoot());
  return out.sort();
}

/** Files matching an extension, for pointing at an index or a note. */
function allFiles(app, ext) {
  return app.vault.getFiles()
    .filter((f) => !ext || f.extension === ext)
    .map((f) => f.path)
    .sort();
}

/**
 * A folder name as a person says it, resolved to a real path.
 * "inbox", "входящие", "5. Inbox" all have to land on the same folder —
 * the model does not know how the vault is numbered.
 */
const FOLDER_WORDS = {
  inbox: ["inbox", "входящие", "входящее", "вхідні"],
  daily: ["daily", "journal", "diary", "дневник", "дневники", "ежедневные", "ежедневник"],
  archive: ["archive", "архив"],
  templates: ["template", "templates", "шаблон", "шаблоны"],
  projects: ["project", "projects", "проект", "проекты"],
  areas: ["area", "areas", "сферы", "области"],
  resources: ["resource", "resources", "ресурсы", "материалы"],
  notes: ["note", "notes", "заметки"],
};

function resolveFolder(app, spoken, inScope) {
  const raw = String(spoken || "").trim().replace(/^\/+|\/+$/g, "");
  if (!raw) return null;
  const folders = allFolders(app).filter((p) => p && (!inScope || inScope(p)));

  const exact = folders.find((p) => p.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;

  // The last segment is what people name: "Inbox", not "0. Files/5. Inbox".
  const tail = (p) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
  const low = raw.toLowerCase();

  const byTail = folders.find((p) => tail(p) === low)
    || folders.find((p) => tail(p).replace(/^[\d.\s]+/, "") === low);
  if (byTail) return byTail;

  // Same idea across languages: "входящие" should find the Inbox folder.
  for (const words of Object.values(FOLDER_WORDS)) {
    if (!words.includes(low)) continue;
    const hit = folders.find((p) => words.some((w) => tail(p).replace(/^[\d.\s]+/, "").startsWith(w)));
    if (hit) return hit;
  }

  const fuzzy = fuzzyFilter(raw, folders, 1);
  return fuzzy[0] || null;
}
