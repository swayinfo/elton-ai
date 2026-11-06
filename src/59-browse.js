/* ============================================================
 *  Browsing the vault from the phone
 *
 *  The app's Feed and Folders tabs. No model is involved: these
 *  are plain reads, answered at once and never queued behind an
 *  assistant turn that is still thinking.
 *
 *  What it shows is exactly what the assistant may read and
 *  nothing more — private folders and anything outside the
 *  working scope do not exist here, not even as names.
 * ========================================================== */

const BROWSE_KINDS = new Set(["vault.tree", "vault.note", "vault.feed", "vault.img", "vault.undo", "vault.changes", "vault.recent"]);

/* Folders that are the vault's machinery rather than its content. */
const BROWSE_SKIP_TOP = new Set([".obsidian", ".trash", ".git"]);

/* The same order Obsidian's explorer uses for names: digits as numbers, so
   "2. Areas" comes before "10. Archive", and case does not matter. */
const browseCollator = (() => {
  try { return new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }); }
  catch { return { compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0) }; }
})();

/** A tiny seeded shuffle, so a feed page asked for twice comes back the same. */
function browseShuffle(list, seed) {
  let x = 0;
  for (let i = 0; i < seed.length; i++) x = (x * 31 + seed.charCodeAt(i)) >>> 0;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const BROWSE_IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);

class VaultBrowser {
  constructor(plugin) {
    this.plugin = plugin;
    this._deck = null;           // { key, list } — eligible notes for the feed
  }

  get app() { return this.plugin.app; }
  get V() { return this.plugin.vault; }
  get s() { return this.plugin.settings; }

  /** May the phone see this path at all? */
  visible(path) {
    const p = String(path || "");
    const top = p.split("/")[0];
    if (BROWSE_SKIP_TOP.has(top)) return false;
    if (!this.s.canRead) return false;
    return this.V.inScope(p);
  }

  /** The explorer's own sort order, when it can be read. */
  sortOrder() {
    try {
      const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
      const o = leaf && leaf.view && leaf.view.sortOrder;
      if (o) return o;
    } catch { /* no explorer open */ }
    return "alphabetical";
  }

  /**
   * Every folder and file name, without a word of content.
   *
   * Sent once and kept on the phone; `v` is a fingerprint of the whole thing,
   * so asking again with the same `v` costs a few bytes instead of the list.
   */
  tree(known) {
    const order = this.sortOrder();
    const byName = (a, b) => browseCollator.compare(a.name, b.name);
    const byFile = {
      alphabetical: byName,
      alphabeticalReverse: (a, b) => -byName(a, b),
      byModifiedTime: (a, b) => (b.stat.mtime - a.stat.mtime),
      byModifiedTimeReverse: (a, b) => (a.stat.mtime - b.stat.mtime),
      byCreatedTime: (a, b) => (b.stat.ctime - a.stat.ctime),
      byCreatedTimeReverse: (a, b) => (a.stat.ctime - b.stat.ctime),
    }[order] || byName;
    const byFolder = order === "alphabeticalReverse" ? (a, b) => -byName(a, b) : byName;

    const folders = [];
    const files = [];
    const walk = (folder, depth) => {
      const idx = folders.length;
      folders.push(folder.path === "/" ? "" : folder.path);
      const kids = folder.children || [];
      const subs = kids.filter((k) => k instanceof TFolder && this.visible(k.path)).sort(byFolder);
      const own = kids.filter((k) => k instanceof TFile && this.visible(k.path)).sort(byFile);
      for (const f of own) {
        files.push([idx, f.name, Math.round(f.stat.mtime / 1000)]);
      }
      if (depth < 30) for (const sub of subs) walk(sub, depth + 1);
    };
    walk(this.app.vault.getRoot(), 0);
    const v = memHash(JSON.stringify([folders, files.length, files.reduce((n, f) => n + f[2], 0), order]));
    if (known && known === v) return { same: true, v };
    return { v, vault: this.app.vault.getName(), order, folders, files };
  }

  file(path) {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(String(path || "")));
    return f instanceof TFile && this.visible(f.path) ? f : null;
  }

  /**
   * Where each link in a note points. The phone draws [[links]] it can open,
   * and needs to know which ones go anywhere — and where.
   */
  linkMap(f) {
    const cache = this.app.metadataCache.getFileCache(f) || {};
    const out = {};
    for (const l of (cache.links || []).concat(cache.embeds || [])) {
      const raw = String(l.link || "");
      const target = raw.split("#")[0].split("|")[0];
      if (!target || out[raw] !== undefined) continue;
      const dest = this.app.metadataCache.getFirstLinkpathDest(target, f.path);
      out[raw] = dest && this.visible(dest.path) ? dest.path : null;
    }
    return out;
  }

  async note(path) {
    const f = this.file(path);
    if (!f) return { error: "hidden" };
    if (f.extension !== "md") {
      return { path: f.path, title: f.basename, ext: f.extension, mtime: f.stat.mtime, text: "" };
    }
    const text = await this.app.vault.cachedRead(f);
    const LIMIT = 400000;
    return {
      path: f.path,
      title: f.basename,
      ext: "md",
      mtime: f.stat.mtime,
      ctime: f.stat.ctime,
      text: text.length > LIMIT ? text.slice(0, LIMIT) : text,
      cut: text.length > LIMIT,
      links: this.linkMap(f),
    };
  }

  /** Notes worth showing in a feed: real writing, not machinery. */
  eligible() {
    const key = this.app.vault.getMarkdownFiles().length + "|" + (this.s.privateFolders || "")
      + "|" + (this.s.scopeFolders || "") + "|" + this.s.scopeMode;
    if (this._deck && this._deck.key === key && Date.now() - this._deck.at < 10 * 60e3) return this._deck.list;
    const tpl = (this.V.templateFolder && this.V.templateFolder()) || "";
    const list = this.app.vault.getMarkdownFiles()
      .filter((f) => this.visible(f.path))
      .filter((f) => !(tpl && (f.path === tpl || f.path.startsWith(tpl + "/"))))
      .filter((f) => f.stat.size > 220)
      .map((f) => f.path)
      .sort();
    this._deck = { key, list, at: Date.now() };
    return list;
  }

  /** The note as a card: its opening, its first picture, where it lives. */
  async card(path) {
    const f = this.file(path);
    if (!f) return null;
    let raw = "";
    try { raw = await this.app.vault.cachedRead(f); } catch { return null; }
    // Line endings first: a note saved on Windows keeps \r, and the
    // properties block would then survive into the card.
    const body = raw.replace(/\r\n?/g, "\n").replace(/^\uFEFF?---\n[\s\S]*?\n---\n?/, "");
    // Lines that are machinery: button blocks, dataview, empty headings.
    const lines = body.split("\n");
    const kept = [];
    let fence = false;
    for (const ln of lines) {
      if (/^\s*(```|~~~)/.test(ln)) { fence = !fence; continue; }
      if (fence) continue;
      if (/^\s*%%/.test(ln)) continue;
      // A row of `button-…` blocks, a bare rule, an inline query: machinery.
      if (/^\s*(`[^`]+`\s*)+$/.test(ln)) continue;
      if (/^\s*([-*_])\1{2,}\s*$/.test(ln)) continue;
      if (/^\s*[\w-]+::\s*`?=/.test(ln)) continue;
      kept.push(ln);
    }
    // The card already shows the title; a first heading repeating it is noise.
    while (kept.length && !kept[0].trim()) kept.shift();
    if (kept.length && /^#{1,6}\s+/.test(kept[0])
      && kept[0].replace(/^#{1,6}\s+/, "").trim().toLowerCase() === f.basename.trim().toLowerCase()) kept.shift();
    const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text.replace(/\s/g, "").length < 60) return null;
    const cache = this.app.metadataCache.getFileCache(f) || {};
    let cover = null;
    for (const e of cache.embeds || []) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(String(e.link).split("#")[0].split("|")[0], f.path);
      if (dest && BROWSE_IMG.has(String(dest.extension).toLowerCase()) && this.visible(dest.path)) { cover = dest.path; break; }
    }
    const tags = [];
    try {
      const fmTags = cache.frontmatter && cache.frontmatter.tags;
      (Array.isArray(fmTags) ? fmTags : fmTags ? [fmTags] : []).forEach((x) => tags.push(String(x).replace(/^#/, "")));
      (cache.tags || []).forEach((x) => tags.push(String(x.tag).replace(/^#/, "")));
    } catch { /* tags are decoration */ }
    return {
      path: f.path,
      title: f.basename,
      folder: f.parent && f.parent.path !== "/" ? f.parent.path : "",
      mtime: f.stat.mtime,
      excerpt: text.slice(0, 1600),
      more: text.length > 1600,
      cover,
      tags: [...new Set(tags)].slice(0, 4),
      links: this.linkMap(f),
    };
  }

  /**
   * A page of the feed.
   *
   * The order is a shuffle of the whole vault, seeded by the phone, so a page
   * asked for again is the same page and nothing repeats until every note
   * has had its turn. The phone remembers where it stopped.
   */
  async feed({ seed = "x", from = 0, n = 10 } = {}) {
    const deck = browseShuffle(this.eligible(), String(seed));
    const items = [];
    let i = Math.max(0, Number(from) || 0);
    // Skip what will not make a card — a note that is all buttons, say —
    // without making the phone ask again.
    while (items.length < Math.min(20, Math.max(1, n)) && i < deck.length) {
      const c = await this.card(deck[i]);
      i++;
      if (c) items.push(c);
    }
    return { items, next: i, total: deck.length, done: i >= deck.length };
  }

  /**
   * A picture, shrunk to what a phone screen needs.
   * A photo from a camera is megabytes; through the relay goes a JPEG a few
   * hundred pixels wide. SVG and GIF go as they are — redrawing them would
   * lose the drawing or the motion.
   */
  async img({ path, link, from, w = 900 }) {
    let f = path ? this.file(path) : null;
    if (!f && link) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(String(link).split("#")[0].split("|")[0], from || "");
      f = dest && this.visible(dest.path) ? dest : null;
    }
    if (!f || !BROWSE_IMG.has(String(f.extension).toLowerCase())) return { error: "hidden" };
    const bin = await this.app.vault.readBinary(f);
    const ext = String(f.extension).toLowerCase();
    const rawMime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : "image/" + ext;
    const asIs = () => ({ path: f.path, mime: rawMime, data: browseB64(bin) });
    if (ext === "svg" || ext === "gif") return bin.byteLength < 700000 ? asIs() : { error: "big" };
    try {
      const blob = new Blob([bin], { type: rawMime });
      const bmp = await createImageBitmap(blob);
      const side = Math.max(160, Math.min(1400, Number(w) || 900));
      const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const cw = Math.max(1, Math.round(bmp.width * k));
      const ch = Math.max(1, Math.round(bmp.height * k));
      const cv = document.createElement("canvas");
      cv.width = cw; cv.height = ch;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(bmp, 0, 0, cw, ch);
      if (bmp.close) bmp.close();
      let q = 0.78;
      let url = cv.toDataURL("image/jpeg", q);
      while (url.length > 520000 && q > 0.4) { q -= 0.12; url = cv.toDataURL("image/jpeg", q); }
      return { path: f.path, mime: "image/jpeg", data: url.split(",")[1] || "", w: bmp.width, h: bmp.height };
    } catch {
      return bin.byteLength < 500000 ? asIs() : { error: "big" };
    }
  }

  /**
   * The row of circles above the feed: today's note first, then whatever was
   * written in most recently. What someone opens the app for, one tap away.
   */
  recent(n = 12) {
    let today = null;
    try {
      const d = this.V.dailyNote && this.V.dailyNote("today");
      if (d && this.visible(d.path)) today = { path: d.path, title: d.basename, mtime: d.stat.mtime };
    } catch { /* no daily notes in this vault */ }
    const items = this.app.vault.getMarkdownFiles()
      .filter((f) => this.visible(f.path) && (!today || f.path !== today.path))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, Math.max(1, Math.min(30, n)))
      .map((f) => ({ path: f.path, title: f.basename, mtime: f.stat.mtime, folder: f.parent && f.parent.path !== "/" ? f.parent.path : "" }));
    return { today, items };
  }

  async changes(n = 30) {
    const J = this.plugin.journal;
    if (!J) return { items: [] };
    const list = await J.listShown(n);
    return {
      items: list.filter((e) => this.visible(e.path) || e.kind === "delete").map((e) => ({
        id: e.id, at: e.at, kind: e.kind, path: e.path, from: e.from || "", title: e.title,
        undone: !!e.undone, channel: e.channel || "",
      })),
    };
  }

  async undo({ id, force }) {
    const J = this.plugin.journal;
    if (!J) return { ok: false, text: t("Nothing to undo") };
    return await J.undo(id, { force: !!force });
  }

  /** One entry point for the connector: kind + JSON in, JSON out. */
  async handle(kind, payload) {
    let args = {};
    try { args = payload ? JSON.parse(payload) : {}; } catch { args = {}; }
    if (!this.s.canRead && kind !== "vault.undo" && kind !== "vault.changes") return { error: "no-read" };
    switch (kind) {
      case "vault.tree": return this.tree(args.v);
      case "vault.note": return await this.note(args.path);
      case "vault.feed": return await this.feed(args);
      case "vault.img": return await this.img(args);
      case "vault.changes": return await this.changes(args.n);
      case "vault.recent": return this.recent(args.n);
      case "vault.undo": return await this.undo(args);
      default: return { error: "unknown" };
    }
  }
}

function browseB64(buf) {
  const a = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < a.length; i += 8192) out += String.fromCharCode.apply(null, a.subarray(i, i + 8192));
  return btoa(out);
}
