/* ============================================================
 *  The panel — an arc-reactor HUD, not a chat log
 *
 *  The reactor IS the status display: its phase attribute drives
 *  every animation, and the core scales with microphone level so
 *  you can see it hearing you. Under it sit three lines — what it
 *  heard, what it answered, which note it is looking at.
 *
 *  Animation rule, learned the hard way: anything that breathes
 *  animates through transform and opacity only. Those go to the
 *  GPU untouched. Animating box-shadow, filter or inset here puts
 *  the lag straight back.
 * ========================================================== */

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>`;

class AssistantView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf, plugin);
    this.plugin = plugin;
    this.messages = [];
    this.mode = "idle";        // idle | conversation
    this.phase = "idle";       // idle | listening | thinking | speaking | confirm
    this.talking = false;
    this.busy = false;
    this.interrupted = false;
    this.stopMonitor = null;
    this.agent = null;
    this.pressed = false;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "💡 " + (this.plugin.settings.assistantName || t("Assistant")); }
  getIcon() { return "bot"; }

  async onOpen() { this.render(); }
  async onClose() { this.teardown(); }

  /* ── layout ─────────────────────────────────────────────── */
  render() {
    if (this.plugin.settings.viewMode === "chat") this.renderChat();
    else this.renderReactor();
  }

  /** Voice-first: the reactor is the whole interface. */
  renderReactor() {
    const root = this.contentEl;
    root.empty();
    root.addClass("oa-host");

    const stage = root.createDiv({ cls: "oa-stage" });
    this.stage = stage;
    this.chat = null;

    /* top-right cluster: mode, voice toggle, settings */
    const bar = stage.createDiv({ cls: "oa-topbar" });
    this.addModeButton(bar);
    this.voiceBtn = bar.createEl("button", { cls: "oa-iconbtn" });
    this.voiceBtn.setAttr("aria-label", t("Voice replies"));
    this.syncVoiceBtn();
    this.voiceBtn.onclick = async () => {
      this.plugin.settings.voiceEnabled = !this.plugin.settings.voiceEnabled;
      await this.plugin.saveSettings();
      this.syncVoiceBtn();
      if (!this.plugin.settings.voiceEnabled) this.plugin.speaker.stop();
    };
    const gear = bar.createEl("button", { cls: "oa-iconbtn" });
    gear.setAttr("aria-label", t("Settings"));
    setIcon(gear, "settings");
    gear.onclick = () => this.plugin.openSettings();

    /* The instrument and everything it has to say, in one group. Laid out
       flat, every element on the stage was the same distance from every
       other, so the dial, the note you have open and the microphone all read
       as one undifferentiated column of things. */
    const hud = stage.createDiv({ cls: "oa-hud" });

    /* the reactor */
    const reactor = hud.createDiv({ cls: "oa-reactor" });
    this.reactor = reactor;
    reactor.dataset.phase = "idle";
    reactor.createDiv({ cls: "oa-ring r1" });
    reactor.createDiv({ cls: "oa-ring r2" });
    reactor.createDiv({ cls: "oa-ring r3" });
    reactor.createDiv({ cls: "oa-ticks" });
    reactor.createDiv({ cls: "oa-core" });
    reactor.setAttr("role", "button");
    reactor.setAttr("tabindex", "0");
    reactor.onclick = () => { unlockAudio(); this.onReactorClick(); };

    // The panel is never unloaded when you switch tabs, so these animations
    // would burn frames forever behind another view. Pause them off-screen.
    this._io = new IntersectionObserver(
      ([e]) => reactor.classList.toggle("oa-paused", !e.isIntersecting), { threshold: 0 });
    this._io.observe(reactor);
    this._onVis = () => reactor.classList.toggle("oa-paused-doc", document.hidden);
    document.addEventListener("visibilitychange", this._onVis);
    this._onVis();

    /* readouts */
    this.statusEl = hud.createDiv({ cls: "oa-status" });
    this.heardEl = hud.createDiv({ cls: "oa-heard" });
    this.replyEl = hud.createDiv({ cls: "oa-reply" });
    // The answer is folded away by default. Reading it while waiting for the
    // voice to catch up means hearing the same thing twice, so revealing it
    // is a deliberate act.
    this.replyToggle = hud.createEl("button", { cls: "oa-reply-toggle" });
    this.replyToggle.onclick = () => {
      this._replyOpen = !this._replyOpen;
      this.paintReply();
    };
    this.noteEl = hud.createDiv({ cls: "oa-note-chip" });

    // One tap for the thing you ask for every day. Only while idle: mid-answer
    // they would be buttons that queue up work you cannot see.
    this.scenRow = stage.createDiv({ cls: "oa-scen-row" });
    this.paintScenarios();

    /* controls */
    const controls = stage.createDiv({ cls: "oa-controls" });

    // Confirmation lives in the HUD rather than a modal: a voice session
    // should not be interrupted by a dialog stealing the whole window.
    this.confirmRow = controls.createDiv({ cls: "oa-confirm-row" });
    this.yesBtn = this.confirmRow.createEl("button", { cls: "oa-cbtn yes", text: "✓" });
    this.noBtn = this.confirmRow.createEl("button", { cls: "oa-cbtn no", text: "✕" });

    this.micBtn = controls.createEl("button", { cls: "oa-mic" });
    // The tap is the only moment iOS will grant permission to make sound
    // later; spend it here, before anything async can lose it.
    this.micBtn.onclick = () => { unlockAudio(); this.toggleTalk(); };
    this.micBtn.addEventListener("pointerdown", () => { this.pressed = true; });
    this.micBtn.addEventListener("pointerup", () => { this.pressed = false; });
    this.micBtn.addEventListener("pointerleave", () => { this.pressed = false; });

    this.textRow = controls.createDiv({ cls: "oa-textrow" });
    this.input = this.textRow.createEl("input", { type: "text" });
    this.input.placeholder = t("or type…");
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.sendTyped(); }
    });
    const send = this.textRow.createEl("button", { cls: "oa-send" });
    setIcon(send, "arrow-up");
    send.setAttr("aria-label", t("Send"));
    send.onclick = () => this.sendTyped();

    this.updateNoteChip();
    // Paint the readouts before showing them. Without this the toggle button
    // is built empty and never told to hide, which put a blank white box on
    // screen under the status line on every fresh panel.
    this.setReply("");
    this.setHeard("");
    this.setPhase("idle");
  }

  /**
   * The pinned scenarios, as chips under the reactor.
   *
   * Three at most, on one line. Six of them wrapped into a ragged two-row
   * block that was the busiest thing on a panel whose whole point is that it
   * is quiet; the rest are one tap away in the picker, which shows every
   * scenario with its trigger phrases and is a better list than chips anyway.
   */
  paintScenarios() {
    if (!this.scenRow) return;
    this.scenRow.empty();
    const all = pinnedScenarios(this.plugin.settings);
    for (const sc of all.slice(0, 3)) {
      const chip = this.scenRow.createEl("button", { cls: "oa-scen-chip" });
      chip.createSpan({ cls: "oa-scen-chip-emoji", text: sc.emoji || "✨" });
      chip.createSpan({ cls: "oa-scen-chip-name", text: sc.name || t("Custom scenario") });
      chip.setAttr("aria-label", sc.triggers ? t("Or just say: {0}", sc.triggers) : sc.name);
      chip.onclick = () => { unlockAudio(); this.runScenario(sc); };
    }
    if (all.length > 3) {
      const more = this.scenRow.createEl("button", { cls: "oa-scen-chip is-more" });
      setIcon(more, "more-horizontal");
      more.setAttr("aria-label", t("All scenarios"));
      more.onclick = () => new ScenarioPickerModal(this.app, this.plugin).open();
    }
  }

  /**
   * Answer about a passage the user highlighted.
   * What goes on screen is their own words, shortened; what goes to the model
   * is the full passage inside a brief.
   */
  async askAbout(selection, prompt) {
    if (this.busy) return;
    const shown = selection.length > 100 ? selection.slice(0, 100).trim() + "…" : selection;
    if (this.chat) this.chat.user(shown);
    else this.setHeard(shown);
    // `scenario` carries a ready-made brief and stops the trigger matcher from
    // reading the passage itself as a command — a highlighted "мысли" is text,
    // not a request.
    await this.turn(prompt, {
      speak: !this.chat && this.plugin.settings.voiceEnabled,
      scenario: { name: t("Selected text"), prompt },
    });
  }

  /** Run a scenario outright — from a chip, the palette or settings. */
  async runScenario(sc) {
    if (this.busy || !sc || !sc.prompt) return;
    const label = scenarioLabel(sc);
    if (this.chat) this.chat.user(label);
    else this.setHeard(label);
    await this.turn(sc.prompt, {
      speak: !this.chat && this.plugin.settings.voiceEnabled,
      scenario: sc,
    });
  }

  syncVoiceBtn() {
    if (!this.voiceBtn) return;
    setIcon(this.voiceBtn, this.plugin.settings.voiceEnabled ? "volume-2" : "volume-x");
  }

  /** The reactor/chat switch, in both layouts' headers. */
  addModeButton(bar, cls = "oa-iconbtn") {
    const chat = this.plugin.settings.viewMode === "chat";
    const b = bar.createEl("button", { cls });
    setIcon(b, chat ? "audio-lines" : "message-square");
    b.setAttr("aria-label", chat ? t("Switch to voice") : t("Switch to text"));
    b.setAttr("title", chat ? t("Switch to voice") : t("Switch to text"));
    b.onclick = async () => {
      // Leaving voice mode must not leave a microphone open behind it.
      this.teardown();
      this.plugin.settings.viewMode = chat ? "reactor" : "chat";
      await this.plugin.saveSettings();
      this.render();
    };
    return b;
  }

  /* ── text-first layout ──────────────────────────────────── */
  renderChat() {
    const root = this.contentEl;
    root.empty();
    root.addClass("oa-host");
    root.removeClass("oa-stage");
    this.stage = null;
    this.reactor = null;
    // The reactor's chips are gone with it; the chat grows its own in the
    // empty state, and a stale reference here would be styled into nothing.
    this.scenRow = null;

    const wrap = root.createDiv({ cls: "oa-chat" });

    const head = wrap.createDiv({ cls: "oa-chat-head" });
    head.createDiv({ cls: "oa-chat-title", text: "💡 " + (this.plugin.settings.assistantName || t("Assistant")) });
    const btns = head.createDiv({ cls: "oa-chat-headbtns" });
    this.addModeButton(btns, "oa-icon-btn");
    const fresh = btns.createEl("button", { cls: "oa-icon-btn" });
    setIcon(fresh, "plus");
    fresh.setAttr("aria-label", t("New conversation"));
    fresh.onclick = () => { this.messages = []; this.render(); };
    const gear = btns.createEl("button", { cls: "oa-icon-btn" });
    setIcon(gear, "settings");
    gear.setAttr("aria-label", t("Settings"));
    gear.onclick = () => this.plugin.openSettings();

    this.chat = new ChatLog(this, wrap.createDiv({ cls: "oa-chat-log" }));

    // Replay the conversation so switching modes does not lose it.
    if (this.messages.length) {
      for (const m of this.messages) {
        if (m.role === "user") this.chat.user(m.content);
        else this.chat.assistant().content(m.content, null);
      }
    } else {
      this.chat.empty(this.plugin.ai.isConfigured());
    }

    this.noteEl = wrap.createDiv({ cls: "oa-chat-note" });
    this.updateNoteChip();

    const bar = wrap.createDiv({ cls: "oa-chat-bar" });
    this.input = bar.createEl("textarea", { cls: "oa-chat-input", attr: { rows: "1", placeholder: t("Type a message…") } });
    const grow = () => {
      // Height has to collapse before scrollHeight means anything: it reports
      // the content, and an already-tall box would never shrink back.
      this.input.setCssStyles({ height: "auto" });
      this.input.setCssStyles({ height: Math.min(160, this.input.scrollHeight) + "px" });
    };
    this.input.addEventListener("input", grow);
    this.input.addEventListener("keydown", (e) => {
      // Enter sends, Shift+Enter breaks the line — the convention everywhere
      // else people type into a conversation.
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.sendTyped(); }
    });

    // Dictation without leaving text mode: one utterance, straight into the box.
    this.dictateBtn = bar.createEl("button", { cls: "oa-chat-mic" });
    setIcon(this.dictateBtn, "mic");
    this.dictateBtn.setAttr("aria-label", t("Dictate"));
    this.dictateBtn.onclick = () => { unlockAudio(); this.dictate(); };

    const send = bar.createEl("button", { cls: "oa-chat-send" });
    setIcon(send, "arrow-up");
    send.setAttr("aria-label", t("Send"));
    send.onclick = () => this.sendTyped();
  }

  /** Record one phrase and drop the transcript into the input box. */
  async dictate() {
    if (this.dictating) { this.plugin.recorder.stop(); return; }
    if (!this.plugin.ai.hasCloud()) {
      new Notice(t("A local model can't transcribe speech or speak. Point this at a cloud key and voice keeps working while text stays local."), 8000);
      return;
    }
    this.dictating = true;
    this.dictateBtn.addClass("is-live");
    try {
      const { blob, format, hadSpeech } = await this.plugin.recorder.record({
        maxMs: 30000,
        getStop: () => !this.dictating,
      });
      if (hadSpeech) {
        const text = await this.plugin.ai.transcribe(await blobToBase64(blob), format);
        if (text) {
          this.input.value = this.input.value ? this.input.value + " " + text : text;
          this.input.dispatchEvent(new Event("input"));
          this.input.focus();
        }
      }
    } catch (e) {
      new Notice(t("Microphone unavailable: {0}", e.message));
    } finally {
      this.dictating = false;
      if (this.dictateBtn) this.dictateBtn.removeClass("is-live");
    }
  }

  /**
   * Speak a specific answer on demand, from the chat's play button.
   * The button becomes the stop control while it runs — otherwise there is
   * no way to shut it up short of switching modes.
   */
  async speakText(text, btn) {
    if (this.reading) {
      this.interrupted = true;
      this.plugin.speaker.stop();
      return;
    }
    this.reading = true;
    this.interrupted = false;
    if (btn) { btn.addClass("is-playing"); setIcon(btn, "square"); btn.createSpan({ text: t("Stop") }); }
    try {
      await this.plugin.speaker.sayAll(speechChunks(text), { shouldStop: () => this.interrupted });
    } finally {
      this.reading = false;
      if (btn) {
        btn.removeClass("is-playing");
        setIcon(btn, "volume-2");
        btn.createSpan({ text: t("Read aloud") });
      }
    }
  }

  updateNoteChip() {
    if (!this.noteEl) return;
    const f = this.plugin.lastNote;
    if (f && this.plugin.vault.inScope(f.path)) {
      this.noteEl.setText("📂 " + t("On screen: {0}", f.basename));
      this.noteEl.toggleClass("is-hidden", false);
    } else this.noteEl.toggleClass("is-hidden", true);
  }

  /** Every visible change to what the assistant is doing routes through here. */
  setPhase(phase, label) {
    this.phase = phase;
    if (!this.stage) return;   // chat mode has no reactor to drive
    if (this.reactor) this.reactor.dataset.phase = phase === "confirm" ? "thinking" : phase;
    const DEFAULT = {
      idle: this.plugin.ai.isConfigured() ? t("At your service") : t("Set up the plugin first"),
      listening: t("Listening…"),
      thinking: t("Thinking…"),
      speaking: t("Answering…"),
      confirm: t("Waiting for your confirmation"),
    };
    if (this.statusEl) this.statusEl.setText(label != null ? label : (DEFAULT[phase] || ""));

    const live = this.mode === "conversation";
    if (this.micBtn) {
      setIcon(this.micBtn, live ? "square" : "mic");
      this.micBtn.classList.toggle("is-live", live);
      this.micBtn.setAttr("aria-label", live ? t("Stop talking") : t("Start talking"));
    }
    const confirming = phase === "confirm";
    if (this.confirmRow) this.confirmRow.toggleClass("is-open", !!confirming);
    if (this.micBtn) this.micBtn.style.display = confirming ? "none" : "flex";
    // The text box is for when you are not in a voice session; hiding it
    // during one keeps the HUD from looking like a chat window.
    if (this.textRow) this.textRow.style.display = (this.mode === "idle" && !confirming) ? "flex" : "none";
    if (this.scenRow) this.scenRow.toggleClass("is-hidden", !(phase === "idle" && !this.busy));
  }

  setHeard(s) { if (this.heardEl) this.heardEl.setText(s ? `«${s}»` : ""); }

  /**
   * Hold the answer, show as much of it as the user asked for.
   * `spoken` is what the voice has actually reached — with the setting on,
   * the text unfolds in step with the speech rather than all at once.
   */
  setReply(full, spoken) {
    this._replyFull = full || "";
    this._replySpoken = spoken !== undefined ? spoken : (full || "");
    if (!full) this._replyOpen = false;
    this.paintReply();
  }

  paintReply() {
    if (!this.replyEl || !this.replyToggle) return;
    const has = !!this._replyFull;
    // Three states, in priority order: the setting wins, then an explicit
    // click, then the default — text trailing the voice instead of racing it.
    const always = this.plugin.settings.showReplyText;

    // The button is only honest while the voice is behind the text. With the
    // setting on it never is; once speaking has finished it no longer is
    // either, and "Show answer" under the answer it would show was the whole
    // complaint. Both cases are the same test: is anything still hidden.
    const hidden = this._replyFull !== this._replySpoken;
    const showToggle = has && !always && hidden;
    this.replyToggle.toggleClass("is-hidden", !showToggle);
    // Emptying it as well as hiding it, so a stale label can never flash
    // through on the next render before paintReply runs.
    this.replyToggle.setText(showToggle ? (this._replyOpen ? t("Hide answer") : t("Show answer")) : "");
    this.replyEl.setText(always || this._replyOpen ? this._replyFull : this._replySpoken);
  }

  /** Clicking the reactor starts a conversation, or cuts off a long answer. */
  onReactorClick() {
    if (this.phase === "speaking") { this.interrupted = true; this.plugin.speaker.stop(); return; }
    if (this.phase === "thinking" && this.agent) { this.agent.cancel(); this.setPhase("idle"); this.busy = false; return; }
    if (this.mode === "idle") this.toggleTalk();
  }

  /* ── confirmation, in the HUD, from the keyboard ───────── */
  askConfirm({ title, body, note, danger }) {
    this.plugin.speaker.stop();

    // Chat mode has no HUD to take over, so the question becomes a card in
    // the conversation — still answered with Enter or Esc.
    let card = null, yes, no;
    if (this.chat) {
      card = this.chat.el.createDiv({ cls: "oa-ask" + (danger ? " is-danger" : "") });
      card.createDiv({ cls: "oa-ask-title", text: title });
      card.createDiv({ cls: "oa-ask-body", text: body });
      if (note) card.createDiv({ cls: "oa-ask-note", text: note });
      card.createDiv({ cls: "oa-ask-keys",
        text: danger ? t("Press Enter to delete, Esc to keep it.") : t("Press Enter to apply, Esc to cancel.") });
      const row = card.createDiv({ cls: "oa-ask-row" });
      no = row.createEl("button", { text: t("Cancel") });
      yes = row.createEl("button", { cls: danger ? "mod-warning" : "mod-cta", text: danger ? t("Delete") : t("Save") });
      this.chat.scroll(true);
    } else {
      this.setPhase("confirm", title);
      this.setReply(body);
      this.confirmRow.classList.toggle("is-danger", !!danger);
      yes = this.yesBtn;
      no = this.noBtn;
    }

    return new Promise((resolve) => {
      const done = (answer) => {
        document.removeEventListener("keydown", onKey, true);
        yes.onclick = null;
        no.onclick = null;
        if (card) {
          card.addClass("is-answered");
          card.createDiv({ cls: "oa-ask-verdict", text: answer ? t("Confirmed") : t("Kept") });
        } else {
          this.setReply(answer ? "" : t("Cancelled"));
        }
        resolve(answer);
      };
      const onKey = (e) => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(true); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      };
      // Capture phase: the panel may not hold focus during a hands-free
      // session, and this key press must not reach the editor underneath.
      document.addEventListener("keydown", onKey, true);
      yes.onclick = () => done(true);
      no.onclick = () => done(false);
    });
  }

  /* ── turns ──────────────────────────────────────────────── */
  async sendTyped() {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    this.input.value = "";
    this.input.setCssStyles({ height: "auto" });
    if (this.chat) this.chat.user(text);
    else this.setHeard(text);
    // Typing means you are reading, so chat mode stays quiet unless you
    // press play on an answer.
    await this.turn(text, { speak: !this.chat && this.plugin.settings.voiceEnabled });
  }

  async turn(userText, { speak, scenario = null }) {
    if (!this.plugin.ai.isConfigured()) {
      new Notice(t("Set up the plugin first"));
      this.plugin.openSettings();
      return;
    }
    this.busy = true;

    // A scenario turns the two words you said into the brief they stand for.
    // Recognised here rather than by the model: it costs nothing and it means
    // the answer starts on the phrase, not after a round trip about it.
    const hit = scenario ? { scenario, rest: "" }
      : matchScenario(userText, this.plugin.settings.scenarios);
    const sent = hit ? scenarioPrompt(hit.scenario, hit.rest) : userText;

    // Both layouts run the same agent; they differ only in where progress
    // and the answer are shown.
    const inChat = !!this.chat;
    const slot = inChat ? this.chat.assistant() : null;
    if (inChat) { if (hit) slot.status(t("Scenario: {0}", scenarioLabel(hit.scenario))); }
    else {
      this.setReply("");
      this.setPhase("thinking", hit ? t("Scenario: {0}", scenarioLabel(hit.scenario)) : null);
    }

    // Fill the wait with something. Only while speaking is expected — in a
    // silent text session a hum out of nowhere would be baffling.
    const willSpeak = speak && this.plugin.settings.voiceEnabled;
    if (willSpeak && this.plugin.settings.waitingSound) this.plugin.ambience.start(this.plugin.settings.waitingVolume);

    // Note where the balance stood before anything is spent.
    // Not awaited: it reads the balance in the background and closeTurn picks
    // it up. Waiting here put half a second of silence before every answer.
    if (this.plugin.spend) this.plugin.spend.openTurn();

    this.agent = new Agent(this.plugin);
    // A long answer is fetched in rounds, and each round costs tens of seconds.
    // Speaking the finished part while the rest is still coming keeps the first
    // word where it was before answers were allowed to run long.
    const streaming = willSpeak && !inChat;
    const queue = streaming ? new SegmentQueue() : null;
    let reply = null;
    try {
      const running = this.agent.run(this.messages, sent, {
        onEvent: (ev) => {
          if (ev.kind !== "action") return;
          if (inChat) slot.status(ev.text);
          else this.setPhase("thinking", ev.text);
        },
        confirm: (opts) => this.askConfirm(opts),
        onSegment: queue ? (part) => queue.push(part) : null,
        // Only in text mode. In the reactor the answer is spoken, and text
        // racing ahead of the voice is the thing that was deliberately fixed.
        onDelta: inChat ? (_piece, whole) => slot.draft(whole) : null,
      });
      if (queue) {
        // However the run ends — answer, cancel or throw — the speaker must be
        // let go, or it waits on a queue nobody will ever push to again.
        running.then(() => queue.close(), () => queue.close());
        await this.speakStream(queue);
      }
      reply = await running;
    } catch (e) {
      console.error("[Elton AI]", e);
      this.plugin.ambience.stop();
      const msg = t("Something went wrong: {0}", e.message);
      if (inChat) slot.failed(msg); else this.setPhase("idle", msg);
      this.busy = false;
      return;
    }

    if (reply == null) {
      this.plugin.ambience.stop();
      if (inChat) slot.failed(t("Cancelled")); else this.setPhase("idle");
      this.busy = false;
      return;
    }

    // The expanded brief goes into the history, not the phrase that triggered
    // it: a follow-up question needs to see what was actually asked.
    this.messages.push({ role: "user", content: sent });
    this.messages.push({ role: "assistant", content: reply });
    if (this.messages.length > 20) this.messages = this.messages.slice(-20);

    // Close the books before the answer is drawn, so the cost line is part of
    // it rather than something that appears underneath a second later.
    let costLine = "";
    if (this.plugin.spend) {
      const spent = await this.plugin.spend.closeTurn();
      if (this.plugin.settings.showCost) costLine = this.plugin.spend.line(spent);
    }

    if (inChat) {
      await slot.content(reply, this.agent.sources, costLine);
    } else if (!streaming) {
      this.setReply(stripMarkdown(reply));
    }

    // When streaming, speakStream has already said it all.
    if (speak && !streaming) await this.speak(reply);
    else if (!speak) this.plugin.ambience.stop();
    if (!inChat) this.setPhase(this.mode === "conversation" ? "listening" : "idle");
    this.busy = false;
    if (this.plugin.settings.saveConversations) this.plugin.saveConversation(this.messages);
  }

  /**
   * Speak an answer that is still being written. Each segment is read aloud as
   * soon as it settles, so the wait for the rest happens behind the voice
   * rather than in front of it.
   */
  async speakStream(queue) {
    this.setPhase("speaking");
    this.interrupted = false;
    const fill = this.plugin.settings.waitingSound;
    let full = "";
    let said = "";

    for await (const segment of queue) {
      if (this.interrupted) break;
      const text = stripMarkdown(segment);
      if (!text) continue;
      full = full ? full + " " + text : text;
      this.setReply(full, said);

      await this.plugin.speaker.sayAll(speechChunks(text), {
        shouldStop: () => this.interrupted,
        onFirstSound: () => this.plugin.ambience.stop(),
        onChunk: (part) => {
          said = said ? said + " " + part : part;
          this.setReply(full, said);
        },
        onWaiting: () => { if (fill && !this.interrupted) this.plugin.ambience.start(this.plugin.settings.waitingVolume * 0.5); },
        onSpeaking: () => this.plugin.ambience.stop(),
      });
    }

    this.plugin.ambience.stop();
    // Interrupted or finished, the written answer can now stand in full.
    this.setReply(full, full);
  }

  async speak(raw) {
    this.setPhase("speaking");
    this.interrupted = false;
    const fill = this.plugin.settings.waitingSound;
    // The reactor shows plain text, not rendered markdown, so "**Про идею:**"
    // would be read out and printed with its asterisks. Strip once, and the
    // screen then matches what is actually being said.
    const text = stripMarkdown(raw);
    let said = "";
    await this.plugin.speaker.sayAll(speechChunks(text), {
      shouldStop: () => this.interrupted,
      onFirstSound: () => this.plugin.ambience.stop(),
      onChunk: (part) => {
        said = said ? said + " " + part : part;
        this.setReply(text, said);
      },
      // Mid-answer the next fragment can still be in flight. Carrying the
      // waiting sound across the gap keeps it sounding like one continuous
      // reply instead of a stall.
      onWaiting: () => { if (fill && !this.interrupted) this.plugin.ambience.start(this.plugin.settings.waitingVolume * 0.5); },
      onSpeaking: () => this.plugin.ambience.stop(),
    });
    this.plugin.ambience.stop();
    // Once it has finished talking there is nothing left to spoil, so the
    // whole answer can stand — including the part cut off by an interruption.
    this.setReply(text, text);
  }

  /* ── hands-free session ─────────────────────────────────── */
  async toggleTalk() {
    if (this.mode === "conversation") { this.teardown(); this.setPhase("idle"); return; }
    if (!this.plugin.ai.isConfigured()) {
      new Notice(t("Set up the plugin first"));
      this.plugin.openSettings();
      return;
    }
    if (!this.plugin.ai.hasCloud()) {
      new Notice(t("A local model can't transcribe speech or speak. Point this at a cloud key and voice keeps working while text stays local."), 8000);
      return;
    }
    this.mode = "conversation";
    this.talking = true;
    this.setPhase("listening");

    // Barge-in wants a second microphone stream open alongside the recorder's.
    // Desktop grants it; a phone hands the microphone to whoever asked last,
    // which quietly kills the recording you are speaking into. On top of that
    // a phone's speaker sits next to its microphone, so the assistant hears
    // itself and interrupts itself. Not a setting — a platform fact.
    if (this.plugin.settings.allowInterrupt && !isMobile()) {
      this.stopMonitor = await startBargeMonitor({
        isSpeaking: () => this.plugin.speaker.speaking,
        threshold: this.plugin.settings.interruptSensitivity,
        onInterrupt: () => {
          this.interrupted = true;
          this.plugin.speaker.stop();
          this.setPhase("listening", t("You interrupted"));
        },
      });
    }
    this.loop();
  }

  teardown() {
    this.mode = "idle";
    this.talking = false;
    this.interrupted = true;
    this.plugin.ambience.stop();
    if (this.agent) this.agent.cancel();
    this.plugin.speaker.stop();
    this.plugin.recorder.stop();
    if (this.stopMonitor) { this.stopMonitor(); this.stopMonitor = null; }
    if (this._io) { this._io.disconnect(); this._io = null; }
    if (this._onVis) { document.removeEventListener("visibilitychange", this._onVis); this._onVis = null; }
  }

  async loop() {
    const push = this.plugin.settings.micMode === "push";
    while (this.talking) {
      try {
        this.setPhase("listening", push ? t("Hold to talk") : null);
        const { blob, format, hadSpeech } = await this.plugin.recorder.record({
          maxMs: push ? 60000 : 20000,
          getStop: () => !this.talking,
          pushToTalk: push,
          isPressed: () => this.pressed,
          // Feeding level into the core is what makes the reactor feel alive
          // instead of decorative.
          onLevel: (lv) => this.reactor && this.reactor.setCssProps({ "--lvl": String(Math.min(1, lv / 45)) }),
        });
        if (this.reactor) this.reactor.setCssProps({ "--lvl": "0" });
        if (!this.talking) break;
        if (!hadSpeech) { await wait(150); continue; }

        this.setPhase("thinking");
        const b64 = await blobToBase64(blob);
        let text = "";
        try { text = await this.plugin.ai.transcribe(b64, format); }
        catch (e) { new Notice(t("Something went wrong: {0}", e.message)); break; }
        if (!text || text.length < 2) { this.setPhase("listening", t("Didn't catch that")); await wait(600); continue; }

        this.setHeard(text);
        await this.turn(text, { speak: this.plugin.settings.voiceEnabled });
      } catch (e) {
        console.error("[Elton AI] loop", e);
        new Notice(t("Microphone unavailable: {0}", e.message));
        break;
      }
    }
    this.teardown();
    this.setPhase("idle");
  }
}
