/* ============================================================
 *  Scenarios
 *
 *  A saved brief hiding behind a short phrase. Say "мысли" and the
 *  model does not have to work out what that meant — the phrase is
 *  recognised here, locally, and the full brief goes out in its
 *  place. No extra round trip, no intent-detection call: a scenario
 *  fires in the time it takes to compare two strings, so the answer
 *  starts while you still expect it to.
 *
 *  Matching is deliberately conservative, because a scenario that
 *  fires when you didn't mean it is worse than one you have to say
 *  twice. A one-word trigger only counts when it is the entire
 *  utterance; a trigger of two words or more may also be found
 *  inside a longer sentence.
 * ========================================================== */

let _scenSeq = 0;
function scenarioId() {
  return "scen-" + Date.now().toString(36) + "-" + (_scenSeq++).toString(36);
}

/** The ready-made scenarios offered in settings, localised on the spot. */
function scenarioPresets() {
  return {
    thoughts: {
      emoji: "💭",
      name: t("What I was thinking"),
      triggers: t("thoughts, what was I thinking, recent thoughts"),
      prompt: t("Go through my daily notes and everything I wrote over the last few days. Tell me what I was actually thinking about: the ideas that came up, the questions I left hanging, the threads I started and dropped. Pick the two or three that matter most and tell them as one connected story rather than a list. Only what is genuinely in my notes — do not fill the gaps."),
    },
    today: {
      emoji: "📅",
      name: t("What's on today"),
      triggers: t("what's on today, plan for today"),
      prompt: t("Look at today's daily note and my most recent notes. Tell me what is planned for today, what is still open from yesterday, and what deserves my attention first. Short and concrete — no encouragement, no padding."),
    },
    wrapup: {
      emoji: "🌙",
      name: t("Wrap up the day"),
      triggers: t("wrap up the day, sum up the day"),
      prompt: t("Look at today's daily note and the notes I touched today. Sum the day up: what I did, what came of it, what I left unfinished. Then ask me one question worth answering before I close the vault."),
    },
    explain: {
      emoji: "📖",
      name: t("Explain this note"),
      triggers: t("explain this, retell this note"),
      prompt: t("Take the note that is open on my screen and explain it out loud, simply, as if I had not read it. The point of it in one sentence first, then the parts that actually matter. If something in it is unclear, thin or unfinished, say so plainly."),
    },
    links: {
      emoji: "🔗",
      name: t("Find connections"),
      triggers: t("find connections, what is this connected to"),
      prompt: t("Take the note that is open on my screen, then search my vault for other notes that touch the same ideas — including ones that use different words for it. Tell me what connects them and what I seem to have missed myself."),
    },
    /* The five below are the habits people actually run a vault on — the
       weekly review, the inbox, the loose ends — rather than things that
       sound clever in a feature list. Each one names what it may not do,
       because the failure mode of all of them is a confident summary of
       notes that do not exist. */
    week: {
      emoji: "📊",
      name: t("The week in review"),
      triggers: t("the week, how was my week, weekly review"),
      prompt: t("Go through my daily notes and everything I wrote in the last seven days. Tell me how the week actually went: what I spent it on, what moved, what stalled, and what came up more than once without my noticing. End with the one thing worth carrying into next week. Only what is in my notes — if a day is empty, say it is empty."),
    },
    inbox: {
      emoji: "📥",
      name: t("Sort out the inbox"),
      triggers: t("the inbox, sort the inbox, what's in my inbox"),
      prompt: t("Look in my inbox folder and at the notes I have not filed anywhere. Go through them and tell me, in order: what can be thrown away, what is already finished and just needs putting somewhere, and what is a real idea that deserves a note of its own. Do not move or delete anything — tell me, and I will decide."),
    },
    loose: {
      emoji: "🧵",
      name: t("Loose ends"),
      triggers: t("loose ends, what did I leave unfinished, what did I forget"),
      prompt: t("Search my recent notes for things I started and never closed: tasks with no follow-up, questions I asked myself and never answered, notes that stop mid-thought. List them shortest-first, each with where it came from and what the next step would be. Nothing invented — only what is genuinely left hanging."),
    },
    quiz: {
      emoji: "🎓",
      name: t("Test me"),
      triggers: t("test me, quiz me, check what I remember"),
      prompt: t("Take the note on my screen — or, if there is none, whatever I have been writing about lately — and test whether I actually understood it. Ask me ONE question and stop. Wait for my answer, say plainly whether it was right, add what I missed, and only then ask the next one. Questions about the meaning, not about the wording."),
    },
    forgotten: {
      emoji: "🕸",
      name: t("What I've forgotten"),
      triggers: t("what have I forgotten, forgotten notes, old notes"),
      prompt: t("Find notes I have not touched in a long time that are about what I am working on now. For each one say what is in it and why it is worth reopening today. I am looking for the thing I wrote once and lost, not a list of old files."),
    },
    draft: {
      emoji: "✍️",
      name: t("Draft it out"),
      triggers: t("draft it out, put together a draft, collect the material"),
      prompt: t("I want to write something on the subject I am about to name. Search my vault for everything I have already said about it — including notes that use other words for it — and lay it out as a draft: what I already think, in what order it holds together, and where the holes are that I have nothing on yet. My own material only; the gaps stay gaps."),
    },
    custom: {
      emoji: "✨",
      name: t("Custom scenario"),
      triggers: "",
      prompt: "",
    },
  };
}

/** A fresh scenario from a preset, with its own id. */
function newScenario(presetId) {
  const p = scenarioPresets()[presetId] || scenarioPresets().custom;
  return {
    id: scenarioId(),
    enabled: true,
    pin: true,
    emoji: p.emoji || "✨",
    name: p.name,
    triggers: p.triggers || "",
    prompt: p.prompt || "",
  };
}

/** The scenarios a first-run vault starts with, so the feature is visible. */
function defaultScenarios() {
  return ["thoughts", "today", "explain"].map(newScenario);
}

/**
 * Spoken text reduced to something two phrasings of the same thing can share:
 * case, punctuation and the ё/е distinction all survive transcription
 * inconsistently, and none of them change what was meant.
 */
function normalizePhrase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which scenario, if any, the user just asked for.
 *
 * Returns `{ scenario, rest }` — `rest` being whatever they said around the
 * trigger, which is passed on as extra context. The longest matching trigger
 * wins, so a specific phrase beats a generic one that happens to sit inside it.
 */
function matchScenario(text, list) {
  const said = normalizePhrase(text);
  if (!said || !Array.isArray(list)) return null;

  let best = null;
  for (const sc of list) {
    if (!sc || !sc.enabled || !sc.prompt) continue;
    for (const raw of String(sc.triggers || "").split(",")) {
      const trigger = normalizePhrase(raw);
      if (!trigger) continue;
      const words = trigger.split(" ").length;

      // The whole utterance is the trigger — always a match, however short.
      if (said === trigger) {
        if (!best || best.score < 1000 + trigger.length) best = { sc, trigger, score: 1000 + trigger.length, rest: "" };
        continue;
      }
      // A single word is too easy to say by accident ("запиши мои мысли о
      // проекте" is not a request for the thoughts scenario), so it needs the
      // exact match above and nothing else.
      if (words < 2) continue;

      const at = said.indexOf(trigger);
      if (at < 0) continue;
      // Only on word boundaries, or "связи" would match inside "связистов".
      const before = at === 0 || said[at - 1] === " ";
      const after = at + trigger.length === said.length || said[at + trigger.length] === " ";
      if (!before || !after) continue;

      // Leading the sentence reads as a command; buried in it, as a mention.
      const score = (at === 0 ? 500 : 100) + trigger.length;
      if (!best || best.score < score) {
        const rest = (said.slice(0, at) + " " + said.slice(at + trigger.length)).replace(/\s+/g, " ").trim();
        best = { sc, trigger, score, rest };
      }
    }
  }
  return best ? { scenario: best.sc, rest: best.rest } : null;
}

/** The brief that actually goes to the model, plus anything else they said. */
function scenarioPrompt(sc, rest) {
  const brief = String(sc.prompt || "").trim();
  const extra = String(rest || "").trim();
  // Two words of filler ("ну", "давай") are noise, not instruction.
  if (extra.length < 4) return brief;
  return brief + "\n\n" + t("The user also said: \"{0}\". Take it into account.", extra);
}

/** The scenarios worth putting on screen as a button. */
function pinnedScenarios(settings) {
  return (settings.scenarios || []).filter((x) => x && x.enabled && x.pin && x.prompt);
}

function scenarioLabel(sc) {
  return `${sc.emoji || "✨"} ${sc.name || t("Custom scenario")}`.trim();
}

/* ============================================================
 *  The editor
 *
 *  A window, not a card that unfolds in the settings page.
 *
 *  Folded cards meant a list where every row could become half a
 *  screen of form, and the page then looked like three nested
 *  boxes with a form loose inside them. A scenario is a small
 *  document — a name, the phrases that call it, and a brief you
 *  actually want room to write — so it gets a window of its own,
 *  and the list stays a list.
 * ========================================================== */
class ScenarioEditModal extends Modal {
  constructor(app, plugin, scenario, onSave) {
    super(app);
    this.plugin = plugin;
    this.sc = scenario;
    this.onSave = onSave;
    // Edited on a copy: closing with Esc has to leave the original alone.
    this.draft = Object.assign({}, scenario);
  }

  onOpen() {
    this.modalEl.addClass("oa-scen-edit");
    const c = this.contentEl;
    c.empty();
    c.createEl("h3", { text: this.draft.name || t("Custom scenario") });

    const d = this.draft;

    new Setting(c)
      .setName(t("Name"))
      .setDesc(t("What it is called on the button and in the bot's menu."))
      .addText((tx) => {
        tx.inputEl.addClass("oa-emoji-input");
        tx.setPlaceholder("✨").setValue(d.emoji || "").onChange((v) => { d.emoji = v.trim().slice(0, 4); });
      })
      .addText((tx) => tx.setValue(d.name || "").onChange((v) => { d.name = v; }));

    new Setting(c)
      .setName(t("Trigger phrases"))
      .setDesc(t("Separated by commas. Say any of them and this scenario runs."))
      .addText((tx) => {
        tx.inputEl.addClass("oa-wide-input");
        tx.setValue(d.triggers || "").onChange((v) => { d.triggers = v; });
      });

    const brief = new Setting(c)
      .setName(t("What it asks for"))
      .setDesc(t("The brief the assistant actually receives. Write it as if you were asking in full."));
    brief.settingEl.addClass("oa-scen-brief");
    brief.addTextArea((ta) => {
      ta.inputEl.addClass("oa-auto-prompt");
      ta.inputEl.rows = 10;
      ta.setValue(d.prompt || "").onChange((v) => { d.prompt = v; });
    });

    new Setting(c)
      .setName(t("Show as a button"))
      .setDesc(t("Puts it under the reactor and in an empty chat, for the days you would rather tap than talk."))
      .addToggle((x) => x.setValue(d.pin !== false).onChange((v) => { d.pin = v; }));

    // Only where it means something. Telling someone their scenario has a
    // Telegram command when they have no bot is noise.
    if (this.plugin.telegram && this.plugin.telegram.configured()) {
      const cmd = slugForCommand(d.name || "");
      if (cmd) c.createDiv({ cls: "oa-note", text: t("In Telegram this scenario answers to /{0}", cmd) });
    }

    const row = c.createDiv({ cls: "oa-modal-buttons" });
    const cancel = row.createEl("button", { text: t("Cancel") });
    cancel.onclick = () => this.close();
    const save = row.createEl("button", { cls: "mod-cta", text: t("Save") });
    save.onclick = async () => {
      Object.assign(this.sc, d);
      await this.plugin.saveSettings();
      this.plugin.refreshViews();
      this.close();
      if (this.onSave) this.onSave();
    };
  }

  onClose() { this.contentEl.empty(); }
}

/* ============================================================
 *  The picker
 *
 *  One command rather than one command per scenario: the list is
 *  edited in settings and commands cannot be unregistered cleanly,
 *  so a palette full of stale entries is the alternative.
 * ========================================================== */
class ScenarioPickerModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("oa-scen-picker");
    contentEl.createEl("h3", { text: t("Run a scenario") });

    const list = (this.plugin.settings.scenarios || []).filter((x) => x && x.enabled && x.prompt);
    if (!list.length) {
      contentEl.createDiv({ cls: "oa-note", text: t("No scenarios yet. Add one in settings.") });
      return;
    }

    for (const sc of list) {
      const row = contentEl.createEl("button", { cls: "oa-scen-item" });
      row.createSpan({ cls: "oa-scen-item-emoji", text: sc.emoji || "✨" });
      const body = row.createDiv({ cls: "oa-scen-item-body" });
      body.createDiv({ cls: "oa-scen-item-name", text: sc.name || t("Custom scenario") });
      if (sc.triggers) body.createDiv({ cls: "oa-scen-item-trig", text: sc.triggers });
      row.onclick = async () => {
        this.close();
        const view = await this.plugin.activateView();
        if (view) view.runScenario(sc);
      };
    }
  }

  onClose() { this.contentEl.empty(); }
}
