/* ============================================================
 *  Chat mode
 *
 *  The reactor is built for talking; this is built for reading.
 *  Same agent, same tools, same permissions underneath — only the
 *  surface differs, and the toggle lives in the panel header so
 *  switching is one click mid-conversation.
 *
 *  Bubbles, the copy button, the animated "thinking" line and the
 *  source list all follow the pattern already proven in the
 *  Explainator script, so the two feel like one family.
 * ========================================================== */

/* The copy button used to carry its two Lucide glyphs as markup and hand them
   to innerHTML. Obsidian ships the same icons, so setIcon draws them without
   the plugin ever writing HTML into the document. */

/** One message pair's worth of DOM, with the controls that hang off it. */
class ChatLog {
  constructor(view, el) {
    this.view = view;
    this.el = el;
  }

  clear() { this.el.empty(); }

  atBottom() {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 60;
  }

  scroll(force) {
    // Only follow the conversation if the reader is already at the bottom —
    // yanking the view down while they are reading older text is hostile.
    if (force || this.atBottom()) this.el.scrollTop = this.el.scrollHeight;
  }

  empty(configured) {
    const box = this.el.createDiv({ cls: "oa-chat-empty" });
    const ic = box.createDiv({ cls: "oa-chat-empty-icon" });
    setIcon(ic, configured ? "message-circle" : "settings");
    box.createDiv({ cls: "oa-chat-empty-title",
      text: configured ? t("Ask me anything about your notes") : t("Set up the plugin first") });
    box.createDiv({ cls: "oa-chat-empty-sub",
      text: configured ? t("I search your vault and answer from it. Switch to the reactor any time to talk instead.")
                       : t("Add a provider and a key in settings, then we can start.") });
    if (!configured) {
      const b = box.createEl("button", { cls: "mod-cta", text: t("Open settings") });
      b.onclick = () => this.view.plugin.openSettings();
      return;
    }
    // The scenarios double as the answer to "what do I even ask it" — the
    // question every empty chat window poses and few of them answer.
    const pinned = pinnedScenarios(this.view.plugin.settings).slice(0, 6);
    if (!pinned.length) return;
    // Wrapping here, unlike under the reactor: an empty chat is mostly space,
    // and this is the one place the chips are meant to be read as a menu.
    const row = box.createDiv({ cls: "oa-scen-row is-wrap" });
    for (const sc of pinned) {
      const chip = row.createEl("button", { cls: "oa-scen-chip" });
      chip.createSpan({ cls: "oa-scen-chip-emoji", text: sc.emoji || "✨" });
      chip.createSpan({ cls: "oa-scen-chip-name", text: sc.name || t("Custom scenario") });
      chip.onclick = () => this.view.runScenario(sc);
    }
  }

  user(text) {
    const e = this.el.querySelector(".oa-chat-empty");
    if (e) e.remove();
    const msg = this.el.createDiv({ cls: "oa-bubble oa-bubble-user oa-bubble-in" });
    msg.createDiv({ text });
    this.scroll(true);
    return msg;
  }

  /** The assistant's side: a bubble that starts as a thinking indicator. */
  assistant() {
    const e = this.el.querySelector(".oa-chat-empty");
    if (e) e.remove();
    const group = this.el.createDiv({ cls: "oa-bubble-group oa-bubble-in" });
    const bubble = group.createDiv({ cls: "oa-bubble oa-bubble-ai" });
    const actions = group.createDiv({ cls: "oa-bubble-actions" });
    this.scroll(true);

    let text = "";
    const view = this.view;

    const thinking = (status) => {
      bubble.empty();
      actions.empty();
      const ind = bubble.createDiv({ cls: "oa-typing" });
      const dots = ind.createDiv({ cls: "oa-typing-dots" });
      for (let i = 0; i < 3; i++) dots.createDiv({ cls: "oa-typing-dot" });
      ind.createSpan({ cls: "oa-typing-text", text: status || t("Thinking…") });
      this.scroll();
    };

    const status = (s) => {
      const el = bubble.querySelector(".oa-typing-text");
      if (!el) return;
      el.textContent = s;
      // Restart the fade so a changed status reads as a new step, not a typo.
      el.classList.remove("oa-typing-text");
      void el.offsetWidth;
      el.classList.add("oa-typing-text");
    };

    /**
     * The answer so far, while it is still arriving.
     *
     * Plain text, not rendered markdown: half a fenced block or an unclosed
     * bold marker renders as garbage that then rearranges itself on the next
     * token. The finished answer is rendered properly a moment later.
     */
    const draft = (text) => {
      if (!text) { thinking(); return; }
      bubble.empty();
      actions.empty();
      const el = bubble.createDiv({ cls: "oa-draft" });
      el.setText(text);
      this.scroll();
    };

    const content = async (md, sources, costLine) => {
      text = md;
      bubble.empty();
      actions.empty();
      const body = bubble.createDiv({ cls: "oa-md" });
      await MarkdownRenderer.render(view.app, md, body, "", view.plugin);

      // A footnote, in the muted colour reserved for things you may ignore.
      if (costLine) bubble.createDiv({ cls: "oa-cost", text: costLine });

      if (sources && sources.length) {
        const src = bubble.createDiv({ cls: "oa-sources" });
        src.createSpan({ text: "📚 " + t("Sources: ") });
        sources.forEach((n, i) => {
          const link = src.createSpan({ cls: "oa-source-link", text: n.title });
          link.onclick = () => {
            const f = view.app.vault.getAbstractFileByPath(n.path);
            if (f instanceof TFile) view.app.workspace.getLeaf(false).openFile(f);
          };
          if (i < sources.length - 1) src.createSpan({ text: ", " });
        });
      }

      const copy = actions.createEl("button", { cls: "oa-bubble-btn" });
      const label = (icon, txt) => { copy.empty(); setIcon(copy, icon); copy.createSpan({ text: txt }); };
      label("copy", t("Copy"));
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(text);
          label("check", t("Copied"));
          copy.addClass("is-done");
          window.setTimeout(() => { label("copy", t("Copy")); copy.removeClass("is-done"); }, 1300);
        } catch { new Notice(t("Could not copy")); }
      };

      // Reading the answer aloud is optional here — this is the mode you
      // pick when you would rather read than listen.
      if (view.plugin.settings.voiceEnabled) {
        const play = actions.createEl("button", { cls: "oa-bubble-btn oa-play" });
        setIcon(play, "volume-2");
        play.createSpan({ text: t("Read aloud") });
        // Keep the whole row visible while it reads, or the control you need
        // to stop it fades out the moment the pointer leaves.
        play.onclick = () => {
          actions.toggleClass("is-pinned", !play.hasClass("is-playing"));
          view.speakText(text, play).finally(() => actions.removeClass("is-pinned"));
        };
      }

      this.scroll();
    };

    const failed = (message) => {
      bubble.empty();
      actions.empty();
      bubble.addClass("is-error");
      bubble.createDiv({ text: message });
      this.scroll();
    };

    thinking();
    return { thinking, status, draft, content, failed, bubble };
  }
}
