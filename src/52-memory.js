/* ============================================================
 *  Memory and the change journal
 *
 *  Two things the assistant used to keep only in RAM, and lost
 *  every time Obsidian restarted:
 *
 *  - what was said in each conversation (phone, Telegram, panel);
 *  - what it changed in the vault, and how to put it back.
 *
 *  Both live as plain JSON in the plugin's own folder, never in
 *  the vault and never on a server. The conversation file holds
 *  only the user's words, the answers and a one-line note of what
 *  was done — not the notes that were read along the way.
 * ========================================================== */

/** A short stable hash — enough to tell "the file is as we left it". */
function memHash(s) {
  let h = 2166136261;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + ":" + str.length;
}

function memId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** "3 h ago" in words the model reads without arithmetic. */
function memAgo(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/* ── conversations ──────────────────────────────────────────── */

class ConversationMemory {
  constructor(plugin) {
    this.plugin = plugin;
    this.data = null;          // { "<channel>:<chat>": { updated, turns: [...] } }
    this._timer = 0;
    this._loading = null;
  }

  get file() { return normalizePath(this.plugin.manifest.dir + "/memory.json"); }

  async load() {
    if (this.data) return this.data;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      let data = {};
      try {
        const a = this.plugin.app.vault.adapter;
        if (await a.exists(this.file)) data = JSON.parse(await a.read(this.file)) || {};
      } catch { data = {}; }
      this.data = data && typeof data === "object" ? data : {};
      this.prune();
      return this.data;
    })();
    return this._loading;
  }

  saveSoon() {
    window.clearTimeout(this._timer);
    this._timer = window.setTimeout(() => this.saveNow(), 800);
  }

  async saveNow() {
    window.clearTimeout(this._timer);
    if (!this.data) return;
    try {
      await this.plugin.app.vault.adapter.write(this.file, JSON.stringify(this.data));
    } catch (e) { console.error("[Elton AI] memory save", e); }
  }

  /** Old conversations go; a month of silence means it is over. */
  prune() {
    const d = this.data || {};
    const old = Date.now() - 30 * 86400e3;
    const keys = Object.keys(d)
      .filter((k) => d[k] && Array.isArray(d[k].turns))
      .sort((a, b) => (d[b].updated || 0) - (d[a].updated || 0));
    keys.forEach((k, i) => {
      if (i >= 80 || (d[k].updated || 0) < old) delete d[k];
      else if (d[k].turns.length > 40) d[k].turns = d[k].turns.slice(-40);
    });
    Object.keys(d).forEach((k) => { if (!d[k] || !Array.isArray(d[k].turns)) delete d[k]; });
  }

  key(channel, chat) { return String(channel || "panel") + ":" + String(chat || "main"); }

  async turns(channel, chat) {
    const d = await this.load();
    const c = d[this.key(channel, chat)];
    return c ? c.turns.slice() : [];
  }

  /**
   * One finished (or failed) turn.
   * `did` is what changed, in words: ["created «X» (path)", ...].
   */
  async add(channel, chat, turn) {
    const d = await this.load();
    const k = this.key(channel, chat);
    const c = d[k] || (d[k] = { updated: 0, turns: [] });
    c.turns.push({
      at: Date.now(),
      user: String(turn.user || "").slice(0, 6000),
      reply: String(turn.reply || "").slice(0, 6000),
      did: (turn.did || []).slice(0, 12),
      status: turn.status || "ok",
      ...(turn.ref ? { ref: String(turn.ref) } : {}),
    });
    c.updated = Date.now();
    if (c.turns.length > 40) c.turns = c.turns.slice(-40);
    this.saveSoon();
  }

  async forget(channel, chat) {
    const d = await this.load();
    delete d[this.key(channel, chat)];
    this.saveSoon();
  }

  /** Was this phone message (by its relay id) already handled? */
  async has(channel, chat, ref) {
    if (!ref) return false;
    return (await this.turns(channel, chat)).some((x) => x.ref === ref);
  }

  /**
   * The conversation as model messages.
   *
   * Recent turns only, inside a character budget: the full history of a long
   * chat costs more than it helps. Each answer carries a line saying what was
   * done, because "add this too" means "to the note you just wrote", and that
   * note is named in the tool calls — which are not kept.
   */
  async messages(channel, chat, { maxTurns = 12, maxChars = 16000 } = {}) {
    const all = await this.turns(channel, chat);
    const picked = [];
    let used = 0;
    for (let i = all.length - 1; i >= 0 && picked.length < maxTurns; i--) {
      const tr = all[i];
      const size = tr.user.length + Math.min(tr.reply.length, 2500) + 200;
      if (picked.length && used + size > maxChars) break;
      used += size;
      picked.unshift(tr);
    }
    const now = Date.now();
    const out = [];
    for (const tr of picked) {
      const age = now - (tr.at || now);
      const when = age > 3 * 3600e3 ? `[${memAgo(age)}] ` : "";
      out.push({ role: "user", content: when + tr.user });
      let reply = tr.reply.length > 2500 ? tr.reply.slice(0, 2500) + " …" : tr.reply;
      if (tr.status === "error") {
        reply = `[This turn FAILED before it was done${reply ? ": " + reply : ""}. The request above was NOT carried out.]`;
      } else if (tr.status === "cancelled") {
        reply = "[The user stopped this turn. Anything not listed below was not done.]";
      }
      /* What was done is NOT appended here. It was, at first, and the model
         learned the shape: asked to add a second thought, it wrote "[What I
         did: appended …]" into its answer and called no tool. The record
         goes in front of the new message instead — see recallNote. */
      out.push({ role: "assistant", content: reply || "…" });
    }
    return out;
  }

  /**
   * The change log of this conversation, as a note in front of the new
   * message: which notes were really created or changed, most recent last.
   * This is what "add this too" and "put it there" resolve against.
   */
  async recallNote(channel, chat) {
    const turns = (await this.turns(channel, chat)).slice(-10);
    const lines = [];
    for (const tr of turns) {
      for (const d of tr.did || []) {
        const i = lines.indexOf(d);
        if (i >= 0) lines.splice(i, 1);
        lines.push(d);
      }
    }
    if (!lines.length) return "";
    return "[Change log of this conversation — notes that were actually created or changed in earlier turns, most recent last:\n"
      + lines.slice(-8).map((x) => "- " + x).join("\n")
      + "\nIf the new message continues that work, the most recent note is where it goes — and you still have to call the tool this turn. "
      + "This log is for you; do not quote it in your reply.]\n\n";
  }
}

/* ── the change journal ─────────────────────────────────────── */

/**
 * Every change the assistant makes to the vault, with the way back.
 *
 * Kept on disk so that "undo" survives a restart and works from the phone,
 * where there is no Ctrl+Z. An edit keeps the text from before it; a new note
 * keeps a fingerprint, so undoing it can tell whether the person has written
 * in it since — and refuses to throw their own words away.
 */
class ChangeJournal {
  constructor(plugin) {
    this.plugin = plugin;
    this.items = null;
    this.sinks = new Set();
    this._timer = 0;
    this._loading = null;
  }

  get dir() { return normalizePath(this.plugin.manifest.dir + "/history"); }
  get index() { return normalizePath(this.dir + "/index.json"); }
  get adapter() { return this.plugin.app.vault.adapter; }

  async load() {
    if (this.items) return this.items;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      let items = [];
      try {
        if (await this.adapter.exists(this.index)) items = JSON.parse(await this.adapter.read(this.index)) || [];
      } catch { items = []; }
      this.items = Array.isArray(items) ? items : [];
      return this.items;
    })();
    return this._loading;
  }

  async ensureDir() {
    try { if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir); } catch { /* exists */ }
  }

  saveSoon() {
    window.clearTimeout(this._timer);
    this._timer = window.setTimeout(() => this.saveNow(), 500);
  }

  async saveNow() {
    window.clearTimeout(this._timer);
    if (!this.items) return;
    await this.ensureDir();
    // Forty-five days or three hundred changes, whichever comes first.
    const old = Date.now() - 45 * 86400e3;
    const keep = [];
    const drop = [];
    this.items.forEach((x, i) => ((i >= this.items.length - 300 && x.at > old) ? keep : drop).push(x));
    this.items = keep;
    for (const x of drop) {
      if (x.snap) { try { await this.adapter.remove(normalizePath(this.dir + "/" + x.snap)); } catch { /* gone */ } }
    }
    try { await this.adapter.write(this.index, JSON.stringify(this.items)); }
    catch (e) { console.error("[Elton AI] journal save", e); }
  }

  /**
   * Note a change. `before` is the text to restore (edits and deletions);
   * `after` is what was written (new notes), kept only as a fingerprint.
   */
  async record(kind, { path, from, before, after, channel }) {
    await this.load();
    const e = {
      id: memId(),
      at: Date.now(),
      kind,                      // edit | create | move | delete
      path,
      ...(from ? { from } : {}),
      title: String(path || "").split("/").pop().replace(/\.md$/i, ""),
      channel: channel || this.channel || "",
      undone: false,
    };
    if (before != null) {
      await this.ensureDir();
      e.snap = e.id + ".txt";
      try { await this.adapter.write(normalizePath(this.dir + "/" + e.snap), String(before)); }
      catch { delete e.snap; }
    }
    if (after != null) e.hash = memHash(after);
    /* The assistant creating a note and then filling in its properties is
       one thing it did, not two — and undoing the note must not refuse
       because "it has been changed since" when the only change was its own.
       Within a few minutes of the note being made, its own edits move the
       point that "changed since" is measured from. */
    if (kind === "edit") {
      const made = this.items.slice().reverse().find((x) => x.path === path && x.kind === "create" && !x.undone);
      if (made && e.at - made.at < 10 * 60 * 1000) made.lastAt = e.at;
    }
    this.items.push(e);
    this.saveSoon();
    for (const fn of this.sinks) { try { fn(e); } catch { /* a listener's problem */ } }
    return e;
  }

  async list(n = 30) {
    await this.load();
    return this.items.slice(-n).reverse();
  }

  /** For people to read: a photo that went in with a line of text is part of
      that line's entry, not a second row with its own Undo. */
  async listShown(n = 30) {
    const all = await this.list(n + 15);
    const inner = new Set();
    for (const e of all) for (const id of e.with || []) inner.add(id);
    return all.filter((e) => !inner.has(e.id)).slice(0, n);
  }

  async get(id) {
    await this.load();
    return this.items.find((x) => x.id === id) || null;
  }

  async readSnap(e) {
    if (!e || !e.snap) return null;
    try { return await this.adapter.read(normalizePath(this.dir + "/" + e.snap)); } catch { return null; }
  }

  /** The newest change that has not been undone yet. */
  async lastOpen() {
    await this.load();
    for (let i = this.items.length - 1; i >= 0; i--) if (!this.items[i].undone) return this.items[i];
    return null;
  }

  /**
   * Put one change back. Returns { ok, text } — the text is said to the user
   * as it is, so it is written for them.
   */
  /* Some changes come in pairs that only make sense together: a photo put
     into today's note is the picture file and the line that shows it.
     Undoing the line and leaving the picture left an orphan in the
     attachments folder. `with` names the rest of the pair. */
  async undo(id, opts = {}) {
    const r = await this.undoOne(id, opts);
    if (r && r.ok && r.entry && Array.isArray(r.entry.with)) {
      for (const other of r.entry.with) {
        try { await this.undoOne(other, { force: true }); } catch { /* the main change is undone; that is what was asked */ }
      }
    }
    if (r) delete r.entry;
    return r;
  }

  async undoOne(id, { force = false } = {}) {
    const e = id ? await this.get(id) : await this.lastOpen();
    if (!e) return { ok: false, text: t("Nothing to undo") };
    if (e.undone) return { ok: false, text: t("Already undone: {0}", e.title) };
    const app = this.plugin.app;
    const V = this.plugin.vault;
    const fileAt = (p) => { const f = app.vault.getAbstractFileByPath(p); return f instanceof TFile ? f : null; };
    try {
      if (e.kind === "edit") {
        const before = await this.readSnap(e);
        if (before == null) return { ok: false, text: t("The saved copy is gone, so it cannot be put back.") };
        const f = fileAt(e.path);
        if (f) await app.vault.modify(f, before);
        else {
          const dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
          if (dir && V) await V.ensureFolder(dir);
          await app.vault.create(e.path, before);
        }
      } else if (e.kind === "create") {
        const f = fileAt(e.path);
        if (f) {
          const now = await app.vault.read(f);
          /* A template plugin may fill the note in a second after it was
             made; that is not the person writing in it. */
          const touchedLater = f.stat && f.stat.mtime - (e.lastAt || e.at) > 8000;
          if (!force && touchedLater && (e.lastAt || (e.hash && memHash(now) !== e.hash))) {
            return { ok: false, changed: true, text: t("«{0}» has been changed since, so it was not deleted.", e.title) };
          }
          await app.fileManager.trashFile(f);
          // Its own later edits went with it.
          for (const x of this.items) if (x.path === e.path && x.kind === "edit" && x.at >= e.at) x.undone = true;
        }
      } else if (e.kind === "move") {
        const f = fileAt(e.path);
        if (!f) return { ok: false, text: t("«{0}» is no longer there.", e.title) };
        if (app.vault.getAbstractFileByPath(e.from)) return { ok: false, text: t("Something else is already at the old place.") };
        const dir = e.from.includes("/") ? e.from.slice(0, e.from.lastIndexOf("/")) : "";
        if (dir && V) await V.ensureFolder(dir);
        await app.fileManager.renameFile(f, e.from);
      } else if (e.kind === "delete") {
        const before = await this.readSnap(e);
        if (before == null) return { ok: false, text: t("The saved copy is gone, so it cannot be put back.") };
        if (app.vault.getAbstractFileByPath(e.path)) return { ok: false, text: t("Something else is already at the old place.") };
        const dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
        if (dir && V) await V.ensureFolder(dir);
        await app.vault.create(e.path, before);
      } else {
        return { ok: false, text: t("Nothing to undo") };
      }
    } catch (err) {
      return { ok: false, text: t("Could not undo: {0}", err.message || String(err)) };
    }
    e.undone = true;
    e.undoneAt = Date.now();
    this.saveSoon();
    return { ok: true, path: e.kind === "move" ? e.from : e.path, text: t("Undone: {0}", e.title), entry: e };
  }
}

/** What a journal entry means, in one line for the model. */
function describeChange(e) {
  const where = `«${e.title}» (${e.path})`;
  if (e.kind === "create") return `created ${where}`;
  if (e.kind === "move") return `moved «${e.title}» from ${e.from} to ${e.path}`;
  if (e.kind === "delete") return `deleted ${where}`;
  return `changed ${where}`;
}

/** The same, for a person: a chip under the answer on the phone. */
function changeLabel(e) {
  if (e.kind === "create") return t("Note created: {0}", e.title);
  if (e.kind === "move") return t("Note moved: {0}", e.title);
  if (e.kind === "delete") return t("Note deleted: {0}", e.title);
  return t("Note changed: {0}", e.title);
}
