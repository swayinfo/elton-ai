/* ============================================================
 *  Provider transport
 *
 *  Every supported provider speaks OpenAI's chat-completions
 *  dialect, so there is one request path and a provider is only a
 *  base URL, a key and a model name.
 *
 *  Requests go through Obsidian's requestUrl rather than fetch:
 *  fetch from a plugin is a browser request subject to CORS, and a
 *  local Ollama server rejects the app://obsidian.md origin unless
 *  the user sets OLLAMA_ORIGINS by hand. requestUrl is made by the
 *  app itself, so a local model works with no setup at all — which
 *  is the whole point of offering the local option.
 * ========================================================== */

/* ============================================================
 *  Streaming
 *
 *  The answer exists token by token on the server long before it
 *  exists as a whole, and the panel used to wait for the whole
 *  thing — tens of seconds of "Thinking…" for text that had been
 *  ready to read from the first second.
 *
 *  Reassembly is the delicate part, and it is delicate in a way
 *  that hides: content is easy, but a tool call arrives split
 *  across events — the name in one, the arguments in fragments
 *  across four more, keyed by an index. Rebuild it wrongly and the
 *  model appears to call a tool with broken arguments, which reads
 *  as the model being stupid rather than as our parser being
 *  wrong. So the folding below is a pure function, and the tests
 *  drive it with streams captured from the real service.
 * ========================================================== */

function newStreamAcc() {
  return { content: "", calls: [], finishReason: null, usage: null };
}

/** Fold one decoded `data:` object into the message being assembled. */
function foldStreamEvent(acc, json) {
  if (!json) return acc;
  // Usage rides on a late chunk, sometimes one that carries no choice at all.
  if (json.usage) acc.usage = json.usage;
  const choice = json.choices && json.choices[0];
  if (!choice) return acc;
  if (choice.finish_reason) acc.finishReason = choice.finish_reason;

  const delta = choice.delta || {};
  if (typeof delta.content === "string") acc.content += delta.content;

  for (const part of delta.tool_calls || []) {
    // `index` is the only reliable identity: id and name arrive once, in the
    // first fragment, and everything after that is arguments with neither.
    const i = Number(part.index) || 0;
    const slot = acc.calls[i] || (acc.calls[i] = { id: "", type: "function", function: { name: "", arguments: "" } });
    if (part.id) slot.id = part.id;
    if (part.type) slot.type = part.type;
    const f = part.function || {};
    if (f.name) slot.function.name = f.name;
    // Arguments are a JSON string built up a few characters at a time.
    if (typeof f.arguments === "string") slot.function.arguments += f.arguments;
  }
  return acc;
}

/** Split a chunk of SSE text into decoded events, keeping any partial tail. */
function readStreamChunk(buffer, onEvent) {
  let rest = buffer;
  let nl;
  while ((nl = rest.indexOf("\n")) >= 0) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (!line || line.startsWith(":")) continue;       // keep-alive comment
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") { onEvent(null, true); continue; }
    try { onEvent(JSON.parse(payload), false); } catch { /* a half-written line */ }
  }
  return rest;
}

/** The assembled accumulator, in the shape the agent expects from chat(). */
function finishStreamAcc(acc) {
  const msg = { role: "assistant", content: acc.content || "" };
  const calls = acc.calls.filter(Boolean);
  if (calls.length) msg.tool_calls = calls;
  Object.defineProperty(msg, "finishReason", {
    value: acc.finishReason || "stop", enumerable: false, writable: true,
  });
  return msg;
}

class AIClient {
  constructor(plugin) { this.plugin = plugin; }

  get s() { return this.plugin.settings; }

  /** Active provider, or the cloud fallback when asked for a voice-capable one. */
  profile(forVoice = false) {
    const s = this.s;
    if (forVoice && s.provider === "local" && s.cloudFallback.enabled && s.cloudFallback.key) {
      const id = s.cloudFallback.provider;
      return { id, key: s.cloudFallback.key, base: s.bases[id] || PROVIDERS[id].base, model: s.models[id] || PROVIDERS[id].model };
    }
    const id = s.provider;
    return { id, key: s.keys[id] || "", base: s.bases[id] || PROVIDERS[id].base, model: s.models[id] || PROVIDERS[id].model };
  }

  isConfigured() {
    const p = this.profile();
    if (!p.base) return false;
    return PROVIDERS[p.id].needsKey ? !!p.key : true;
  }

  /** Can this profile do speech-to-text and text-to-speech at all? */
  hasCloud() {
    const p = this.profile(true);
    return p.id !== "local" && !!p.key;
  }

  headers(p, endpointPath) {
    const h = { "Content-Type": "application/json" };
    if (p.key) h["Authorization"] = "Bearer " + p.key;
    if (p.id === "openrouter") {
      h["HTTP-Referer"] = "https://obsidian.md";
      h["X-Title"] = "Elton AI";
    }
    // The Elton AI proxy routes by an explicit endpoint header rather than
    // by path, so it can sit in front of several upstreams.
    if (PROVIDERS[p.id] && PROVIDERS[p.id].proxyHeader) h["x-endpoint"] = endpointPath;
    return h;
  }

  async post(path, body, opts = {}) {
    const p = opts.profile || this.profile(!!opts.forVoice);
    const res = await requestUrl({
      url: joinUrl(p.base, path),
      method: "POST",
      headers: this.headers(p, path),
      body: JSON.stringify(body),
      throw: false,
      contentType: "application/json",
    });
    if (res.status < 200 || res.status >= 300) {
      let detail = "";
      try { detail = (res.json && res.json.error && (res.json.error.message || res.json.error)) || String(res.text || "").slice(0, 200); }
      catch { detail = String(res.text || "").slice(0, 200); }
      throw new Error(`HTTP ${res.status} — ${detail}`);
    }
    return res;
  }

  /* ── Скиллы ─────────────────────────────────────────────────────────
     Тот же набор, что у плагина Системы: короткий индекс (имя + описание)
     уходит в системный промпт, а полный текст модель тянет сама через
     load_skill — так контекст не забивается тем, что сейчас не нужно.
     Работают только через прокси Elton AI: там они и лежат. */

  skillsAvailable() {
    const p = this.profile();
    return p.id === "obsimind" && !!p.base;
  }

  async get(path, opts = {}) {
    const p = opts.profile || this.profile();
    const res = await requestUrl({
      url: joinUrl(p.base, path),
      method: "GET",
      headers: this.headers(p, path),
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) throw new Error("HTTP " + res.status);
    return res;
  }

  /** Индекс скиллов: [{ name, description }]. Кэшируем на сессию. */
  async skillIndex() {
    if (!this.skillsAvailable()) return [];
    if (this._skillIndex) return this._skillIndex;
    try {
      const res = await this.get(`/skills/manifest?v=${SKILLS_VERSION}`);
      const list = res.json && Array.isArray(res.json.skills) ? res.json.skills : [];
      this._skillIndex = list.filter((s) => s && s.name);
    } catch (e) {
      console.warn("[Elton AI] the skill index is unavailable —", e.message);
      this._skillIndex = [];
    }
    return this._skillIndex;
  }

  /** Полный текст одного скилла. */
  async skillText(name) {
    const key = String(name || "").replace(/\.md$/i, "").trim();
    if (!key) return "";
    this._skillCache = this._skillCache || new Map();
    if (this._skillCache.has(key)) return this._skillCache.get(key);
    const res = await this.get(`/skills/${encodeURIComponent(key)}?v=${SKILLS_VERSION}`);
    let text = "";
    if (res.json && typeof res.json.content === "string") text = res.json.content;
    else text = String(res.text || "");
    this._skillCache.set(key, text);
    return text;
  }

  /** One chat turn. Returns the raw message object so tool_calls survive. */
  /**
   * Remember what a call consumed.
   *
   * A single answer is several calls — a search, a read, the reply, and a
   * continuation or two — so the number worth showing is the sum over a turn,
   * not the last one. The tracker adds it up; this only hands it over.
   */
  noteUsage(usage) {
    if (!usage || !this.plugin.spend) return;
    this.plugin.spend.add(usage);
  }

  async chat(messages, { tools, maxTokens = 900, temperature = 0.3, model } = {}) {
    const p = this.profile();
    const body = {
      model: model || p.model,
      messages,
      max_tokens: maxTokens,
      temperature,
    };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = "auto"; }
    const res = await this.post("/v1/chat/completions", body, { profile: p });
    const choice = res.json && res.json.choices && res.json.choices[0];
    const msg = choice && choice.message;
    if (!msg) throw new Error("Empty response from the model");
    this.noteUsage(res.json && res.json.usage);
    // A reply that hit the token ceiling stops mid-word and says nothing about
    // it. Non-enumerable so the message can still be pushed back into the
    // conversation without this leaking into the request body.
    Object.defineProperty(msg, "finishReason", {
      value: choice.finish_reason || "stop", enumerable: false, writable: true,
    });
    return msg;
  }

  /** Can this provider be streamed at all? */
  canStream() {
    const id = this.plugin.settings.provider;
    // A local server rejects the app://obsidian.md origin unless the user set
    // OLLAMA_ORIGINS by hand, and fetch — unlike requestUrl — is subject to
    // that. Not worth breaking the one option that needs no setup.
    return id !== "local";
  }

  /**
   * The same call as chat(), delivered as it is written.
   *
   * Uses fetch rather than requestUrl because requestUrl hands back a finished
   * body and there is no way to watch one arrive. That costs us CORS, which is
   * why local providers are excluded above — and why any failure here falls
   * back to the buffered path rather than surfacing as a broken assistant.
   *
   * `signal` is what finally makes cancelling real: before this, stopping an
   * answer stopped the display while the request carried on and kept billing.
   */
  async chatStream(messages, { tools, maxTokens = 900, temperature = 0.3, model, signal } = {}, onDelta) {
    const p = this.profile();
    const body = {
      model: model || p.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = "auto"; }

    const res = await fetch(joinUrl(p.base, "/v1/chat/completions"), {
      method: "POST",
      headers: this.headers(p, "/v1/chat/completions"),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 200); } catch {}
      throw new Error(`HTTP ${res.status} — ${detail}`);
    }

    const acc = newStreamAcc();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let handed = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = readStreamChunk(buffer + decoder.decode(value, { stream: true }), (json) => {
        foldStreamEvent(acc, json);
      });
      // Hand over only what is new, so the caller appends rather than redraws.
      if (onDelta && acc.content.length > handed) {
        onDelta(acc.content.slice(handed), acc.content);
        handed = acc.content.length;
      }
    }
    this.noteUsage(acc.usage);
    return finishStreamAcc(acc);
  }

  /**
   * A web search that comes back as a written answer plus its sources.
   *
   * OpenRouter runs the search itself when the request carries a
   * `plugins: [{ id: "web" }]` block: it searches, feeds the results to the
   * model, and folds the citations into `message.annotations`. The Elton AI
   * proxy forwards the same block to OpenRouter, so both providers work — a
   * local model and OpenAI direct do not, which is why the tool that calls
   * this is only offered for the two that route through OpenRouter.
   */
  async webSearch(query, { maxResults = 5 } = {}) {
    const p = this.profile();
    const body = {
      model: p.model,
      messages: [
        { role: "system", content: "You are a web research helper. Search the web for the user's query and answer it concisely and factually from what you find. Ground every claim in the results." },
        { role: "user", content: String(query || "").slice(0, 1000) },
      ],
      plugins: [{ id: "web", max_results: Math.max(1, Math.min(10, maxResults)) }],
      max_tokens: 1200,
      temperature: 0.2,
    };
    const res = await this.post("/v1/chat/completions", body, { profile: p });
    const msg = res.json && res.json.choices && res.json.choices[0] && res.json.choices[0].message;
    const answer = String((msg && msg.content) || "").trim();
    const citations = [];
    for (const a of (msg && msg.annotations) || []) {
      const u = a && a.url_citation;
      if (u && u.url) citations.push({ title: u.title || u.url, url: u.url });
    }
    return { answer, citations };
  }

  /** Model list, for the picker in settings. */
  async listModels() {
    const p = this.profile();
    const res = await requestUrl({
      url: joinUrl(p.base, "/v1/models"),
      method: "GET",
      headers: this.headers(p, "/v1/models"),
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    const list = (res.json && res.json.data) || [];
    return list.map((m) => m.id).filter(Boolean).sort();
  }

  async embed(text) {
    const p = this.profile();
    const res = await this.post("/v1/embeddings", {
      model: this.s.embedModel,
      input: String(text || "").slice(0, 12000),
    }, { profile: p });
    const v = res.json && res.json.data && res.json.data[0] && res.json.data[0].embedding;
    if (!v) throw new Error("Empty embedding response");
    return v;
  }

  /* ── speech ───────────────────────────────────────────────
   * Both directions need a cloud provider. With a local model and
   * no fallback key these throw, and the view degrades to text.
   */
  /**
   * `format` must be what the recorder actually produced. Desktop and Android
   * give webm/opus, iOS gives mp4/AAC — sending one under the other's name is
   * how the assistant ends up "mishearing everything on the phone".
   */
  /**
   * Прочитать текст с фотографии.
   *
   * Тем же путём, что и звук, — через обычный чат: это единственная форма,
   * которую понимают все облачные провайдеры. Модель берётся быстрая: здесь
   * не нужно рассуждать, нужно аккуратно переписать увиденное.
   *
   * Просим именно переписать, а не пересказать. Снимок бумажной страницы —
   * это чужой текст, и додумывать за него нельзя: неразобранное честнее
   * пометить, чем угадать.
   */
  async readPhoto(base64Image, mime = "image/jpeg") {
    const p = this.profile(true);
    if (p.id === "local") throw new Error("no-cloud");
    const spoken = this.s.speechLang || LANG;
    const named = spoken === "ru" ? "Russian" : "English";
    const res = await this.post("/v1/chat/completions", {
      model: p.id === "openai" ? "gpt-4o-mini" : "google/gemini-2.5-flash",
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: "Read every piece of text in this photo and write it out. "
              + `It is most likely handwritten or printed ${named}. `
              + "Copy it, do not summarise and do not rephrase. Keep the original "
              + "structure: headings, lists, numbering, indentation. Keep formulas "
              + "and numbers exactly as written. "
              // Кириллица и латиница делят вид у половины букв, и модель
              // переписывает CAC как САС. Для сокращений это важно: искать
              // потом по заметкам будут латиницей.
              + "Latin abbreviations and terms (LTV, CAC, ARPU, SQL, KPI and the like) "
              + "must stay in Latin letters, never transliterated into Cyrillic. "
              + "If a word is genuinely unreadable, write [неразборчиво] in its place "
              + "instead of guessing. If the photo has no text at all, reply with "
              + "the single word: NOTEXT. Reply with the text only — no commentary.",
          },
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64Image}` } },
        ],
      }],
      max_tokens: 4000,
      temperature: 0,
    }, { profile: p });
    // Ответ лежит в res.json, а не в самом res: post отдаёт ответ запроса
    // целиком — со статусом и заголовками. Без .json здесь всегда выходила
    // пустая строка, а человек в ответ получал «на фотографии не видно
    // текста» — при том что модель текст прочитала.
    const out = res.json && res.json.choices && res.json.choices[0]
      && res.json.choices[0].message;
    return String((out && out.content) || "").trim();
  }

  async transcribe(base64Audio, format = "webm") {
    const p = this.profile(true);
    if (p.id === "local") throw new Error("no-cloud");
    // Everything but OpenAI direct goes through the chat endpoint rather than
    // /audio/transcriptions: that is the shape those providers accept, and it
    // lets us pass a hint about what the audio is likely to contain.
    /* The language is stated, not guessed.
     *
     * Left to work it out, the model hears Russian and sometimes writes
     * Polish — same sound inventory, close enough vocabulary, and a short
     * noisy clip gives it nothing to break the tie. What came back was
     * "Ty powinien zmienić nazwę zametki": the user's own words, spelled in
     * another language, so the assistant then answered the wrong question.
     *
     * Which language is a setting, defaulting to the one the interface is in.
     * Someone who reads the plugin in Russian is overwhelmingly likely to
     * speak to it in Russian. */
    const spoken = this.s.speechLang || LANG;
    const named = spoken === "ru" ? "Russian" : "English";
    const script = spoken === "ru" ? " Write it in Cyrillic." : "";
    if (p.id === "openai") return this.transcribeDirect(p, base64Audio, format, spoken);
    const res = await this.post("/v1/chat/completions", {
      model: "google/gemini-2.5-flash",
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: `Transcribe this audio exactly. The speaker is speaking ${named}, so the transcript must be in ${named}.${script} `
              + `Never translate it and never render it in a related language — if a word is unclear, write the ${named} word it most likely was. `
              + "It is a short spoken command to a note-taking assistant. Reply with the transcript only — no commentary, no quotes.",
          },
          { type: "input_audio", input_audio: { data: base64Audio, format } },
        ],
      }],
      max_tokens: 300,
      temperature: 0,
    }, { profile: p });
    const txt = res.json?.choices?.[0]?.message?.content;
    return String(txt || "").trim();
  }

  /**
   * OpenAI direct: the transcript comes from /v1/audio/transcriptions.
   *
   * Its chat endpoint refuses a transcription model outright — HTTP 404,
   * "this is not a chat model" — and the chat models that do take audio only
   * accept wav and mp3, never the webm or mp4 a recorder hands us. The
   * dedicated endpoint takes both, so that is the door for this provider.
   * It wants multipart, which requestUrl will not build, so it is built here.
   */
  async transcribeDirect(p, base64Audio, format, spoken) {
    const bin = atob(base64Audio);
    const audio = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) audio[i] = bin.charCodeAt(i);

    const boundary = "----EltonAI" + Date.now().toString(36);
    /* Заголовки и границы в multipart/form-data разделяются именно CRLF.
       На обычном переводе строки разборщик OpenAI отвечает 400 и жалуется
       на форму, а не на звук, — и голос не работает вообще ни на чём.
       Поэтому перевод строки здесь вынесен в константу: настоящий CRLF
       внутри шаблонной строки не виден глазом и его уже однажды
       выпрямил автоформат, после чего запись голоса замолчала. */
    const CRLF = "\r\n";
    const field = (name, value) =>
      `--${boundary}${CRLF}`
      + `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`
      + `${value}${CRLF}`;
    const enc = new TextEncoder();
    const head = enc.encode(
      field("model", "gpt-transcribe")
      + field("language", spoken)
      + `--${boundary}${CRLF}`
      + `Content-Disposition: form-data; name="file"; filename="audio.${format}"${CRLF}`
      + `Content-Type: audio/${format}${CRLF}${CRLF}`);
    const tail = enc.encode(`${CRLF}--${boundary}--${CRLF}`);
    const body = new Uint8Array(head.length + audio.length + tail.length);
    body.set(head, 0);
    body.set(audio, head.length);
    body.set(tail, head.length + audio.length);

    const res = await requestUrl({
      url: joinUrl(p.base, "/v1/audio/transcriptions"),
      method: "POST",
      headers: {
        "Authorization": "Bearer " + p.key,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: body.buffer,
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      let detail = "";
      try { detail = (res.json && res.json.error && res.json.error.message) || String(res.text || "").slice(0, 200); }
      catch { detail = String(res.text || "").slice(0, 200); }
      throw new Error(`HTTP ${res.status} — ${detail}`);
    }
    return String((res.json && res.json.text) || "").trim();
  }

  /**
   * Cloud text-to-speech. Tries the models in order and returns the first
   * that answers, with the format it came back in — Gemini hands back raw
   * PCM, OpenAI an mp3, and the player needs to know which.
   */
  async speech(text) {
    const p = this.profile(true);
    if (p.id === "local") throw new Error("no-cloud");
    const path = "/v1/audio/speech";
    const cfg = ttsProfileFor(p.id);
    const voice = pickVoice(cfg, this.s.cloudVoice);

    const body = {
      model: this.s.ttsModel || cfg.model,
      input: text,
      voice,
      response_format: cfg.format,
    };
    if (cfg.useSpeed) body.speed = this.s.speechSpeed || 1;
    // The tone instruction sits inside provider.options.<vendor> for a
    // routing proxy and at the top level for OpenAI direct. Send both, so it
    // survives whichever path the request takes.
    const tone = this.s.voiceTone || VOICE_TONE;
    if (tone) {
      body.provider = { options: { [cfg.provider]: { instructions: tone } } };
      if (cfg.provider === "openai") body.instructions = tone;
    }

    const res = await requestUrl({
      url: joinUrl(p.base, path),
      method: "POST",
      headers: this.headers(p, path),
      body: JSON.stringify(body),
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      let detail = "";
      try { detail = String(res.text || "").replace(/\s+/g, " ").slice(0, 160); } catch {}
      throw new Error(`${body.model} → HTTP ${res.status} ${detail}`);
    }
    return { buffer: res.arrayBuffer, format: cfg.format };
  }
}

/* Speech engines, and the voices each one actually accepts.
 *
 * These lists are not decoration. Voice names do not cross vendors: sending
 * OpenAI's "alloy" to Gemini returns a 500, and a silent fallback to the
 * robotic system voice is what the user hears. So the voice is always
 * validated against the engine before the request goes out. */
const TTS_PROFILES = {
  gemini: {
    model: "google/gemini-3.1-flash-tts-preview",
    format: "pcm",
    provider: "google",
    voices: ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"],
    fallback: "Puck",   // lively, and reads Russian well
  },
  openai: {
    model: "gpt-4o-mini-tts",
    format: "mp3",
    provider: "openai",
    useSpeed: true,
    voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
    fallback: "onyx",
  },
};

/** Which speech engine a provider can reach. */
function ttsProfileFor(providerId) {
  return providerId === "openai" ? TTS_PROFILES.openai : TTS_PROFILES.gemini;
}

/** A voice the given engine will accept — the stored one if it is valid. */
function pickVoice(profile, wanted) {
  return profile.voices.includes(wanted) ? wanted : profile.fallback;
}

const VOICE_TONE =
  "A devoted, upbeat AI assistant. Warm and confident, with subtle dry wit. " +
  "A brisk, lively pace and crisp articulation — never flat, never monotone, never sleepy.";

/* ============================================================
 *  Piper — local text-to-speech
 *
 *  Piper is a separate process the user installs once; we only
 *  talk to its HTTP interface. Kept deliberately dumb: if it isn't
 *  running we fall back to the system voice rather than nagging.
 * ========================================================== */
async function piperSpeak(url, text) {
  // POST with a JSON body rather than a query string: the text is arbitrary
  // length and arbitrary script, and a body settles its encoding explicitly
  // instead of leaving it to URL rules.
  const res = await requestUrl({
    url: String(url).replace(/\/+$/, "") + "/",
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({ text }),
    throw: false,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`Piper HTTP ${res.status}`);
  return res.arrayBuffer;
}

async function piperAlive(url) {
  try { await piperSpeak(url, "."); return true; } catch { return false; }
}
