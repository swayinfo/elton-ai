/* ============================================================
 *  Automations
 *
 *  Scheduled runs of the assistant — a morning digest, a catch-up
 *  on the last few days — that fire on their own and write the
 *  result into the vault. Each one is an ordinary agent turn with a
 *  saved prompt; the scheduler only decides when it runs and where
 *  the answer lands.
 *
 *  Timing is deliberately forgiving. Obsidian isn't a server: the
 *  vault is closed most of the night, so firing exactly at 08:30 is
 *  the wrong target. An automation fires once per matching day, the
 *  first time the app is running past its time — so the morning
 *  digest is waiting whether you open the vault at 8:31 or at noon.
 *  `lastRun` (a date string, synced in data.json) is what stops it
 *  running twice, here or on another device.
 * ========================================================== */

let _autoSeq = 0;
function automationId() {
  return "auto-" + Date.now().toString(36) + "-" + (_autoSeq++).toString(36);
}

/** The ready-made automations offered in settings, localised on the spot. */
function automationPresets() {
  return {
    digest: {
      name: t("Morning digest"),
      time: "08:30",
      days: [],
      target: "daily",
      heading: t("Morning digest"),
      prompt: t("Put together a short morning briefing for me. Look at my daily note for yesterday and my notes from the last two or three days. Remind me what I did, what ideas and thoughts came up, what's still open, and what's worth focusing on today. Warm and to the point, in the second person. Don't invent anything — only what's actually in my notes."),
    },
    catchup: {
      name: t("Catch up on recent thoughts"),
      time: "09:00",
      days: [1],   // Monday
      target: "note",
      prompt: t("Catch me up on the last few days. Go through my recent notes and daily entries and pull the main threads into a short, connected read: what I've been thinking about, ideas that came up, tasks in flight, recurring themes, and anything I seem to have dropped."),
    },
    custom: {
      name: t("Custom automation"),
      time: "09:00",
      days: [],
      target: "daily",
      prompt: "",
    },
  };
}

/** A fresh automation from a preset, with its own id and defaults filled in. */
function newAutomation(presetId) {
  const p = automationPresets()[presetId] || automationPresets().custom;
  return {
    id: automationId(),
    enabled: false,
    name: p.name,
    time: p.time || "09:00",
    days: Array.isArray(p.days) ? p.days.slice() : [],
    target: p.target || "daily",
    heading: p.heading || "",
    folder: "",
    prompt: p.prompt || "",
    notify: true,
    lastRun: "",
  };
}

class AutomationScheduler {
  constructor(plugin) {
    this.plugin = plugin;
    // Which automations are mid-run, so a slow one isn't started twice.
    this.running = new Set();
  }

  start() {
    // A minute's granularity is ample for something that fires once a day, and
    // the check is cheap. registerInterval ties it to the plugin's lifetime.
    this.plugin.registerInterval(window.setInterval(() => this.tick(), 60 * 1000));
    // One pass shortly after load catches an automation whose time already
    // passed while the vault was closed.
    window.setTimeout(() => this.tick(), 8000);
  }

  /** Is this automation due — a matching day, past its time, not yet run today? */
  due(a, now = new Date()) {
    if (!a || !a.enabled || !a.time) return false;
    if (a.lastRun === todayKey(now)) return false;
    if (Array.isArray(a.days) && a.days.length && !a.days.includes(now.getDay())) return false;
    const [h, m] = String(a.time).split(":").map((n) => parseInt(n, 10) || 0);
    return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
  }

  async tick() {
    const list = this.plugin.settings.automations || [];
    for (const a of list) {
      if (this.running.has(a.id) || !this.due(a)) continue;
      // Claim the day before running: mark it done up front so the next tick
      // can't start it again while it's still working, and so a sync of the
      // flag reaches other devices before they try the same run.
      a.lastRun = todayKey();
      await this.plugin.saveSettings();
      this.run(a).catch((e) => console.warn("[Elton AI] automation failed:", e && e.message));
    }
  }

  /**
   * Run one automation. `manual` is the "Run now" button — it ignores the
   * schedule and still stamps lastRun, so a hand-run in the morning doesn't
   * get repeated by the timer an hour later.
   */
  async run(a, { manual = false } = {}) {
    if (this.running.has(a.id)) return null;
    this.running.add(a.id);
    const plugin = this.plugin;
    try {
      if (manual) { a.lastRun = todayKey(); await plugin.saveSettings(); }
      const agent = new Agent(plugin);
      const reply = await agent.run([], a.prompt || "", {
        onEvent: () => {},
        // An unattended run must never sit waiting on a keypress that will
        // never come, so any confirm is declined — it just won't edit or delete.
        confirm: async () => false,
        onSegment: null,
        written: true,
      });
      if (!reply || !reply.trim()) {
        if (a.notify !== false) new Notice(t("Nothing to write — the run came back empty."));
        return null;
      }
      return await this.deliver(a, reply.trim(), agent.sources || []);
    } finally {
      this.running.delete(a.id);
    }
  }

  /** Write the answer where the automation says, and offer to open it. */
  async deliver(a, text, sources) {
    const plugin = this.plugin, V = plugin.vault;
    const title = a.name || t("Morning digest");
    const stamp = todayKey();
    const body = text + this.sourcesBlock(sources);
    let file = null;

    if (a.target === "note") {
      file = await V.createNote(`${title} ${stamp}`, `# ${title} — ${stamp}\n\n${body}\n`,
        a.folder || plugin.settings.newNoteFolder || "");
    } else {
      // Into today's daily note — creating it if the day hasn't one yet.
      file = V.dailyNote("today");
      if (!file && plugin.settings.dailyFolder) {
        await V.ensureFolder(plugin.settings.dailyFolder);
        file = await plugin.app.vault.create(
          normalizePath(plugin.settings.dailyFolder + "/" + stamp + ".md"), "");
      }
      if (file) await V.appendToNote(file, body, a.heading || title);
      else file = await V.createNote(`${title} ${stamp}`, body, plugin.settings.newNoteFolder || "");
    }

    if (a.notify !== false && file) {
      const n = new Notice(t("{0} is ready", title), 12000);
      if (n.noticeEl) {
        n.noticeEl.addClass("oa-notice-click");
        n.noticeEl.addEventListener("click", () => plugin.app.workspace.getLeaf(false).openFile(file));
      }
    }
    return file;
  }

  sourcesBlock(sources) {
    if (!sources || !sources.length) return "";
    const links = sources.slice(0, 12).map((s) => `[[${(s.title || s.path || "").replace(/\.md$/, "")}]]`).join(" · ");
    return `\n\n---\n${t("Sources: ")}${links}`;
  }
}
