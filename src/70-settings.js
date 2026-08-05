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
      { title: t("Meet your assistant"), body: t("It reads and writes the notes you already have. Talk to it or type — it searches your vault, answers from it, and edits notes when you ask."), icon: "sparkles", render: null },
      { title: t("Pick where the brains come from"), body: t("Four options: Elton AI, OpenRouter, a local model on your own machine, or OpenAI directly. You bring the key — the plugin stores it only in this vault."), icon: "plug", render: (c) => this.stepProvider(c) },
      { title: t("Give it a name"), body: t("Call it whatever you like. The name is what it answers to and how it introduces itself."), icon: "user", render: (c) => this.stepName(c) },
      { title: t("Decide what it may touch"), body: t("By default it can read the whole vault, and create or edit notes. Deleting always asks you first. You can narrow it to specific folders."), icon: "shield", render: (c) => this.stepPerms(c) },
      { title: t("You're set"), body: t("Open the panel from the ribbon or the command palette. Everything here can be changed later in settings."), icon: "check-circle", render: null },
    ];
  }

  draw() {
    const c = this.contentEl;
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
  }

  async finish() {
    this.plugin.settings.onboarded = true;
    await this.plugin.saveSettings();
    this.close();
    this.plugin.activateView();
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
    c.empty();
    c.addClass("oa-settings");

    // The way in for anyone who doesn't want to read a settings page.
    const onb = c.createDiv({ cls: "oa-onb-card" });
    const left = onb.createDiv();
    left.createDiv({ cls: "oa-onb-card-title", text: t("Getting started") });
    left.createDiv({ cls: "oa-onb-card-sub", text: t("Walks you through the provider, the assistant's name and what it may touch. Two minutes.") });
    const go = onb.createEl("button", { cls: "mod-cta", text: t("Open the setup guide") });
    go.onclick = () => new OnboardingModal(this.app, this.plugin).open();

    const TABS = [
      { id: "connection", label: t("Connection") },
      // Short labels on purpose: nine tabs at full length overflow the strip
      // in either language. The full wording lives on the headings inside.
      { id: "persona", label: t("Assistant") },
      { id: "voice", label: t("Voice") },
      { id: "access", label: t("Notes") },
      { id: "search", label: t("Search") },
      { id: "scenarios", label: t("Scenarios") },
      { id: "automations", label: t("Automations") },
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
      search: () => this.tabSearch(body),
      scenarios: () => this.tabScenarios(body),
      automations: () => this.tabAutomations(body),
      ui: () => this.tabUI(body),
    })[this._tab]();
  }

  save(rerender) {
    return async () => { await this.plugin.saveSettings(); if (rerender) this.display(); };
  }

  /**
   * A card that is a summary until you open it.
   *
   * Scenarios and automations are each seven rows of form, and a vault with
   * six of them was a page you had to scroll past rather than read. Folded,
   * the list is the list: name, what fires it, whether it is on.
   *
   * Which cards are open is kept on the tab, not in settings — it is where you
   * are in the page, not something to sync between devices. It has to survive
   * `display()` all the same, because half the controls inside a card re-render
   * the whole tab when you touch them.
   */
  foldCard(c, { id, title, subtitle, enabled, onToggle }) {
    if (!this._open) this._open = new Set();
    const open = this._open.has(id);

    const card = c.createDiv({ cls: "oa-auto-card" + (enabled ? " is-on" : "") + (open ? " is-open" : "") });

    const head = card.createDiv({ cls: "oa-auto-head" });
    // A real button: the fold has to be reachable by keyboard, and the whole
    // strip is the target rather than a chevron you have to aim at.
    const grip = head.createEl("button", { cls: "oa-auto-grip" });
    grip.setAttr("aria-expanded", String(open));
    grip.setAttr("aria-label", open ? t("Collapse") : t("Expand"));
    const chev = grip.createSpan({ cls: "oa-auto-chev" });
    setIcon(chev, "chevron-right");
    const info = grip.createDiv({ cls: "oa-auto-info" });
    info.createDiv({ cls: "oa-auto-name", text: title });
    info.createDiv({ cls: "oa-auto-when", text: subtitle });
    grip.onclick = () => {
      if (this._open.has(id)) this._open.delete(id); else this._open.add(id);
      this.display();
    };

    const sw = head.createDiv({ cls: "oa-auto-switch" });
    new Setting(sw).addToggle((x) => x.setValue(!!enabled).onChange(onToggle));

    // Built either way rather than only when open: the callers hang their
    // controls off it, and a missing element would mean two code paths.
    const body = card.createDiv({ cls: "oa-auto-body" + (open ? "" : " is-hidden") });
    return body;
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
    this._open = this._open || {};
    const box = c.createDiv({ cls: "oa-adv" + (this._open[key] ? " is-open" : "") });
    const head = box.createEl("button", { cls: "oa-adv-head" });
    head.createSpan({ cls: "oa-adv-caret", text: "›" });
    head.createSpan({ text: t("Advanced") });
    head.setAttr("aria-expanded", this._open[key] ? "true" : "false");
    head.onclick = () => { this._open[key] = !this._open[key]; this.display(); };
    if (this._open[key]) build(box.createDiv({ cls: "oa-adv-body" }));
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
        for (const m of list) d.addOption(m.id, m.note ? `${m.id} — ${m.note}` : m.id);
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
      new Setting(a).setName(t("Let me interrupt")).setHeading();
      new Setting(a)
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

      new Setting(a)
        .setName(t("Microphone mode"))
        .addDropdown((d) => {
          d.addOption("handsfree", t("Hands-free — it listens until you go quiet."));
          d.addOption("push", t("Push to talk — hold the button while you speak."));
          d.setValue(s.micMode).onChange(async (v) => { s.micMode = v; await this.plugin.saveSettings(); });
        });
    });
  }

  /* ── access ─────────────────────────────────────────────── */
  tabAccess(c) {
    const s = this.s;
    new Setting(c).setName(t("What the assistant may do")).setHeading();

    new Setting(c).setName(t("Read notes"))
      .setDesc(t("Search and read. Without this it can only chat — it won't see your vault at all."))
      .addToggle((x) => x.setValue(s.canRead).onChange(async (v) => { s.canRead = v; await this.plugin.saveSettings(); }));
    new Setting(c).setName(t("Create notes"))
      .addToggle((x) => x.setValue(s.canCreate).onChange(async (v) => { s.canCreate = v; await this.plugin.saveSettings(); this.display(); }));
    new Setting(c).setName(t("Edit notes"))
      .setDesc(t("Change existing notes. Every edit is backed up first, so \"undo that\" always works."))
      .addToggle((x) => x.setValue(s.canEdit).onChange(async (v) => { s.canEdit = v; await this.plugin.saveSettings(); }));
    new Setting(c).setName(t("Delete notes"))
      .setDesc(t("Even with this on, every deletion stops and waits for you to confirm from the keyboard. It can never delete anything on its own."))
      .addToggle((x) => x.setValue(s.canDelete).onChange(async (v) => { s.canDelete = v; await this.plugin.saveSettings(); }));
    new Setting(c).setName(t("Confirm every edit"))
      .setDesc(t("Ask before writing anything, not just before deleting. Safer, slower."))
      .addToggle((x) => x.setValue(s.confirmEveryEdit).onChange(async (v) => { s.confirmEveryEdit = v; await this.plugin.saveSettings(); }));

    new Setting(c).setName(t("Manage tabs and windows"))
      .setDesc(t("Let it open notes beside each other, open web pages inside the vault and close tabs you're done with. It never touches its own panel, and closing several at once still asks you."))
      .addToggle((x) => x.setValue(s.canControlUI).onChange(async (v) => {
        s.canControlUI = v; await this.plugin.saveSettings(); this.display();
      }));

    // The web page part of it quietly changes behaviour when the core plugin
    // is off — better said here than discovered when a tab opens elsewhere.
    if (s.canControlUI) {
      const ip = this.app.internalPlugins;
      const wv = ip && ip.getPluginById ? ip.getPluginById("webviewer") : null;
      if (!wv || !wv.enabled) {
        const box = c.createDiv({ cls: "oa-note" });
        box.createDiv({ cls: "oa-note-title", text: t("Web viewer is switched off") });
        box.createDiv({ text: t("Pages will open in your system browser instead. Turn on the core plugin «Web viewer» to have them open inside the vault.") });
      }
    }

    this.advanced(c, "access", (a) => {
      new Setting(a).setName(t("Where it may work")).setHeading();
      new Setting(a).addDropdown((d) => {
        d.addOption("all", t("Whole vault"));
        d.addOption("include", t("Only these folders"));
        d.addOption("exclude", t("Everything except these folders"));
        d.setValue(s.scopeMode).onChange(async (v) => {
          s.scopeMode = v; await this.plugin.saveSettings();
          this.plugin.vault.index = null;   // scope changed → the index is stale
          this.display();
        });
      });

      if (s.scopeMode !== "all") {
        new Setting(a)
          .setName(t("Folders"))
          .setDesc(t("One path per line, relative to the vault root."))
          .addTextArea((tx) => {
            tx.inputEl.rows = 5;
            tx.setPlaceholder("Projects")
              .setValue(s.scopeFolders)
              .onChange(async (v) => { s.scopeFolders = v; await this.plugin.saveSettings(); this.plugin.vault.index = null; });
          });
      }

      if (s.canCreate) {
        this.folderField(
          new Setting(a).setName(t("Folder for new notes")).setDesc(t("Where notes the assistant creates end up.")),
          () => s.newNoteFolder,
          async (v) => { s.newNoteFolder = v; await this.plugin.saveSettings(); },
          "Inbox");
      }

      // Empty no longer means "off" — it means "wherever Obsidian keeps them".
      // Say which folder that turned out to be, or the field reads as a
      // feature nobody switched on.
      const found = this.plugin.vault.dailyFolder();
      this.folderField(
        new Setting(a).setName(t("Daily notes folder"))
          .setDesc(!s.dailyFolder && found
            ? t("Lets it answer \"what did I do yesterday\". Taken from your Obsidian daily notes settings: {0}", found)
            : t("Lets it answer \"what did I do yesterday\". Empty means the folder from your Obsidian daily notes settings.")),
        () => s.dailyFolder,
        async (v) => { s.dailyFolder = v; await this.plugin.saveSettings(); this.display(); },
        "Daily");
    });
  }

  /* ── search ─────────────────────────────────────────────── */
  tabSearch(c) {
    const s = this.s;

    new Setting(c).setName(t("Web access")).setHeading();
    // Only the two providers that route through OpenRouter can search the web;
    // for the others the switch would be a promise the transport can't keep.
    const webCapable = s.provider === "obsimind" || s.provider === "openrouter";
    if (!webCapable) {
      c.createDiv({ cls: "oa-note", text: t("Only Elton AI and OpenRouter can search the web. Switch to one of them on the Connection tab to turn this on.") });
    } else {
      new Setting(c)
        .setName(t("Search the web"))
        .setDesc(t("Let the assistant look things up online — news, facts, anything outside your vault. Answers are still grounded in your notes first; the web is a second source it can reach when the notes don't have it."))
        .addToggle((x) => x.setValue(s.webSearch).onChange(async (v) => { s.webSearch = v; await this.plugin.saveSettings(); this.display(); }));
      if (s.webSearch) {
        new Setting(c)
          .setName(t("How many results"))
          .setDesc(t("More results mean a fuller answer and a slightly higher cost per search."))
          .addSlider((sl) => sl.setLimits(1, 10, 1).setValue(s.webSearchResults).setDynamicTooltip()
            .onChange(async (v) => { s.webSearchResults = v; await this.plugin.saveSettings(); }));
      }
    }

    new Setting(c).setName(t("Search")).setHeading();
    const box = c.createDiv({ cls: "oa-note" });
    box.createDiv({ cls: "oa-note-title", text: t("Word search is always on") });
    box.createDiv({ text: t("It builds itself from your vault in a second, costs nothing and needs no key.") });

    new Setting(c)
      .setName(t("Meaning-based search"))
      .setDesc(t("Also find notes that mean the same thing in different words. Needs a one-time pass over your vault that costs tokens."))
      .addToggle((x) => x.setValue(s.semanticSearch).onChange(async (v) => { s.semanticSearch = v; await this.plugin.saveSettings(); this.display(); }));

    if (!s.semanticSearch) return;

    new Setting(c).setName(t("Embedding model"))
      .addText((tx) => tx.setValue(s.embedModel).onChange(async (v) => { s.embedModel = v.trim(); await this.plugin.saveSettings(); }));

    /* The state of the index, in one place and in words.
       "Reusing an existing index: 2108" next to a button offering to index 48
       more says nothing about whether those 48 are new writing, notes too
       short to be worth a vector, or requests the provider keeps refusing. */
    const panel = c.createDiv({ cls: "oa-index-panel" });
    const status = panel.createDiv({ cls: "oa-index-status" });
    const detail = panel.createDiv({ cls: "oa-index-detail" });
    const problem = panel.createDiv({ cls: "oa-index-problem" });

    const showCount = async () => {
      const n = await this.plugin.vault.indexSize();
      const pending = await this.plugin.vault.pendingCount();
      status.setText(n
        ? t("{0} notes in the index", n)
        : t("Nothing indexed yet"));
      detail.setText(pending
        ? t("{0} waiting: notes written or changed since the last pass.", pending)
        : t("Everything in your vault is in it."));
      detail.toggleClass("is-hidden", false);
    };
    const showProblem = (text) => {
      problem.setText(text || "");
      problem.toggleClass("is-hidden", !text);
    };
    showProblem("");

    this.fileField(
      new Setting(c).setName(t("Index file"))
        .setDesc(t("Already have an index from another script? Point at its .json and it gets reused — no re-indexing, no tokens spent. Leave empty to keep a private one.")),
      () => s.embedIndexPath,
      async (v) => {
        s.embedIndexPath = v;
        this.plugin.vault._emb = null;      // different file, different vectors
        await this.plugin.saveSettings();
        if (v && !(await this.plugin.vault.indexSize(v))) new Notice(t("That file isn't a usable index"));
        showCount();
      },
      "json", "Embedding/embeddings-cache.json");

    showCount();

    // A borrowed index is only ever added to, never rewritten — so the button
    // is offered either way, with the difference spelled out.
    if (this.plugin.vault.indexIsBorrowed) {
      const why = c.createDiv({ cls: "oa-note" });
      why.createDiv({ cls: "oa-note-title", text: t("This index belongs to another tool") });
      why.createDiv({ text: t("Updating adds only notes it hasn't seen — nothing existing is rewritten or deleted, so whatever maintains this file keeps working.") });
    }

    let stop = false;
    new Setting(c).addButton((b) => {
      // The label answers the question the button raises: how much is left to
      // do. "Update the index" with nothing pending is a button you press and
      // learn nothing from.
      const relabel = async () => {
        const n = await this.plugin.vault.pendingCount();
        b.setButtonText(n ? t("Index {0} new notes", n) : t("Everything is indexed"));
        b.setDisabled(!n);
      };
      relabel();
      b.setCta().onClick(async () => {
        if (this._indexing) { stop = true; return; }
        this._indexing = true; stop = false;
        b.setButtonText(t("Stop"));
        showProblem("");
        detail.toggleClass("is-hidden", true);
        try {
          const r = await this.plugin.vault.buildEmbeddings(
            (done, total) => status.setText(t("Indexing… {0}/{1}", done, total)),
            () => stop);
          await showCount();

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
          // Reaching here now means the index file itself could not be written,
          // which used to be swallowed and looked like a successful pass.
          showProblem(t("The index could not be saved: {0}", e.message));
          new Notice(t("Something went wrong: {0}", e.message));
        } finally {
          this._indexing = false;
          await relabel();
        }
      });
    });
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
    s.scenarios.forEach((sc) => this.scenarioCard(c, sc));

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
      for (const key of ["custom", "thoughts", "today", "wrapup", "week", "inbox", "loose", "explain", "links", "quiz", "forgotten", "draft"]) {
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
      // Open the one just added — a new card that appears folded looks like
      // the button did nothing.
      if (!this._open) this._open = new Set();
      this._open.add(fresh.id);
      await this.plugin.saveSettings();
      this.plugin.refreshViews();
      this.display();
    }));
  }

  scenarioCard(c, sc) {
    const s = this.s;
    const card = this.foldCard(c, {
      id: sc.id,
      title: scenarioLabel(sc),
      // A blank scenario does nothing at all yet — neither a phrase nor a
      // button — and saying "button only" would be a straight lie.
      subtitle: !sc.prompt ? t("Empty — write what it should ask for")
        : (sc.triggers || t("No trigger phrase — button only")),
      enabled: sc.enabled,
      onToggle: async (v) => {
        sc.enabled = v; await this.plugin.saveSettings(); this.plugin.refreshViews(); this.display();
      },
    });

    // Emoji and name are one thing — the label on the button — so they are one
    // row. Two rows made the emoji look like a setting of its own.
    new Setting(card).setName(t("Name"))
      .addText((tx) => {
        tx.inputEl.addClass("oa-emoji-input");
        tx.setPlaceholder("✨");
        tx.setValue(sc.emoji || "").onChange(async (v) => { sc.emoji = v.trim().slice(0, 4); await this.plugin.saveSettings(); });
      })
      .addText((tx) =>
        tx.setValue(sc.name || "").onChange(async (v) => { sc.name = v; await this.plugin.saveSettings(); }));

    new Setting(card)
      .setName(t("Trigger phrases"))
      .setDesc(t("Separated by commas. Say any of them and this scenario runs."))
      .addText((tx) => {
        tx.inputEl.addClass("oa-wide-input");
        tx.setValue(sc.triggers || "").onChange(async (v) => { sc.triggers = v; await this.plugin.saveSettings(); });
      });

    const promptSetting = new Setting(card)
      .setName(t("What it asks for"))
      .setDesc(t("The brief the assistant actually receives. Write it as if you were asking in full."));
    promptSetting.settingEl.addClass("oa-auto-prompt-row");
    promptSetting.addTextArea((ta) => {
      ta.inputEl.addClass("oa-auto-prompt");
      ta.inputEl.rows = 5;
      ta.setValue(sc.prompt || "").onChange(async (v) => { sc.prompt = v; await this.plugin.saveSettings(); });
    });

    new Setting(card)
      .setName(t("Show as a button"))
      .setDesc(t("Puts it under the reactor and in an empty chat, for the days you would rather tap than talk."))
      .addToggle((x) => x.setValue(sc.pin !== false).onChange(async (v) => {
        sc.pin = v; await this.plugin.saveSettings(); this.plugin.refreshViews();
      }));

    new Setting(card)
      .addButton((b) => b.setButtonText(t("Run now")).onClick(async () => {
        const view = await this.plugin.activateView();
        if (view) view.runScenario(sc);
      }))
      .addExtraButton((b) => b.setIcon("trash-2").setTooltip(t("Delete this scenario")).onClick(async () => {
        s.scenarios = s.scenarios.filter((x) => x.id !== sc.id);
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
    s.automations.forEach((a) => this.automationCard(c, a));

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
    add.addButton((b) => b.setCta().setButtonText("+").onClick(async () => {
      const fresh = newAutomation(pick);
      s.automations.push(fresh);
      if (!this._open) this._open = new Set();
      this._open.add(fresh.id);
      await this.plugin.saveSettings();
      this.display();
    }));
  }

  dayLabels() { return [t("Sun"), t("Mon"), t("Tue"), t("Wed"), t("Thu"), t("Fri"), t("Sat")]; }

  scheduleSummary(a) {
    const L = this.dayLabels();
    const when = (!a.days || !a.days.length) ? t("Every day")
      : [1, 2, 3, 4, 5, 6, 0].filter((d) => a.days.includes(d)).map((d) => L[d]).join(", ");
    return `${a.time || "--:--"} · ${when}`;
  }

  automationCard(c, a) {
    const s = this.s;
    const card = this.foldCard(c, {
      id: a.id,
      title: a.name || t("Custom automation"),
      subtitle: this.scheduleSummary(a),
      enabled: a.enabled,
      onToggle: async (v) => { a.enabled = v; await this.plugin.saveSettings(); this.display(); },
    });

    new Setting(card).setName(t("Name")).addText((tx) =>
      tx.setValue(a.name || "").onChange(async (v) => { a.name = v; await this.plugin.saveSettings(); }));

    new Setting(card).setName(t("Time")).addText((tx) => {
      tx.inputEl.type = "time";
      tx.setValue(a.time || "09:00").onChange(async (v) => { a.time = v || "09:00"; await this.plugin.saveSettings(); });
    });

    // Days: click to toggle, none selected means every day. Monday-first.
    const daysSetting = new Setting(card).setName(t("Days")).setDesc(t("None selected = every day."));
    const daysRow = daysSetting.controlEl.createDiv({ cls: "oa-auto-days" });
    const L = this.dayLabels();
    [1, 2, 3, 4, 5, 6, 0].forEach((d) => {
      const btn = daysRow.createEl("button", { cls: "oa-day" + (a.days.includes(d) ? " is-on" : ""), text: L[d] });
      btn.onclick = async () => {
        a.days = a.days.includes(d) ? a.days.filter((x) => x !== d) : a.days.concat(d);
        await this.plugin.saveSettings();
        this.display();
      };
    });

    new Setting(card).setName(t("Where it writes")).addDropdown((d) => {
      d.addOption("daily", t("Today's daily note"));
      d.addOption("note", t("A new note"));
      d.setValue(a.target || "daily").onChange(async (v) => { a.target = v; await this.plugin.saveSettings(); this.display(); });
    });

    if ((a.target || "daily") === "daily") {
      new Setting(card).setName(t("Heading")).setDesc(t("Under this heading in the daily note."))
        .addText((tx) => tx.setPlaceholder(a.name || "").setValue(a.heading || "")
          .onChange(async (v) => { a.heading = v; await this.plugin.saveSettings(); }));
    } else {
      this.folderField(
        new Setting(card).setName(t("Folder")).setDesc(t("Where the new note goes.")),
        () => a.folder || "",
        async (v) => { a.folder = v; await this.plugin.saveSettings(); });
    }

    new Setting(card).setName(t("Prompt")).setDesc(t("What the assistant should do. It has the same tools as in a normal chat — it can read your notes, your daily entries, and search the web if that's on."))
      .addTextArea((tx) => {
        tx.inputEl.rows = 4;
        tx.inputEl.addClass("oa-auto-prompt");
        tx.setValue(a.prompt || "").onChange(async (v) => { a.prompt = v; await this.plugin.saveSettings(); });
      });

    new Setting(card).setName(t("Notify me when it's done"))
      .addToggle((x) => x.setValue(a.notify !== false).onChange(async (v) => { a.notify = v; await this.plugin.saveSettings(); }));

    new Setting(card)
      .addButton((b) => b.setButtonText(t("Run now")).onClick(async () => {
        b.setButtonText(t("Running…")).setDisabled(true);
        try { await this.plugin.scheduler.run(a, { manual: true }); }
        catch (e) { new Notice(t("Something went wrong: {0}", e.message)); }
        finally { b.setButtonText(t("Run now")).setDisabled(false); }
      }))
      .addExtraButton((b) => b.setIcon("trash-2").setTooltip(t("Delete this automation")).onClick(async () => {
        s.automations = s.automations.filter((x) => x.id !== a.id);
        await this.plugin.saveSettings();
        this.display();
      }));
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
      .addDropdown((d) => {
        d.addOption("auto", t("Follow Obsidian"));
        d.addOption("ru", t("Russian"));
        d.addOption("en", t("English"));
        d.setValue(s.lang).onChange(async (v) => {
          s.lang = v; setLang(v === "auto" ? null : v);
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
          this.display();
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
          .setDesc(t("One note per conversation, named after the assistant and the time. Empty means the root of your vault.")),
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
  }
}
