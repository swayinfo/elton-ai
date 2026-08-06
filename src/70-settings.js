/* ============================================================
 *  Onboarding
 *
 *  A first run that ends with a working assistant, not a wall of
 *  switches. Each slide asks for one thing and writes it straight
 *  to settings, so quitting halfway still leaves progress behind.
 * ========================================================== */
class OnboardingModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.step = 0;
  }

  onOpen() {
    this.modalEl.addClass("oa-onb");
    this.draw();
  }

  onClose() { this.contentEl.empty(); }

  get steps() {
    return [
      {
        title: t("Meet your assistant"),
        body: t("It reads and writes the notes you already have. Talk to it or type — it searches your vault, answers from it, and edits notes when you ask."),
        icon: "sparkles",
        // The first slide is where someone decides whether to hand this thing
        // a key and their notes. A name and an address belong here.
        render: (c) => {
          const box = c.createDiv({ cls: "oa-note" });
          box.createDiv({ cls: "oa-note-title", text: t("Who made this") });
          const line = box.createDiv();
          line.appendText(t("Elton — I build tools for Obsidian and use this one every day. What the plugin sends, where it sends it and what it never touches is written out in full on the Vault tab and in the readme: ") );
          const a = line.createEl("a", { text: siteLabel(), href: siteUrl() });
          a.setAttr("target", "_blank");
          a.setAttr("rel", "noopener");
        },
      },
      { title: t("Pick where the brains come from"), body: t("Four options: Elton AI, OpenRouter, a local model on your own machine, or OpenAI directly. You bring the key — the plugin stores it only in this vault."), icon: "plug", render: (c) => this.stepProvider(c) },
      { title: t("Give it a name"), body: t("Call it whatever you like. The name is what it answers to and how it introduces itself."), icon: "user", render: (c) => this.stepName(c) },
      { title: t("Decide what it may touch"), body: t("By default it can read the whole vault, and create or edit notes. Deleting always asks you first. You can narrow it to specific folders."), icon: "shield", render: (c) => this.stepPerms(c) },
      { title: t("Let it learn your vault"), body: t("Before it writes anything it needs to know how your vault is arranged — which folders hold what, and which templates a new note should be built from. Here is what it found. Correct it if it got something wrong."), icon: "folder-tree", render: (c) => this.stepVault(c) },
      { title: t("You're set"), body: t("Open the panel from the ribbon or the command palette. Everything here can be changed later in settings."), icon: "check-circle", render: null },
    ];
  }

  draw() {
    const c = this.contentEl;
    // Choosing a provider redraws this slide to show the fields that provider
    // needs — the same slide, so the reader's place is kept. Moving to the
    // next slide is a new page and starts at the top.
    const back = keepScroll(c);
    const same = this.step === this._drawnStep;
    this._drawnStep = this.step;

    c.empty();
    const s = this.steps[this.step];

    const dots = c.createDiv({ cls: "oa-onb-dots" });
    this.steps.forEach((_, i) => dots.createDiv({ cls: "oa-onb-dot" + (i === this.step ? " is-on" : "") }));

    const ic = c.createDiv({ cls: "oa-onb-icon" });
    setIcon(ic, s.icon);
    c.createEl("h2", { text: s.title, cls: "oa-onb-title" });
    c.createDiv({ cls: "oa-onb-body", text: s.body });

    if (s.render) s.render(c.createDiv({ cls: "oa-onb-form" }));

    const nav = c.createDiv({ cls: "oa-onb-nav" });
    if (this.step > 0) {
      const b = nav.createEl("button", { text: t("Back") });
      b.onclick = () => { this.step--; this.draw(); };
    } else {
      const b = nav.createEl("button", { text: t("Skip") });
      b.onclick = () => this.finish();
    }
    const next = nav.createEl("button", { cls: "mod-cta", text: this.step === this.steps.length - 1 ? t("Done") : t("Next") });
    next.onclick = async () => {
      if (this.step === this.steps.length - 1) return this.finish();
      this.step++;
      await this.plugin.saveSettings();
      this.draw();
    };

    if (same) back();
  }

  stepProvider(c) {
    const s = this.plugin.settings;
    new Setting(c)
      .setName(t("AI provider"))
      .addDropdown((d) => {
        Object.entries(PROVIDERS).forEach(([id, p]) => d.addOption(id, t(p.label)));
        d.setValue(s.provider).onChange(async (v) => { s.provider = v; await this.plugin.saveSettings(); this.draw(); });
      });
    const p = PROVIDERS[s.provider];
    if (p.needsKey) {
      new Setting(c).setName(t("API key")).addText((tx) => {
        tx.inputEl.type = "password";
        tx.setValue(s.keys[s.provider] || "").onChange(async (v) => { s.keys[s.provider] = v.trim(); await this.plugin.saveSettings(); });
      });
    } else if (!p.fixedBase) {
      new Setting(c).setName(t("Server address")).addText((tx) =>
        tx.setValue(s.bases[s.provider] || "").onChange(async (v) => { s.bases[s.provider] = v.trim(); await this.plugin.saveSettings(); }));
    }
    new Setting(c).setName(t("Model")).addText((tx) =>
      tx.setValue(s.models[s.provider] || "").onChange(async (v) => { s.models[s.provider] = v.trim(); await this.plugin.saveSettings(); }));
  }

  stepName(c) {
    const s = this.plugin.settings;
    new Setting(c).setName(t("What should it be called?")).addText((tx) =>
      tx.setValue(s.assistantName).onChange(async (v) => { s.assistantName = v; await this.plugin.saveSettings(); }));
    new Setting(c).setName(t("How should it address you?")).addText((tx) =>
      tx.setValue(s.userName).onChange(async (v) => { s.userName = v; await this.plugin.saveSettings(); }));
  }

  stepPerms(c) {
    const s = this.plugin.settings;
    const tog = (name, key, desc) => new Setting(c).setName(name).setDesc(desc || "")
      .addToggle((x) => x.setValue(s[key]).onChange(async (v) => { s[key] = v; await this.plugin.saveSettings(); }));
    tog(t("Read notes"), "canRead");
    tog(t("Create notes"), "canCreate");
    tog(t("Edit notes"), "canEdit");
    tog(t("Delete notes"), "canDelete", t("Even with this on, every deletion stops and waits for you to confirm from the keyboard. It can never delete anything on its own."));

    /* Asked here rather than left to be found.
       Answering sends parts of notes to a provider, and the moment to decide
       which parts may never go is before the first question, not after. */
    c.createDiv({ cls: "oa-warn", text: t("⚠ Answering a question sends parts of your notes to your AI provider. Anything in the folders below is never read, never searched, never indexed and never sent — even when it is the note open on your screen. This is the place for medical records, finances, passwords, other people's information, anything under an agreement.") });
    new Setting(c)
      .setName(t("Private folders"))
      .setDesc(t("One folder per line, relative to the vault root. Subfolders are covered too."))
      .addTextArea((tx) => {
        tx.inputEl.rows = 3;
        tx.setPlaceholder(t("2. Areas/Health"))
          .setValue(s.privateFolders || "")
          .onChange(async (v) => {
            s.privateFolders = v;
            await this.plugin.saveSettings();
            this.plugin.vault.index = null;
            this.plugin.vault._map = null;
          });
      });
  }

  /**
   * The map, shown rather than described.
   *
   * A note created without this comes out orphaned — no properties, no link
   * back, filed in the root — and the user's only clue is that the assistant
   * seems careless. Showing what it worked out turns that into something that
   * can be checked and corrected in ten seconds.
   */
  stepVault(c) {
    const s = this.plugin.settings;
    const V = this.plugin.vault;

    const found = V.templateFolder();
    const setting = new Setting(c)
      .setName(t("Templates folder"))
      .setDesc(found ? t("Found on its own: {0}", found) : t("None found — point at it if you have one."));
    setting.addText((tx) => {
      tx.setPlaceholder(found || "Templates").setValue(s.templateFolder || "");
      const commit = async (v) => {
        s.templateFolder = String(v || "").trim().replace(/^\/+|\/+$/g, "");
        V._map = null;
        await this.plugin.saveSettings();
      };
      tx.onChange(commit);
      new PathSuggest(tx.inputEl, () => allFolders(this.app), async (v) => { await commit(v); this.draw(); });
    });

    let map = "";
    try { map = V.describeVault(); } catch (e) { map = String(e.message); }
    c.createDiv({ cls: "oa-map-body", text: map });

    new Setting(c)
      .setName(t("Anything it should know about your system"))
      .setDesc(t("Whatever the folder names don't say. Optional — you can fill this in later."))
      .addTextArea((tx) => {
        tx.inputEl.rows = 3;
        tx.setValue(s.vaultNotes || "").onChange(async (v) => { s.vaultNotes = v; await this.plugin.saveSettings(); });
      });
  }

  async finish() {
    this.plugin.settings.onboarded = true;
    await this.plugin.saveSettings();
    this.close();
    this.plugin.activateView();
  }
}

/* ============================================================
 *  A group of settings, in a window
 *
 *  The tab lists what there is and what state it is in; the window
 *  holds the controls. Used wherever a single tab had grown into a
 *  page you scroll rather than read.
 *
 *  `build` is called again on every redraw, because half of these
 *  settings decide whether the others exist — turning the map off
 *  removes the map, choosing a scope adds a folder list.
 * ========================================================== */
class SettingsGroupModal extends Modal {
  constructor(app, title, build, onClose) {
    super(app);
    this.title = title;
    this.build = build;
    this.done = onClose;
  }

  onOpen() {
    this.modalEl.addClass("oa-scen-edit");
    this.draw();
  }

  draw() {
    const c = this.contentEl;
    const was = this.bodyEl ? this.bodyEl.scrollTop : 0;

    c.empty();
    c.createEl("h3", { text: this.title });
    this.bodyEl = c.createDiv({ cls: "oa-group-body" });
    this.build(this.bodyEl);
    const row = c.createDiv({ cls: "oa-modal-buttons" });
    // One button, and it says done rather than save: everything in here is
    // written the moment it is touched, exactly as on a settings page.
    row.createEl("button", { cls: "mod-cta", text: t("Done") }).onclick = () => this.close();

    // Not `keepScroll`: the scrolling box itself is rebuilt here, so the
    // position has to be carried across to the new one by hand.
    if (was) {
      this.bodyEl.scrollTop = was;
      window.requestAnimationFrame(() => { if (this.bodyEl) this.bodyEl.scrollTop = was; });
    }
  }

  onClose() {
    this.contentEl.empty();
    if (this.done) this.done();
  }
}

/* ============================================================
 *  Settings
 *
 *  Split across tabs rather than one long scroll: each tab is a
 *  whole job ("I'm connecting an AI", "I'm deciding what it may
 *  touch"), so you only face the handful of options that belong to
 *  what you came to do.
 * ========================================================== */
class AssistantSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; this._tab = "connection"; }

  get s() { return this.plugin.settings; }

  display() {
    const c = this.containerEl;

    /* Hold the reader's place across a redraw.
       `display()` is called by a couple of dozen controls — every toggle that
       changes what else belongs on the page — and each one used to throw the
       scroll position away. The scrolling element is Obsidian's own tab
       container, not ours, so it is found rather than assumed. */
    const scroller = c.closest(".vertical-tab-content") || c.parentElement;
    const back = keepScroll(scroller);

    c.empty();
    c.addClass("oa-settings");

    // The way in for anyone who doesn't want to read a settings page.
    const onb = c.createDiv({ cls: "oa-onb-card" });
    const left = onb.createDiv();
    left.createDiv({ cls: "oa-onb-card-title", text: t("Getting started") });
    left.createDiv({ cls: "oa-onb-card-sub", text: t("Walks you through the provider, the assistant's name and what it may touch. Two minutes.") });
    // Who made this, on the first thing anyone reads.
    // A plugin that asks for a key and reads your notes is asking for trust,
    // and trust wants a name and an address behind it rather than a username.
    const by = left.createDiv({ cls: "oa-onb-card-by" });
    by.appendText(t("Made by Elton") + " · ");
    // The plugin's own page, not the site's front door: someone clicking from
    // inside the plugin wants this plugin, not a homepage to navigate from.
    const site = by.createEl("a", { text: siteLabel(), href: siteUrl() });
    site.setAttr("target", "_blank");
    site.setAttr("rel", "noopener");
    const go = onb.createEl("button", { cls: "mod-cta", text: t("Open the setup guide") });
    go.onclick = () => new OnboardingModal(this.app, this.plugin).open();

    /* Six, down from eight, and none of them a page you scroll past.
       The two that went were not deletions: Search belongs with the vault it
       searches, and Automations is the same card list as Scenarios — a saved
       prompt behind a phrase, or behind a time. Splitting them meant two tabs
       that each held one list. What is left is one tab per question you might
       arrive with, and the dials nobody turns are folded under Advanced. */
    const TABS = [
      { id: "connection", label: t("Connection") },
      // Short labels on purpose: at full length they overflow the strip in
      // either language. The full wording lives on the headings inside.
      { id: "persona", label: t("Assistant") },
      { id: "voice", label: t("Voice") },
      { id: "access", label: t("Vault") },
      { id: "scenarios", label: t("Tasks") },
      { id: "telegram", label: t("Telegram") },
      { id: "ui", label: t("Interface") },
    ];
    if (!TABS.some((x) => x.id === this._tab)) this._tab = "connection";
    const bar = c.createDiv({ cls: "oa-set-tabs" });
    let active = null;
    TABS.forEach((tab) => {
      const on = tab.id === this._tab;
      const el = bar.createDiv({ cls: "oa-set-tab" + (on ? " is-on" : ""), text: tab.label });
      if (on) active = el;
      el.onclick = () => { this._tab = tab.id; this.display(); };
    });
    // The strip scrolls rather than wraps, so the tab you just opened can be
    // off to one side of it — which looks like nothing happened.
    if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });

    const body = c.createDiv({ cls: "oa-set-body" });
    ({
      connection: () => this.tabConnection(body),
      persona: () => this.tabPersona(body),
      voice: () => this.tabVoice(body),
      access: () => this.tabAccess(body),
      scenarios: () => this.tabTasks(body),
      telegram: () => this.tabTelegram(body),
      ui: () => this.tabUI(body),
    })[this._tab]();

    // Switching tabs is the one case where starting at the top is right —
    // that is a new page, not the same one redrawn.
    if (this._tab === this._drawnTab) back();
    this._drawnTab = this._tab;
  }

  save(rerender) {
    return async () => { await this.plugin.saveSettings(); if (rerender) this.display(); };
  }


  /**
   * A fold for settings almost nobody changes.
   *
   * Every one of these earned its place, and together they still made the
   * page unreadable — the eye has to walk past a dozen dials it will never
   * touch to reach the one it came for. Folding them keeps the capability and
   * loses the wall. Open state is remembered per section for the life of the
   * settings tab, so adjusting two things in a row doesn't mean two clicks.
   */
  advanced(c, key, build) {
    this._openAdv = this._openAdv || {};
    const box = c.createDiv({ cls: "oa-adv" + (this._openAdv[key] ? " is-open" : "") });
    const head = box.createEl("button", { cls: "oa-adv-head" });
    head.createSpan({ cls: "oa-adv-caret", text: "›" });
    head.createSpan({ text: t("Advanced") });
    head.setAttr("aria-expanded", this._openAdv[key] ? "true" : "false");
    head.onclick = () => { this._openAdv[key] = !this._openAdv[key]; this.display(); };
    if (this._openAdv[key]) build(box.createDiv({ cls: "oa-adv-body" }));
    return box;
  }

  /** A text field that suggests real folders as you type. */
  folderField(setting, get, set, placeholder) {
    setting.addText((tx) => {
      tx.setPlaceholder(placeholder || "").setValue(get());
      const commit = async (v) => { await set(String(v || "").trim().replace(/^\/+|\/+$/g, "")); };
      tx.onChange(commit);
      new PathSuggest(tx.inputEl, () => allFolders(this.app), commit);
    });
    return setting;
  }

  /** The same, for pointing at a single file. */
  fileField(setting, get, set, ext, placeholder) {
    setting.addText((tx) => {
      tx.setPlaceholder(placeholder || "").setValue(get());
      const commit = async (v) => { await set(String(v || "").trim()); };
      tx.onChange(commit);
      new PathSuggest(tx.inputEl, () => allFiles(this.app, ext), commit);
    });
    return setting;
  }

  /* ── connection ─────────────────────────────────────────── */
  tabConnection(c) {
    const s = this.s;
    new Setting(c)
      .setName(t("AI provider"))
      .setDesc(t("Where requests go. All four speak the same protocol — switching keeps your other settings."))
      .addDropdown((d) => {
        Object.entries(PROVIDERS).forEach(([id, p]) => d.addOption(id, t(p.label)));
        d.setValue(s.provider).onChange(async (v) => {
          s.provider = v;
          // A model list fetched from the old address says nothing about the
          // new one, and neither does the user's choice to type one by hand.
          this._models = null;
          this._custom = false;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    const p = PROVIDERS[s.provider];

    if (p.needsKey) {
      new Setting(c)
        .setName(t("API key"))
        .setDesc(t("Stored in this vault's plugin folder in plain text, like every Obsidian plugin. Don't put it in a vault you share or sync publicly."))
        .addText((tx) => {
          tx.inputEl.type = "password";
          tx.setPlaceholder(t("Paste your key here")).setValue(s.keys[s.provider] || "")
            .onChange(async (v) => { s.keys[s.provider] = v.trim(); await this.plugin.saveSettings(); });
        });
    }

    // Elton AI's address is part of the service rather than something to
    // configure, so the field is not shown at all.
    if (!p.fixedBase) {
      new Setting(c)
        .setName(t("Server address"))
        .setDesc(s.provider === "local" ? t("Ollama's default is http://localhost:11434/v1 · LM Studio's is http://localhost:1234/v1") : "")
        .addText((tx) => tx.setValue(s.bases[s.provider] || "").onChange(async (v) => {
          s.bases[s.provider] = v.trim() || PROVIDERS[s.provider].base;
          await this.plugin.saveSettings();
        }));
    }

    this.modelSetting(c);

    new Setting(c)
      .setName(t("Show what it cost"))
      .setDesc(t("A quiet line under each answer: what left your balance and how many tokens it took."))
      .addToggle((x) => x.setValue(s.showCost).onChange(async (v) => {
        s.showCost = v; await this.plugin.saveSettings(); this.display();
      }));

    if (s.showCost && this.plugin.spend) {
      c.createDiv({ cls: "oa-index-status", text: t("Spent this session") + ": " + this.plugin.spend.sessionLine() });
    }

    new Setting(c).addButton((b) => b.setButtonText(t("Test connection")).onClick(async () => {
      b.setButtonText(t("Checking…")).setDisabled(true);
      try {
        await this.plugin.ai.chat([{ role: "user", content: "Reply with the single word: ok" }], { maxTokens: 10 });
        new Notice(t("Connection works"));
      } catch (e) {
        new Notice(t("Connection failed: {0}", e.message), 8000);
      } finally { b.setButtonText(t("Test connection")).setDisabled(false); }
    }));

    this.advanced(c, "connection", (a) => {
      new Setting(a)
        .setName(t("Show the answer as it's written"))
        .setDesc(t("The reply appears word by word instead of all at once when it's done. Falls back on its own if the provider can't stream."))
        .addToggle((x) => x.setValue(s.streamReplies).onChange(async (v) => {
          s.streamReplies = v; await this.plugin.saveSettings();
        }));
    });

    // Voice needs a cloud provider; a local model can neither hear nor speak.
    if (s.provider === "local") {
      new Setting(c).setName(t("Cloud fallback for voice")).setHeading();
      new Setting(c)
        .setDesc(t("A local model can't transcribe speech or speak. Point this at a cloud key and voice keeps working while text stays local."))
        .addToggle((x) => x.setValue(s.cloudFallback.enabled).onChange(async (v) => {
          s.cloudFallback.enabled = v; await this.plugin.saveSettings(); this.display();
        }));
      if (s.cloudFallback.enabled) {
        new Setting(c).setName(t("AI provider")).addDropdown((d) => {
          Object.entries(PROVIDERS).filter(([id]) => id !== "local").forEach(([id, pr]) => d.addOption(id, t(pr.label)));
          d.setValue(s.cloudFallback.provider).onChange(async (v) => { s.cloudFallback.provider = v; await this.plugin.saveSettings(); });
        });
        new Setting(c).setName(t("API key")).addText((tx) => {
          tx.inputEl.type = "password";
          tx.setValue(s.cloudFallback.key).onChange(async (v) => { s.cloudFallback.key = v.trim(); await this.plugin.saveSettings(); });
        });
      }
    }
  }

  /**
   * The model picker.
   *
   * A named list where one exists, a text box where it doesn't — and the text
   * box stays reachable either way, because a curated list that cannot be
   * escaped is a list that goes stale the week a new model ships.
   */
  modelSetting(c) {
    const s = this.s;
    const current = s.models[s.provider] || "";
    const choices = modelChoices(s.provider);
    // Whatever the server told us this session outranks the built-in list:
    // it is the truth about that particular address.
    const fetched = (this._models && this._models.length) ? this._models.map((id) => ({ id, note: "" })) : null;
    const list = fetched || choices;
    const known = list.some((m) => m.id === current);
    // The text box is showing when there is no list to pick from, when the
    // user asked for it, or when nothing is chosen yet — never leaving the
    // dropdown parked on "Another model…" with no way to type one.
    const useCustom = !list.length || !!this._custom || !current;

    const setting = new Setting(c)
      .setName(t("Model"))
      .setDesc(t("The model that answers and calls tools. It must support tool calling, or the assistant can only chat."));

    if (list.length) {
      setting.addDropdown((d) => {
        for (const m of list) d.addOption(m.id, m.note ? `${m.id} — ${t(m.note)}` : m.id);
        // A model saved before this list existed, or typed by hand, must not
        // silently turn into something else just because it is not on it.
        if (current && !known) d.addOption(current, `${current} — ${t("your own")}`);
        d.addOption("__custom__", t("Another model…"));
        d.setValue(current || "__custom__");
        d.onChange(async (v) => {
          if (v === "__custom__") { this._custom = true; this.display(); return; }
          this._custom = false;
          s.models[s.provider] = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });
    }

    if (useCustom) {
      new Setting(c)
        .setName(list.length ? t("Model id") : " ")
        .setDesc(list.length ? t("Exactly as the provider spells it, for example anthropic/claude-sonnet-4.6.") : "")
        .addText((tx) => {
          tx.setPlaceholder(PROVIDERS[s.provider].model);
          tx.setValue(current).onChange(async (v) => {
            s.models[s.provider] = v.trim();
            await this.plugin.saveSettings();
          });
        });
    }

    // Only where the question can actually be asked — the Elton AI proxy
    // answers 405 to it, and a button that always fails is worse than none.
    if (canListModels(s.provider)) {
      setting.addExtraButton((b) => b.setIcon("refresh-cw").setTooltip(t("Refresh model list")).onClick(async () => {
        b.setDisabled(true);
        try {
          const got = await this.plugin.ai.listModels();
          if (!got.length) { new Notice(t("No models found at that address. Is the server running?")); return; }
          new Notice(t("Found {0} models", got.length));
          this._models = got;
          this._custom = false;
          this.display();
        } catch (e) {
          new Notice(t("Connection failed: {0}", e.message));
        } finally { b.setDisabled(false); }
      }));
    }

    // A second, quicker model for the searching. Measured through the proxy on
    // the same request: choosing a tool takes Sonnet 2.6s and Gemini Flash
    // 0.9s, and both choose the same tool. That step repeats two to four times
    // a turn, so it is most of the wait before the assistant starts talking.
    const auto = FAST_MODELS[s.provider];
    if (auto) {
      new Setting(c)
        .setName(t("Quick model for searching"))
        .setDesc(t("Finding the right notes is a lot of small decisions, and a quick model makes them just as well as a clever one — about three times faster. The answer itself is still written by the model above."))
        .addDropdown((d) => {
          d.addOption("auto", t("Automatic ({0})", auto));
          for (const m of modelChoices(s.provider)) d.addOption(m.id, `${m.id} — ${t(m.note)}`);
          d.addOption("", t("Off — one model for everything"));
          d.setValue(s.fastModel == null ? "auto" : s.fastModel)
            .onChange(async (v) => { s.fastModel = v; await this.plugin.saveSettings(); });
        });
    }
  }

  /* ── persona ────────────────────────────────────────────── */
  tabPersona(c) {
    const s = this.s;
    new Setting(c)
      .setName(t("What should it be called?"))
      .setDesc(t("The assistant answers to this name and uses it when it introduces itself."))
      .addText((tx) => tx.setValue(s.assistantName).onChange(async (v) => {
        s.assistantName = v || "Assistant"; await this.plugin.saveSettings(); this.plugin.refreshViews();
      }));

    new Setting(c)
      .setName(t("How should it address you?"))
      .setDesc(t("Your name, so it doesn't have to say \"you\" for everything. Leave empty to stay anonymous."))
      .addText((tx) => tx.setValue(s.userName).onChange(async (v) => { s.userName = v; await this.plugin.saveSettings(); }));

    new Setting(c)
      .setName(t("Character"))
      .setDesc(t("Sets the tone of every reply."))
      .addDropdown((d) => {
        d.addOption("calm", t("Calm and precise"));
        d.addOption("warm", t("Warm and chatty"));
        d.addOption("blunt", t("Short and blunt"));
        d.addOption("custom", t("Custom"));
        d.setValue(s.persona).onChange(async (v) => { s.persona = v; await this.plugin.saveSettings(); this.display(); });
      });

    if (s.persona === "custom") {
      new Setting(c)
        .setName(t("Custom character"))
        .setDesc(t("Describe how it should behave. Replaces the preset above."))
        .addTextArea((tx) => {
          tx.inputEl.rows = 4;
          tx.setValue(s.personaCustom).onChange(async (v) => { s.personaCustom = v; await this.plugin.saveSettings(); });
        });
    }

    new Setting(c)
      .setName(t("Answer length"))
      .setDesc(t("How much the assistant may write in one go. If an answer still runs past it, the rest is fetched and joined on — you never get a sentence that stops mid-word. Longer answers cost more tokens."))
      .addDropdown((d) => {
        d.addOption("900", t("Short — a few paragraphs"));
        d.addOption("2000", t("Normal — a full explanation"));
        d.addOption("4000", t("Long — detailed and thorough"));
        d.setValue(String(s.replyTokens));
        d.onChange(async (v) => { s.replyTokens = Number(v); await this.plugin.saveSettings(); });
      });

    new Setting(c).setName(t("Context note")).setHeading();
    // The warning goes above the field, not below it: after you have typed
    // your medical history into a box, being told not to is too late.
    c.createDiv({ cls: "oa-warn", text: t("⚠ This note is sent to your AI provider with every single request. Never put passwords, keys, financial or medical records, or anything about other people in it. Keep it to what you would say out loud in a meeting.") });

    new Setting(c)
      .setDesc(t("A note the assistant reads before every reply — your projects, your goals, how you like things phrased. Path inside the vault."))
      .addText((tx) => tx.setPlaceholder("Context.md").setValue(s.contextNote)
        .onChange(async (v) => { s.contextNote = v.trim(); await this.plugin.saveSettings(); }))
      .addExtraButton((b) => b.setIcon("file-plus").setTooltip(t("Create this note")).onClick(async () => {
        const path = normalizePath(s.contextNote || "Context.md");
        let f = this.app.vault.getAbstractFileByPath(path);
        if (!f) {
          await this.plugin.vault.ensureFolder(path.split("/").slice(0, -1).join("/"));
          f = await this.app.vault.create(path, `# ${t("Context note")}\n\n`);
          s.contextNote = path;
          await this.plugin.saveSettings();
          this.display();
        }
        if (f instanceof TFile) this.app.workspace.getLeaf(false).openFile(f);
      }));
  }

  /* ── voice ──────────────────────────────────────────────── */
  tabVoice(c) {
    const s = this.s;
    new Setting(c)
      .setName(t("Voice replies"))
      .setDesc(t("Read answers out loud. Turn off for a text-only assistant."))
      .addToggle((x) => x.setValue(s.voiceEnabled).onChange(async (v) => { s.voiceEnabled = v; await this.plugin.saveSettings(); this.display(); }));

    /* What language you speak to it in.
       Stated rather than detected: a short clip of Russian is regularly heard
       as Polish, and what comes back is your own sentence spelled in a
       language you do not read. */
    new Setting(c)
      .setName(t("The language you speak"))
      .setDesc(t("What your speech is transcribed as. Left on the interface language, which is right unless you read the plugin in one language and talk to it in another."))
      .addDropdown((d) => {
        d.addOption("", t("Same as the interface"));
        d.addOption("ru", t("Russian"));
        d.addOption("en", t("English"));
        d.setValue(s.speechLang || "").onChange(async (v) => { s.speechLang = v; await this.plugin.saveSettings(); });
      });

    // Before the early return below: this is about talking TO it, which works
    // whether or not it talks back.
    this.holdKeySetting(c);

    if (!s.voiceEnabled) return;

    new Setting(c)
      .setName(t("Speech engine"))
      .addDropdown((d) => {
        d.addOption("cloud", t("Cloud voice (best quality, costs tokens)"));
        d.addOption("piper", t("Piper (local, natural sounding)"));
        d.addOption("system", t("System voice (free, offline)"));
        d.setValue(s.ttsEngine).onChange(async (v) => { s.ttsEngine = v; await this.plugin.saveSettings(); this.display(); });
      });

    if (s.ttsEngine === "piper") {
      new Setting(c)
        .setName(t("Piper server address"))
        .setDesc(t("Piper runs as a small local HTTP server. Leave the default unless you changed the port."))
        .addText((tx) => tx.setValue(s.piperUrl).onChange(async (v) => { s.piperUrl = v.trim(); await this.plugin.saveSettings(); }));
    }
    if (s.ttsEngine === "cloud") {
      // Only the voices this provider's speech engine accepts. Offering the
      // full list across vendors is how a valid-looking choice ends up
      // producing a 500 and a silent drop to the system voice.
      const cfg = ttsProfileFor(s.provider === "local" ? s.cloudFallback.provider : s.provider);
      new Setting(c)
        .setName(t("Cloud voice"))
        .setDesc(t("Voices your provider offers. Puck is lively and reads Russian well."))
        .addDropdown((d) => {
          cfg.voices.forEach((v) => d.addOption(v, v));
          d.setValue(pickVoice(cfg, s.cloudVoice))
            .onChange(async (v) => { s.cloudVoice = v; await this.plugin.saveSettings(); });
        });
    }

    new Setting(c)
      .setName(t("Speech speed"))
      .addSlider((sl) => sl.setLimits(0.6, 1.6, 0.05).setValue(s.speechSpeed).setDynamicTooltip()
        .onChange(async (v) => { s.speechSpeed = v; await this.plugin.saveSettings(); }));

    new Setting(c).addButton((b) => b.setButtonText(t("Test the voice")).onClick(async () => {
      new Notice(t("Speaking a test phrase…"));
      await this.plugin.speaker.say(
        LANG === "ru"
          ? `Здравствуйте. Меня зовут ${s.assistantName}. Я готов к работе.`
          : `Hello. My name is ${s.assistantName}. I'm ready when you are.`);
    }));

    this.advanced(c, "voice", (a) => {
      // Name and description on one row, not a bare heading above a nameless
      // toggle: a `setHeading` at the top of a fold sits flush against the
      // fold's own button with nothing under it, so it read as a label that
      // had slipped out of its card.
      new Setting(a)
        .setName(t("Let me interrupt"))
        .setDesc(t("Start talking while it's speaking and it stops immediately to listen. Off by default: it keeps a microphone open while it talks, and through speakers rather than headphones it hears itself and stops on its own first sentence. Clicking the reactor stops it either way."))
        .addToggle((x) => x.setValue(s.allowInterrupt).onChange(async (v) => {
          s.allowInterrupt = v; await this.plugin.saveSettings(); this.plugin.refreshViews(); this.display();
        }));

      if (s.allowInterrupt) {
        new Setting(a)
          .setName(t("Interrupt sensitivity"))
          .setDesc(t("Lower means it gives up the floor sooner. Raise it if background noise keeps cutting it off."))
          .addSlider((sl) => sl.setLimits(3, 25, 1).setValue(s.interruptSensitivity).setDynamicTooltip()
            .onChange(async (v) => { s.interruptSensitivity = v; await this.plugin.saveSettings(); }));
      }

      new Setting(a)
        .setName(t("Sound while you wait"))
        .setDesc(t("A quiet pulse while an answer is being prepared, so the silence doesn't read as a freeze."))
        .addToggle((x) => x.setValue(s.waitingSound).onChange(async (v) => {
          s.waitingSound = v; await this.plugin.saveSettings(); this.display();
        }));

      if (s.waitingSound) {
        new Setting(a)
          .setName(t("Waiting sound volume"))
          .addSlider((sl) => sl.setLimits(0.05, 1, 0.05).setValue(s.waitingVolume).setDynamicTooltip()
            .onChange(async (v) => { s.waitingVolume = v; await this.plugin.saveSettings(); }))
          .addExtraButton((b) => b.setIcon("play").setTooltip(t("Play it")).onClick(() => {
            // One pass. Passes are fifteen seconds apart now, so waiting for
            // a second one would be a preview that is mostly silence.
            this.plugin.ambience.stop();
            this.plugin.ambience.start(s.waitingVolume);
            window.setTimeout(() => this.plugin.ambience.stop(), 2400);
          }));

        this.fileField(
          new Setting(a).setName(t("Your own waiting sound"))
            .setDesc(t("A .wav from your vault. Leave empty for the built-in sound. Short clips work best — it repeats every few seconds.")),
          () => s.waitingSoundFile,
          async (v) => { s.waitingSoundFile = v; await this.plugin.saveSettings(); },
          "wav", "");
      }

    });
  }

  /* Hold a key and talk, from anywhere.
     Not an Obsidian hotkey, and it cannot be: Obsidian tells a command when a
     key goes down and never when it comes up, so "hold" has no end. This one
     is watched directly, which is also why it is captured by pressing it
     rather than typed. */
  holdKeySetting(c) {
    const s = this.s;
    new Setting(c).setName(t("Hold a key and talk")).setHeading();
    c.createDiv({ cls: "oa-note", text: t("Works anywhere in Obsidian, from any note. Hold the keys, say what you want, let go — the panel opens itself if it was closed. It is a combination the plugin watches directly, so it is set by pressing it rather than by typing it.") });

    const hkSetting = new Setting(c)
      .setName(t("Key combination"))
      .setDesc(hotkeyLabel(s.holdKey));
    hkSetting.addButton((b) => {
      b.setButtonText(s.holdKey ? t("Change") : t("Set")).onClick(() => {
        b.setButtonText(t("Press the keys…")).setDisabled(true);
        const grab = async (e) => {
          const hk = hotkeyFromEvent(e);
          e.preventDefault();
          e.stopPropagation();
          // Modifiers alone are not a combination — keep listening.
          if (!hk) return;
          window.removeEventListener("keydown", grab, true);
          if (hk.code === "Escape") { this.display(); return; }
          s.holdKey = hk;
          await this.plugin.saveSettings();
          this.display();
        };
        window.addEventListener("keydown", grab, true);
      });
    });
    if (s.holdKey) {
      hkSetting.addExtraButton((x) => x.setIcon("trash-2").setTooltip(t("Turn it off")).onClick(async () => {
        s.holdKey = null; await this.plugin.saveSettings(); this.display();
      }));
    }
  }

  /* ── access ─────────────────────────────────────────────── */
  /* ── the vault ──────────────────────────────────────────────
   *
   * Four groups, each behind its own window.
   *
   * Everything here used to sit on one page: eleven toggles, four folder
   * fields, an index panel and a scrollable map. It was the longest tab by a
   * distance and read as a pile rather than a set of decisions. Now the tab is
   * four lines, each summarising what it holds — the state of the whole thing
   * is visible without opening anything, and you open exactly the one you came
   * for.
   * ────────────────────────────────────────────────────────── */
  tabAccess(c) {
    const s = this.s;
    const V = this.plugin.vault;

    const grid = c.createDiv({ cls: "oa-tiles" });

    /* Each tile answers its own question at a glance.
       The facts are chips rather than one run-on line: "reads · creates ·
       edits · whole vault" is a sentence you have to read, four chips is a
       state you can see. On chips carry the accent; off ones stay muted, so
       what is switched off is legible without being loud. */
    const may = [
      [t("reads"), s.canRead],
      [t("creates"), s.canCreate],
      [t("edits"), s.canEdit],
      [t("deletes"), s.canDelete],
      [s.scopeMode === "all" ? t("whole vault")
        : s.scopeMode === "include" ? t("chosen folders only") : t("all but some folders"), true],
    ];
    this.tile(grid, {
      icon: "shield-check",
      name: t("What it may do"),
      facts: may,
      build: (m) => this.groupPermissions(m),
    });

    const tplFolder = V.templateFolder();
    let tplCount = 0;
    try { tplCount = V.templates().length; } catch { tplCount = 0; }
    this.tile(grid, {
      icon: "folder-tree",
      name: t("Where things live"),
      facts: [
        [s.newNoteFolder ? tail(s.newNoteFolder) : t("new notes: root"), !!s.newNoteFolder],
        [(s.dailyFolder || V.dailyFolder()) ? tail(s.dailyFolder || V.dailyFolder()) : t("no daily notes"), !!(s.dailyFolder || V.dailyFolder())],
        [tplFolder ? tail(tplFolder) : t("no templates"), !!tplFolder],
      ],
      build: (m) => this.groupFolders(m),
    });

    this.tile(grid, {
      icon: "map",
      name: t("What it knows about your vault"),
      facts: s.vaultMap === false
        ? [[t("off — it files notes blind"), false]]
        : [
          [t("map on"), true],
          [tplCount ? t("{0} templates", tplCount) : t("no templates found"), !!tplCount],
          [s.vaultNotes ? t("your notes added") : t("nothing from you"), !!s.vaultNotes],
        ],
      build: (m) => this.groupMap(m),
    });

    const web = s.webSearch && (s.provider === "obsimind" || s.provider === "openrouter");
    this.tile(grid, {
      icon: "search",
      name: t("Search and the web"),
      facts: [
        [t("by words"), true],
        [t("by meaning"), !!s.semanticSearch],
        [t("the web"), !!web],
      ],
      build: (m) => this.groupSearch(m),
    });
  }

  /**
   * A tile that opens a window full of settings.
   *
   * A square rather than a row: four of them sit two-up on a settings page and
   * fill the width instead of leaving two thirds of it empty, and the facts
   * have somewhere to go. No chevron — the whole tile is the button, and an
   * arrow that is not itself clickable is an invitation to click the wrong
   * thing.
   */
  tile(c, { icon, name, facts, build }) {
    // A div, not a button. Themes style `button` heavily — this vault's gives
    // them a fixed height and a panel background — and a two-line tile inside
    // one collapses to a single row with its own contents spilling over the
    // top of the next tile. Which is exactly what happened. `clickable` puts
    // the keyboard behaviour back.
    const el = clickable(c.createDiv({ cls: "oa-tile" }));
    const head = el.createDiv({ cls: "oa-tile-head" });
    const mark = head.createDiv({ cls: "oa-tile-icon" });
    setIcon(mark, icon);
    head.createDiv({ cls: "oa-tile-name", text: name });

    const row = el.createDiv({ cls: "oa-tile-facts" });
    for (const [label, on] of facts) {
      if (!label) continue;
      row.createSpan({ cls: "oa-chip" + (on ? " is-on" : ""), text: label });
    }

    // The tile's own facts come from the settings inside it, so the tab is
    // redrawn once the window is done with.
    el.onclick = () => {
      // Held on the tab so `redrawGroup` can reach it: a control inside the
      // window that changes what else belongs there redraws the window.
      this._group = new SettingsGroupModal(this.app, name, build, () => {
        this._group = null;
        this.display();
      });
      this._group.open();
    };
  }

  /**
   * A section heading inside a group window.
   *
   * Obsidian's own `setHeading()` draws a full-width rule and dilutes the text
   * to the same grey as the descriptions around it — in a window it reads as
   * another disabled setting rather than as a divider. This is the opposite:
   * small, dark, tightly spaced, with the air above it doing the separating.
   */
  section(c, text) {
    c.createDiv({ cls: "oa-sec", text });
  }

  /** A fold that lives inside a group window and never touches the page. */
  groupFold(c, key, build) {
    this._openAdv = this._openAdv || {};
    const open = !!this._openAdv[key];
    const box = c.createDiv({ cls: "oa-adv" + (open ? " is-open" : "") });
    const head = box.createEl("button", { cls: "oa-adv-head" });
    head.createSpan({ cls: "oa-adv-caret", text: "›" });
    head.createSpan({ text: t("Advanced") });
    head.onclick = () => { this._openAdv[key] = !this._openAdv[key]; this.redrawGroup(); };
    if (open) build(box.createDiv({ cls: "oa-adv-body" }));
  }

  /* ── group: what it may do ──────────────────────────────── */
  groupPermissions(c) {
    const s = this.s;
    c.createDiv({ cls: "oa-note", text: t("A switched-off permission is not an instruction the assistant is asked to respect — the tool simply stops existing for it. It cannot be talked into using one.") });

    this.section(c, t("Notes"));
    new Setting(c).setName(t("Read notes"))
      .setDesc(t("Search and read. Without this it can only chat — it won't see your vault at all."))
      .addToggle((x) => x.setValue(s.canRead).onChange(async (v) => { s.canRead = v; await this.plugin.saveSettings(); }));
    new Setting(c).setName(t("Create notes"))
      .addToggle((x) => x.setValue(s.canCreate).onChange(async (v) => { s.canCreate = v; await this.plugin.saveSettings(); }));
    new Setting(c).setName(t("Edit notes"))
      .setDesc(t("Change existing notes. Every edit is backed up first, so \"undo that\" always works."))
      .addToggle((x) => x.setValue(s.canEdit).onChange(async (v) => { s.canEdit = v; await this.plugin.saveSettings(); }));
    new Setting(c).setName(t("Delete notes"))
      .setDesc(t("Even with this on, every deletion stops and waits for you to confirm from the keyboard. It can never delete anything on its own."))
      .addToggle((x) => x.setValue(s.canDelete).onChange(async (v) => { s.canDelete = v; await this.plugin.saveSettings(); }));
    new Setting(c).setName(t("Confirm every edit"))
      .setDesc(t("Ask before writing anything, not just before deleting. Safer, slower."))
      .addToggle((x) => x.setValue(s.confirmEveryEdit).onChange(async (v) => { s.confirmEveryEdit = v; await this.plugin.saveSettings(); }));

    this.section(c, t("Your screen"));
    new Setting(c).setName(t("Manage tabs and windows"))
      .setDesc(t("Let it open notes beside each other, open web pages inside the vault and close tabs you're done with. It never touches its own panel, and closing several at once still asks you."))
      .addToggle((x) => x.setValue(s.canControlUI).onChange(async (v) => {
        s.canControlUI = v; await this.plugin.saveSettings(); this.redrawGroup();
      }));

    // The web page part quietly changes behaviour when the core plugin is off
    // — better said here than discovered when a tab opens somewhere else.
    const ip = this.app.internalPlugins;
    const wv = ip && ip.getPluginById ? ip.getPluginById("webviewer") : null;
    if (s.canControlUI && (!wv || !wv.enabled)) {
      const box = c.createDiv({ cls: "oa-note" });
      box.createDiv({ cls: "oa-note-title", text: t("Web viewer is switched off") });
      box.createDiv({ text: t("Pages will open in your system browser instead. Turn on the core plugin «Web viewer» to have them open inside the vault.") });
    }

    /* Privacy, said plainly and given its own place.
       "Where it may work" is a scope with three modes that exclude each other,
       so it cannot answer "work everywhere except my medical notes". This can,
       it is checked before anything else reads a note, and it is worded as
       what people actually come looking for. */
    this.section(c, t("Private folders"));
    const warn = c.createDiv({ cls: "oa-warn" });
    warn.setText(t("⚠ Answering a question sends parts of your notes to your AI provider. Anything in the folders below is never read, never searched, never indexed and never sent — even when it is the note open on your screen. This is the place for medical records, finances, passwords, other people's information, anything under an agreement."));

    new Setting(c)
      .setDesc(t("One folder per line, relative to the vault root. Subfolders are covered too."))
      .addTextArea((tx) => {
        tx.inputEl.rows = 4;
        // Translated like everything else: an example folder is only an
        // example if it is written in a language the reader uses.
        tx.setPlaceholder(t("2. Areas/Health") + "\n" + t("3. Resources/Finances"))
          .setValue(s.privateFolders || "")
          .onChange(async (v) => {
            s.privateFolders = v;
            await this.plugin.saveSettings();
            // Both caches contain material from folders that just became
            // private, so both have to go.
            this.plugin.vault.index = null;
            this.plugin.vault._map = null;
          });
      });

    const hidden = this.plugin.vault.privateList();
    if (hidden.length) {
      let n = 0;
      try { n = this.app.vault.getMarkdownFiles().filter((f) => this.plugin.vault.isPrivate(f.path)).length; } catch { n = 0; }
      c.createDiv({ cls: "oa-note", text: t("{0} notes are hidden from the assistant right now.", n) });
    }

    this.section(c, t("Where it may work"));
    new Setting(c)
      .setDesc(t("A narrower question than privacy: which part of the vault it works in day to day. Private folders stay hidden whatever you choose here."))
      .addDropdown((d) => {
        d.addOption("all", t("Whole vault"));
        d.addOption("include", t("Only these folders"));
        d.addOption("exclude", t("Everything except these folders"));
        d.setValue(s.scopeMode).onChange(async (v) => {
          s.scopeMode = v;
          await this.plugin.saveSettings();
          this.plugin.vault.index = null;   // scope changed → the index is stale
          this.plugin.vault._map = null;
          this.redrawGroup();
        });
      });

    if (s.scopeMode !== "all") {
      new Setting(c)
        .setName(t("Folders"))
        .setDesc(t("One path per line, relative to the vault root."))
        .addTextArea((tx) => {
          tx.inputEl.rows = 5;
          tx.setPlaceholder("Projects")
            .setValue(s.scopeFolders)
            .onChange(async (v) => {
              s.scopeFolders = v;
              await this.plugin.saveSettings();
              this.plugin.vault.index = null;
              this.plugin.vault._map = null;
            });
        });
    }
  }

  /* ── group: where things live ───────────────────────────── */
  groupFolders(c) {
    const s = this.s;
    c.createDiv({ cls: "oa-note", text: t("These three decide where a new note lands and what shape it takes. Left empty, the assistant guesses — and a guess is how a project note ends up in the vault root with nothing linking to it.") });

    this.folderField(
      new Setting(c).setName(t("Folder for new notes")).setDesc(t("Where notes the assistant creates end up when it has no better idea.")),
      () => s.newNoteFolder,
      async (v) => { s.newNoteFolder = v; await this.plugin.saveSettings(); },
      "Inbox");

    const foundDaily = this.plugin.vault.dailyFolder();
    this.folderField(
      new Setting(c).setName(t("Daily notes folder"))
        .setDesc(!s.dailyFolder && foundDaily
          ? t("Lets it answer \"what did I do yesterday\". Taken from your Obsidian daily notes settings: {0}", foundDaily)
          : t("Lets it answer \"what did I do yesterday\". Empty means the folder from your Obsidian daily notes settings.")),
      () => s.dailyFolder,
      async (v) => { s.dailyFolder = v; await this.plugin.saveSettings(); },
      "Daily");

    const foundTpl = this.plugin.vault.templateFolder();
    this.folderField(
      new Setting(c).setName(t("Templates folder"))
        .setDesc(!s.templateFolder && foundTpl
          ? t("The assistant reads a template before creating a note of that kind, so a project note comes out looking like your other project notes. Found on its own: {0}", foundTpl)
          : t("The assistant reads a template before creating a note of that kind, so a project note comes out looking like your other project notes. Empty means it asks the Templates or Templater plugin where they are.")),
      () => s.templateFolder,
      async (v) => {
        s.templateFolder = v;
        this.plugin.vault._map = null;    // the map lists the templates
        await this.plugin.saveSettings();
      },
      "Templates");

    /* Which template an ordinary note is built on.
       Shown as a setting because the guess is good but not always right, and
       because the consequence of a wrong guess — every new note in the wrong
       shape — is worth being able to see and correct. */
    let all = [];
    try { all = this.plugin.vault.templates(); } catch { all = []; }
    if (all.length) {
      const found = this.plugin.vault.standardTemplate();
      new Setting(c)
        .setName(t("Template for ordinary notes"))
        .setDesc(t("The assistant is shown this one with every request, so a note it writes comes out with your properties, headings and buttons rather than as bare text. A project or a book has its own template — it reads those itself."))
        .addDropdown((d) => {
          d.addOption("", t("Work it out ({0})", found ? found.basename : t("nothing suitable found")));
          for (const f of all) d.addOption(f.path, f.basename);
          d.addOption("-", t("Don't use one"));
          d.setValue(s.standardTemplate || "").onChange(async (v) => {
            s.standardTemplate = v; await this.plugin.saveSettings(); this.redrawGroup();
          });
        });
    }

    // What it found in there, listed. A templates folder that turns out to be
    // empty is otherwise a silent failure.
    let names = [];
    try { names = all.map((f) => f.basename); } catch { names = []; }
    if (names.length) {
      const box = c.createDiv({ cls: "oa-note" });
      box.createDiv({ cls: "oa-note-title", text: t("Templates it can build from: {0}", names.length) });
      box.createDiv({ text: names.join(" · ") });
    } else if (foundTpl || s.templateFolder) {
      c.createDiv({ cls: "oa-note", text: t("No templates in that folder yet.") });
    }
  }

  /* ── group: the map ─────────────────────────────────────── */
  groupMap(c) {
    const s = this.s;

    new Setting(c)
      .setName(t("Learn the vault's structure"))
      .setDesc(t("Folds a map of your vault into every request — the folders, what is in them, which templates exist. This is what stops it filing a project note in the root and inventing a shape for it."))
      .addToggle((x) => x.setValue(s.vaultMap !== false).onChange(async (v) => {
        s.vaultMap = v;
        this.plugin.vault._map = null;
        await this.plugin.saveSettings();
        this.redrawGroup();
      }));

    if (s.vaultMap === false) return;

    c.createDiv({ cls: "oa-map-how", text: t("Nothing here was written by hand or asked of a model. The plugin walks the file list Obsidian already keeps: folders with how many notes are under each, the folders one level in, the contents of your templates folder, and the daily-notes folder from your Obsidian settings. It costs nothing, rebuilds itself when the vault changes, and goes into every request as the text below.") });

    let map = "";
    try { map = this.plugin.vault.describeVault(); } catch (e) { map = String(e.message); }
    c.createDiv({ cls: "oa-map-body", text: map });

    new Setting(c)
      .setName(t("Anything it should know about your system"))
      .setDesc(t("Read the map above; whatever it cannot tell from folder names, write here. \"Projects live in 1. Projects, one note each, always linked from the MOC\" is the kind of thing that saves a dozen wrong guesses."))
      .addTextArea((tx) => {
        tx.inputEl.rows = 5;
        tx.inputEl.addClass("oa-auto-prompt");
        tx.setValue(s.vaultNotes || "").onChange(async (v) => { s.vaultNotes = v; await this.plugin.saveSettings(); });
      });
  }

  /* ── group: search and the web ──────────────────────────── */
  groupSearch(c) {
    const s = this.s;

    /* Order follows what people come here to do.
       Meaning-based search is the thing with a switch, a cost and a button
       that does work; the web is one toggle; the model name and the index file
       are typed once and never again. The old order was the reverse of that,
       so the button that actually does something sat at the bottom of a
       scrolling window. */
    this.section(c, t("In your notes"));

    c.createDiv({ cls: "oa-note", text: t("Word search is always on: it builds itself from your vault in a second, costs nothing and needs no key.") });

    new Setting(c)
      .setName(t("Also search by meaning"))
      .setDesc(t("Finds notes that say the same thing in different words."))
      .addToggle((x) => x.setValue(s.semanticSearch).onChange(async (v) => {
        s.semanticSearch = v; await this.plugin.saveSettings(); this.redrawGroup();
      }));

    if (s.semanticSearch) {
      /* What this actually is, before the button that does it.
         "Embeddings" is a word people switch on without knowing that it sends
         every note in the vault to a provider, one by one, and costs money
         doing it. Both of those are worth knowing beforehand. */
      const box = c.createDiv({ cls: "oa-explain" });
      box.createDiv({ cls: "oa-explain-title", text: t("What indexing does, in plain words") });
      box.createDiv({ text: t("Word search only finds notes containing the words you typed. Ask about «burnout» and a note that says «I have nothing left in the tank» will not come up, though it is exactly what you meant.") });
      box.createDiv({ text: t("Indexing fixes that. Each note is sent once to your provider, which returns a long list of numbers describing what the note is about — its meaning, expressed as coordinates. That list is kept in a file inside your vault. When you ask something, your question is turned into the same kind of numbers and compared against them, so notes about the same thing come up whatever words they use.") });
      box.createDiv({ text: t("Two things to know: the pass costs tokens, roughly a small fraction of a cent per note, and it happens once per note — only notes you change afterwards are done again. And the text of every note that gets indexed is sent to your provider, which is why private folders are excluded from it and why you can leave more folders out below.") });

      this.indexPanel(c);
    }

    this.section(c, t("Outside your notes"));

    // Only the two providers that route through OpenRouter can search the web;
    // for the others the switch would be a promise the transport can't keep.
    const webCapable = s.provider === "obsimind" || s.provider === "openrouter";
    if (!webCapable) {
      c.createDiv({ cls: "oa-note", text: t("Only Elton AI and OpenRouter can search the web. Switch to one of them on the Connection tab to turn this on.") });
    } else {
      new Setting(c)
        .setName(t("Search the web"))
        .setDesc(t("Let the assistant look things up online — news, facts, anything outside your vault. Answers are still grounded in your notes first."))
        .addToggle((x) => x.setValue(s.webSearch).onChange(async (v) => {
          s.webSearch = v; await this.plugin.saveSettings(); this.redrawGroup();
        }));
      if (s.webSearch) {
        new Setting(c)
          .setName(t("How many results"))
          .setDesc(t("More results mean a fuller answer and a slightly higher cost per search."))
          .addSlider((sl) => sl.setLimits(1, 10, 1).setValue(s.webSearchResults).setDynamicTooltip()
            .onChange(async (v) => { s.webSearchResults = v; await this.plugin.saveSettings(); }));
      }
    }

    if (!s.semanticSearch) return;

    this.section(c, t("Left out of the index"));
    new Setting(c)
      .setDesc(t("Folders that are not indexed. The assistant can still open these notes when you ask for one by name — they are just never sent away in bulk. Private folders are already excluded and do not need repeating here."))
      .addTextArea((tx) => {
        tx.inputEl.rows = 3;
        tx.setPlaceholder(t("4. Archive") + "\n" + t("2. Areas/Journals"))
          .setValue(s.noIndexFolders || "")
          .onChange(async (v) => { s.noIndexFolders = v; await this.plugin.saveSettings(); });
      });

    this.groupFold(c, "embeddings", (a) => {
      new Setting(a).setName(t("Embedding model"))
        .addText((tx) => tx.setValue(s.embedModel).onChange(async (v) => { s.embedModel = v.trim(); await this.plugin.saveSettings(); }));

      this.fileField(
        new Setting(a).setName(t("Index file"))
          .setDesc(t("Already have an index from another script? Point at its .json and it gets reused — no re-indexing, no tokens spent. Leave empty to keep a private one.")),
        () => s.embedIndexPath,
        async (v) => {
          s.embedIndexPath = v;
          this.plugin.vault._emb = null;      // different file, different vectors
          await this.plugin.saveSettings();
          if (v && !(await this.plugin.vault.indexSize(v))) new Notice(t("That file isn't a usable index"));
        },
        "json", "Embedding/embeddings-cache.json");

      // A borrowed index is only ever added to, never rewritten.
      if (this.plugin.vault.indexIsBorrowed) {
        const why = a.createDiv({ cls: "oa-note" });
        why.createDiv({ cls: "oa-note-title", text: t("This index belongs to another tool") });
        why.createDiv({ text: t("Updating adds only notes it hasn't seen — nothing existing is rewritten or deleted, so whatever maintains this file keeps working.") });
      }
    });
  }

  /**
   * The index: what is in it, what is waiting, and the button, in one card.
   *
   * The state and the action belong together. Split apart — a status line at
   * the top of a window, its button at the bottom past everything else — you
   * have to remember one to make sense of the other.
   */
  indexPanel(c) {
    const panel = c.createDiv({ cls: "oa-index" });
    const left = panel.createDiv({ cls: "oa-index-text" });
    const status = left.createDiv({ cls: "oa-index-status" });
    const detail = left.createDiv({ cls: "oa-index-detail" });
    const action = panel.createDiv({ cls: "oa-index-action" });
    const problem = c.createDiv({ cls: "oa-index-problem is-hidden" });

    const btn = action.createEl("button", { cls: "mod-cta" });
    let stop = false;

    const showProblem = (text) => {
      problem.setText(text || "");
      problem.toggleClass("is-hidden", !text);
    };

    const refresh = async () => {
      const n = await this.plugin.vault.indexSize();
      const pending = await this.plugin.vault.pendingCount();
      status.setText(n ? t("{0} notes in the index", n) : t("Nothing indexed yet"));
      // Says what the number means. "48 waiting" without this reads as a
      // failure rather than as notes written since the last pass.
      detail.setText(pending
        ? t("{0} waiting: notes written or changed since the last pass.", pending)
        : t("Everything in your vault is in it."));
      // The label answers the question the button raises — how much is left.
      btn.setText(pending ? t("Index {0} new notes", pending) : t("Everything is indexed"));
      btn.toggleAttribute("disabled", !pending);
    };
    refresh();

    btn.onclick = async () => {
      if (this._indexing) { stop = true; return; }
      this._indexing = true; stop = false;
      btn.setText(t("Stop"));
      btn.removeAttribute("disabled");
      showProblem("");
      try {
        const r = await this.plugin.vault.buildEmbeddings(
          (done, total) => status.setText(t("Indexing… {0}/{1}", done, total)),
          () => stop);

        // Say what the pass actually did. A run that embedded nothing at all
        // is the interesting case, and it used to look exactly like a run
        // that embedded everything.
        const parts = [];
        if (r.embedded) parts.push(t("{0} added", r.embedded));
        if (r.skipped) parts.push(t("{0} too short to be worth a vector", r.skipped));
        if (r.failed) parts.push(t("{0} failed", r.failed));
        new Notice(parts.length ? parts.join(" · ") : t("Nothing left to index"), 8000);

        if (r.failed) {
          showProblem(r.embedded
            ? t("{0} notes could not be indexed. The provider said: {1}", r.failed, r.error)
            : t("Nothing could be indexed — every request was refused. The provider said: {0}. Check the embedding model and your key on the Connection tab.", r.error));
        }
      } catch (e) {
        // Reaching here means the index file itself could not be written,
        // which used to be swallowed and looked like a successful pass.
        showProblem(t("The index could not be saved: {0}", e.message));
        new Notice(t("Something went wrong: {0}", e.message));
      } finally {
        this._indexing = false;
        await refresh();
      }
    };
  }

  /**
   * Redraw the window a group is currently living in.
   *
   * Some of these settings decide whether others exist at all — turning off
   * the map hides the map, choosing a scope reveals a folder list. Inside a
   * window that means redrawing the window, never the settings page behind it:
   * `display()` from in here rebuilt the tab under the modal and threw its
   * scroll position away for nothing.
   */
  redrawGroup() {
    if (this._group) this._group.draw();
  }


  /* ── saved tasks: by phrase, and by clock ───────────────── */

  /**
   * Scenarios and automations on one tab.
   *
   * They are the same object with a different trigger — a saved brief that
   * fires when you say a phrase, or when a time comes round. Two tabs each
   * holding one list of cards was two places to look for the same thing.
   */
  tabTasks(c) {
    const sub = c.createDiv({ cls: "oa-subtabs" });
    const which = this._task === "auto" ? "auto" : "scen";
    const mk = (id, label) => {
      const el = sub.createDiv({ cls: "oa-subtab" + (which === id ? " is-on" : ""), text: label });
      el.onclick = () => { this._task = id; this.display(); };
    };
    mk("scen", t("By phrase"));
    mk("auto", t("On a schedule"));
    const body = c.createDiv();
    if (which === "auto") this.tabAutomations(body);
    else this.tabScenarios(body);
  }

  /* ── scenarios ──────────────────────────────────────────── */
  tabScenarios(c) {
    const s = this.s;
    if (!Array.isArray(s.scenarios)) s.scenarios = [];

    c.createDiv({ cls: "oa-note", text: t("A scenario is a long brief hiding behind a short phrase. Say the phrase and the assistant gets the whole brief instead of the two words you said — so it starts answering straight away rather than working out what you meant.") });

    const how = c.createDiv({ cls: "oa-note" });
    how.createDiv({ cls: "oa-note-title", text: t("How a phrase is matched") });
    how.createDiv({ text: t("A one-word trigger fires only when it is the whole thing you said. Two words or more also fire inside a longer sentence, so \"what was I thinking\" catches \"listen, what was I thinking about yesterday\". Anything you say around the trigger is passed along as context.") });

    if (!s.scenarios.length) {
      c.createDiv({ cls: "oa-auto-empty", text: t("No scenarios yet. Add one and it appears as a button under the reactor.") });
    }
    const list = c.createDiv({ cls: "oa-list" });
    s.scenarios.forEach((sc) => this.scenarioRow(list, sc));

    // Blank first, and selected. The list used to open on "What I was
    // thinking" — which every vault already has, because it is one of the
    // three it starts with. Pressing add then produced a second copy of a
    // card already on screen, which reads as the button not working rather
    // than as a scenario being created.
    let pick = "custom";
    const have = new Set(s.scenarios.map((x) => (x.name || "").trim()));
    const add = new Setting(c).setName(t("Add scenario"))
      .setDesc(t("Blank, or start from one of the ready-made briefs."));
    add.addDropdown((d) => {
      const p = scenarioPresets();
      // The ones that do something come first: they are the reason to have
      // scenarios at all, and they were buried under the ones that summarise.
      for (const key of ["custom", "project", "tidy", "next", "brief", "thoughts", "today", "wrapup", "week", "inbox", "loose", "explain", "links", "quiz", "forgotten", "draft"]) {
        // Say so rather than hide it: a second copy is a fair thing to want,
        // and a preset vanishing from the list looks like a bug of its own.
        const seen = key !== "custom" && have.has((p[key].name || "").trim());
        d.addOption(key, `${p[key].emoji} ${p[key].name}` + (seen ? ` · ${t("already added")}` : ""));
      }
      d.setValue(pick).onChange((v) => { pick = v; });
    });
    add.addButton((b) => b.setCta().setButtonText(t("Add")).onClick(async () => {
      const fresh = newScenario(pick);
      s.scenarios.push(fresh);
      await this.plugin.saveSettings();
      this.plugin.refreshViews();
      this.display();
      // Straight into the editor. A blank scenario appearing in a list is a
      // row you then have to work out what to do with; a preset one you
      // usually want to read before it runs.
      new ScenarioEditModal(this.app, this.plugin, fresh, () => this.display()).open();
    }));
  }

  /**
   * One line per scenario.
   *
   * Everything a list is for — what it is called, what fires it, whether it is
   * on — and nothing else. Editing happens in its own window, because a row
   * that unfolds into seven form fields stops the list being a list.
   */
  scenarioRow(c, sc) {
    const s = this.s;
    const row = c.createDiv({ cls: "oa-row" + (sc.enabled ? "" : " is-off") });

    const open = () => new ScenarioEditModal(this.app, this.plugin, sc, () => this.display()).open();

    const main = clickable(row.createDiv({ cls: "oa-row-main" }));
    main.createSpan({ cls: "oa-row-emoji", text: sc.emoji || "✨" });
    const body = main.createDiv({ cls: "oa-row-body" });
    body.createDiv({ cls: "oa-row-name", text: sc.name || t("Custom scenario") });
    body.createDiv({
      cls: "oa-row-sub",
      text: !sc.prompt ? t("Empty — write what it should ask for")
        : (sc.triggers || t("No trigger phrase — button only")),
    });
    main.onclick = open;

    const tools = row.createDiv({ cls: "oa-row-tools" });
    const run = tools.createEl("button", { cls: "oa-row-btn" });
    setIcon(run, "play");
    run.setAttr("aria-label", t("Run now"));
    run.onclick = async () => {
      const view = await this.plugin.activateView();
      if (view) view.runScenario(sc);
    };
    const del = tools.createEl("button", { cls: "oa-row-btn is-danger" });
    setIcon(del, "trash-2");
    del.setAttr("aria-label", t("Delete this scenario"));
    del.onclick = async () => {
      s.scenarios = s.scenarios.filter((x) => x.id !== sc.id);
      await this.plugin.saveSettings();
      this.plugin.refreshViews();
      this.display();
    };
    const sw = tools.createDiv({ cls: "oa-row-switch" });
    new Setting(sw).addToggle((x) => x.setValue(!!sc.enabled).onChange(async (v) => {
      sc.enabled = v;
      await this.plugin.saveSettings();
      this.plugin.refreshViews();
      this.display();
    }));
  }


  /* ── automations ────────────────────────────────────────── */
  tabAutomations(c) {
    const s = this.s;
    if (!Array.isArray(s.automations)) s.automations = [];

    c.createDiv({ cls: "oa-note", text: t("Scheduled runs that write into your vault on their own — a morning digest, a catch-up on recent thoughts. Each one is the assistant answering a saved prompt at a time you choose.") });

    if (!s.automations.length) {
      c.createDiv({ cls: "oa-auto-empty", text: t("No automations yet. Add one to have the assistant work while you sleep.") });
    }
    const list = c.createDiv({ cls: "oa-list" });
    s.automations.forEach((a) => this.automationRow(list, a));

    // Add row: pick a preset, drop a fresh copy into the list.
    let pick = "digest";
    const add = new Setting(c).setName(t("Add automation"));
    add.addDropdown((d) => {
      const p = automationPresets();
      d.addOption("digest", p.digest.name);
      d.addOption("catchup", p.catchup.name);
      d.addOption("custom", p.custom.name);
      d.setValue(pick).onChange((v) => { pick = v; });
    });
    add.addButton((b) => b.setCta().setButtonText(t("Add")).onClick(async () => {
      const fresh = newAutomation(pick);
      s.automations.push(fresh);
      await this.plugin.saveSettings();
      this.display();
      new AutomationEditModal(this.app, this.plugin, fresh, () => this.display()).open();
    }));
  }

  /** One line per automation: what it is, when it fires, whether it is on. */
  automationRow(c, a) {
    const s = this.s;
    const row = c.createDiv({ cls: "oa-row" + (a.enabled ? "" : " is-off") });

    const main = clickable(row.createDiv({ cls: "oa-row-main" }));
    main.createSpan({ cls: "oa-row-emoji", text: "⏰" });
    const body = main.createDiv({ cls: "oa-row-body" });
    body.createDiv({ cls: "oa-row-name", text: a.name || t("Custom automation") });
    body.createDiv({ cls: "oa-row-sub", text: this.scheduleSummary(a) });
    main.onclick = () => new AutomationEditModal(this.app, this.plugin, a, () => this.display()).open();

    const tools = row.createDiv({ cls: "oa-row-tools" });
    const run = tools.createEl("button", { cls: "oa-row-btn" });
    setIcon(run, "play");
    run.setAttr("aria-label", t("Run now"));
    run.onclick = async () => {
      run.setAttr("disabled", "true");
      // The "running…" notice belongs to the scheduler, so a run started by
      // the clock shows it too — not only one started from this button.
      try { await this.plugin.scheduler.run(a, { manual: true }); }
      catch (e) { new Notice(t("Something went wrong: {0}", e.message), 8000); }
      finally { run.removeAttribute("disabled"); }
    };
    const del = tools.createEl("button", { cls: "oa-row-btn is-danger" });
    setIcon(del, "trash-2");
    del.setAttr("aria-label", t("Delete this automation"));
    del.onclick = async () => {
      s.automations = s.automations.filter((x) => x.id !== a.id);
      await this.plugin.saveSettings();
      this.display();
    };
    const sw = tools.createDiv({ cls: "oa-row-switch" });
    new Setting(sw).addToggle((x) => x.setValue(!!a.enabled).onChange(async (v) => {
      a.enabled = v; await this.plugin.saveSettings(); this.display();
    }));
  }

  dayLabels() { return [t("Sun"), t("Mon"), t("Tue"), t("Wed"), t("Thu"), t("Fri"), t("Sat")]; }

  scheduleSummary(a) {
    const L = this.dayLabels();
    const when = (!a.days || !a.days.length) ? t("Every day")
      : [1, 2, 3, 4, 5, 6, 0].filter((d) => a.days.includes(d)).map((d) => L[d]).join(", ");
    // Where it lands belongs on the summary line: an automation that messages
    // your phone at 08:30 is a different thing from one that quietly writes a
    // note, and you should not have to open it to tell them apart.
    /* Whether it is going to run, on the line you already look at.
       "It didn't fire" took a look inside data.json to explain, and the answer
       was a field nothing on screen ever mentioned. */
    const ran = a.lastRun === todayKey();
    const state = !a.enabled ? t("off")
      : ran ? t("already ran today")
      : this.plugin.scheduler.due(a) ? t("due — runs within a minute")
      : t("waiting");
    return `${a.time || "--:--"} · ${when}${a.telegram ? " · ✈️" : ""} · ${state}`;
  }

  /* ── telegram ───────────────────────────────────────────── */
  tabTelegram(c) {
    const s = this.s;
    if (!s.telegram) s.telegram = { enabled: false, token: "", userId: "" };
    const tg = s.telegram;

    c.createDiv({ cls: "oa-note", text: t("Write to your vault from your phone. A bot you own passes your messages — typed or spoken — to this assistant, and sends its answers back. It has the same access to your notes as the panel does.") });

    /* Nothing to set up from a phone.
       The bridge deliberately does not run here — settings sync, so switching
       it on at the desk would otherwise start a second poller in your pocket,
       and Telegram gives each message to whoever asks first. Showing the
       controls anyway would mean a token field that changes nothing and a
       toggle that appears not to work. */
    if (isMobile()) {
      const box = c.createDiv({ cls: "oa-note" });
      box.createDiv({ cls: "oa-note-title", text: t("Set this up on your computer") });
      box.createDiv({ text: t("The bot is answered by the computer that holds your vault — that is the whole point of it, and it is why a phone is where you write TO the bot rather than where it runs. These settings are on the Telegram tab there.") });
      box.createDiv({ text: this.plugin.settings.telegram && this.plugin.settings.telegram.enabled
        ? t("It is switched on for this vault, so your computer answers whenever Obsidian is open on it.")
        : t("It is not switched on yet.") });
      return;
    }

    // Straight facts about reachability, no advice attached. Someone in Russia
    // discovering this only after setting the whole thing up would fairly
    // conclude the plugin was broken.
    const warn = c.createDiv({ cls: "oa-warn" });
    warn.setText(t("⚠ Access to Telegram is restricted by some providers in Russia, and connections to it may be slow or fail entirely. If Telegram does not open normally on this computer, the bot will not answer reliably either."));

    const card = c.createDiv({ cls: "oa-onb-card" });
    const left = card.createDiv();
    left.createDiv({ cls: "oa-onb-card-title", text: t("Connect a bot") });
    left.createDiv({ cls: "oa-onb-card-sub", text: t("Four steps, with what you'll see at each one. No experience with Telegram bots needed.") });
    const go = card.createEl("button", { cls: "mod-cta", text: t("Set up Telegram") });
    go.onclick = () => new TelegramSetupModal(this.app, this.plugin, () => this.display()).open();

    new Setting(c)
      .setName(t("Answer messages"))
      .setDesc(t("Only while Obsidian is open on this computer. Anything sent while it is closed arrives the next time you open the vault."))
      .addToggle((x) => x.setValue(!!tg.enabled).onChange(async (v) => {
        tg.enabled = v;
        await this.plugin.saveSettings();
        if (v) this.plugin.telegram.restart(); else this.plugin.telegram.stop();
        this.display();
      }));

    new Setting(c)
      .setName(t("Bot token"))
      .setDesc(t("From BotFather. It is a password — anyone holding it can talk to your bot."))
      .addText((tx) => {
        tx.inputEl.type = "password";
        tx.setPlaceholder("8123456789:AAH…").setValue(tg.token || "")
          .onChange(async (v) => { tg.token = v.trim(); await this.plugin.saveSettings(); });
      });

    const status = c.createDiv({ cls: "oa-index-status" });
    const paint = () => {
      const b = this.plugin.telegram;
      status.setText(isMobile() ? t("This is a phone — the bot runs on the computer that holds the vault.")
        : !tg.token ? t("No token yet.")
        : !tg.enabled ? t("Switched off.")
        : b.lastError ? t("Telegram refused the token: {0}", b.lastError)
        : !tg.userId ? t("Waiting for /start. Send it from the phone you want to use.")
        : b.running ? t("Listening. Linked to your Telegram account.")
        : t("Not running — reopen the vault or switch it off and on."));
    };
    paint();

    new Setting(c)
      .addButton((b) => b.setButtonText(t("Check the token")).onClick(async () => {
        b.setButtonText(t("Checking…")).setDisabled(true);
        try {
          const me = await this.plugin.telegram.api("getMe", {});
          new Notice(t("Works — the bot is @{0}. Now go and say /start to it.", me.username || me.first_name), 8000);
        } catch (e) {
          new Notice(t("Telegram refused the token: {0}", e.message), 8000);
        } finally { b.setButtonText(t("Check the token")).setDisabled(false); paint(); }
      }))
      .addButton((b) => b.setButtonText(t("Send me a test message")).onClick(async () => {
        try {
          // Not "hello". This is the one place to find out whether formatting
          // survives the trip: a heading, a list and a fold, all in one tap.
          const demo = [
            `## ${t("This is {0}, speaking from your vault. Everything works.", s.assistantName)}`,
            "",
            t("If you can read this as a heading and the list below as a list, formatting is working."),
            "",
            "- " + t("Search and read your notes"),
            "- " + t("Create and edit them"),
            "- " + t("Listen to voice messages"),
            "",
            `<details><summary>${t("A fold, like the one your sources arrive in")}</summary>`,
            "",
            "- " + t("Tap it to open."),
            "",
            "</details>",
          ].join("\n");
          const sent = await this.plugin.telegram.push(demo);
          new Notice(sent ? t("Sent.") : t("Nobody is linked yet — send /start to the bot first."));
        } catch (e) { new Notice(t("Something went wrong: {0}", e.message), 8000); }
      }));

    if (tg.userId) {
      new Setting(c)
        .setName(t("Linked account"))
        .setDesc(t("The only Telegram account this bot answers. Clearing it lets the next person to send /start take over — do that only if it is you."))
        .addText((tx) => tx.setValue(String(tg.userId)).setDisabled(true))
        .addExtraButton((b) => b.setIcon("trash-2").setTooltip(t("Forget the linked account")).onClick(async () => {
          tg.userId = "";
          await this.plugin.saveSettings();
          this.display();
        }));
    }

    new Setting(c)
      .setName(t("Show an animation while it thinks"))
      .setDesc(t("An answer takes tens of seconds. A moving picture appears the moment you write, its caption says what the assistant is doing right now — searching, reading, writing — and it disappears when the answer arrives."))
      .addToggle((x) => x.setValue(tg.thinkingGif !== false).onChange(async (v) => {
        tg.thinkingGif = v; await this.plugin.saveSettings(); this.display();
      }));

    this.advanced(c, "telegram", (a) => {
      if (tg.thinkingGif !== false) {
        new Setting(a)
          .setName(t("Your own animation"))
          .setDesc(t("A link to a .gif or .mp4. Empty means the built-in one. It is uploaded once and then reused from Telegram's own storage."))
          .addText((tx) => tx.setPlaceholder(t("Link to a GIF")).setValue(tg.thinkingGifUrl || "")
            .onChange(async (v) => {
              tg.thinkingGifUrl = v.trim();
              tg.gifId = "";      // a new picture is not the one already uploaded
              await this.plugin.saveSettings();
            }));
      }
      const box = a.createDiv({ cls: "oa-note" });
      box.createDiv({ cls: "oa-note-title", text: t("What it can and cannot do") });
      box.createDiv({ text: t("It searches, reads, creates and edits notes exactly as the panel does. It cannot delete: deleting waits for a key press at the keyboard, and over a chat there is nobody to press it — so it declines and says so.") });
      box.createDiv({ text: t("Voice messages are transcribed with your provider, the same way the panel hears you.") });
      box.createDiv({ text: t("Send /new in the chat to make it forget the conversation so far.") });
      box.createDiv({ text: t("Set it up on one computer only: Telegram gives each message to whoever asks first, so two would answer half each.") });
    });
  }

  /* ── interface ──────────────────────────────────────────── */
  tabUI(c) {
    const s = this.s;
    new Setting(c)
      .setName(t("How the panel opens"))
      .setDesc(t("You can switch any time from the button in the panel header."))
      .addDropdown((d) => {
        d.addOption("reactor", t("Reactor — voice first, one big dial that shows what's happening."));
        d.addOption("chat", t("Text — a conversation you read, with sources and copy buttons."));
        d.setValue(s.viewMode).onChange(async (v) => {
          s.viewMode = v; await this.plugin.saveSettings(); this.plugin.refreshViews();
        });
      });

    new Setting(c)
      .setName(t("Where the panel opens"))
      .addDropdown((d) => {
        d.addOption("right", t("Right sidebar"));
        d.addOption("left", t("Left sidebar"));
        d.addOption("main", t("Main area (as a tab)"));
        d.setValue(s.viewLocation).onChange(async (v) => { s.viewLocation = v; await this.plugin.saveSettings(); });
      });

    new Setting(c).setName(t("Open on startup"))
      .addToggle((x) => x.setValue(s.openOnStartup).onChange(async (v) => { s.openOnStartup = v; await this.plugin.saveSettings(); }));

    new Setting(c)
      .setName(t("Language"))
      .setDesc(t("The interface switches immediately. Restart Obsidian afterwards so anything already open picks it up too. What the assistant answers in does not depend on this — it replies in the language you write or speak to it."))
      .addDropdown((d) => {
        d.addOption("auto", t("Follow Obsidian"));
        d.addOption("ru", t("Russian"));
        d.addOption("en", t("English"));
        d.setValue(s.lang).onChange(async (v) => {
          s.lang = v; setLang(v === "auto" ? null : v);
          await this.plugin.saveSettings();
          // Everything at once, including the palette entries and the ribbon
          // tooltip. A restart is not needed — but it is offered, because
          // "almost everything changed" is the state people distrust most,
          // and a window that was already open when the switch happened keeps
          // whatever text it was built with.
          this.plugin.applyLanguage();
          this.display();
          new Notice(t("Language changed. Anything already open keeps its old wording until you restart Obsidian."), 8000);
        });
      });

    new Setting(c)
      .setName(t("Show the answer as text"))
      .setDesc(t("The written answer arrives before the voice reaches it, so you read it and then hear it again. Off, the text keeps pace with the speech and the rest is a tap away. On, the whole answer appears at once."))
      .addToggle((x) => x.setValue(s.showReplyText).onChange(async (v) => {
        s.showReplyText = v; await this.plugin.saveSettings(); this.plugin.refreshViews();
      }));

    new Setting(c)
      .setName(t("Show what it's doing"))
      .setDesc(t("Print each search and edit in the conversation, so you can see how it got there."))
      .addToggle((x) => x.setValue(s.showActions).onChange(async (v) => { s.showActions = v; await this.plugin.saveSettings(); }));

    new Setting(c)
      .setName(t("Save conversations"))
      .setDesc(t("Off, nothing is written down and a conversation is gone when you close the panel. On, each one becomes a note you can search and link to."))
      .addToggle((x) => x.setValue(s.saveConversations).onChange(async (v) => { s.saveConversations = v; await this.plugin.saveSettings(); this.display(); }));

    if (s.saveConversations) {
      this.folderField(
        new Setting(c).setName(t("Conversations folder"))
          .setDesc(t("One note per conversation, named after the assistant and the time. Empty means a folder called «{0}», created the first time something is saved.", t("Assistant conversations"))),
        () => s.conversationFolder,
        async (v) => { s.conversationFolder = v.trim().replace(/^\/+|\/+$/g, ""); await this.plugin.saveSettings(); },
        "Conversations");
    }

    // What used to be a ninth tab. Two sentences and a version number did not
    // earn a tab of their own — one that then sat alone past the right edge of
    // the strip — and the setup guide is already a button at the top of every
    // tab. It reads better as the last thing on the page than as a place to go.
    const foot = c.createDiv({ cls: "oa-set-foot" });
    foot.createDiv({ cls: "oa-set-foot-title", text: `Elton AI ${this.plugin.manifest.version}` });
    foot.createDiv({ text: t("Your notes stay in your vault. Only the text needed to answer a question is sent to the provider you chose — and with a local model, nothing leaves your machine at all.") });
    const link = foot.createDiv({ cls: "oa-onb-card-by" });
    const a = link.createEl("a", { text: siteLabel(), href: siteUrl() });
    a.setAttr("target", "_blank");
    a.setAttr("rel", "noopener");
  }
}
