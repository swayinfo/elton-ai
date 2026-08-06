/* ============================================================
 *  The agent loop
 *
 *  The model gets tools and runs until it has an answer, seeing the
 *  result of each step. One shot at a search was the old design and
 *  it failed whenever the user's words didn't match their notes'
 *  words; now a miss just means it tries again differently.
 *
 *  Tools are built per-turn from the permission settings, so a
 *  capability the user switched off is not merely refused — the
 *  model is never told it exists.
 * ========================================================== */

// Six was the whole turn. With the quick model doing the gathering the strong
// model then arrives with whatever is left, and "create eight notes" is eight
// tool calls that have to fit after the searching — so the ceiling has to hold
// both halves.
const MAX_STEPS = 10;
// A long answer can outrun the token ceiling. Ask for the rest rather than
// serving a sentence that stops mid-word — but bounded, so a model that has
// forgotten how to stop can't bill forever.
const MAX_CONTINUATIONS = 3;
/**
 * The turn from gathering to answering.
 *
 * It has to go out WITH the tools still declared, even though the point is to
 * stop using them. Measured against the proxy: drop `tools` from a request
 * whose history contains tool calls and Anthropic returns an empty message
 * with finish_reason "stop" — no error, no text. So this line is what asks for
 * the answer, and the tools stay only to keep the history valid.
 */
const HANDOVER = {
  role: "user",
  content: "Enough searching. Answer now, from what you have already gathered. "
    + "Do not call any more tools; if something is missing, say so in the answer.",
};

/**
 * The quick model has stopped gathering, so the strong one takes over.
 *
 * NOT the same instruction as running out of steps. This one used to be, and
 * it was the bug behind "I'll create that note" followed by nothing: the quick
 * model answers a request to write something with a sentence rather than a tool
 * call, this arrived saying call no more tools, and the strong model — which
 * had the request and the ability — was forbidden from doing the one thing that
 * had been asked for. Both models then described the work and neither did it.
 */
const TAKE_OVER = {
  role: "user",
  content: "Stop searching — you have enough. Now finish the job. "
    + "If the user asked you to create, write, edit or delete anything and it has not been done yet, "
    + "do it NOW with the tools, in this turn. Never announce work you have not carried out.",
};

const CONTINUE_PROMPT =
  "Your answer was cut off at the point shown. Carry straight on from there. " +
  "Do not repeat anything you already wrote, do not start over, and do not add " +
  "a preamble like \"continuing\" — write only what comes next.";

/**
 * Everything up to the last sentence that actually finished. Returns "" when
 * the text has no sentence end at all, so the caller can start it over rather
 * than build on a fragment.
 */
function wholeSentences(text) {
  const m = String(text || "").match(/^[\s\S]*[.!?…]["'»”)\]]?(?=\s|$)/);
  return m ? m[0].trim() : "";
}

/** Web search only works through a provider that routes to OpenRouter. */
function webSearchOK(s) {
  return !!s.webSearch && (s.provider === "obsimind" || s.provider === "openrouter");
}

/**
 * The model that drives the tool loop, or "" for one model doing everything.
 *
 * Off when it would be the same model twice — that buys nothing and costs an
 * extra round trip at the handover.
 */
function fastModelFor(s) {
  const chosen = String(s.fastModel || "").trim();
  if (!chosen) return "";                       // one model does everything
  const fast = chosen === "auto" ? (FAST_MODELS[s.provider] || "") : chosen;
  const main = String((s.models && s.models[s.provider]) || "").trim();
  return fast && fast !== main ? fast : "";
}

function buildTools(s, plugin) {
  const tools = [];
  const fn = (name, description, properties, required) =>
    tools.push({ type: "function", function: { name, description, parameters: { type: "object", properties, required: required || [] } } });

  if (s.canRead) {
    fn("search_notes",
      "Search the user's notes by meaning and by words. Call it more than once with different wording if the first attempt finds nothing useful — the user's phrasing often differs from what they wrote.",
      { query: { type: "string", description: "What to look for, in your own words." } }, ["query"]);
    fn("read_note",
      "Read a whole note. Use it when the search snippet is not enough to answer accurately.",
      { path: { type: "string", description: "Path or title of the note" } }, ["path"]);
    fn("open_note",
      "Show a note on screen. Only when the user actually asks to open, show or go to it — not to answer a question about it.",
      { path: { type: "string" } }, ["path"]);
    fn("list_notes",
      "List notes in a folder. The folder can be named loosely — \"inbox\", \"входящие\" or \"5. Inbox\" all resolve to the same place, so pass what the user said.",
      { folder: { type: "string" } }, ["folder"]);
    fn("find_files",
      "Find notes by name or path pattern, when you know roughly what a file is called but not where it is. Use * for any part of a name.",
      { pattern: { type: "string", description: "e.g. \"*budget*\", \"Projects/**/*.md\", \"MOC*\"" } }, ["pattern"]);
    fn("grep",
      "Find exact text inside notes, with the line it appears on. Use it for a phrase, a tag, a property or a link you need to locate precisely — search_notes finds notes by topic, this finds literal text.",
      { query: { type: "string", description: "Text or a regular expression" },
        pattern: { type: "string", description: "Optional: limit to paths matching this pattern" } },
      ["query"]);
    fn("recent_notes",
      "What the user has written or changed lately, newest first, with the date of each. This is the ONLY way to answer anything about a period of time — \"the last few days\", \"this week\", \"lately\", \"recently\". search_notes ranks by topic and ignores dates entirely, so it will happily return something from six months ago.",
      { days: { type: "number", description: "How far back to look. 3 for \"the last few days\", 7 for \"this week\"." } }, []);
    // Registered whether or not the setting was ever filled in: the folder is
    // read from Obsidian's own daily-notes settings when ours is empty.
    if (plugin.vault.dailyFolder()) {
      fn("daily_note",
        "The user's daily note for one date. Needed for questions like \"what did I do yesterday\" — ordinary search does not find these reliably. For a span of days use recent_notes instead of calling this once per day.",
        { when: { type: "string", description: "today, yesterday, or a date as DD-MM-YYYY" } }, ["when"]);
    }
  }
  if (webSearchOK(s)) {
    fn("search_web",
      "Search the public internet for things the notes can't answer — current events, facts, prices, documentation, anything outside the vault or newer than what you already know. Returns a short answer with source links. Use the user's own notes for anything personal; use this for the outside world, and say when something came from the web.",
      { query: { type: "string", description: "What to look up, in your own words." } }, ["query"]);
  }
  if (s._skillIndex && s._skillIndex.length) {
    const names = s._skillIndex.map((x) => x.name).join(", ");
    fn("load_skill",
      "Load a skill: a short guide to how THIS vault works — its structure, note formats, scripts, styling. Load the relevant one BEFORE writing or changing anything in that area; general knowledge about Obsidian goes stale, the skill describes this exact setup. Available: " + names,
      { name: { type: "string", description: "Skill name, exactly as listed" } }, ["name"]);
  }
  if (s.canControlUI) {
    fn("list_tabs",
      "See what the user currently has open in the main area — notes, web pages, boards. Use it before closing or rearranging anything, and when the user says \"this\", \"that one\" or \"the other tab\" and you need to know what they mean.",
      {}, []);
    fn("open_url",
      "Open a web page in front of the user, inside their vault. Use it when they ask to see, open or show a site, or after a web search when a source is worth reading in full. Only ordinary http and https addresses work.",
      { url: { type: "string", description: "Full address, including https://" } }, ["url"]);
    fn("close_tab",
      "Close tabs the user is done with. Name it the way they did — a title or part of one. Notes save continuously, so nothing is lost, but say what you closed.",
      { name: { type: "string", description: "Title or part of it. Leave empty only when closing everything." },
        all: { type: "boolean", description: "Close every tab in the main area. The user is asked to confirm." } },
      []);
    fn("open_beside",
      "Open a note beside what's already on screen instead of on top of it, so two things can be read together. Use it when the user wants to compare, or when you are pointing at a second note while they read the first.",
      { path: { type: "string" } }, ["path"]);
  }
  if (s.canCreate) {
    fn("create_note",
      "Create a new note. If this vault has a template for this kind of note, read it first and build the note on it — properties, headings and links included. A note that does not look like its neighbours is filed wrong.",
      { title: { type: "string" }, content: { type: "string", description: "Body, in markdown" }, folder: { type: "string", description: "Optional folder" } },
      ["title", "content"]);
    if (plugin.vault.templateFolder()) {
      fn("read_template",
        "Read one of this vault's templates — the shape a note of that kind is supposed to have. Call it BEFORE creating a project, a meeting, a book note or anything else the vault has a template for. The list of them is in the layout description above.",
        { name: { type: "string", description: "Template name or path, as listed" } }, ["name"]);
    }
    // Only when the board can actually be rendered. Without the Kanban plugin
    // the same file opens as ordinary text, and "here is your board" would be
    // a note with headings in it.
    if (plugin.vault.kanbanReady()) {
      fn("create_board",
        "Create a Kanban board: a project laid out as columns with cards you drag between them. Use this — NOT create_note — whenever the user asks for a board, a kanban, or a project broken into stages. A note with headings and checkboxes is not a board; it opens as plain text. If this vault has a board template, read it first: take its columns and its properties from there rather than inventing your own.",
        {
          title: { type: "string" },
          folder: { type: "string", description: "Optional folder" },
          properties: {
            type: "object",
            description: "Frontmatter properties the vault's boards carry — copy them from the template or from a neighbouring board, e.g. a link back to the parent MOC. Values may be strings or lists of strings.",
          },
          columns: {
            type: "array",
            description: "The columns, in order. Three or four is usual — e.g. Idea, In progress, Done.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Column heading" },
                cards: { type: "array", items: { type: "string" }, description: "Cards in this column. May be empty." },
              },
              required: ["name"],
            },
          },
        },
        ["title", "columns"]);
    }
  }
  if (s.canEdit) {
    fn("append_note",
      "Add text to an existing note. If the user names a section, pass it as heading and the text goes under that heading.",
      { path: { type: "string" }, content: { type: "string" }, heading: { type: "string", description: "Exact heading to add under" } },
      ["path", "content"]);
    fn("replace_in_note",
      "Replace exact text inside a note. Use for corrections and rewording. The find text must match the note exactly.",
      { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
      ["path", "find", "replace"]);
    fn("undo_last", "Undo the last change you made to a note. For \"undo that\" or \"put it back\".", {}, []);
  }
  if (s.canDelete) {
    fn("delete_note",
      "Delete a note. The user is always asked to confirm from the keyboard before anything is deleted, so say what you are about to delete rather than promising it is done.",
      { path: { type: "string" } }, ["path"]);
  }
  return tools;
}

const PERSONAS = {
  calm:  "Calm, precise and unhurried. You state what you know, and say plainly when you do not know.",
  warm:  "Warm and conversational. You are easy to talk to, but you never pad an answer to seem friendly.",
  blunt: "Short and direct. No preamble, no summary of what you are about to say. Answer, then stop.",
};

async function buildSystemPrompt(plugin, { written = false, channel = "" } = {}) {
  const s = plugin.settings;
  const name = s.assistantName || "Assistant";
  const persona = s.persona === "custom" && s.personaCustom ? s.personaCustom : (PERSONAS[s.persona] || PERSONAS.calm);
  const who = s.userName ? `The person you are talking to is ${s.userName}.` : "";

  const lines = [
    `You are ${name}, an assistant living inside the user's Obsidian vault. ${who}`,
    persona,
    "",
    "How you work:",
    "• Your answers come from the user's own notes. Search before you answer anything about their material — do not answer from memory and do not invent note contents.",
    "• If a search finds nothing, try different words before giving up. Two or three attempts, then say honestly that you found nothing.",
    "• You may reason and give an opinion, not just retrieve. Ground it in their notes, and say which part is your own view.",
  ];

  if (channel === "telegram") {
    /* Telegram renders proper markdown now — headings, lists, tables and all.
       Worth saying outright: told only "write markdown", a model aims at the
       old bold-and-italic dialect and produces a wall of paragraphs, which is
       what a long answer on a phone screen must not be. */
    lines.push("• This answer is read in a Telegram chat on a phone. It renders full markdown, so use it: `##` headings to break a long answer into parts, `-` and `1.` lists, `- [ ]` checkboxes for things to do, `---` between big sections, tables where the content really is a table, `**bold**` for the thing that matters, `> ` for quoting the user's own notes.");
    lines.push("• Write for a phone screen: lead with the answer, keep paragraphs to two or three sentences, and never send one unbroken block of text. Do not add a heading to a two-line answer — structure a long one, leave a short one short.");
    lines.push("• Do not list your sources at the end; that is added for you.");
  } else if (written) {
    // The answer is written into a note, not spoken — so markdown helps here
    // where it would only be read out as noise in the reactor.
    lines.push("• This answer is saved to a note, not spoken. Write clean, readable markdown: short paragraphs, and headings or lists where they genuinely help. Do not mention that you are writing to a note.");
  } else {
    lines.push("• Answers are spoken aloud, so write them to be heard: plain sentences, no markdown, no bullet lists, no headings, no code blocks.");
    lines.push("• Keep it to a few sentences unless asked for detail.");
  }

  if (webSearchOK(s)) {
    lines.push("• You can search the public internet when the answer isn't in their notes — use it for current events, facts and anything outside the vault, and say plainly when something came from the web rather than their notes.");
  }

  // Индекс скиллов — короткие описания, полный текст модель тянет сама.
  if (s._skillIndex && s._skillIndex.length) {
    lines.push("", "Guides to Obsidian and to how this vault is built. Load the relevant one with load_skill BEFORE writing or changing anything in that area — these describe file formats you cannot reliably guess, and a file in the wrong shape opens as plain text instead of what the user asked for:");
    for (const sk of s._skillIndex) {
      lines.push(`• ${sk.name} — ${sk.description || ""}`.trim());
    }
    lines.push("Only the guides listed above exist here. A format that has no guide listed means the plugin for it is not installed — say so instead of writing a block that will not render.");
  }

  if (s.canEdit || s.canCreate) {
    lines.push("• When you change a note, do it — do not ask permission first, and do not describe what you would do. The user can always say \"undo that\".");
    // The single most common failure, and the one that reads as the assistant
    // being useless: it replies "I'll create that note" and the turn ends. A
    // promise is not an action, and there is no later in which to keep it.
    lines.push("• NEVER announce work instead of doing it. \"I'll create it\", \"let me write that\", \"I'm making the note\" are forbidden unless the tool call is already in this same turn. Call the tool first, then say what you did, in the past tense. If you cannot, say why — do not promise.");
    lines.push("• Asked for several notes, create all of them, one create_note call each. Do not stop after the first and do not offer to continue.");
    // The convention lives in the neighbours and nowhere else, so a note made
    // without looking at them comes out orphaned — no link back to its MOC, no
    // tags, filed nowhere.
    lines.push("• A new note has to fit the folder it lands in. Creating one tells you which properties the other notes there carry; add the same ones straight away, including any link back to a parent or index note. Do not leave a note that nothing points at.");
  }
  if (s.canControlUI) {
    lines.push("• You control what is on their screen as well as what is in their notes. Put the thing you are talking about in front of them: open the note you are describing, open a source worth reading, open two notes side by side when you are comparing them. Close what is finished with when they ask.");
    lines.push("• Do this while you answer, not instead of answering — the screen and the words go together.");
  }
  if (s.canDelete) {
    lines.push("• Deletion always stops for the user's confirmation. Never claim something is deleted before they confirm it.");
  }

  // The map of the vault. Cached for the session — it reads metadata only, but
  // it reads all of it, and it goes into every single prompt.
  if (s.vaultMap !== false) {
    if (!plugin.vault._map) {
      try { plugin.vault._map = plugin.vault.describeVault(); } catch { plugin.vault._map = ""; }
    }
    if (plugin.vault._map) lines.push("", "How this vault is laid out:", plugin.vault._map);
  }
  if (s.vaultNotes) {
    lines.push("", "What the user says about how their vault works:", String(s.vaultNotes).slice(0, 2000));
  }

  // The note that carries the user's own context. Read fresh each turn so
  // edits to it take effect without a reload.
  if (s.contextNote) {
    try {
      const f = plugin.vault.resolve(s.contextNote);
      if (f) {
        const body = stripMarkdown(await plugin.app.vault.cachedRead(f)).slice(0, 4000);
        if (body) lines.push("", "What the user told you about themselves and their work:", body);
      }
    } catch {}
  }

  lines.push("", `Reply in the same language the user speaks to you in.`);
  // Spelled out rather than mentioned in passing. One clause at the end of a
  // long prompt was not enough to stop "the last couple of days" being served
  // from February: the model had the date and no reason to connect it to the
  // fact that its only search tool cannot see dates at all.
  lines.push("",
    `Today is ${todayKey()} (DD-MM-YYYY).`,
    "Anything about a stretch of time — \"the last few days\", \"this week\", \"lately\", \"recently\" — is answered with recent_notes, never with search_notes. search_notes ranks by topic alone and cannot tell this month from last year.",
    "Before you say when something happened, check the date you were actually given for it. Do not date anything from memory, and do not present an old note as recent.");
  return lines.join("\n");
}

/* ============================================================
 *  Runner
 *
 *  `onEvent` reports progress to the view: tool activity, the final
 *  answer, and errors. Destructive tools call back through
 *  `confirm` and block until the user answers with the keyboard.
 * ========================================================== */
class Agent {
  constructor(plugin) {
    this.plugin = plugin;
    this.cancelled = false;
    // Aborting the request is what makes "stop" mean stopped. Without it the
    // panel went quiet while the model carried on writing, and billing with it.
    this.abort = typeof AbortController !== "undefined" ? new AbortController() : null;
    // Which notes fed this answer. Chat mode lists them under the reply so
    // an answer can be traced back to what it came from.
    this.sources = [];
  }

  cancel() {
    this.cancelled = true;
    if (this.abort) { try { this.abort.abort(); } catch {} }
  }

  /**
   * One model call, streamed where that is possible and buffered where it is
   * not. A stream that fails for any reason — CORS, a proxy that will not
   * chunk, a provider that ignores `stream` — falls back rather than surfacing:
   * the answer matters more than the way it arrived.
   */
  async ask(messages, opts, onDelta) {
    const ai = this.plugin.ai;
    // Not gated on onDelta: the reactor shows nothing as it arrives, but it
    // still gains the thing streaming brings with it — a request that can
    // actually be aborted. Voice answers are the long ones, so that is where
    // "stop" quietly costing money mattered most.
    const streamable = this.plugin.settings.streamReplies && ai.canStream();
    if (streamable) {
      try {
        return await ai.chatStream(messages, { ...opts, signal: this.abort && this.abort.signal }, onDelta);
      } catch (e) {
        if (this.cancelled || (e && e.name === "AbortError")) throw e;
        console.warn("[Elton AI] streaming unavailable, falling back:", e.message);
      }
    }
    return await ai.chat(messages, opts);
  }

  noteSource(file) {
    if (!file || this.sources.some((s) => s.path === file.path)) return;
    this.sources.push({ path: file.path, title: file.basename });
  }

  async run(history, userText, { onEvent, confirm, onSegment, onDelta, written = false, channel = "" }) {
    const plugin = this.plugin;
    const s = plugin.settings;
    const V = plugin.vault;
    // Индекс скиллов подтягиваем один раз за сессию: он нужен и инструментам,
    // и системному промпту. Нет прокси или сети — просто работаем без них.
    // Built-in guides first, then whatever the proxy adds for subscribers.
    // The built-in ones ship inside main.js, so they are there for everyone
    // who installed the plugin, with no key and no second download.
    if (s._skillIndex === undefined) {
      let remote = [];
      try { remote = await plugin.ai.skillIndex(); } catch { remote = []; }
      const builtin = builtinSkillsFor(plugin.app);
      const taken = new Set(remote.map((x) => x.name));
      s._skillIndex = remote.concat(builtin.filter((x) => !taken.has(x.name)));
    }
    const tools = buildTools(s, plugin);

    const messages = [
      { role: "system", content: await buildSystemPrompt(plugin, { written, channel }) },
      ...history,
    ];

    // The note on screen is the strongest clue to what "this" refers to.
    const active = plugin.lastNote;
    let opener = userText;
    if (active && s.canRead && V.inScope(active.path)) {
      try {
        const body = (await V.read(active, 1500));
        opener = `[The note currently open on the user's screen is "${active.basename}" (${active.path}). Its content:\n${body}\n]\n\nThe user says: ${userText}`;
      } catch {}
    }
    messages.push({ role: "user", content: opener });

    const budget = { maxTokens: plugin.settings.replyTokens };

    /* Two models, split by what the step is actually for.
       Measured through the proxy on the same request: picking a tool takes
       Sonnet 2.6s and Gemini Flash 0.6s, and they pick the SAME tool — the
       decision is "which of these seventeen", not a judgement call. That step
       repeats two to four times a turn, so it is most of the wait before the
       first word. Writing the answer is the one step where the strong model
       earns its keep, and it happens once. */
    const fast = fastModelFor(s);
    // True once the strong model has taken over. From then on it runs the loop
    // itself — it can still call tools, which is what makes "create a note"
    // actually create one.
    let handed = !fast;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.cancelled) return null;
      const opts = handed ? { tools, ...budget } : { tools, ...budget, model: fast };
      // Deltas are only worth showing for the step that turns out to be the
      // answer, and which step that is only becomes clear once it arrives with
      // no tool calls. So they go out as they come and the view discards them
      // if the step turns out to have been a search after all.
      const msg = await this.ask(messages, opts, handed ? onDelta : null);
      if (this.cancelled) return null;

      const calls = msg.tool_calls || [];
      if (!calls.length) {
        if (handed) return await this.finishAnswer(messages, msg, budget, onSegment);
        // The quick model has stopped reaching for tools. Everything it
        // gathered is in `messages`; the strong model continues from here —
        // answering, or doing the work the quick one only talked about.
        handed = true;
        if (onDelta) onDelta(null, "");
        messages.push(TAKE_OVER);
        continue;
      }
      if (onDelta) onDelta(null, "");   // that step was tool use — clear the draft

      messages.push(msg);
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
        let result;
        try {
          result = await this.runTool(call.function.name, args, { onEvent, confirm });
        } catch (e) {
          result = "That failed: " + e.message;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: String(result).slice(0, 8000) });
      }
    }

    // Out of steps — ask for a plain answer with whatever it has. `tools` goes
    // with it for the reason in HANDOVER: dropping it here returned an empty
    // message, so running out of steps produced no answer at all.
    const final = await this.ask(messages.concat([HANDOVER]), { tools, ...budget }, onDelta);
    return await this.finishAnswer(messages, final, budget, onSegment);
  }

  /**
   * Stitch a truncated reply back together. Models hit `max_tokens` and stop
   * mid-word without a word of warning — `finish_reason` is the only signal.
   *
   * The cut lands at an arbitrary token, so the seam cannot be glued by
   * guesswork: "начина" + "лся" needs no space, "Всё это" + "работает" does,
   * and nothing in the text says which. So the dangling fragment is dropped
   * back to the last sentence that finished, and the model rewrites from
   * there — a clean join beats a clever one.
   */
  async finishAnswer(messages, msg, opts, onSegment) {
    let text = String(msg.content || "").trim();
    let reason = msg.finishReason;
    // How much of `text` has already been handed over. Fetching the rest takes
    // tens of seconds, so the settled part goes out before that wait, not after.
    let handed = 0;
    const hand = (piece) => { if (onSegment && piece) onSegment(piece); };

    for (let i = 0; i < MAX_CONTINUATIONS && reason === "length"; i++) {
      if (this.cancelled) break;
      const kept = wholeSentences(text);
      if (kept.length > handed) { hand(kept.slice(handed).trim()); handed = kept.length; }
      const next = await this.plugin.ai.chat(
        messages.concat([
          { role: "assistant", content: kept },
          { role: "user", content: CONTINUE_PROMPT },
        ]),
        opts,
      );
      const more = String(next.content || "").trim();
      if (!more) break;
      text = kept ? kept + " " + more : more;
      // Nothing had finished, so the answer was started over — anything handed
      // out would have been from a draft that no longer exists.
      if (!kept) handed = 0;
      reason = next.finishReason;
    }

    // Still truncated after the last allowed round: end on the last finished
    // sentence rather than mid-word. A short clean answer reads as an answer;
    // one that stops mid-word reads as a bug.
    if (reason === "length") text = wholeSentences(text) || text;
    hand(text.slice(handed).trim());
    return text;
  }

  async runTool(name, args, { onEvent, confirm }) {
    const plugin = this.plugin;
    const s = plugin.settings;
    const V = plugin.vault;

    switch (name) {
      case "search_notes": {
        onEvent({ kind: "action", text: t("Searching: {0}", args.query) });
        const hits = await V.search(args.query, 6);
        if (!hits.length) return "Nothing found for that wording. Try other words, or a broader query.";
        const out = [];
        for (const h of hits) {
          const f = V.resolve(h.path);
          if (!f) continue;
          this.noteSource(f);
          out.push(`— "${f.basename}" (${f.path})\n${await V.snippet(f, args.query, 350)}`);
        }
        return "Found:\n\n" + out.join("\n\n");
      }

      case "read_note": {
        const f = V.resolve(args.path);
        if (!f) return `No note called "${args.path}".`;
        this.noteSource(f);
        onEvent({ kind: "action", text: t("Read: {0}", f.basename) });
        return `"${f.basename}" (${f.path}):\n\n${await V.read(f)}`;
      }

      case "search_web": {
        if (!webSearchOK(s)) return "Web search is switched off in settings.";
        onEvent({ kind: "action", text: t("Searching the web: {0}", args.query) });
        const r = await plugin.ai.webSearch(args.query, { maxResults: s.webSearchResults || 5 });
        if (!r.answer && !r.citations.length) return "The web search came back empty. Try different words.";
        const src = r.citations.length ? "\n\nSources:\n" + r.citations.map((c) => `— ${c.title}: ${c.url}`).join("\n") : "";
        return "Web results:\n\n" + (r.answer || "(no summary returned)") + src;
      }

      case "load_skill": {
        const name = String(args.name || "").trim();
        onEvent({ kind: "action", text: t("Reading the guide: {0}", name) });
        // A built-in guide needs no network, so it also works with a local
        // model, with no key, and offline.
        const own = builtinSkillText(name);
        if (own) return `Skill "${name}":\n\n${own}`;
        try {
          const text = await plugin.ai.skillText(name);
          if (!text) return `No skill called "${name}". Available: ${(s._skillIndex || []).map((x) => x.name).join(", ")}`;
          return `Skill "${name}":\n\n${text}`;
        } catch (e) {
          return `Could not load the skill "${name}": ${e.message}`;
        }
      }

      case "open_note": {
        const f = V.resolve(args.path);
        if (!f) return `No note called "${args.path}".`;
        await V.openNote(f);
        onEvent({ kind: "action", text: t("Opened: {0}", f.basename) });
        return `Opened "${f.basename}" on screen. Tell the user briefly that it is in front of them.`;
      }

      case "list_notes": {
        // Resolve the spoken name first: the model says "inbox", the vault
        // calls it "0. Files/5. Inbox", and a literal prefix match finds
        // neither.
        const dir = V.folder(args.folder);
        if (!dir && args.folder) {
          const all = allFolders(this.plugin.app).filter((p) => p && V.inScope(p)).slice(0, 40);
          return `No folder matching "${args.folder}". Folders that exist:\n${all.join("\n")}`;
        }
        const list = V.files().filter((f) => !dir || f.path.startsWith(dir + "/")).slice(0, 60);
        onEvent({ kind: "action", text: t("Looking in: {0}", dir || "/") });
        if (!list.length) return `"${dir}" has no notes in it.`;
        return `"${dir}" contains:\n` + list.map((f) => `— ${f.basename} (${f.path})`).join("\n");
      }

      case "find_files": {
        onEvent({ kind: "action", text: t("Searching: {0}", args.pattern) });
        const hits = V.listByGlob(args.pattern, 60);
        if (!hits.length) return `Nothing matches "${args.pattern}". Try a looser pattern, like *word*.`;
        return hits.map((f) => `— ${f.basename} (${f.path})`).join("\n");
      }

      case "grep": {
        onEvent({ kind: "action", text: t("Searching: {0}", args.query) });
        const hits = await V.grep(args.query, args.pattern, 40);
        if (!hits.length) return `"${args.query}" does not appear in any note.`;
        for (const h of hits.slice(0, 8)) { const f = V.resolve(h.path); if (f) this.noteSource(f); }
        return hits.map((h) => `${h.path}:${h.line}  ${h.text}`).join("\n");
      }

      case "recent_notes": {
        const days = Math.min(60, Math.max(1, Number(args.days) || 3));
        onEvent({ kind: "action", text: t("Looking at the last {0} days", days) });
        const files = V.recentNotes(days, 30);
        if (!files.length) return `Nothing was written or changed in the last ${days} days.`;
        for (const f of files.slice(0, 8)) this.noteSource(f);
        // The date goes on every line: without it the model has the notes but
        // still no idea which of them is yesterday's.
        const lines = files.map((f) => `${todayKey(new Date(f.stat.mtime))}  ${f.path}`);
        return `Notes changed in the last ${days} days, newest first (today is ${todayKey()}):\n${lines.join("\n")}\n\nRead the ones that matter with read_note.`;
      }

      case "daily_note": {
        const f = V.dailyNote(args.when);
        if (!f) return `No daily note for "${args.when}".`;
        onEvent({ kind: "action", text: t("Read: {0}", f.basename) });
        return `Daily note "${f.basename}":\n\n${await V.read(f, 4000)}`;
      }

      case "list_tabs": {
        if (!s.canControlUI) return "Working with tabs is switched off in settings.";
        const tabs = V.listTabs();
        onEvent({ kind: "action", text: t("Looking at what's open") });
        if (!tabs.length) return "The main area is empty — nothing is open.";
        return "Open right now:\n" + tabs.map((x, i) =>
          `${i + 1}. "${x.title}"${x.path ? ` (${x.path})` : ` [${x.type}]`}${x.active ? " — in front" : ""}`).join("\n");
      }

      case "open_url": {
        if (!s.canControlUI) return "Opening web pages is switched off in settings.";
        try {
          const r = await V.openUrl(args.url);
          onEvent({ kind: "action", text: t("Opened: {0}", r.url) });
          return r.where === "obsidian"
            ? `Opened ${r.url} in a tab in front of the user. Say briefly what it is.`
            : `The web viewer is switched off, so ${r.url} opened in the system browser instead. Tell the user that.`;
        } catch (e) {
          return `Could not open that: ${e.message}`;
        }
      }

      case "close_tab": {
        if (!s.canControlUI) return "Working with tabs is switched off in settings.";
        const wantsAll = !!args.all || !String(args.name || "").trim();
        const targets = V.matchTabs(wantsAll ? "" : args.name).filter((x) => x.type !== VIEW_TYPE);
        if (!targets.length) {
          return wantsAll ? "There is nothing open to close."
            : `Nothing open is called "${args.name}". Call list_tabs to see what actually is.`;
        }
        // One tab named outright is what was asked for. Everything at once, or
        // a vague word that caught several, is not — that gets a keypress.
        if (wantsAll || targets.length > 1) {
          const ok = await confirm({
            title: t("Close tabs?"),
            body: targets.map((x) => x.title).join("\n"),
            note: t("Notes save as you type, so nothing is lost."),
            danger: false,
          });
          if (!ok) return "The user declined, so nothing was closed. Say so plainly and do not try again.";
        }
        const closed = V.closeTabs(targets);
        onEvent({ kind: "action", text: t("Closed: {0}", closed.length) });
        if (!closed.length) return "Nothing could be closed — the only match was the assistant's own panel.";
        return `Closed: ${closed.map((n) => `"${n}"`).join(", ")}.`;
      }

      case "open_beside": {
        if (!s.canControlUI) return "Working with tabs is switched off in settings.";
        const f = V.resolve(args.path);
        if (!f) return `No note called "${args.path}".`;
        await V.openNoteSplit(f);
        this.noteSource(f);
        onEvent({ kind: "action", text: t("Opened beside: {0}", f.basename) });
        return `Opened "${f.basename}" beside what was already there.`;
      }

      case "read_template": {
        const want = String(args.name || "").trim();
        const list = V.templates();
        const low = want.toLowerCase().replace(/\.md$/, "");
        const f = list.find((x) => x.path === want)
          || list.find((x) => x.basename.toLowerCase() === low)
          || list.find((x) => x.basename.toLowerCase().includes(low));
        if (!f) return `No template called "${want}". These exist: ${list.map((x) => x.basename).join(", ") || "none"}`;
        onEvent({ kind: "action", text: t("Reading the template: {0}", f.basename) });
        // Raw, not stripped: the frontmatter and the placeholders ARE the
        // template. Reading it as prose would drop exactly the part that
        // decides what the finished note looks like.
        const raw = await plugin.app.vault.cachedRead(f);
        return `Template "${f.basename}" (${f.path}):\n\n${raw.slice(0, 6000)}\n\n`
          + "Build the new note on this: same properties, same headings, same links. "
          + "Replace template placeholders ({{date}}, <% ... %> and the like) with real values — "
          + "the assistant's notes are not processed by the template plugin afterwards.";
      }

      case "create_note": {
        if (!s.canCreate) return "Creating notes is switched off in settings.";
        if (s.confirmEveryEdit) {
          const ok = await confirm({ title: t("Confirm change"), body: `${t("Created: {0}", safeTitle(args.title))}`, danger: false });
          if (!ok) return "The user declined. Do not retry.";
        }
        const f = await V.createNote(args.title, args.content, args.folder);
        onEvent({ kind: "action", text: t("Created: {0}", f.basename) });
        await V.openNote(f);
        return `Created "${f.basename}" at ${f.path} and opened it. ${V.folderConventions(f.parent && f.parent.path)}`.trim();
      }

      case "create_board": {
        if (!s.canCreate) return "Creating notes is switched off in settings.";
        if (!V.kanbanReady()) return "The Kanban plugin is not enabled, so a board cannot be rendered. Offer an ordinary note instead.";
        if (s.confirmEveryEdit) {
          const ok = await confirm({ title: t("Confirm change"), body: `${t("Created: {0}", safeTitle(args.title))}`, danger: false });
          if (!ok) return "The user declined. Do not retry.";
        }
        const f = await V.createBoard(args.title, args.columns, args.folder, args.properties);
        onEvent({ kind: "action", text: t("Board created: {0}", f.basename) });
        await V.openNote(f);
        const names = (args.columns || []).map((c) => c && c.name).filter(Boolean).join(", ");
        return `Created the board "${f.basename}" at ${f.path} with columns: ${names}. It is open and rendering as a board. ${V.folderConventions(f.parent && f.parent.path)}`.trim();
      }

      case "append_note": {
        if (!s.canEdit) return "Editing notes is switched off in settings.";
        const f = V.resolve(args.path);
        if (!f) return `No note called "${args.path}".`;
        if (s.confirmEveryEdit) {
          const ok = await confirm({ title: t("Confirm change"), body: `${f.basename}\n\n${String(args.content).slice(0, 400)}`, danger: false });
          if (!ok) return "The user declined. Do not retry.";
        }
        await V.appendToNote(f, args.content, args.heading);
        onEvent({ kind: "action", text: t("Edited: {0}", f.basename) });
        return `Added it to "${f.basename}".`;
      }

      case "replace_in_note": {
        if (!s.canEdit) return "Editing notes is switched off in settings.";
        const f = V.resolve(args.path);
        if (!f) return `No note called "${args.path}".`;
        if (s.confirmEveryEdit) {
          const ok = await confirm({ title: t("Confirm change"), body: `${f.basename}\n\n− ${String(args.find).slice(0, 200)}\n+ ${String(args.replace).slice(0, 200)}`, danger: false });
          if (!ok) return "The user declined. Do not retry.";
        }
        try { await V.replaceInNote(f, args.find, args.replace); }
        catch { return `That exact text is not in "${f.basename}". Read the note and use text that matches it.`; }
        onEvent({ kind: "action", text: t("Edited: {0}", f.basename) });
        return `Changed it in "${f.basename}".`;
      }

      case "delete_note": {
        if (!s.canDelete) return "Deleting notes is switched off in settings. Tell the user they can enable it there.";
        const f = V.resolve(args.path);
        if (!f) return `No note called "${args.path}".`;
        // The hard stop. Nothing is deleted without a key press, whatever the
        // model decided or the prompt said.
        const ok = await confirm({
          title: t("Confirm deletion"),
          body: f.path,
          note: t("It goes to the system trash, so it can still be recovered from there."),
          danger: true,
        });
        if (!ok) return `The user did not confirm, so "${f.basename}" was NOT deleted. Say so plainly and do not try again.`;
        await plugin.app.fileManager.trashFile(f);
        onEvent({ kind: "action", text: t("Deleted: {0}", f.basename) });
        return `Deleted "${f.basename}" (moved to trash).`;
      }

      case "undo_last": {
        const p = await V.undo();
        onEvent({ kind: "action", text: p ? t("Undone") : t("Nothing to undo") });
        return p ? `Restored "${p}" to how it was.` : "There is nothing to undo.";
      }

      default:
        return `No such tool: ${name}`;
    }
  }
}
