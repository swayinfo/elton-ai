/* ============================================================
 *  Plugin
 * ========================================================== */
class EltonAI extends ObsidianPlugin {
  async onload() {
    await this.loadSettings();
    setLang(this.settings.lang === "auto" ? null : this.settings.lang);

    // Seeded only after the language is known, so the starter scenarios are
    // named in the reader's language. An empty array is a deliberate state —
    // someone who deleted all of them does not want them back.
    if (this.settings.scenarios == null) {
      this.settings.scenarios = defaultScenarios();
      await this.saveSettings();
    }

    this.ai = new AIClient(this);
    this.spend = new SpendTracker(this);
    this.ambience = new Ambience(this);
    this.vault = new VaultBridge(this);
    this.recorder = new Recorder();
    this.speaker = new Speaker(this);
    this.scheduler = new AutomationScheduler(this);
    this.lastNote = null;

    this.registerView(VIEW_TYPE, (leaf) => new AssistantView(leaf, this));

    this.addRibbonIcon("bot", "💡 " + t("Elton AI"), () => this.activateView());

    // Not named after the plugin: the palette already prefixes every entry
    // with it, and "Elton AI: Elton AI" tells you nothing.
    this.addCommand({ id: "open", name: t("Open the panel"), callback: () => this.activateView() });
    this.addCommand({
      id: "talk",
      name: t("Start talking"),
      callback: async () => { const v = await this.activateView(); if (v) v.toggleTalk(); },
    });
    this.addCommand({
      id: "onboarding",
      name: t("Open the setup guide"),
      callback: () => new OnboardingModal(this.app, this).open(),
    });
    this.addCommand({
      id: "scenario",
      name: t("Run a scenario"),
      callback: () => new ScenarioPickerModal(this.app, this).open(),
    });

    // Highlight a paragraph and ask about it. Every assistant plugin worth
    // using has this and it is how most people first reach for one: the
    // question starts from something already in front of them, not from a
    // blank panel they have to describe their way back to.
    this.addCommand({
      id: "ask-selection",
      name: t("Ask about the selected text"),
      editorCheckCallback: (checking, editor) => {
        const has = !!(editor && editor.getSelection && editor.getSelection().trim());
        if (!checking && has) this.askAboutSelection(editor.getSelection());
        return has;
      },
    });

    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
      const sel = editor && editor.getSelection ? editor.getSelection().trim() : "";
      if (!sel) return;
      menu.addItem((item) => item
        .setTitle("💡 " + t("Ask the assistant"))
        .setIcon("bot")
        .onClick(() => this.askAboutSelection(sel)));
    }));

    this.addSettingTab(new AssistantSettingTab(this.app, this));

    // Which note is on screen decides what "this" and "here" mean. The
    // workspace's own idea of the active file goes stale the moment focus
    // moves to the assistant panel, so track markdown opens explicitly.
    this.registerEvent(this.app.workspace.on("file-open", (f) => {
      if (f instanceof TFile && f.extension === "md") this.lastNote = f;
    }));

    this.app.workspace.onLayoutReady(async () => {
      const f = this.app.workspace.getActiveFile();
      if (f && f.extension === "md") this.lastNote = f;
      // Build the word index in the background so the first question doesn't
      // pay for it.
      this.vault.buildIndex().catch(() => {});

      // Start the automation timer once the vault is ready to be read.
      this.scheduler.start();

      if (!this.settings.onboarded) {
        // Persist the flag before opening: a sync writing data.json can
        // re-trigger onload, and greeting someone twice is worse than not
        // greeting them at all.
        this.settings.onboarded = true;
        await this.saveSettings();
        new OnboardingModal(this.app, this).open();
      } else if (this.settings.openOnStartup) {
        this.activateView();
      }
    });

    // Keep the index roughly honest without rebuilding on every keystroke.
    const stale = obsidian.debounce(() => { this.vault.index = null; }, 20000, true);
    for (const ev of ["create", "delete", "rename", "modify"]) {
      this.registerEvent(this.app.vault.on(ev, stale));
    }
  }

  onunload() {
    this.speaker.stop();
    this.recorder.stop();
    this.ambience.stop();
  }

  async loadSettings() {
    const raw = (await this.loadData()) || {};
    // Nested objects need a deeper merge than Object.assign, or a saved
    // file from an older version loses the keys added since.
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw, {
      keys: Object.assign({}, DEFAULT_SETTINGS.keys, raw.keys),
      bases: Object.assign({}, DEFAULT_SETTINGS.bases, raw.bases),
      models: Object.assign({}, DEFAULT_SETTINGS.models, raw.models),
      cloudFallback: Object.assign({}, DEFAULT_SETTINGS.cloudFallback, raw.cloudFallback),
    });

    // A voice saved for one engine is rejected by another, and the only
    // symptom is the robotic system voice. Heal it here rather than waiting
    // for the user to find the dropdown.
    const cfg = ttsProfileFor(this.settings.provider === "local"
      ? this.settings.cloudFallback.provider : this.settings.provider);
    const fixed = pickVoice(cfg, this.settings.cloudVoice);
    if (fixed !== this.settings.cloudVoice) {
      console.warn(`[Elton AI] voice "${this.settings.cloudVoice}" is not available here — using "${fixed}"`);
      this.settings.cloudVoice = fixed;
      await this.saveData(this.settings);
    }
  }

  async saveSettings() { await this.saveData(this.settings); }

  /** Open the panel where the user asked for it, reusing an existing one. */
  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length) {
      workspace.revealLeaf(existing[0]);
      return existing[0].view;
    }
    const where = this.settings.viewLocation;
    const leaf = where === "main" ? workspace.getLeaf("tab")
      : where === "left" ? workspace.getLeftLeaf(false)
      : workspace.getRightLeaf(false);
    if (!leaf) return null;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
    return leaf.view;
  }

  /**
   * The prompt behind "ask about this".
   *
   * Kept out of the view so it can be read and tested on its own: the wording
   * is what decides whether the answer is about the highlighted sentence or
   * about the note it happens to sit in.
   */
  static selectionPrompt(selection) {
    const text = String(selection || "").trim();
    if (!text) return "";
    return t("The user highlighted this passage in the note they are reading:\n\n«{0}»\n\nAnswer about this passage specifically, not about the note as a whole. Explain what it means and why it matters, and say plainly if it is unclear or unfinished. Search their other notes if that helps place it.", text);
  }

  /** Send a highlighted passage to the panel and answer about it. */
  async askAboutSelection(selection) {
    const prompt = EltonAI.selectionPrompt(selection);
    if (!prompt) { new Notice(t("Select some text first")); return; }
    const view = await this.activateView();
    if (view) view.askAbout(selection, prompt);
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view && leaf.view.render) leaf.view.render();
    }
  }

  openSettings() {
    this.app.setting.open();
    this.app.setting.openTabById(this.manifest.id);
  }

  /** Write the conversation out as a note, one file per session. */
  async saveConversation(messages) {
    if (!messages.length) return;
    try {
      const folder = this.settings.conversationFolder || "";
      if (folder) await this.vault.ensureFolder(folder);
      let announce = false;
      if (!this._convPath) {
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
        this._convPath = normalizePath((folder ? folder + "/" : "") + `${this.settings.assistantName} ${stamp}.md`);
        // Once, when the file for this conversation is decided. Saving that
        // nobody can find is the same as not saving: the setting is off by
        // default, the folder is usually blank, and the note then lands in the
        // vault root under a name nobody went looking for.
        announce = true;
      }
      const body = messages.map((m) =>
        (m.role === "user" ? "**" + (this.settings.userName || "You") + ":** " : "**" + this.settings.assistantName + ":** ") + m.content
      ).join("\n\n");
      const existing = this.app.vault.getAbstractFileByPath(this._convPath);
      if (existing instanceof TFile) await this.app.vault.modify(existing, body);
      else await this.app.vault.create(this._convPath, body);
      if (announce) new Notice(t("Conversation is being saved: {0}", this._convPath), 8000);
    } catch (e) { console.warn("[Elton AI] could not save the conversation:", e.message); }
  }
}

module.exports = EltonAI;
