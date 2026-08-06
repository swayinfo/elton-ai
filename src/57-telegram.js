/* ============================================================
 *  Telegram
 *
 *  The vault, reachable from a phone that isn't holding it. You
 *  write to a bot — typed or spoken — and the same assistant that
 *  lives in the panel answers, with the same tools: it searches
 *  your notes, reads them, and creates or edits them when asked.
 *
 *  Long polling, not a webhook. A webhook needs a public address
 *  and a certificate; Obsidian is an app on a laptop that closes
 *  at night. So the plugin asks Telegram for messages and holds
 *  the request open until one arrives — no server, no port, no
 *  setup beyond a token.
 *
 *  Two consequences worth knowing about, both surfaced in
 *  settings rather than left to be discovered:
 *
 *  • The bot only answers while Obsidian is open. Messages sent
 *    while it is closed are not lost — Telegram keeps them for a
 *    day and they all arrive when the vault next opens.
 *  • One vault at a time. Telegram hands each update to whoever
 *    asks first, so two devices polling the same token take turns
 *    at random and answer half the messages each.
 * ========================================================== */

const TG_API = "https://api.telegram.org";
/* Telegram holds the request open this long when there is nothing to say.
   Long enough that idle polling is nearly free, short enough that stopping
   the plugin doesn't leave a request hanging for a minute. */
const TG_POLL_SECONDS = 25;
const TG_MAX_MESSAGE = 4000;      // plain sendMessage: the hard limit is 4096
/* A rich message holds eight times as much, which matters: a long answer split
   into eight bubbles reads as eight answers. Verified against the API. */
const TG_MAX_RICH = 30000;

/* The waiting animation.
 *
 * A GIF rather than the "typing…" indicator: typing expires after a few
 * seconds and has to be re-sent, it is easy to miss at the top of the screen,
 * and it says nothing about what is happening. This sits in the conversation
 * with a caption that changes as the assistant works — searching, reading,
 * writing — and is deleted the moment the answer arrives.
 *
 * Sent by URL once; Telegram then hands back a file_id, and every later send
 * uses that instead — no download, no dependency on the host staying up.
 */
const TG_THINKING_GIF = "https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif";

/* Cyrillic → Latin, because a Telegram command may only contain lowercase
   Latin letters, digits and underscores. A scenario called «Что сегодня» has
   to become /chto_segodnya or it cannot be a command at all. */
const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

function slugForCommand(name) {
  const out = String(name || "").toLowerCase().replace(/[Ѐ-ӿ]/g, (ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ""));
  return out.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
}

/** ArrayBuffer → base64, for handing a downloaded voice note to the model. */
function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  // In chunks: String.fromCharCode with a few hundred thousand arguments
  // overflows the call stack, and a voice note easily gets there.
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

class TelegramBridge {
  constructor(plugin) {
    this.plugin = plugin;
    this.running = false;
    this.offset = 0;
    // Conversation history per chat, so a follow-up question makes sense.
    // In memory only: a bot conversation is a thread, not a document.
    this.history = new Map();
    this.busy = new Set();
    this.lastError = "";
  }

  get cfg() { return this.plugin.settings.telegram || {}; }

  configured() { return !!(this.cfg.enabled && this.cfg.token); }

  /* ── lifecycle ──────────────────────────────────────────── */
  start() {
    if (this.running || !this.configured()) return;
    // Never from a phone. The token lives in data.json, which syncs, so
    // switching this on at the desk would quietly start a second poller in
    // your pocket — and Telegram hands each message to whoever asked first,
    // so the phone would swallow half of them and answer from a vault that is
    // usually asleep. The point of this is reaching the computer anyway.
    if (isMobile()) return;
    this.running = true;
    this.lastError = "";
    this.syncCommands();
    this.loop().catch((e) => console.warn("[Elton AI] telegram stopped:", e && e.message));
  }

  stop() { this.running = false; }

  /** Settings changed — come back up on the new token, or stay down. */
  restart() {
    this.stop();
    // A poll already in flight holds the old token for up to TG_POLL_SECONDS.
    // Starting immediately would mean two loops and Telegram handing updates
    // to whichever asked last, so wait out the request that is still open.
    window.setTimeout(() => { if (this.configured()) this.start(); }, 1200);
  }

  /* ── transport ──────────────────────────────────────────── */
  async api(method, body, { timeout } = {}) {
    const res = await requestUrl({
      url: `${TG_API}/bot${this.cfg.token}/${method}`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(body || {}),
      throw: false,
    });
    const json = res.json || {};
    if (!json.ok) {
      const why = json.description || `HTTP ${res.status}`;
      throw new Error(why);
    }
    return json.result;
  }

  /**
   * Ask Telegram for whatever has arrived, then answer it.
   *
   * The failure that matters here is a wrong token: retrying it forever
   * would hammer the API for as long as the vault is open, so a refusal
   * Telegram will keep repeating stops the bridge and says why.
   */
  async loop() {
    let backoff = 2000;
    while (this.running) {
      let updates = [];
      try {
        updates = await this.api("getUpdates", {
          offset: this.offset || undefined,
          timeout: TG_POLL_SECONDS,
          allowed_updates: ["message"],
        });
        backoff = 2000;
        this.lastError = "";
      } catch (e) {
        const why = String(e.message || e);
        this.lastError = why;
        // Unauthorized is a wrong token; 409 is another device already polling
        // this bot. Neither is fixed by trying again in two seconds.
        if (/unauthorized|not found/i.test(why)) {
          this.running = false;
          new Notice(t("Telegram refused the token: {0}", why), 10000);
          return;
        }
        await wait(backoff);
        backoff = Math.min(backoff * 2, 60000);
        continue;
      }

      for (const u of updates || []) {
        this.offset = Math.max(this.offset, (u.update_id || 0) + 1);
        // Not awaited: a long answer must not hold up the next message, and
        // each chat is guarded separately below.
        this.handle(u.message).catch((e) => console.warn("[Elton AI] telegram:", e && e.message));
      }
    }
  }

  /* ── slash commands ─────────────────────────────────────────
   *
   * Every scenario becomes a command, so the things you ask for most are in
   * the bot's own menu instead of being phrases you have to remember. The
   * trigger phrases still work — this is the same list, reachable by tapping.
   * ────────────────────────────────────────────────────────── */

  /** The scenarios that have a usable command, paired with it. */
  commandMap() {
    const out = new Map();
    for (const sc of this.plugin.settings.scenarios || []) {
      if (!sc || !sc.enabled || !sc.prompt) continue;
      let name = slugForCommand(sc.name || "");
      if (!name) continue;
      // Telegram allows a command name once. A second "Мысли" would silently
      // replace the first, so it is numbered instead.
      let unique = name, n = 2;
      while (out.has(unique)) unique = (name + "_" + n++).slice(0, 32);
      out.set(unique, sc);
    }
    return out;
  }

  /**
   * Publish the menu Telegram shows behind the "/" button.
   *
   * Called on every save because the alternative is a menu that is right on
   * the day you set it up and wrong forever after. Debounced by the caller;
   * failures are ignored, since a stale menu is a cosmetic problem.
   */
  async syncCommands() {
    if (!this.configured() || isMobile()) return;
    const commands = [
      { command: "help", description: t("What this bot can do") },
      { command: "new", description: t("Forget the conversation so far") },
    ];
    for (const [name, sc] of this.commandMap()) {
      if (commands.length >= 100) break;
      commands.push({ command: name, description: (sc.name || "").slice(0, 256) });
    }
    try { await this.api("setMyCommands", { commands }); }
    catch (e) { console.warn("[Elton AI] telegram commands:", e && e.message); }
  }

  /** The help text, built from what is actually switched on right now. */
  helpText() {
    const s = this.plugin.settings;
    const lines = [
      `## ${t("What I can do")}`,
      "",
      t("Write to me the way you would speak to the panel — about your notes, or asking for one to be written. Voice messages work too."),
      "",
      `### ${t("Commands")}`,
      "",
      `- /help — ${t("What this bot can do")}`,
      `- /new — ${t("Forget the conversation so far")}`,
    ];
    const map = this.commandMap();
    if (map.size) {
      lines.push("", `### ${t("Your scenarios")}`, "");
      for (const [name, sc] of map) {
        lines.push(`- /${name} — ${sc.emoji || "✨"} ${sc.name}`);
      }
      lines.push("", t("Each one also works as a spoken phrase — just write it out."));
    }
    lines.push("", "---", "",
      t("I can search, read, create and edit notes. I cannot delete — that waits for a key press at the keyboard, and there is nobody here to press it."));
    if (!s.canCreate) lines.push("", t("Creating notes is switched off in settings right now."));
    return lines.join("\n");
  }

  /* ── who is allowed to talk to it ───────────────────────── */

  /**
   * A bot token is a password, and a bot anyone can find is a bot anyone can
   * ask about your notes. So exactly one Telegram account is served: the
   * first one to say /start, which is then written into settings and is the
   * only one answered from then on.
   */
  async authorise(msg) {
    const from = msg.from || {};
    const allowed = String(this.cfg.userId || "").trim();
    const who = String(from.id || "");
    if (!allowed) {
      if (!/^\/start/.test(String(msg.text || ""))) {
        await this.send(msg.chat.id, t("Send /start to link this bot to your vault."));
        return false;
      }
      this.cfg.userId = who;
      this.plugin.settings.telegram = this.cfg;
      await this.plugin.saveSettings();
      await this.send(msg.chat.id,
        t("Linked. This bot now answers only you, and only while Obsidian is open on your computer.\n\nWrite to it the way you would speak to the panel — ask about your notes, or ask it to write one. Voice messages work too."));
      return false;
    }
    if (who !== allowed) {
      // No reply at all: a stranger who gets "you are not allowed" has learnt
      // that the bot is live and belongs to someone.
      console.warn("[Elton AI] telegram: ignoring message from", who);
      return false;
    }
    return true;
  }

  /* ── one message ────────────────────────────────────────── */
  async handle(msg) {
    if (!msg || !msg.chat) return;
    if (!(await this.authorise(msg))) return;

    const chatId = msg.chat.id;
    const said = String(msg.text || "").trim();
    if (/^\/start/.test(said)) {
      await this.send(chatId, t("Ready. Ask about your notes, or ask for one to be written."));
      await this.send(chatId, this.helpText());
      return;
    }
    if (/^\/(new|reset|clear)\b/.test(said)) {
      this.history.delete(String(chatId));
      await this.send(chatId, t("Forgotten. Starting fresh."));
      return;
    }
    if (/^\/help\b/.test(said)) {
      await this.send(chatId, this.helpText());
      return;
    }

    // A scenario invoked by its command. Anything typed after it rides along
    // as a refinement, exactly as words around a spoken trigger phrase do.
    const cmd = said.match(/^\/([a-z0-9_]{1,32})(?:@\S+)?\s*([\s\S]*)$/i);
    if (cmd) {
      const sc = this.commandMap().get(cmd[1].toLowerCase());
      if (!sc) {
        await this.send(chatId, t("I don't know that command. Send /help for the list."));
        return;
      }
      if (this.busy.has(String(chatId))) { await this.send(chatId, t("Still working on the last one — one moment.")); return; }
      this.busy.add(String(chatId));
      const spinner = await this.thinking(chatId);
      try {
        spinner.step(t("Scenario: {0}", scenarioLabel(sc)));
        await this.answer(chatId, scenarioPrompt(sc, cmd[2]), spinner);
      } catch (e) {
        await this.send(chatId, t("Something went wrong: {0}", e.message));
      } finally {
        await spinner.done();
        this.busy.delete(String(chatId));
      }
      return;
    }

    // One turn per chat at a time. Two questions in a row otherwise run two
    // agents against the same vault, and the second answer arrives first.
    if (this.busy.has(String(chatId))) {
      await this.send(chatId, t("Still working on the last one — one moment."));
      return;
    }

    let text = String(msg.text || msg.caption || "").trim();
    const voice = msg.voice || msg.audio || msg.video_note;
    if (!text && !voice) {
      await this.send(chatId, t("I can read text and listen to voice messages — nothing else yet."));
      return;
    }

    this.busy.add(String(chatId));
    // Straight away, before anything slow: an answer takes tens of seconds and
    // until now the chat sat silent for all of them.
    const wait_ = await this.thinking(chatId);
    try {
      if (voice) {
        wait_.step(t("Listening to your message…"));
        text = await this.transcribe(voice);
        if (!text) { await this.send(chatId, t("I couldn't make that out. Try again?")); return; }
        // Echo what was heard: a misheard word explains a strange answer, and
        // without this the answer just looks wrong.
        await this.send(chatId, `🎤 _${text}_`);
        // It has stopped listening — say so, or the caption keeps claiming it
        // is still doing the thing it finished ten seconds ago.
        wait_.step(t("Thinking about your answer…"));
      }
      await this.answer(chatId, text, wait_);
    } catch (e) {
      // Both places: the chat is where it is noticed, the console is where it
      // can be diagnosed. An answer that fails silently over Telegram is
      // indistinguishable from one that is still being written.
      console.error("[Elton AI] telegram turn failed:", e);
      await this.send(chatId, t("Something went wrong: {0}", (e && e.message) || e));
    } finally {
      await wait_.done();
      this.busy.delete(String(chatId));
    }
  }

  /** Download a voice message and turn it into words. */
  async transcribe(voice) {
    const file = await this.api("getFile", { file_id: voice.file_id });
    const res = await requestUrl({
      url: `${TG_API}/file/bot${this.cfg.token}/${file.file_path}`,
      method: "GET",
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    // Telegram voice notes are OGG/Opus; an audio file forwarded from
    // elsewhere can be anything, so the extension is what we go on.
    const ext = String(file.file_path || "").split(".").pop().toLowerCase();
    const format = ["ogg", "mp3", "wav", "m4a", "mp4", "webm"].includes(ext) ? ext : "ogg";
    return await this.plugin.ai.transcribe(bufferToBase64(res.arrayBuffer), format);
  }

  /** Run the agent and send back what it said. */
  async answer(chatId, text, indicator) {
    const key = String(chatId);
    const history = this.history.get(key) || [];
    const show = (indicator && indicator.step) || (() => {});

    const agent = new Agent(this.plugin);
    let reply = "";
    // A scenario phrase works here exactly as it does when spoken.
    const hit = matchScenario(text, this.plugin.settings.scenarios);
    const sent = hit ? scenarioPrompt(hit.scenario, hit.rest) : text;
    if (hit) show(t("Scenario: {0}", scenarioLabel(hit.scenario)));

    reply = await agent.run(history, sent, {
      // The agent already narrates every search and edit — that narration is
      // what the caption is for.
      onEvent: (ev) => { if (ev && ev.kind === "action") show(ev.text); },
      // Nobody is at the keyboard to press Enter. Deleting therefore never
      // happens over Telegram — it asks, is declined, and says so.
      confirm: async () => false,
      onSegment: null,
      // Markdown, because this is read rather than spoken.
      written: true,
      channel: "telegram",
    });
    history.push({ role: "user", content: sent });
    history.push({ role: "assistant", content: reply || "" });
    this.history.set(key, history.slice(-12));

    if (!reply || !reply.trim()) { await this.send(chatId, t("I have nothing to say to that.")); return; }

    // Sources folded away rather than stacked under every answer. They are
    // worth having and rarely worth reading, which is what a collapsible
    // block is for — and rich messages are the reason we can have one.
    const list = (agent.sources || []).slice(0, 8);
    const block = list.length
      ? `\n\n<details><summary>${t("From your notes:")} ${list.length}</summary>\n\n`
        + list.map((s) => "- " + (s.title || s.path)).join("\n") + "\n\n</details>"
      : "";
    // The animation goes before the answer, not after: deleting it afterwards
    // leaves the reply sitting above a spinner for a beat.
    if (indicator && indicator.done) await indicator.done();
    await this.send(chatId, reply.trim() + block);
  }

  /* ── sending ────────────────────────────────────────────── */

  /**
   * Send a message, in pieces if it is long.
   *
   * Three attempts, in descending order of how good it looks.
   *
   * `sendRichMessage` is the one that actually renders what the model writes:
   * headings, lists, checkboxes, tables, dividers, collapsible blocks. The old
   * path was `sendMessage` with parse_mode Markdown, which knows only bold,
   * italic and quotes — a "## Heading" arrived as the literal characters, and
   * any stray underscore in a file name made the API refuse the message
   * outright, dropping the whole answer to plain text. That is exactly what an
   * answer full of `##` and `—` looked like in the chat.
   *
   * The two fallbacks stay because an answer that arrives plain still beats an
   * answer that does not arrive.
   */
  async send(chatId, text) {
    const body = String(text || "");
    if (!body.trim()) return;

    // The last thing that went wrong when even plain text would not go. This
    // used to be swallowed: the final attempt ended in `.catch(console.warn)`,
    // so a message that never left still reported success, and an automation
    // that failed to reach Telegram looked exactly like one that arrived.
    let failure = null;

    for (const part of splitForTelegram(body, TG_MAX_RICH)) {
      try {
        await this.api("sendRichMessage", { chat_id: chatId, rich_message: { markdown: part } });
        continue;
      } catch (e) {
        console.warn("[Elton AI] rich message refused, falling back:", e && e.message);
        // Said out loud once per session. A silent fallback is how "the
        // markdown doesn't work" becomes a mystery: the answer still arrives,
        // just flattened, and nothing anywhere says why.
        if (!this._richWarned) {
          this._richWarned = true;
          new Notice(t("Telegram would not take the formatted message ({0}), so answers are being sent as plain text.", e.message), 10000);
        }
      }
      for (const small of splitForTelegram(part)) {
        try {
          await this.api("sendMessage", { chat_id: chatId, text: small, parse_mode: "Markdown", disable_web_page_preview: true });
        } catch {
          try {
            await this.api("sendMessage", { chat_id: chatId, text: small, disable_web_page_preview: true });
          } catch (err) {
            console.error("[Elton AI] telegram send failed:", err && err.message);
            failure = err;
          }
        }
      }
    }

    if (failure) throw failure;
  }

  /* ── the waiting animation ──────────────────────────────── */

  /**
   * Put something on screen the moment a message arrives, and keep it honest.
   *
   * Returns a handle: `step(text)` rewrites the caption as the agent works,
   * `done()` takes the whole thing away. Every call is allowed to fail
   * silently — a decoration must never be the reason an answer doesn't arrive.
   */
  async thinking(chatId) {
    const cfg = this.cfg;
    if (cfg.thinkingGif === false) return { step: () => {}, done: async () => {} };

    const source = cfg.gifId || cfg.thinkingGifUrl || TG_THINKING_GIF;
    let msg = null;
    try {
      msg = await this.api("sendAnimation", {
        chat_id: chatId,
        animation: source,
        caption: t("Thinking about your answer…"),
      });
      // Telegram uploaded it once; from now on it is a file_id, which needs no
      // download and works even if the original host has gone.
      const id = msg && msg.animation && msg.animation.file_id;
      if (id && id !== cfg.gifId) {
        cfg.gifId = id;
        this.plugin.settings.telegram = cfg;
        await this.plugin.saveSettings();
      }
    } catch (e) {
      console.warn("[Elton AI] waiting animation unavailable:", e && e.message);
      // A stored file_id can go stale; forget it so the next turn re-uploads.
      if (cfg.gifId) { cfg.gifId = ""; this.plugin.settings.telegram = cfg; await this.plugin.saveSettings().catch(() => {}); }
    }

    if (!msg) {
      // No animation — fall back to the typing indicator, which is better than
      // an unanswered chat sitting silent for a minute.
      const keep = { alive: true };
      const beat = async () => {
        while (keep.alive) {
          try { await this.api("sendChatAction", { chat_id: chatId, action: "typing" }); } catch {}
          await wait(5000);
        }
      };
      beat();
      return { step: () => {}, done: async () => { keep.alive = false; } };
    }

    let last = "";
    let gone = false;
    const started = Date.now();
    let current = t("Thinking about your answer…");

    const paint = (caption) => {
      // Telegram refuses an edit that changes nothing, and the agent repeats
      // the same step often enough for that to be most of the calls.
      if (gone || !caption || caption === last) return;
      last = caption;
      this.api("editMessageCaption", { chat_id: chatId, message_id: msg.message_id, caption })
        .catch(() => {});
    };

    /* A clock on the caption.
     *
     * The agent only narrates when it calls a tool, and the longest silence in
     * a turn is before the first one — the model is deciding what to do, which
     * can take half a minute. Without this the picture sits there saying
     * "Listening to your message…" long after it stopped listening, and the
     * only reasonable conclusion is that it died. */
    const tick = window.setInterval(() => {
      if (gone) return;
      const secs = Math.round((Date.now() - started) / 1000);
      paint(secs >= 10 ? `${current} · ${secs} ${t("s")}` : current);
    }, 5000);

    return {
      step: (line) => {
        if (gone) return;
        current = String(line || "").slice(0, 180);
        paint(current);
      },
      // Called once when the answer is ready and again from the caller's
      // `finally`, so it has to be safe to run twice.
      done: async () => {
        if (gone) return;
        gone = true;
        window.clearInterval(tick);
        try { await this.api("deleteMessage", { chat_id: chatId, message_id: msg.message_id }); } catch {}
      },
    };
  }

  /** Send a note into the chat unasked — used by automations. */
  async push(text) {
    if (!this.configured() || !this.cfg.userId) return false;
    await this.send(this.cfg.userId, text);
    return true;
  }
}

/* ============================================================
 *  Connecting one, for someone who has never made a bot
 *
 *  Every instruction anyone writes for this assumes you know what
 *  BotFather is. The steps are genuinely short — the hard part is
 *  that none of the words mean anything the first time, so each
 *  one here says what you will see, not what to do in the
 *  abstract, and the token gets checked before you are told it
 *  worked.
 * ========================================================== */
class TelegramSetupModal extends Modal {
  constructor(app, plugin, onDone) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone;
    this.step = 0;
  }

  onOpen() {
    this.modalEl.addClass("oa-onb");
    this.draw();
  }

  onClose() { this.contentEl.empty(); if (this.onDone) this.onDone(); }

  get cfg() {
    if (!this.plugin.settings.telegram) this.plugin.settings.telegram = { enabled: false, token: "", userId: "" };
    return this.plugin.settings.telegram;
  }

  get steps() {
    return [
      {
        title: t("What this actually is"),
        icon: "send",
        body: t("A Telegram bot is a chat account you own. You write to it from your phone, and the assistant on this computer answers — the same one as in the panel, with the same access to your notes. Nothing is published anywhere: the bot talks only to you."),
        render: (c) => {
          const box = c.createDiv({ cls: "oa-note" });
          box.createDiv({ cls: "oa-note-title", text: t("Two things to know first") });
          box.createDiv({ text: t("It answers only while Obsidian is open on this computer. Messages sent while it is closed arrive the next time you open the vault.") });
          box.createDiv({ text: t("Set it up on one computer only. Two would take turns answering at random.") });
          // Said plainly, without instructions: what someone does about it is
          // their business, and it is a fact about the network, not advice.
          const warn = c.createDiv({ cls: "oa-warn" });
          warn.setText(t("⚠ Access to Telegram is restricted by some providers in Russia, and connections to it may be slow or fail entirely. If Telegram does not open normally for you, this bot will not work reliably either."));
        },
      },
      {
        title: t("Make the bot"),
        icon: "bot",
        body: t("In Telegram, find the account called BotFather — the one with the blue tick. Send it /newbot. It asks for a name (anything, e.g. «My vault»), then for a username, which must end in bot (e.g. elton_vault_bot). It replies with a long line of letters and digits after «Use this token to access the HTTP API» — that line is the token."),
        render: (c) => {
          const box = c.createDiv({ cls: "oa-note" });
          box.createDiv({ cls: "oa-note-title", text: t("The token looks like this") });
          box.createDiv({ cls: "oa-mono", text: "8123456789:AAH...long...string" });
          box.createDiv({ text: t("It is a password. Anyone who has it can talk to your bot, so do not put it in a note or send it to anyone.") });
        },
      },
      {
        title: t("Paste the token"),
        icon: "key",
        body: t("Paste it here and press check. The plugin asks Telegram whether the token is real and tells you the bot's name back — if the name is right, the token is right."),
        render: (c) => this.stepToken(c),
      },
      {
        title: t("Say hello to it"),
        icon: "message-circle",
        body: t("Open your bot in Telegram — BotFather gave you a t.me link to it — and send it /start. The first person to do that becomes the owner, and from then on it answers nobody else."),
        render: (c) => this.stepLink(c),
      },
    ];
  }

  draw() {
    const c = this.contentEl;
    // Same slide redrawn (a token checked, an account forgotten) keeps its
    // place; a new slide starts at the top.
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
      nav.createEl("button", { text: t("Back") }).onclick = () => { this.step--; this.draw(); };
    } else {
      nav.createEl("button", { text: t("Close") }).onclick = () => this.close();
    }
    const next = nav.createEl("button", { cls: "mod-cta", text: this.step === this.steps.length - 1 ? t("Done") : t("Next") });
    next.onclick = async () => {
      if (this.step === this.steps.length - 1) { this.close(); return; }
      this.step++;
      await this.plugin.saveSettings();
      this.draw();
    };

    if (same) back();
  }

  stepToken(c) {
    const cfg = this.cfg;
    let field = null;
    const status = c.createDiv({ cls: "oa-index-status" });

    new Setting(c).setName(t("Bot token")).addText((tx) => {
      field = tx;
      tx.inputEl.type = "password";
      tx.setPlaceholder("8123456789:AAH…").setValue(cfg.token || "")
        .onChange(async (v) => { cfg.token = v.trim(); await this.plugin.saveSettings(); });
    });

    new Setting(c).addButton((b) => b.setCta().setButtonText(t("Check the token")).onClick(async () => {
      if (!cfg.token) { status.setText(t("Paste the token first.")); return; }
      b.setButtonText(t("Checking…")).setDisabled(true);
      try {
        const me = await this.plugin.telegram.api("getMe", {});
        status.setText(t("Works — the bot is @{0}. Now go and say /start to it.", me.username || me.first_name));
        cfg.enabled = true;
        await this.plugin.saveSettings();
        this.plugin.telegram.restart();
      } catch (e) {
        status.setText(t("Telegram refused the token: {0}", e.message));
      } finally {
        b.setButtonText(t("Check the token")).setDisabled(false);
        if (field) field.setValue(cfg.token);
      }
    }));
  }

  stepLink(c) {
    const cfg = this.cfg;
    const status = c.createDiv({ cls: "oa-index-status" });
    const paint = () => status.setText(cfg.userId
      ? t("Linked to your Telegram account. It is listening.")
      : t("Waiting for /start. Send it from the phone you want to use."));
    paint();
    // Polled rather than pushed: the linking happens inside the bridge when
    // the message lands, and this window has no way of hearing about it.
    const timer = window.setInterval(paint, 1500);
    this.onDone = ((prev) => () => { window.clearInterval(timer); if (prev) prev(); })(this.onDone);

    new Setting(c).addButton((b) => b.setButtonText(t("Forget the linked account")).onClick(async () => {
      cfg.userId = "";
      await this.plugin.saveSettings();
      paint();
    }));
  }
}

/**
 * Cut a long answer into messages Telegram will accept.
 * On paragraph boundaries where there are any, because a message that ends
 * mid-sentence and continues in the next one is worse than two short ones.
 */
function splitForTelegram(text, limit = TG_MAX_MESSAGE) {
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "));
    const at = cut > limit * 0.5 ? cut + 1 : limit;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at);
  }
  if (rest.trim()) out.push(rest.trim());
  return out.length ? out : [""];
}
