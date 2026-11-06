/* ============================================================
 *  Onboarding (4.0)
 *
 *  The first run as a short welcome, in the shape Book Reader
 *  uses: one screen, one idea, a big mark and a few lines, the
 *  same height on every step so nothing jumps, and the content
 *  sitting in the middle of the card rather than pinned to its
 *  top edge with a hole underneath.
 *
 *  Three of the screens do something — connect the AI, say who
 *  you are, choose how far it may reach — and write straight to
 *  settings, so leaving halfway still leaves progress behind.
 * ========================================================== */

/* Complaints, ideas and "it does not work" — one Telegram bot, the same
   way Book Reader does it. No GitHub account, no form. */
const FEEDBACK_URL = "https://t.me/elton_feedback_bot";
function openFeedback() { window.open(FEEDBACK_URL); }

/* Three levels of access instead of five switches. Each is a full set, so
   picking one never leaves a combination nobody chose. */
const ACCESS_PRESETS = {
  read: { canRead: true, canCreate: false, canEdit: false, canDelete: false, canControlUI: false },
  write: { canRead: true, canCreate: true, canEdit: true, canDelete: false, canControlUI: true },
  full: { canRead: true, canCreate: true, canEdit: true, canDelete: true, canControlUI: true },
};

/** The first sentence of a brief, short enough for a card. */
function firstSentence(text) {
  // No lookbehind: Safari before 16.4 — Obsidian on older iPhones — cannot parse it.
  const m = String(text || "").match(/^[\s\S]*?[.!?](?=\s|$)/);
  const one = (m ? m[0] : String(text || "")).trim();
  return one.length > 110 ? one.slice(0, 107).replace(/\s+\S*$/, "") + "…" : one;
}

function accessPreset(s) {
  for (const [id, p] of Object.entries(ACCESS_PRESETS)) {
    if (Object.entries(p).every(([k, v]) => !!s[k] === v)) return id;
  }
  return "custom";
}

function applyAccessPreset(s, id) {
  const p = ACCESS_PRESETS[id];
  if (!p) return;
  Object.assign(s, p);
}

/** Three cards to choose from — used here and on the Access tab. */
function accessCards(c, s, onPick) {
  const now = accessPreset(s);
  const box = c.createDiv({ cls: "oa-presets" });
  const card = (id, icon, name, desc) => {
    const el = clickable(box.createDiv({ cls: "oa-preset" + (now === id ? " is-on" : "") }));
    const ic = el.createDiv({ cls: "oa-preset-icon" });
    setIcon(ic, icon);
    const body = el.createDiv({ cls: "oa-preset-body" });
    body.createDiv({ cls: "oa-preset-name", text: name });
    body.createDiv({ cls: "oa-preset-desc", text: desc });
    el.createDiv({ cls: "oa-preset-check" });
    el.onclick = () => onPick(id);
  };
  card("read", "eye", t("Read only"),
    t("Searches and answers from your notes. Changes nothing — not a word."));
  card("write", "pencil", t("Read and write"),
    t("Also writes new notes and edits existing ones. Every change is saved first and can be undone with one tap, from the computer or the phone."));
  card("full", "shield-check", t("Full access"),
    t("Also deletes and arranges tabs. Deleting always stops and asks you — from the phone or Telegram it never deletes at all."));
  if (now === "custom") {
    box.createDiv({ cls: "oa-preset-custom", text: t("Right now: your own combination — see Advanced below.") });
  }
  return box;
}

/** Folders chosen as chips, added from a list of the real ones. */
function folderChips(c, app, get, set, emptyText) {
  const wrap = c.createDiv({ cls: "oa-chips" });
  const paint = () => {
    wrap.empty();
    const list = get();
    if (!list.length && emptyText) wrap.createSpan({ cls: "oa-chips-empty", text: emptyText });
    for (const f of list) {
      const chip = wrap.createSpan({ cls: "oa-fchip" });
      const ic = chip.createSpan({ cls: "oa-fchip-icon" });
      setIcon(ic, "folder-lock");
      chip.createSpan({ text: f });
      const x = chip.createEl("button", { cls: "oa-fchip-x", attr: { "aria-label": t("Remove") } });
      setIcon(x, "x");
      x.onclick = async () => { await set(list.filter((y) => y !== f)); paint(); };
    }
    const add = wrap.createEl("button", { cls: "oa-fchip-add" });
    setIcon(add.createSpan(), "plus");
    add.createSpan({ text: t("Add a folder") });
    add.onclick = () => new FolderPickModal(app, async (path) => {
      if (!path || get().includes(path)) return;
      await set(get().concat([path]));
      paint();
    }).open();
  };
  paint();
  return wrap;
}

/** Pick a real folder by typing a few letters of it. */
// Fallback base only matters in the test harness, which has no fuzzy modal.
const FuzzyBase = obsidian.FuzzySuggestModal || Modal;
class FolderPickModal extends FuzzyBase {
  constructor(app, onPick) {
    super(app);
    this.onPick = onPick;
    this.setPlaceholder(t("Start typing a folder name…"));
  }
  getItems() { return allFolders(this.app).filter(Boolean); }
  getItemText(item) { return item; }
  onChooseItem(item) { this.onPick(item); }
}

class OnboardingModal extends Modal {
  /** `start` — a screen's id, to open the welcome on that screen. */
  constructor(app, plugin, start) {
    super(app);
    this.plugin = plugin;
    this.idx = 0;
    if (start) {
      const i = this.slides.findIndex((x) => x.id === start);
      if (i >= 0) this.idx = i;
    }
  }

  get s() { return this.plugin.settings; }

  onOpen() {
    this.modalEl.addClass("oa-onb-modal");
    this.scope.register([], "ArrowRight", (e) => {
      if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      e.preventDefault(); this.go(1);
    });
    this.scope.register([], "ArrowLeft", (e) => {
      if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      e.preventDefault(); this.go(-1);
    });
    this.draw();
  }

  onClose() {
    if (!this.s.onboarded) { this.s.onboarded = true; this.plugin.saveSettings(); }
    this.contentEl.empty();
  }

  go(dir) {
    const n = this.idx + dir;
    if (n < 0 || n >= this.slides.length) return;
    this.idx = n;
    this.plugin.saveSettings();
    this.draw();
  }

  get slides() {
    return [
      {
        emoji: "👋",
        title: t("Hi! This is Elton AI"),
        body: [
          t("An assistant that lives inside your vault. Ask it something and it searches your own notes and answers from them; ask it to write and it files a proper note — in the right folder, from your own template."),
          t("By voice or by text, here in Obsidian, from your phone or from Telegram — it is the same assistant, and it remembers the conversation."),
        ],
        render: (c) => this.uses(c),
      },
      {
        emoji: "🔌",
        title: t("Connect the brains"),
        body: [t("Pick where answers come from and paste a key. The key stays in this vault, on this device.")],
        render: (c) => this.provider(c),
      },
      {
        emoji: "🙂",
        title: t("Introduce yourselves"),
        body: [t("What it is called and what to call you. Both can be changed any time.")],
        render: (c) => this.names(c),
      },
      {
        emoji: "🛡️",
        title: t("How far it may reach"),
        body: [t("Choose one. Folders you mark private are never read, never searched and never sent anywhere — whatever you pick here.")],
        render: (c) => this.access(c),
      },
      {
        /* Its own screen, because it was the most asked question there is:
           "how do I make it answer from my notes?" The switch sat in a tile
           on the Access tab, and people who never found it decided the
           assistant was dumb. Everyone passes through here now. */
        id: "search",
        emoji: "🧠",
        title: t("Answers from your own notes"),
        body: [
          t("To answer about your notes it first has to find the right ones. Search by words works straight away — but finds only notes that contain the words you used."),
          t("Search by meaning finds a note however you put it: ask about «burnout» and «I have nothing left in the tank» comes up. For that each note is read once and given a fingerprint of its meaning — that is what indexing is."),
        ],
        render: (c) => this.search(c),
      },
      {
        emoji: "🗂️",
        title: t("It has looked around"),
        body: [t("So that a new note lands where yours do and looks like yours, it needs three places. Here is what it found — correct anything that is wrong.")],
        render: (c) => this.places(c),
      },
      {
        emoji: "📱",
        title: t("Your vault in your pocket"),
        body: [
          t("The Elton AI app on your phone: a feed of your own notes, your folders exactly as here, and the same assistant in a chat. It installs straight from the browser — no app store."),
          t("Your notes stay on this computer: the phone asks, the computer answers, and everything in between is end-to-end encrypted. You can turn it on now or later on the Phone tab."),
        ],
        render: (c) => this.phone(c),
      },
      {
        emoji: "✨",
        title: t("All set"),
        body: [
          t("Open the assistant from the ribbon on the left or with the command «Elton AI: open». Try: «what did I write about sleep?», «take down a thought», «what is on my plate today?»."),
          t("Everything you chose is on the Home tab of the settings, and this welcome is one click away there too."),
          t("Something not working, or an idea? Write to @elton_feedback_bot in Telegram — the link is on the Home tab too."),
        ],
        render: null,
      },
    ];
  }

  draw() {
    const c = this.contentEl;
    // Choosing a provider redraws this screen with the fields it needs — the
    // same screen, so the place is kept. A new screen starts at the top.
    const back = keepScroll(c);
    const same = this.idx === this._drawn;
    this._drawn = this.idx;
    c.empty();
    const list = this.slides;
    const s = list[this.idx];
    const last = this.idx === list.length - 1;

    const card = c.createDiv({ cls: "oa-onb-card oa-onb-anim" });
    const hero = card.createDiv({ cls: "oa-onb-hero" });
    hero.createDiv({ cls: "oa-onb-emoji", text: s.emoji });
    hero.createDiv({ cls: "oa-onb-title", text: s.title });
    const body = hero.createDiv({ cls: "oa-onb-body" });
    s.body.forEach((p) => body.createEl("p", { text: p }));
    if (s.render) s.render(card.createDiv({ cls: "oa-onb-form" }));

    const dots = c.createDiv({ cls: "oa-onb-dots" });
    list.forEach((_, i) => {
      const d = dots.createDiv({ cls: "oa-onb-dot" + (i === this.idx ? " is-on" : "") });
      d.setAttr("aria-label", t("Step {0}", i + 1));
      d.onclick = () => { this.idx = i; this.draw(); };
    });

    const nav = c.createDiv({ cls: "oa-onb-nav" });
    const prev = nav.createEl("button", { cls: "oa-onb-prev", text: "‹ " + t("Back") });
    prev.disabled = this.idx === 0;
    prev.onclick = () => this.go(-1);
    nav.createDiv({ cls: "oa-onb-counter", text: `${this.idx + 1} / ${list.length}` });
    const next = nav.createEl("button", { cls: "mod-cta oa-onb-next", text: last ? t("Open the assistant") : t("Next") + " ›" });
    next.onclick = async () => {
      if (!last) { this.go(1); return; }
      this.s.onboarded = true;
      await this.plugin.saveSettings();
      this.close();
      this.plugin.activateView();
    };

    const skip = c.createDiv({ cls: "oa-onb-skip" });
    if (!last) {
      skip.setText(t("Skip"));
      skip.onclick = () => this.close();
    }
    // Inside the card, not under the buttons: a line below them on one screen
    // only moved Next up on that screen, and the thumb missed it on the next.
    if (this.idx === 0) {
      card.createDiv({ cls: "oa-onb-later", text: t("This welcome can be opened again any time: Settings → Elton AI → Home.") });
    }
    if (same) back();
  }

  /* ── screen 1: what it does, in five lines ─────────────────── */
  uses(c) {
    const box = c.createDiv({ cls: "oa-uses" });
    const row = (icon, text) => {
      const r = box.createDiv({ cls: "oa-use" });
      setIcon(r.createSpan({ cls: "oa-use-icon" }), icon);
      r.createSpan({ text });
    };
    row("message-circle", t("Answers about your notes — and about the world, joined to your notes"));
    row("pen-line", t("Writes notes, lists and boards from your templates"));
    row("mic", t("Listens and speaks — hold a key and talk"));
    row("smartphone", t("A phone app with a feed and folders, and a Telegram bot"));
    row("undo-2", t("Every change it makes can be undone"));
  }

  /* ── the search screen: words only, or meaning too ───────────── */
  search(c) {
    const s = this.s;
    const R = this.plugin.index;
    const V = this.plugin.vault;
    const box = c.createDiv({ cls: "oa-presets" });
    const card = (on, icon, name, desc, pick) => {
      const el = clickable(box.createDiv({ cls: "oa-preset" + (on ? " is-on" : "") }));
      setIcon(el.createDiv({ cls: "oa-preset-icon" }), icon);
      const body = el.createDiv({ cls: "oa-preset-body" });
      body.createDiv({ cls: "oa-preset-name", text: name });
      body.createDiv({ cls: "oa-preset-desc", text: desc });
      el.createDiv({ cls: "oa-preset-check" });
      el.onclick = async () => { s.semanticSearch = pick; await this.plugin.saveSettings(); this.draw(); };
    };
    card(!!s.semanticSearch, "sparkles", t("By meaning too (recommended)"),
      t("A one-time pass over your notes, a fraction of a cent each. After that only the notes you change are redone — by themselves."), true);
    card(!s.semanticSearch, "type", t("By words only"),
      t("Free and instant. You can switch meaning on later: Settings → Elton AI → Access → Search and the web."), false);
    if (!s.semanticSearch) return;

    const run = c.createDiv({ cls: "oa-onb-index" });
    const line = run.createDiv({ cls: "oa-onb-index-line" });
    const track = run.createDiv({ cls: "oa-onb-bar" });
    const fill = track.createDiv({ cls: "oa-onb-bar-fill" });
    const row = run.createDiv({ cls: "oa-onb-index-row" });
    const note = row.createDiv({ cls: "oa-onb-index-note" });
    const btn = row.createEl("button", { cls: "mod-cta" });
    const paint = async () => {
      if (!run.isConnected) return false;
      if (R.running) {
        line.setText(R.total ? t("Indexing… {0}/{1}", R.done, R.total) : t("Indexing…"));
        fill.style.width = (R.total ? Math.max(3, Math.round(100 * R.done / R.total)) : 3) + "%";
        btn.setText(t("Stop"));
        btn.disabled = false;
        note.setText(t("Carry on with the next step — it works in the background. Stopped or interrupted, it picks up where it left off."));
        return true;
      }
      const n = await V.indexSize();
      const est = await V.indexEstimate();
      if (!run.isConnected) return false;
      if (!est.notes) {
        line.setText(n ? t("{0} notes in the index", n) : t("Nothing to index yet"));
        fill.style.width = "100%";
        btn.setText(t("Everything is indexed"));
        btn.disabled = true;
        note.setText(t("New and changed notes are added by themselves."));
      } else {
        line.setText(n ? t("{0} indexed, {1} to go", n, est.notes) : t("{0} notes · about {1} min", est.notes, est.minutes));
        fill.style.width = (n ? Math.round(100 * n / (n + est.notes)) : 0) + "%";
        btn.setText(n ? t("Continue") : t("Index now"));
        btn.disabled = false;
        note.setText(t("Private folders are never indexed and never sent."));
      }
      const r = R.last;
      if (r && r.failed && !r.embedded) {
        note.setText(t("Nothing could be indexed — every request was refused. The provider said: {0}. Check the embedding model and your key on the Connection tab.", r.error));
      }
      return true;
    };
    paint();
    const off = R.on(() => { paint().then((alive) => { if (!alive) off(); }); });
    btn.onclick = () => { if (R.running) R.stop(); else R.run(); };
  }

  /* ── screen 2: provider and key ────────────────────────────── */
  provider(c) {
    const s = this.s;
    new Setting(c)
      .setName(t("AI provider"))
      .addDropdown((d) => {
        Object.entries(PROVIDERS).forEach(([id, p]) => d.addOption(id, t(p.label)));
        d.setValue(s.provider).onChange(async (v) => { s.provider = v; await this.plugin.saveSettings(); this.draw(); });
      });
    if (s.provider === "obsimind") {
      const box = c.createDiv({ cls: "oa-note" });
      box.createDiv({ cls: "oa-note-title", text: t("A balance instead of a key") });
      box.createDiv({ text: t("One balance for every model, topped up from a Telegram bot — no card left with a foreign provider and no separate signup. There is a free trial with the promo code «{0}».", t("Gift")) });
      const line = box.createDiv();
      line.appendText(t("Prices, models and how to top up: "));
      const a = line.createEl("a", { text: siteLabel(), href: siteUrl() });
      a.setAttr("target", "_blank");
      a.setAttr("rel", "noopener");
    }
    const p = PROVIDERS[s.provider];
    if (p.needsKey) {
      new Setting(c).setName(t("API key")).addText((tx) => {
        tx.inputEl.type = "password";
        tx.setPlaceholder(t("Paste your key here"));
        tx.setValue(s.keys[s.provider] || "").onChange(async (v) => { s.keys[s.provider] = v.trim(); await this.plugin.saveSettings(); });
      });
    } else if (!p.fixedBase) {
      new Setting(c).setName(t("Server address")).addText((tx) =>
        tx.setValue(s.bases[s.provider] || "").onChange(async (v) => { s.bases[s.provider] = v.trim(); await this.plugin.saveSettings(); }));
    }
    const check = new Setting(c).setName(t("Check it works")).setDesc(t("One tiny request — costs a fraction of a kopeck."));
    check.addButton((b) => b.setButtonText(t("Test connection")).onClick(async () => {
      b.setButtonText(t("Checking…")).setDisabled(true);
      try {
        await this.plugin.ai.chat([{ role: "user", content: "Reply with the single word: ok" }], { maxTokens: 10 });
        check.setDesc(t("Connection works"));
        check.descEl.addClass("oa-ok");
      } catch (e) {
        check.setDesc(t("Connection failed: {0}", e.message));
        check.descEl.addClass("oa-bad");
      } finally { b.setButtonText(t("Test connection")).setDisabled(false); }
    }));
  }

  /* ── screen 3: names ───────────────────────────────────────── */
  names(c) {
    const s = this.s;
    new Setting(c).setName(t("What should it be called?")).addText((tx) =>
      tx.setPlaceholder(t("Elton AI")).setValue(s.assistantName).onChange(async (v) => { s.assistantName = v; await this.plugin.saveSettings(); }));
    new Setting(c).setName(t("How should it address you?")).addText((tx) =>
      tx.setPlaceholder(t("Your name")).setValue(s.userName).onChange(async (v) => { s.userName = v; await this.plugin.saveSettings(); }));
  }

  /* ── screen 4: access and private folders ──────────────────── */
  access(c) {
    const s = this.s;
    accessCards(c, s, async (id) => { applyAccessPreset(s, id); await this.plugin.saveSettings(); this.draw(); });
    c.createDiv({ cls: "oa-sec", text: t("Private folders") });
    folderChips(c, this.app,
      () => this.plugin.vault.privateList(),
      async (list) => {
        s.privateFolders = list.join("\n");
        await this.plugin.saveSettings();
        this.plugin.vault.index = null;
        this.plugin.vault._map = null;
      },
      t("None yet. Health, money, other people's details — add them here."));
  }

  /* ── screen 5: where things live ───────────────────────────── */
  places(c) {
    const s = this.s;
    const V = this.plugin.vault;
    const fold = (name, desc, get, set, found) => {
      const st = new Setting(c).setName(name).setDesc(found ? t("Found on its own: {0}", found) : desc);
      st.addText((tx) => {
        tx.setPlaceholder(found || "").setValue(get() || "");
        const commit = async (v) => { await set(String(v || "").trim().replace(/^\/+|\/+$/g, "")); V._map = null; };
        tx.onChange(commit);
        new PathSuggest(tx.inputEl, () => allFolders(this.app), commit);
      });
    };
    fold(t("Folder for new notes"), t("Empty — it picks a fitting folder by meaning."),
      () => s.newNoteFolder, async (v) => { s.newNoteFolder = v; await this.plugin.saveSettings(); }, "");
    fold(t("Daily notes folder"), t("None found — daily notes will be skipped."),
      () => s.dailyFolder, async (v) => { s.dailyFolder = v; await this.plugin.saveSettings(); }, V.dailyFolder());
    fold(t("Templates folder"), t("None found — point at it if you have one."),
      () => s.templateFolder, async (v) => { s.templateFolder = v; await this.plugin.saveSettings(); }, V.templateFolder());
  }

  /* ── screen 6: the phone ───────────────────────────────────── */
  phone(c) {
    const s = this.s;
    const cfg = this.plugin.connector.cfg;
    // On a phone there is nothing to switch on: the computer is what answers.
    if (isMobile()) {
      c.createDiv({ cls: "oa-note", text: t("Turn it on in Obsidian on your computer — Settings → Elton AI → Phone. The app then talks to that computer.") });
      return;
    }
    const st = new Setting(c)
      .setName(t("Answer from the phone"))
      .setDesc(cfg.enabled ? t("On. The code and the link to the app are on the Phone tab.") : t("Off. Turning it on gives you a code to type once in the app."));
    st.addToggle((x) => x.setValue(!!cfg.enabled).onChange(async (v) => {
      cfg.enabled = v;
      if (v && !cfg.code) cfg.code = newConnectorCode();
      await this.plugin.saveSettings();
      if (v) this.plugin.connector.start(); else this.plugin.connector.stop();
      this.draw();
    }));
    if (s.provider !== "obsimind") {
      c.createDiv({ cls: "oa-note", text: t("The phone app works through the Elton AI service, so it needs an Elton AI key — even if answers come from another provider.") });
    }
  }
}

/* ============================================================
 *  What changed since last time
 *
 *  Shown once per version, never on a fresh install. A handful
 *  of cards — the ones a person would be sorry to miss — and a
 *  link to the full story on the site.
 * ========================================================== */
class WhatsNewModal extends Modal {
  constructor(app, plugin, version) {
    super(app);
    this.plugin = plugin;
    this.version = version;
  }

  onClose() { this.contentEl.empty(); }

  onOpen() {
    const c = this.contentEl;
    this.modalEl.addClass("oa-onb-modal");
    const card = c.createDiv({ cls: "oa-onb-card oa-wn" });
    const hero = card.createDiv({ cls: "oa-onb-hero" });
    hero.createDiv({ cls: "oa-onb-emoji", text: "✨" });
    hero.createDiv({ cls: "oa-onb-title", text: t("What’s new in {0}", this.version) });

    const list = card.createDiv({ cls: "oa-wn-list" });
    const item = (icon, title, text) => {
      const box = list.createDiv({ cls: "oa-wn-item" });
      setIcon(box.createDiv({ cls: "oa-wn-icon" }), icon);
      const b = box.createDiv();
      b.createDiv({ cls: "oa-wn-title", text: title });
      b.createDiv({ cls: "oa-wn-text", text });
    };
    item("brain", t("It remembers the conversation"),
      t("“Take down a thought” — and the next message, with no instruction, goes into the same note. Conversations from the phone and Telegram survive a restart, and a message that never reached the computer is picked up from the phone."));
    item("smartphone", t("A new phone app"),
      t("Feed, Chats, Folders, Settings — at the bottom, like any app. The feed shows your own notes at random, the folders are exactly the ones you have here, and a note opens looking the way it does in Obsidian."));
    item("image", t("A photo does what you want"),
      t("Into a note, as text from paper, or “what is this?” — you choose on the phone before sending."));
    item("undo-2", t("Every change can be undone"),
      t("Each note the assistant creates or edits is saved first. Undo it from the answer, from the phone’s settings, or on the Access tab here."));
    item("sparkles", t("Answers from your notes, by meaning"),
      t("Its own step in the welcome now. Indexing is many times faster, saves as it goes, picks up where it stopped, and keeps itself current as you write."));
    item("message-circle", t("Tell us what is wrong"),
      t("Complaints, ideas and «this does not work» — the Telegram bot @elton_feedback_bot. The link is on the Home tab."));
    item("sliders-horizontal", t("Simpler settings"),
      t("A Home tab with the state of everything, three levels of access instead of five switches, and the welcome tour whenever you want it."));

    const nav = c.createDiv({ cls: "oa-onb-nav" });
    const tour = nav.createEl("button", { text: t("Take the tour") });
    tour.onclick = () => { this.close(); new OnboardingModal(this.app, this.plugin).open(); };
    // Someone upgrading never sees the welcome. If meaning is off for them,
    // this is the one step worth taking — straight to it.
    if (!this.plugin.settings.semanticSearch) {
      const setup = nav.createEl("button", { text: t("Set up search by meaning") });
      setup.onclick = () => { this.close(); new OnboardingModal(this.app, this.plugin, "search").open(); };
    }
    const done = nav.createEl("button", { cls: "mod-cta", text: t("Got it") });
    done.onclick = () => this.close();
  }
}
