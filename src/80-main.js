/* ============================================================
 *  Plugin
 * ========================================================== */
class EltonAI extends ObsidianPlugin {
  /** Раз в неделю — сколько заметок ждёт индексации. Ничего не делает сама. */
  async remindIndex() {
    const s = this.settings;
    if (!s.indexRemind || !s.semanticSearch) return;

    const WEEK = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - (s.indexRemindAt || 0) < WEEK) return;

    let pending = 0;
    try { pending = await this.vault.pendingCount(); } catch { return; }
    // Две-три заметки погоды не делают, а сообщение из-за них — назойливость.
    if (pending < 15) return;

    s.indexRemindAt = Date.now();
    await this.saveSettings();
    new Notice(t("{0} notes are not in the search index yet. Settings → Elton AI → Vault → Index.", pending), 9000);
  }

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
    /* Before everything that writes or talks: the vault records each change
       into the journal, and every channel reads the conversation from memory. */
    this.memory = new ConversationMemory(this);
    this.journal = new ChangeJournal(this);
    this.memory.load().catch(() => {});
    this.journal.load().catch(() => {});
    this.vault = new VaultBridge(this);
    this.index = new IndexRunner(this);
    try {
      this.index.bar = this.addStatusBarItem();
      this.index.bar.addClass("oa-index-bar");
      this.index.bar.onclick = () => this.openSettings();
      this.index.paint();
    } catch { /* no status bar on this platform */ }
    this.recorder = new Recorder();
    this.speaker = new Speaker(this);
    this.scheduler = new AutomationScheduler(this);
    this.telegram = new TelegramBridge(this);
    this.connector = new ConnectorBridge(this);
    this.lastNote = null;

    this.registerView(VIEW_TYPE, (leaf) => new AssistantView(leaf, this));

    this.ribbon = this.addRibbonIcon("bot", "💡 " + t("Elton AI"), () => this.activateView());
    this.registerCommands();

    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
      const sel = editor && editor.getSelection ? editor.getSelection().trim() : "";
      if (!sel) return;
      menu.addItem((item) => item
        .setTitle("💡 " + t("Ask the assistant"))
        .setIcon("bot")
        .onClick(() => this.askAboutSelection(sel)));
    }));

    // Держим ссылку: окно «что нового» открывает настройки сразу
    // на вкладке коннектора, а вкладка живёт в самой странице.
    this.settingTab = new AssistantSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.registerHoldKey();

    /*
     * Индекс стареет молча: поиск не ломается, он просто перестаёт видеть
     * написанное на прошлой неделе. Раз в неделю говорим об этом вслух.
     *
     * Через минуту после запуска, а не сразу: человек открыл хранилище,
     * чтобы работать, а не читать сообщения. Дальше — раз в сутки, этого
     * с запасом хватает для недельного напоминания.
     */
    this.registerInterval(window.setInterval(() => this.remindIndex(), 24 * 60 * 60 * 1000));
    window.setTimeout(() => this.remindIndex(), 60 * 1000);

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
      // The bot answers from the vault, so it must not start before the vault
      // is there to answer from.
      this.telegram.start();
      this.connector.start();

      /* After the layout, not before: while the vault loads, Obsidian fires
         "create" for every file in it, and each would have been queued. */
      this.registerEvent(this.app.vault.on("modify", (f) => this.index.touch(f.path)));
      this.registerEvent(this.app.vault.on("create", (f) => this.index.touch(f.path)));
      this.registerEvent(this.app.vault.on("rename", (f, old) => {
        if (this.index.auto) this.vault.renameEmbedding(old, f.path).catch(() => {});
      }));
      this.registerEvent(this.app.vault.on("delete", (f) => {
        if (this.index.auto) this.vault.dropEmbedding(f.path).catch(() => {});
      }));
      const later = setTimeout(() => this.index.catchUp().catch(() => {}), 90000);
      this.register(() => clearTimeout(later));

      if (!this.settings.onboarded) {
        // Persist the flag before opening: a sync writing data.json can
        // re-trigger onload, and greeting someone twice is worse than not
        // greeting them at all.
        this.settings.onboarded = true;
        // Новичку рассказывать, что изменилось, нечего: он ничего
        // предыдущего не видел, и онбординг покажет то же самое подробнее.
        this.settings.seenVersion = this.manifest.version;
        await this.saveSettings();
        new OnboardingModal(this.app, this).open();
      } else {
        if (this.settings.openOnStartup) this.activateView();
        if (this.settings.seenVersion !== this.manifest.version) {
          // Флаг раньше окна по той же причине, что и выше.
          this.settings.seenVersion = this.manifest.version;
          await this.saveSettings();
          new WhatsNewModal(this.app, this, this.manifest.version).open();
        }
      }
    });

    // Keep the index roughly honest without rebuilding on every keystroke.
    const stale = obsidian.debounce(() => { this.vault.index = null; this.vault._map = null; }, 20000, true);
    for (const ev of ["create", "delete", "rename", "modify"]) {
      this.registerEvent(this.app.vault.on(ev, stale));
    }
  }

  /**
   * The palette entries.
   *
   * Their own method because they carry translated names, and those are fixed
   * at the moment they are registered — which is load time. Changing the
   * language then left five commands and a ribbon tooltip speaking the old
   * one until Obsidian was restarted, and "restart for the rest of it" is a
   * poor answer to a setting that otherwise takes effect instantly. Calling
   * this again re-registers them under the same ids, which replaces them.
   */
  registerCommands() {
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
      id: "feedback",
      name: t("Report a problem or suggest an idea"),
      callback: () => openFeedback(),
    });
    this.addCommand({
      id: "whats-new",
      name: t("What’s new"),
      callback: () => new WhatsNewModal(this.app, this, this.manifest.version).open(),
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
  }

  /** Everything that has to be redrawn or re-registered when the language changes. */
  applyLanguage() {
    this.registerCommands();
    if (this.ribbon) this.ribbon.setAttr("aria-label", "💡 " + t("Elton AI"));
    this.refreshViews();
    // The bot's menu is built from scenario names, which are the user's own
    // words — but /help around them is not.
    if (this.telegram) this.telegram.syncCommands();
  }

  /**
   * Hold a key anywhere in Obsidian and talk.
   *
   * Not an Obsidian command: commands fire once on the way down and say
   * nothing about the way up, so "hold to speak" cannot be built on one. The
   * listener is on the window in capture phase — otherwise an editor with
   * focus swallows the combination before it is ever seen — and it opens the
   * panel if it is closed, which is the whole point of it being global.
   */
  registerHoldKey() {
    let down = false;
    this.registerDomEvent(window, "keydown", (e) => {
      const hk = this.settings.holdKey;
      if (!hotkeyMatches(hk, e)) return;
      e.preventDefault();
      e.stopPropagation();
      // Held keys repeat. The second one must not start a second recording.
      if (down || e.repeat) return;
      down = true;
      this.activateView().then((v) => { if (v) v.startHold(); else down = false; });
    }, true);

    // Any keyup that ends the combination ends the recording — letting go of
    // Ctrl while still on Space has to stop it too, or the microphone stays
    // open on a combination that is no longer held.
    this.registerDomEvent(window, "keyup", (e) => {
      const hk = this.settings.holdKey;
      if (!down || !hk) return;
      const releases = e.code === hk.code
        || (hk.ctrl && /^Control/.test(e.code)) || (hk.shift && /^Shift/.test(e.code))
        || (hk.alt && /^Alt/.test(e.code)) || (hk.meta && /^Meta/.test(e.code));
      if (!releases) return;
      down = false;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view && leaf.view.stopHold) leaf.view.stopHold();
      }
    }, true);

    // A window that loses focus never delivers the keyup, and the microphone
    // would sit open until the tab came back.
    this.registerDomEvent(window, "blur", () => {
      if (!down) return;
      down = false;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view && leaf.view.stopHold) leaf.view.stopHold();
      }
    });
  }

  onunload() {
    if (this.index) this.index.dispose();
    this.speaker.stop();
    this.recorder.stop();
    this.ambience.stop();
    this.telegram.stop();
    if (this.connector) this.connector.stop();
    // Whatever is still waiting on a timer goes to disk now.
    if (this.memory) this.memory.saveNow();
    if (this.journal) this.journal.saveNow();
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
      telegram: Object.assign({}, DEFAULT_SETTINGS.telegram, raw.telegram),
    });

    /* The old default was the English word "Assistant", saved into every
       data.json on first save — so a Russian vault greeted its owner with
       "Меня зовут Assistant" and headed the panel in English. Nobody chose
       it; it is the product's own name now, which needs no translating. */
    if (!this.settings.assistantName || this.settings.assistantName === "Assistant") {
      this.settings.assistantName = "Elton AI";
    }

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

  async saveSettings() {
    await this.saveData(this.settings);
    // The bot's "/" menu is built from the scenarios, so it goes stale the
    // moment one is renamed. Debounced: this runs on every keystroke in a
    // settings field, and the menu is one HTTP call.
    if (!this._syncCmds) {
      this._syncCmds = obsidian.debounce(() => { this.telegram.syncCommands(); }, 4000);
    }
    this._syncCmds();

    /* Список промптов приложение узнаёт один раз, когда подключается. Значит
       после правки сценария в телефоне остаётся вчерашний список — до
       перезапуска Obsidian. Сверяем отпечаток и, если он изменился, просим
       коннектор рассказать о себе заново: он сделает это на ближайшем круге,
       в пределах полуминуты. Отпечаток нужен потому, что сюда приходят на
       каждое нажатие клавиши в настройках. */
    const stamp = JSON.stringify((this.settings.scenarios || [])
      .filter((x) => x && x.enabled && x.prompt)
      .map((x) => [x.emoji, x.name, x.prompt]));
    if (stamp !== this._promptStamp) {
      this._promptStamp = stamp;
      if (this.connector) this.connector.refreshAbout();
    }
  }

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
      // A folder of its own rather than the vault root, and made if it is not
      // there. The name is translated, because it is a folder the plugin
      // creates in someone else's vault and they have to recognise it.
      const folder = this.settings.conversationFolder || t("Assistant conversations");
      await this.vault.ensureFolder(folder);
      let announce = false;
      if (!this._convPath) {
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
        this._convPath = normalizePath(folder + "/" + `${this.settings.assistantName} ${stamp}.md`);
        // Said once, when the file for this conversation is decided. Saving
        // that nobody can find is the same as not saving — and now that this
        // is on by default, the first note appears in a folder the user never
        // asked for. Better to be told where than to find it later.
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

/* nosourcemap */