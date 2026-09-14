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
    // Open the answer when it is done. On, because an automation whose result
    // you have to go and look for is one you stop trusting.
    showResult: true,
    // Also send the result to Telegram. Off by default — an automation that
    // starts messaging your phone without being asked is a surprise, not a
    // feature.
    telegram: false,
    lastRun: "",
  };
}

/* ============================================================
 *  Editing one, in its own window
 *
 *  Same reasoning as the scenario editor: a schedule is eight
 *  fields, and eight fields unfolding inside a list turn the list
 *  into a form with rows around it.
 * ========================================================== */
class AutomationEditModal extends Modal {
  constructor(app, plugin, automation, onSave) {
    super(app);
    this.plugin = plugin;
    this.auto = automation;
    this.onSave = onSave;
    this.draft = Object.assign({}, automation, { days: (automation.days || []).slice() });
  }

  onOpen() {
    this.modalEl.addClass("oa-scen-edit");
    this.draw();
  }

  onClose() { this.contentEl.empty(); }

  draw() {
    const c = this.contentEl;
    // Clicking a weekday or changing where it writes rebuilds this window.
    const back = keepScroll(c);
    c.empty();
    const a = this.draft;
    c.createEl("h3", { text: a.name || t("Custom automation") });

    new Setting(c).setName(t("Name")).addText((tx) =>
      tx.setValue(a.name || "").onChange((v) => { a.name = v; }));

    new Setting(c).setName(t("Time")).addText((tx) => {
      tx.inputEl.type = "time";
      tx.setValue(a.time || "09:00").onChange((v) => {
        a.time = v || "09:00";
        // Changing the time is asking for it to run at the new one. Keeping
        // "already ran today" would mean setting a time and watching nothing
        // happen — which is exactly how this looked from outside.
        a.lastRun = "";
      });
    });

    // Days: click to toggle, none selected means every day. Monday-first.
    const L = [t("Sun"), t("Mon"), t("Tue"), t("Wed"), t("Thu"), t("Fri"), t("Sat")];
    const daysSetting = new Setting(c).setName(t("Days")).setDesc(t("None selected = every day."));
    const daysRow = daysSetting.controlEl.createDiv({ cls: "oa-auto-days" });
    [1, 2, 3, 4, 5, 6, 0].forEach((d) => {
      const btn = daysRow.createEl("button", { cls: "oa-day" + (a.days.includes(d) ? " is-on" : ""), text: L[d] });
      btn.onclick = () => {
        a.days = a.days.includes(d) ? a.days.filter((x) => x !== d) : a.days.concat(d);
        this.draw();
      };
    });

    new Setting(c).setName(t("Where it writes")).addDropdown((d) => {
      d.addOption("daily", t("Today's daily note"));
      d.addOption("note", t("A new note"));
      /* Не всякая автоматизация должна что-то оставлять в хранилище.
         Вечернее «как прошёл день» нужно как разговор: ответить с телефона,
         а запись человек сделает сам — или не сделает. */
      d.addOption("none", t("Nowhere — only into the chat"));
      d.setValue(a.target || "daily").onChange((v) => { a.target = v; this.draw(); });
    });

    if ((a.target || "daily") === "none") {
      new Setting(c).setDesc(t("The answer is not saved to the vault. Switch on the app or Telegram below, otherwise it will be seen only in the window."));
    } else if ((a.target || "daily") === "daily") {
      new Setting(c).setName(t("Heading")).setDesc(t("Under this heading in the daily note."))
        .addText((tx) => tx.setPlaceholder(a.name || "").setValue(a.heading || "")
          .onChange((v) => { a.heading = v; }));
    } else {
      new Setting(c).setName(t("Folder")).setDesc(t("Where the new note goes."))
        .addText((tx) => {
          tx.setValue(a.folder || "");
          const commit = (v) => { a.folder = String(v || "").trim().replace(/^\/+|\/+$/g, ""); };
          tx.onChange(commit);
          new PathSuggest(tx.inputEl, () => allFolders(this.app), commit);
        });
    }

    const brief = new Setting(c).setName(t("Prompt"))
      .setDesc(t("What the assistant should do. It has the same tools as in a normal chat — it can read your notes, your daily entries, and search the web if that's on."));
    brief.settingEl.addClass("oa-scen-brief");
    brief.addTextArea((tx) => {
      tx.inputEl.rows = 8;
      tx.inputEl.addClass("oa-auto-prompt");
      tx.setValue(a.prompt || "").onChange((v) => { a.prompt = v; });
    });

    new Setting(c)
      .setName(t("Show the result in a window"))
      .setDesc(t("When it finishes, open the answer in a window — rendered, with where it was written and whether it reached Telegram. Turn off for something that runs while you are asleep; you still get a notice, and clicking it opens the same window."))
      .addToggle((x) => x.setValue(a.showResult !== false).onChange((v) => { a.showResult = v; }));

    new Setting(c).setName(t("Notify me when it's done"))
      .addToggle((x) => x.setValue(a.notify !== false).onChange((v) => { a.notify = v; }));

    /* Send it to the phone as well.
       Раньше заметка писалась в любом случае, и это был только способ узнать
       о ней, не открывая ноутбук. С вариантом «никуда» это стало
       единственным местом, куда ответ вообще попадёт. */
    const tg = this.plugin.telegram;
    const ready = tg && tg.configured() && this.plugin.settings.telegram.userId;
    new Setting(c)
      .setName(t("Send it to Telegram too"))
      .setDesc(ready
        ? t("The result arrives in the chat as well as being written into your vault.")
        : t("Connect a bot on the Telegram tab first — then this can send the result to your phone."))
      .addToggle((x) => {
        x.setValue(!!a.telegram && !!ready).onChange((v) => { a.telegram = v; });
        if (!ready) x.setDisabled(true);
      });

    /* Второй адрес доставки — приложение с домашнего экрана. Смысл тот же,
       что у Telegram: узнать результат утром, не открывая ноутбук. */
    const cn = this.plugin.connector;
    const cnReady = cn && cn.configured();
    new Setting(c)
      .setName(t("Send it to the app too"))
      .setDesc(cnReady
        ? t("A notification arrives on the phone, and the text waits inside the app.")
        : t("Switch the Connector on first — then this can notify your phone."))
      .addToggle((x) => {
        x.setValue(!!a.connector && !!cnReady).onChange((v) => { a.connector = v; });
        if (!cnReady) x.setDisabled(true);
      });

    const row = c.createDiv({ cls: "oa-modal-buttons" });
    row.createEl("button", { text: t("Cancel") }).onclick = () => this.close();
    const save = row.createEl("button", { cls: "mod-cta", text: t("Save") });
    save.onclick = async () => {
      Object.assign(this.auto, a);
      await this.plugin.saveSettings();
      this.close();
      if (this.onSave) this.onSave();
    };

    back();
  }
}

/* ============================================================
 *  The result, in a window
 *
 *  An automation used to finish invisibly: a line appeared at the
 *  bottom of a note somewhere and a notice flashed past. Whether
 *  the answer was any good, whether it went to Telegram, whether
 *  anything failed — all of it had to be gone and looked for.
 *
 *  Here it is rendered as markdown, exactly as it will read in the
 *  note, with what happened to it underneath and the two things
 *  you might want next: open the note, or send it to the phone.
 * ========================================================== */
class AutomationResultModal extends Modal {
  constructor(app, plugin, automation, out) {
    super(app);
    this.plugin = plugin;
    this.auto = automation;
    this.out = out;
  }

  onOpen() {
    this.modalEl.addClass("oa-result");
    this.draw();
  }

  onClose() { this.contentEl.empty(); }

  draw() {
    const c = this.contentEl;
    c.empty();
    const out = this.out;

    const head = c.createDiv({ cls: "oa-result-head" });
    head.createEl("h3", { text: out.title || t("Automation") });
    head.createDiv({ cls: "oa-result-when", text: this.auto.prompt ? `«${String(this.auto.prompt).slice(0, 120)}»` : "" });

    if (out.text) {
      const body = c.createDiv({ cls: "oa-result-body markdown-rendered" });
      // Rendered, not printed. The answer is written as markdown for a note,
      // so a window showing it as raw text with hashes in it would be showing
      // you the wrong thing.
      MarkdownRenderer.render(this.app, out.text, body, "", this.plugin);
    } else {
      c.createDiv({ cls: "oa-note", text: t("The run came back with nothing to write.") });
    }

    // What happened to it. Every line here is something you would otherwise
    // have had to go and check.
    const facts = c.createDiv({ cls: "oa-result-facts" });
    if (out.file) facts.createDiv({ cls: "oa-fact ok", text: "📄 " + t("Written to: {0}", out.file.path) });
    if (this.auto.telegram) {
      facts.createDiv({
        cls: "oa-fact " + (out.sent ? "ok" : "bad"),
        text: out.sent ? "✈️ " + t("Sent to Telegram") : "✈️ " + t("Not sent to Telegram"),
      });
    }
    for (const e of out.errors || []) facts.createDiv({ cls: "oa-fact bad", text: "⚠ " + e });

    const row = c.createDiv({ cls: "oa-modal-buttons" });
    if (out.file) {
      row.createEl("button", { text: t("Open the note") }).onclick = () => {
        this.close();
        this.app.workspace.getLeaf(false).openFile(out.file);
      };
    }
    if (out.text) {
      row.createEl("button", { text: t("Copy") }).onclick = async () => {
        await navigator.clipboard.writeText(out.text);
        new Notice(t("Copied"));
      };
      // Offered even when the automation never asked for Telegram: having
      // read the answer, sending it on is a fair thing to want.
      if (this.plugin.telegram && this.plugin.telegram.configured() && !out.sent) {
        row.createEl("button", { text: t("Send to Telegram") }).onclick = async () => {
          try {
            const ok = await this.plugin.telegram.push(`## ${out.title}\n\n${out.text}`);
            this.out.sent = !!ok;
            if (!ok) new Notice(t("Nobody is linked to the bot yet — send it /start first."), 8000);
            this.draw();
          } catch (e) {
            new Notice(t("Telegram refused the message: {0}", e.message), 8000);
          }
        };
      }
    }
    row.createEl("button", { cls: "mod-cta", text: t("Done") }).onclick = () => this.close();
  }
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
   * Run one automation. `manual` is the "Run now" button.
   *
   * A hand-run deliberately does NOT claim the day. It used to: the idea was
   * that running the morning digest by hand should stop the timer repeating
   * it an hour later. In practice it meant pressing "Run now" once silently
   * cancelled that day's scheduled run — so the way anyone tests an
   * automation is also the way they stop it from firing, and the feature
   * looks broken. A digest arriving twice is a smaller problem than one that
   * never arrives.
   */
  async run(a, { manual = false } = {}) {
    if (this.running.has(a.id)) return null;
    this.running.add(a.id);
    const plugin = this.plugin;

    /* A notice that stays up while it works.
       An automation takes tens of seconds, and until it finished there was no
       sign anywhere that anything had started — the first you knew of it was
       the answer, or nothing at all if it failed. This says it began, then
       follows along: searching, reading, writing. `0` means it stays until
       hidden, and the `finally` below is what hides it. */
    const name = a.name || t("Custom automation");
    const notice = a.notify === false ? null : new Notice("⏳ " + t("{0} — running…", name), 0);

    try {
      const agent = new Agent(plugin);
      const reply = await agent.run([], a.prompt || "", {
        onEvent: (ev) => {
          if (notice && ev && ev.kind === "action") notice.setMessage(`⏳ ${name}\n${ev.text}`);
        },
        // An unattended run must never sit waiting on a keypress that will
        // never come, so any confirm is declined — it just won't edit or delete.
        confirm: async () => false,
        onSegment: null,
        written: true,
      });
      const answer = String(reply || "").trim();
      const out = answer
        ? await this.deliver(a, answer, agent.sources || [])
        : { text: "", file: null, sent: false, errors: [t("The run came back with nothing to write.")] };
      out.text = answer;
      out.title = a.name || t("Morning digest");

      /* Show it, unless this one was told not to.
         A run by hand always opens the window — you are standing right there.
         A scheduled run does too by default: the whole complaint about
         automations was that something happens somewhere and you have to go
         looking for it. The switch exists because a window appearing over
         your work at 08:30 is a fair thing to not want. */
      // Down before the result appears, or the running notice sits under a
      // window announcing that the running has finished.
      if (notice) notice.hide();
      if (manual || a.showResult !== false) new AutomationResultModal(plugin.app, plugin, a, out).open();
      else this.announce(a, out);
      return out;
    } finally {
      if (notice) notice.hide();
      this.running.delete(a.id);
    }
  }

  /**
   * Put the answer where the automation says, and report what actually
   * happened to it.
   *
   * Each delivery is on its own. They used to run in sequence in one `try`,
   * so a note that failed to be written took the Telegram message down with
   * it — the failure was in the note, but what you noticed was the message
   * that never arrived. Now one can fail without touching the other, and both
   * outcomes come back to be shown.
   */
  async deliver(a, text, sources) {
    const plugin = this.plugin, V = plugin.vault;
    const title = a.name || t("Morning digest");
    const stamp = todayKey();
    const body = text + this.sourcesBlock(sources);
    const out = { text, file: null, sent: false, errors: [] };

    try {
      // «Никуда» — значит никуда: ни новой заметки, ни строки в ежедневной.
      if (a.target === "none") { /* ничего не пишем */ }
      else if (a.target === "note") {
        out.file = await V.createNote(`${title} ${stamp}`, `# ${title} — ${stamp}\n\n${body}\n`,
          a.folder || plugin.settings.newNoteFolder || "");
      } else {
        // Into today's daily note, made through Obsidian's own command if the
        // day hasn't one yet — so a digest arriving before you have opened the
        // vault does not leave you an empty note where your template should be.
        let file = await V.ensureDailyNote("today");
        if (file) await V.appendToNote(file, body, a.heading || title);
        // No daily notes at all in this vault — the answer still has to land
        // somewhere rather than being thrown away.
        else file = await V.createNote(`${title} ${stamp}`, body, plugin.settings.newNoteFolder || "");
        out.file = file;
      }
    } catch (e) {
      out.errors.push(t("Could not write the note: {0}", (e && e.message) || e));
    }

    if (a.connector) {
      try {
        const cn = plugin.connector;
        if (!cn || !cn.configured()) {
          out.errors.push(t("The Connector is off, so nothing was sent to the app."));
        } else {
          // Свой чат у каждой автоматизации: её же номер. Тот же номер
          // уезжает в уведомление, поэтому нажатие открывает именно её.
          await cn.post(text, a.id, title);
          const ok = await cn.notify(title, text, a.id);
          if (!ok) out.errors.push(t("Nobody has switched notifications on in the app yet."));
        }
      } catch (e) {
        out.errors.push(t("Could not notify the app: {0}", (e && e.message) || e));
      }
    }

    if (a.telegram) {
      try {
        if (!plugin.telegram || !plugin.telegram.configured()) {
          out.errors.push(t("Telegram is not connected, so nothing was sent."));
        } else if (!plugin.settings.telegram.userId) {
          out.errors.push(t("Nobody is linked to the bot yet — send it /start first."));
        } else {
          const where = out.file ? `\n\n_${t("Written to: {0}", out.file.path)}_` : "";
          out.sent = await plugin.telegram.push(`## ${title} · ${stamp}\n\n${text}${where}`);
        }
      } catch (e) {
        // Said out loud rather than logged. A message that silently fails to
        // arrive is indistinguishable from a feature that does not work.
        out.errors.push(t("Telegram refused the message: {0}", (e && e.message) || e));
      }
    }
    return out;
  }

  /** A scheduled run finished while you were doing something else. */
  announce(a, out) {
    if (a.notify === false) return;
    const plugin = this.plugin;
    const bad = out.errors.length;
    const n = new Notice(bad ? t("{0}: something went wrong", out.title) : t("{0} is ready", out.title), 12000);
    if (!n.noticeEl) return;
    n.noticeEl.addClass("oa-notice-click");
    // Clicking opens the same window the manual run shows, rather than the
    // note — the window has the answer, where it went, and what failed.
    n.noticeEl.addEventListener("click", () => new AutomationResultModal(plugin.app, plugin, a, out).open());
  }

  sourcesBlock(sources) {
    if (!sources || !sources.length) return "";
    const links = sources.slice(0, 12).map((s) => `[[${(s.title || s.path || "").replace(/\.md$/, "")}]]`).join(" · ");
    return `\n\n---\n${t("Sources: ")}${links}`;
  }
}
