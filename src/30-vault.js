/* ============================================================
 *  Vault access — scope, search, edits
 *
 *  Everything the assistant does to notes goes through this class,
 *  which is also where the permission settings are enforced. The
 *  model is never trusted to respect them: a tool call for a note
 *  outside the allowed folders is refused here, not in the prompt.
 * ========================================================== */

const STOPWORDS = new Set(
  ("и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам сказал ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто человек чего раз тоже себе под жизнь будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее кажется сейчас были куда зачем сказать всех никогда сегодня можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве三 эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между " +
   "the a an and or but if then else for to of in on at by with from as is are was were be been being it its this that these those i you he she we they me him her them my your his their our not no yes do does did have has had will would can could should may might must about into over under again more most other some such only own same so than too very just now here there what which who whom when where why how all any both each few nor own s t don t s")
    .split(/\s+/).filter(Boolean)
);

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

class VaultBridge {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.index = null;        // BM25, built lazily, lives for the session
    this.indexing = false;
    this.undoStack = [];      // {path, before} — powers "undo that"
  }

  get s() { return this.plugin.settings; }

  /* ── scope ──────────────────────────────────────────────── */
  scopeList() {
    return String(this.s.scopeFolders || "")
      .split("\n").map((x) => x.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
  }

  /** Folders the assistant must never read, whatever else is configured. */
  privateList() {
    return String(this.s.privateFolders || "")
      .split("\n").map((x) => x.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
  }

  /**
   * Is this path private?
   *
   * Separate from the working scope on purpose. Scope answers "where should it
   * work" and has three modes that exclude each other — you cannot say "work
   * only in Projects" AND "never look in Health" with one setting. This answers
   * a different question, "what must never leave this machine", and it wins
   * over everything: scope, the note open on screen, search, the index.
   */
  isPrivate(path) {
    const list = this.privateList();
    if (!list.length) return false;
    const p = String(path || "");
    return list.some((f) => p === f || p.startsWith(f + "/"));
  }

  /** Is this path inside what the user allowed the assistant to touch? */
  inScope(path) {
    // First, and regardless of mode. Everything that reads a note goes through
    // here, so this one line is what makes "private" mean private.
    if (this.isPrivate(path)) return false;
    const mode = this.s.scopeMode;
    if (mode === "all") return true;
    const list = this.scopeList();
    if (!list.length) return mode === "exclude";
    const hit = list.some((f) => path === f || path.startsWith(f + "/"));
    return mode === "include" ? hit : !hit;
  }

  files() {
    return this.app.vault.getMarkdownFiles().filter((f) => this.inScope(f.path));
  }

  /** Resolve a model-supplied path leniently — it often gives a title. */
  resolve(pathOrTitle) {
    const raw = String(pathOrTitle || "").trim().replace(/^\[\[|\]\]$/g, "");
    if (!raw) return null;
    const direct = this.app.vault.getAbstractFileByPath(normalizePath(raw));
    if (direct instanceof TFile && this.inScope(direct.path)) return direct;
    const withExt = this.app.vault.getAbstractFileByPath(normalizePath(raw.endsWith(".md") ? raw : raw + ".md"));
    if (withExt instanceof TFile && this.inScope(withExt.path)) return withExt;
    const want = raw.replace(/\.md$/i, "").toLowerCase();
    const all = this.files();
    return all.find((f) => f.basename.toLowerCase() === want)
        || all.find((f) => f.basename.toLowerCase().includes(want))
        || null;
  }

  /* ── keyword search (BM25) ──────────────────────────────── */
  async buildIndex() {
    if (this.indexing) return;
    this.indexing = true;
    try {
      const files = this.files();
      const docs = [];
      const df = new Map();
      for (const f of files) {
        let text = "";
        try { text = await this.app.vault.cachedRead(f); } catch { continue; }
        // The title is worth more than a body mention, so it goes in twice.
        const terms = tokenize(f.basename + " " + f.basename + " " + stripMarkdown(text).slice(0, 20000));
        if (!terms.length) continue;
        const tf = new Map();
        for (const w of terms) tf.set(w, (tf.get(w) || 0) + 1);
        for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
        docs.push({ path: f.path, title: f.basename, tf, len: terms.length });
      }
      const avg = docs.reduce((a, d) => a + d.len, 0) / (docs.length || 1);
      this.index = { docs, df, avg, n: docs.length };
    } finally { this.indexing = false; }
  }

  async keywordSearch(query, limit = 8) {
    if (!this.index) await this.buildIndex();
    const idx = this.index;
    if (!idx || !idx.docs.length) return [];
    const qs = tokenize(query);
    if (!qs.length) return [];
    const k1 = 1.5, b = 0.75;
    const scored = [];
    for (const d of idx.docs) {
      let score = 0;
      for (const w of qs) {
        const f = d.tf.get(w);
        if (!f) continue;
        const n = idx.df.get(w) || 1;
        const idf = Math.log(1 + (idx.n - n + 0.5) / (n + 0.5));
        score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / idx.avg));
      }
      if (score > 0) scored.push({ path: d.path, title: d.title, score });
    }
    return scored.sort((a, b2) => b2.score - a.score).slice(0, limit);
  }

  /* ── meaning-based search (optional) ────────────────────── */
  cachePath() {
    return this.s.embedIndexPath
      ? normalizePath(this.s.embedIndexPath)
      : normalizePath(this.plugin.manifest.dir + "/embeddings.json");
  }

  /**
   * Read the vector off an entry, whichever tool wrote it.
   * Indexes built by the older vault scripts store it under `embedding`;
   * this plugin writes `v`. Reading both is what lets an existing index be
   * reused instead of rebuilt at the user's expense.
   */
  static vectorOf(entry) {
    if (!entry) return null;
    const v = entry.v || entry.embedding || null;
    return Array.isArray(v) && v.length ? v : null;
  }

  async loadEmbeddings() {
    if (this._emb && this._embFrom === this.cachePath()) return this._emb;
    try {
      const p = this.cachePath();
      this._embFrom = p;
      if (await this.app.vault.adapter.exists(p)) {
        this._emb = JSON.parse((await this.app.vault.adapter.read(p)) || "{}");
      } else this._emb = {};
    } catch (e) {
      console.warn("[Elton AI] could not read the index:", e.message);
      this._emb = {};
    }
    return this._emb;
  }

  /** How many usable vectors an index holds — for the settings readout. */
  async indexSize(path) {
    try {
      const p = normalizePath(path || this.cachePath());
      if (!(await this.app.vault.adapter.exists(p))) return 0;
      const j = JSON.parse((await this.app.vault.adapter.read(p)) || "{}");
      return Object.values(j).filter((e) => VaultBridge.vectorOf(e)).length;
    } catch { return 0; }
  }

  /* Throws on purpose. A swallowed write is the worst failure this file has:
     the run looks like it worked, the count never moves, and the only way to
     find out is to read the console. Let the caller say so out loud. */
  async saveEmbeddings() {
    await this.app.vault.adapter.write(this.cachePath(), JSON.stringify(this._emb || {}));
  }

  /** An index this plugin did not create is never written to. */
  get indexIsBorrowed() { return !!this.s.embedIndexPath; }

  /** Notes that have no vector yet, or whose vector is older than the file. */
  /**
   * Folders left out of the index.
   *
   * Weaker than private, and deliberately so: these notes can still be read
   * when you ask for them by name. They are simply not swept up wholesale and
   * sent away one by one, which is what indexing is. Useful for a big archive
   * you don't want to pay to embed as much as for anything delicate.
   */
  noIndexList() {
    return String(this.s.noIndexFolders || "")
      .split("\n").map((x) => x.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
  }

  indexable(path) {
    const list = this.noIndexList();
    if (!list.length) return true;
    const p = String(path || "");
    return !list.some((f) => p === f || p.startsWith(f + "/"));
  }

  pendingEmbeddings(cache) {
    return this.files().filter((f) => this.indexable(f.path)).filter((f) => {
      const e = cache[f.path];
      if (!e) return true;
      if (e.mtime !== f.stat.mtime) return true;
      // An entry that is neither a vector nor a deliberate skip is unusable.
      return !VaultBridge.vectorOf(e) && !e.skip;
    });
  }

  /** How many notes are waiting to be embedded — for the settings readout. */
  async pendingCount() {
    try { return this.pendingEmbeddings(await this.loadEmbeddings()).length; }
    catch { return 0; }
  }

  /**
   * Embed everything new or changed, leaving everything else alone.
   *
   * This works on a borrowed index too, which it did not used to. Refusing
   * outright was the safe reading of "don't break the script that owns this
   * file", but it left no way to pick up notes written since — the index just
   * quietly went stale and the assistant stopped finding recent thinking.
   *
   * Nothing is rewritten or deleted here: entries already in the file are
   * never touched, and missing notes are added in BOTH shapes — `v` for this
   * plugin and `embedding` for the vault scripts — so whichever tool reads the
   * file next finds what it expects.
   *
   * Returns a tally rather than a bare count. "Indexing finished" over a run
   * where every single request failed is the exact lie this whole method used
   * to tell: the failures went to the console, the button kept offering the
   * same notes, and nothing on screen ever explained why.
   */
  async buildEmbeddings(onProgress, shouldStop) {
    const borrowed = this.indexIsBorrowed;
    const cache = await this.loadEmbeddings();
    const files = this.files();

    // Only prune when the file is ours. In a borrowed index a path we cannot
    // see may simply be outside our scope, and dropping it would silently
    // destroy work another tool paid for.
    if (!borrowed) {
      const live = new Set(files.map((f) => f.path));
      for (const p of Object.keys(cache)) if (!live.has(p)) delete cache[p];
    }

    const todo = this.pendingEmbeddings(cache);
    const tally = { done: 0, total: todo.length, embedded: 0, skipped: 0, failed: 0, error: "", stopped: false };
    let streak = 0;

    for (const f of todo) {
      if (shouldStop && shouldStop()) { tally.stopped = true; break; }
      try {
        const raw = await this.app.vault.cachedRead(f);
        const body = stripMarkdown(raw);
        // A near-empty note has no meaning to embed; its vector would be
        // noise that matches everything.
        if (body.replace(/\s/g, "").length < 80) {
          cache[f.path] = { mtime: f.stat.mtime, skip: true };
          tally.skipped++;
        } else {
          const v = await this.plugin.ai.embed(f.basename + "\n" + body.slice(0, 8000));
          const entry = { mtime: f.stat.mtime, title: f.basename, v };
          // Written twice on purpose — see above. The duplicate costs disk,
          // not correctness, and only for notes this plugin added.
          if (borrowed) entry.embedding = v;
          cache[f.path] = entry;
          tally.embedded++;
        }
        streak = 0;
      } catch (e) {
        tally.failed++;
        streak++;
        if (!tally.error) tally.error = e.message;
        console.warn("[Elton AI] embed failed", f.path, e.message);
        // A provider that has said no five times running will say no two
        // thousand times running. Stop and report instead of spending the
        // next twenty minutes proving it.
        if (streak >= 5) { tally.stopped = true; break; }
      }
      tally.done++;
      if (onProgress) onProgress(tally.done, todo.length);
      // The index can be tens of megabytes, and it is rewritten whole. Every
      // ten notes turned that into gigabytes of writing for one pass.
      if (tally.done % 50 === 0) await this.saveEmbeddings();
    }

    await this.saveEmbeddings();
    return tally;
  }

  async semanticSearch(query, limit = 8) {
    const cache = await this.loadEmbeddings();
    const entries = [];
    for (const [path, e] of Object.entries(cache)) {
      const v = VaultBridge.vectorOf(e);
      // A borrowed index covers the whole vault; the scope setting still
      // applies, so filter it here rather than trusting the file.
      if (v && this.inScope(path)) entries.push({ path, title: e.title, v });
    }
    if (!entries.length) return [];
    let qv;
    try { qv = await this.plugin.ai.embed(query); } catch { return []; }
    // Vectors from another tool may come from a different model. Comparing
    // across dimensions is meaningless, so say so instead of ranking noise.
    const dim = entries[0].v.length;
    if (qv.length !== dim) {
      console.warn(`[Elton AI] the index holds ${dim}-dimension vectors but the embedding model returns ${qv.length} — falling back to word search`);
      return [];
    }
    return entries
      .map((e) => ({ path: e.path, title: e.title, score: cosine(qv, e.v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Keyword always; meaning too when enabled. Merged, best rank wins. */
  async search(query, limit = 6) {
    const kw = await this.keywordSearch(query, limit * 2);
    let sem = [];
    if (this.s.semanticSearch) {
      try { sem = await this.semanticSearch(query, limit * 2); } catch {}
    }
    const merged = new Map();
    // Reciprocal-rank fusion: it combines two scores that aren't on the same
    // scale without needing either to be normalised.
    const add = (list, weight) => list.forEach((r, i) => {
      const cur = merged.get(r.path) || { path: r.path, title: r.title, score: 0 };
      cur.score += weight / (i + 2);
      merged.set(r.path, cur);
    });
    add(kw, 1);
    add(sem, 1);
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /* ── glob + text search ─────────────────────────────────── */
  /**
   * A pattern as a model writes it, made to behave.
   * Two shapes used to silently return nothing: a bare "*name*" only ever
   * matched the vault root because one star does not cross "/", and
   * "[Nn]ame" is a regex class rather than a glob.
   */
  static normalizeGlob(pattern) {
    let p = String(pattern || "").replace(/^\/+/, "");
    if (!p) return "**/*";
    if (!p.includes("/") && !p.startsWith("**")) p = "**/" + p;
    return p;
  }

  static globToRegex(pattern) {
    const p = VaultBridge.normalizeGlob(pattern);
    const esc = (c) => c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    let re = "";
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === "*") {
        if (p[i + 1] === "*") { re += ".*"; i++; if (p[i + 1] === "/") i++; }
        else re += "[^/]*";
      } else if (c === "?") re += "[^/]";
      else if (c === "[") {
        const end = p.indexOf("]", i + 1);
        if (end === -1) { re += esc(c); continue; }
        let cls = p.slice(i + 1, end);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        re += "[" + cls + "]";
        i = end;
      } else re += esc(c);
    }
    return new RegExp("^" + re + "$", "i");
  }

  listByGlob(pattern, limit = 100) {
    const re = VaultBridge.globToRegex(pattern);
    return this.files().filter((f) => re.test(f.path)).slice(0, limit);
  }

  /** Literal or regex text search across notes, with line numbers. */
  async grep(query, glob, max = 40) {
    let re;
    try { re = new RegExp(query, "i"); }
    catch { re = new RegExp(String(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
    const gre = glob ? VaultBridge.globToRegex(glob) : null;
    const hits = [];
    for (const f of this.files()) {
      if (hits.length >= max) break;
      if (gre && !gre.test(f.path)) continue;
      let text;
      try { text = await this.app.vault.cachedRead(f); } catch { continue; }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (re.test(lines[i])) hits.push({ path: f.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }
    return hits;
  }

  /** A folder as a person names it → the real path. */
  folder(spoken) {
    return resolveFolder(this.app, spoken, (p) => this.inScope(p));
  }

  /* ── reads ──────────────────────────────────────────────── */
  async read(file, maxChars = 6000) {
    const raw = await this.app.vault.cachedRead(file);
    const body = stripMarkdown(raw);
    return body.length > maxChars ? body.slice(0, maxChars) + "\n…" : body;
  }

  async snippet(file, query, len = 400) {
    const body = stripMarkdown(await this.app.vault.cachedRead(file));
    const words = tokenize(query);
    const low = body.toLowerCase();
    let at = -1;
    for (const w of words) { const i = low.indexOf(w); if (i >= 0) { at = i; break; } }
    if (at < 0) return body.slice(0, len);
    const start = Math.max(0, at - Math.floor(len / 3));
    return (start ? "…" : "") + body.slice(start, start + len) + "…";
  }

  /* ── writes ─────────────────────────────────────────────── */
  async ensureFolder(path) {
    const p = normalizePath(path);
    if (!p || p === "/") return;
    if (!this.app.vault.getAbstractFileByPath(p)) {
      try { await this.app.vault.createFolder(p); } catch {}
    }
  }

  async createNote(title, content, folder) {
    // The model passes a folder the way the user said it; map it onto a
    // real one, and fall back to the configured default.
    const asked = folder ? this.folder(folder) : null;
    const dir = normalizePath(asked || (folder ? folder : "") || this.s.newNoteFolder || "");
    if (dir) await this.ensureFolder(dir);
    let base = safeTitle(title);
    let path = normalizePath((dir ? dir + "/" : "") + base + ".md");
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath((dir ? dir + "/" : "") + base + " " + n++ + ".md");
    }
    if (!this.inScope(path)) throw new Error("out-of-scope");
    return await this.app.vault.create(path, String(content || ""));
  }

  /**
   * What the notes already in a folder have in common.
   *
   * A vault's conventions are not written down anywhere — that a project note
   * carries a link back to its MOC lives only in the other project notes. The
   * model cannot guess it and had no way to look, so every note it created
   * came out orphaned. This reads a handful of neighbours and reports the
   * properties they share, which is the convention, stated by the vault itself
   * rather than hard-coded for one person's setup.
   */
  folderConventions(dir, sample = 8) {
    try { return this._folderConventions(dir, sample); }
    // Nothing here is worth failing a created note over: this is a hint on
    // the end of a tool result, not the result itself.
    catch { return ""; }
  }

  _folderConventions(dir, sample) {
    const folder = normalizePath(dir || "");
    if (!folder) return "";
    const near = this.files()
      .filter((f) => f.path.startsWith(folder + "/"))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, sample);
    if (near.length < 2) return "";

    // Frontmatter is already parsed for every file; reading it again here
    // would mean opening eight notes to answer a question about their shape.
    const seen = new Map();
    let withFm = 0;
    for (const f of near) {
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter;
      if (!fm) continue;
      withFm++;
      for (const [k, v] of Object.entries(fm)) {
        if (k === "position") continue;
        if (!seen.has(k)) seen.set(k, { n: 0, example: v });
        seen.get(k).n++;
      }
    }
    if (!withFm) return "";

    // Shared by most of them, not merely present once.
    const common = [...seen.entries()]
      .filter(([, v]) => v.n >= Math.max(2, Math.ceil(withFm * 0.6)))
      .map(([k, v]) => {
        const ex = Array.isArray(v.example) ? v.example[0] : v.example;
        const shown = typeof ex === "string" || typeof ex === "number" ? String(ex).slice(0, 60) : "";
        return shown ? `${k} (e.g. ${shown})` : k;
      });
    if (!common.length) return "";
    return `Notes in "${folder}" almost all carry these properties: ${common.join(", ")}. `
      + `Add the same ones here unless the user said otherwise — a note without them is not filed the way the rest of the folder is.`;
  }

  /* ── templates ──────────────────────────────────────────────
   *
   * A vault's note types live in its templates, and the assistant had no way
   * to know they existed: asked for a project note it invented a shape, while
   * the real one — with its properties, its headings, its links back — sat in
   * a folder it never looked in. The folder is not guessed: Obsidian's own
   * Templates plugin and Templater both record it, and either answer is the
   * truth about this vault.
   * ────────────────────────────────────────────────────────── */
  templateFolder() {
    // What the user pointed at wins over anything we can work out: a vault can
    // have templates in a folder no plugin was ever told about.
    if (this.s.templateFolder) return normalizePath(this.s.templateFolder);
    const ip = this.app.internalPlugins;
    try {
      const core = ip && ip.getPluginById ? ip.getPluginById("templates") : null;
      const dir = core && core.instance && core.instance.options && core.instance.options.folder;
      if (dir) return normalizePath(dir);
    } catch {}
    try {
      const tp = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins["templater-obsidian"];
      const dir = tp && tp.settings && tp.settings.templates_folder;
      if (dir) return normalizePath(dir);
    } catch {}
    // Neither plugin configured — fall back to a folder actually called that.
    return resolveFolder(this.app, "templates", (p) => this.inScope(p));
  }

  /** The templates themselves, newest first. */
  templates(limit = 40) {
    const dir = this.templateFolder();
    if (!dir) return [];
    return this.app.vault.getMarkdownFiles()
      // Scope applies here too. A templates folder inside a private one is
      // still private, however sensible reading a template usually is.
      .filter((f) => f.path.startsWith(dir + "/") && this.inScope(f.path))
      .sort((a, b) => a.basename.localeCompare(b.basename))
      .slice(0, limit);
  }

  /**
   * The shape of this vault, in a paragraph.
   *
   * Built once and kept in settings, because it goes into every system prompt:
   * top-level folders with how much is in them, the templates that exist, and
   * where the daily notes live. Without it the assistant files everything in
   * the root of wherever it last looked — it genuinely had no map.
   */
  describeVault() {
    const files = this.files();
    const byTop = new Map();
    for (const f of files) {
      const top = f.path.includes("/") ? f.path.slice(0, f.path.indexOf("/")) : "/";
      byTop.set(top, (byTop.get(top) || 0) + 1);
    }
    const lines = [];
    lines.push(`The vault holds ${files.length} notes. Top-level folders, with how many notes are under each:`);
    for (const [name, n] of [...byTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      // The second level is where the actual filing happens in a PARA-style
      // vault — "2. Areas" alone tells the model nothing about where a project
      // note belongs.
      const subs = new Set();
      for (const f of files) {
        if (!f.path.startsWith(name + "/")) continue;
        const rest = f.path.slice(name.length + 1);
        if (rest.includes("/")) subs.add(rest.slice(0, rest.indexOf("/")));
      }
      const tail = subs.size ? ` — inside: ${[...subs].slice(0, 8).join(", ")}` : "";
      lines.push(`• ${name} (${n})${tail}`);
    }

    const tpl = this.templates();
    if (tpl.length) {
      lines.push("", `Templates live in "${this.templateFolder()}". A note of a kind that has a template here MUST be built from it — read it with read_note first and follow its properties, headings and links. The templates are:`);
      for (const f of tpl) lines.push(`• ${f.basename} (${f.path})`);
    }

    const daily = this.dailyFolder();
    if (daily) lines.push("", `Daily notes are in "${daily}".`);
    return lines.join("\n");
  }

  /** Is the Kanban plugin there to render a board at all? */
  kanbanReady() {
    const p = this.app.plugins;
    return !!(p && ((p.plugins && p.plugins["obsidian-kanban"])
      || (p.enabledPlugins && p.enabledPlugins.has && p.enabledPlugins.has("obsidian-kanban"))));
  }

  /**
   * A real Kanban board, not a note that looks like one.
   *
   * Asked for a board, the model wrote headings and checkboxes and left it at
   * that — which opens as ordinary text, because the board view is chosen by
   * `kanban-plugin: board` in the frontmatter and nothing else. The other two
   * things it cannot guess are that columns must be `##` headings and that the
   * trailing settings block has to hold real JSON, one list-collapse flag per
   * column. Miss any of the three and the file is a note about a board.
   */
  async createBoard(title, columns, folder, properties) {
    const cols = (Array.isArray(columns) ? columns : [])
      .map((c) => ({
        name: String((c && c.name) || "").trim(),
        cards: (Array.isArray(c && c.cards) ? c.cards : []).map((x) => String(x || "").trim()).filter(Boolean),
      }))
      .filter((c) => c.name);
    if (!cols.length) throw new Error("a board needs at least one column");

    const body = cols
      .map((c) => `## ${c.name}\n\n` + c.cards.map((x) => `- [ ] ${x}`).join("\n") + "\n")
      .join("\n");

    const settings = JSON.stringify({
      "kanban-plugin": "board",
      "list-collapse": cols.map(() => false),
    });
    // The settings live in a fenced block inside a comment, so the fence is
    // built rather than typed — a literal one here would end this file's own.
    const fence = "`".repeat(3);
    const tail = `%% kanban:settings\n${fence}\n${settings}\n${fence}\n%%`;

    /* Whatever else the vault's own board template carries.
       A board built from `kanban-plugin: board` alone renders correctly and is
       still filed wrong: in a vault whose project boards all carry a link back
       to their MOC, one without it is an orphan nothing points at. The model
       reads the template and passes those properties through here. */
    const extra = [];
    for (const [k, v] of Object.entries(properties || {})) {
      if (!k || k === "kanban-plugin") continue;
      if (Array.isArray(v)) {
        extra.push(`${k}:`);
        for (const item of v) extra.push(`  - "${String(item).replace(/"/g, '\\"')}"`);
      } else if (v != null && String(v) !== "") {
        extra.push(`${k}: ${/[:#[\]{}]/.test(String(v)) ? `"${String(v).replace(/"/g, '\\"')}"` : v}`);
      }
    }
    const front = (extra.length ? extra.join("\n") + "\n" : "") + "kanban-plugin: board";
    const text = `---\n${front}\n---\n\n${body}\n\n${tail}\n`;
    return await this.createNote(title, text, folder);
  }

  /** Snapshot before every write, so "undo that" is always available. */
  async remember(file) {
    try {
      const before = await this.app.vault.read(file);
      this.undoStack.push({ path: file.path, before });
      if (this.undoStack.length > 20) this.undoStack.shift();
    } catch {}
  }

  async appendToNote(file, content, heading) {
    await this.remember(file);
    const raw = await this.app.vault.read(file);
    const add = String(content || "").trim();
    if (!heading) {
      await this.app.vault.modify(file, raw.replace(/\s*$/, "") + "\n\n" + add + "\n");
      return;
    }
    // Put it under the named heading, keeping whatever follows intact.
    const lines = raw.split("\n");
    const want = String(heading).trim().toLowerCase();
    let at = -1, level = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
      if (m && m[2].trim().toLowerCase() === want) { at = i; level = m[1].length; break; }
    }
    if (at < 0) {
      await this.app.vault.modify(file, raw.replace(/\s*$/, "") + `\n\n## ${heading}\n\n${add}\n`);
      return;
    }
    let end = lines.length;
    for (let i = at + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+/);
      if (m && m[1].length <= level) { end = i; break; }
    }
    while (end > at + 1 && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, add);
    await this.app.vault.modify(file, lines.join("\n"));
  }

  async replaceInNote(file, find, replace) {
    await this.remember(file);
    const raw = await this.app.vault.read(file);
    if (!raw.includes(find)) throw new Error("not-found");
    await this.app.vault.modify(file, raw.split(find).join(replace));
  }

  async undo() {
    const last = this.undoStack.pop();
    if (!last) return null;
    const f = this.app.vault.getAbstractFileByPath(last.path);
    if (f instanceof TFile) { await this.app.vault.modify(f, last.before); return last.path; }
    return null;
  }

  /**
   * Show a note in the main editor area, never in the assistant's own pane.
   *
   * `getLeaf(false)` returns the most recently used leaf, and during a voice
   * session that is the sidebar the assistant lives in — so the note replaced
   * the reactor mid-sentence. Asking the root split for its own recent leaf
   * targets the editing area explicitly, whichever sidebar has focus.
   */
  async openNote(file) {
    const ws = this.app.workspace;
    let leaf = ws.getMostRecentLeaf(ws.rootSplit);
    // An empty workspace has no leaf in the root split yet.
    if (!leaf) leaf = ws.getLeaf("tab");
    await leaf.openFile(file);
    ws.setActiveLeaf(leaf, { focus: false });
  }

  /* ── the workspace ───────────────────────────────────────────
   * Reading and writing notes is only half of working alongside
   * someone. The other half is the screen: which note is in front
   * of them, what else is open, what is in the way. These four
   * methods are the whole of it, and they all confine themselves
   * to the main editor area — the assistant's own panel is never a
   * thing it can close or navigate away from.
   * ========================================================== */

  /** Tabs open in the main area, in the order they appear on screen. */
  listTabs() {
    const out = [];
    this.app.workspace.iterateRootLeaves((leaf) => {
      const view = leaf.view;
      if (!view) return;
      const file = view.file;
      out.push({
        leaf,
        title: (typeof leaf.getDisplayText === "function" ? leaf.getDisplayText() : "") || t("Untitled"),
        type: view.getViewType ? view.getViewType() : "",
        path: file && file.path ? file.path : "",
        active: leaf === this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit),
      });
    });
    return out;
  }

  /**
   * Tabs matching what the user called them. An empty query matches
   * everything, which is what "close everything" means — the caller decides
   * whether that needs confirming, not this.
   */
  matchTabs(query) {
    const tabs = this.listTabs();
    const q = String(query || "").trim().toLowerCase();
    if (!q) return tabs;
    // Exact title first: with "Проект" open next to "Проект — архив", the
    // shorter one is what was meant, and a substring match returns both.
    const exact = tabs.filter((x) => x.title.toLowerCase() === q || x.path.toLowerCase() === q);
    if (exact.length) return exact;
    return tabs.filter((x) => x.title.toLowerCase().includes(q) || x.path.toLowerCase().includes(q));
  }

  /** Close tabs, reporting what actually went. Never the assistant's own. */
  closeTabs(tabs) {
    const closed = [];
    for (const tab of tabs) {
      if (!tab.leaf || tab.type === VIEW_TYPE) continue;
      try { tab.leaf.detach(); closed.push(tab.title); } catch {}
    }
    return closed;
  }

  /**
   * A web page in the main area.
   *
   * The address arrives from the model, which read it out of a note, which
   * anyone could have written — so only ordinary web addresses are opened.
   * `javascript:` and `file:` would turn a note into a way to run something.
   */
  async openUrl(rawUrl) {
    const url = String(rawUrl || "").trim();
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error(t("That isn't a valid address.")); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(t("Only ordinary web addresses can be opened."));
    }

    const ws = this.app.workspace;
    // Web viewer is a core plugin and it can be switched off; falling back to
    // the system browser keeps the request honoured rather than refused.
    const internal = this.app.internalPlugins;
    const wv = internal && internal.getPluginById ? internal.getPluginById("webviewer") : null;
    if (!wv || !wv.enabled) {
      window.open(parsed.href, "_blank");
      return { where: "browser", url: parsed.href };
    }

    const leaf = ws.getLeaf("tab");
    await leaf.setViewState({ type: "webviewer", state: { url: parsed.href, navigate: true }, active: true });
    ws.setActiveLeaf(leaf, { focus: false });
    return { where: "obsidian", url: parsed.href };
  }

  /**
   * A note beside the current one, rather than on top of it.
   * A phone has no room for two panes — there it is an ordinary tab, which is
   * what "show me this as well" means on a screen that narrow.
   */
  async openNoteSplit(file, direction = "vertical") {
    if (isPhone()) return this.openNote(file);
    const leaf = this.app.workspace.getLeaf("split", direction);
    await leaf.openFile(file);
    this.app.workspace.setActiveLeaf(leaf, { focus: false });
  }

  /**
   * Notes changed in the last `days` days, newest first.
   *
   * The one thing the assistant had no way to ask. Every other lookup is by
   * topic or by name, and "what was I doing over the last couple of days" is
   * neither — so it went to search_notes, which is blind to time, and came
   * back with whatever matched best in the whole vault. In August it answered
   * with February and had no way to know it was wrong.
   */
  recentNotes(days = 3, limit = 30) {
    const since = Date.now() - Math.max(1, Number(days) || 3) * 86400000;
    return this.files()
      .filter((f) => f.stat.mtime >= since)
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, limit);
  }

  /**
   * Where the daily notes live.
   *
   * Falls back to Obsidian's own daily-notes settings when ours is empty,
   * which it is for anyone who never opened our Notes tab. The tool was
   * simply absent for them, and "what did I do yesterday" then became a
   * topic search — the same failure as above, from a blank field.
   */
  dailyFolder() {
    if (this.s.dailyFolder) return this.s.dailyFolder;
    const core = this.app.internalPlugins && this.app.internalPlugins.getPluginById
      ? this.app.internalPlugins.getPluginById("daily-notes")
      : null;
    const folder = core && core.instance && core.instance.options && core.instance.options.folder;
    return folder ? String(folder).replace(/^\/+|\/+$/g, "") : "";
  }

  dailyNote(when) {
    const folder = this.dailyFolder();
    if (!folder) return null;
    const d = new Date();
    const w = String(when || "").toLowerCase().trim();
    if (/вчера|yesterday/.test(w)) d.setDate(d.getDate() - 1);
    else if (/позавчера|day before/.test(w)) d.setDate(d.getDate() - 2);
    else if (/завтра|tomorrow/.test(w)) d.setDate(d.getDate() + 1);
    else if (/^\d{2}[-.]\d{2}[-.]\d{4}$/.test(w)) {
      const [dd, mm, yy] = w.split(/[-.]/).map(Number);
      d.setFullYear(yy, mm - 1, dd);
    }
    const key = todayKey(d);
    // Every other way into a note goes through `files()` or `resolve()`, both
    // of which check the scope. This one reached for a path directly and so
    // was the one hole in it: a daily-notes folder marked private, or outside
    // the working scope, was read anyway.
    const direct = this.app.vault.getAbstractFileByPath(normalizePath(folder + "/" + key + ".md"));
    if (direct instanceof TFile) return this.inScope(direct.path) ? direct : null;
    // Daily-note naming varies; fall back to any file in the folder whose
    // name carries the same date parts in any order.
    const parts = key.split("-");
    return this.app.vault.getMarkdownFiles().find((f) =>
      f.path.startsWith(folder + "/") && this.inScope(f.path)
      && parts.every((p) => f.basename.includes(p))) || null;
  }
}
