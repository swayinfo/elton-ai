/* ============================================================
 *  Audio — listening, speaking, and being interrupted
 *
 *  Interruption is the reason the microphone stays open for the
 *  whole conversation instead of per phrase: getUserMedia is slow
 *  enough that reopening it each turn would put a gap exactly where
 *  the user is trying to cut in.
 * ========================================================== */

const SPEECH_THRESHOLD = 5;     // RMS above which we call it speech
const MIN_SPEECH_MS = 300;      // shorter than this is a cough, not a phrase
const SILENCE_HANG = 1100;      // pause that ends a turn — long enough to think mid-sentence
const TICK_MS = 100;
const BARGE_GRACE_MS = 700;     // don't hear our own first syllable as an interruption
const BARGE_TICK_MS = 60;
const BARGE_SUSTAIN_MS = 360;   // sustained speech required to take the floor

function rms(analyser, buf) {
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) { const d = buf[i] - 128; sum += d * d; }
  return Math.sqrt(sum / buf.length);
}

/**
 * Wake a context iOS handed back asleep.
 *
 * Safari suspends a fresh AudioContext unless the tap that created it is still
 * on the stack, and a suspended analyser reports pure silence. The level meter
 * then reads zero for a whole utterance and the assistant concludes nobody
 * spoke — on the phone that looks like a microphone that does not work.
 */
async function wakeContext(ctx) {
  if (ctx && ctx.state === "suspended") {
    try { await ctx.resume(); } catch {}
  }
  return ctx;
}

/**
 * Spend a tap on permission to make sound later.
 *
 * iOS only allows audio started by a gesture, and the answer arrives tens of
 * seconds after the tap that asked for it. Playing a moment of nothing while
 * the gesture is still valid buys the right to play the answer when it comes.
 */
let _audioUnlocked = false;
function unlockAudio() {
  if (_audioUnlocked) return;
  _audioUnlocked = true;
  try {
    const ctx = new AudioContext();
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
    wakeContext(ctx);
    window.setTimeout(() => { try { ctx.close(); } catch {} }, 400);
  } catch {}
}

async function openMic(agc = true) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: agc },
  });
  const ctx = new AudioContext();
  await wakeContext(ctx);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  return { stream, ctx, analyser, buf: new Uint8Array(analyser.fftSize) };
}

function closeMic(m) {
  if (!m) return;
  try { m.stream.getTracks().forEach((tr) => tr.stop()); } catch {}
  try { m.ctx.close(); } catch {}
}

/* ── what this device can actually record ────────────────────
 *
 * The single worst mobile bug this plugin had: the format was
 * hard-coded to webm. Desktop and Android record webm/opus, so it
 * was right there and wrong nowhere visible — but iOS records
 * mp4/AAC, and the bytes went to the model labelled "webm". The
 * model got AAC claiming to be Opus and transcribed noise, which
 * looks exactly like "the assistant mishears everything on my
 * phone".
 *
 * So ask the browser instead of assuming. Opus first because it is
 * the smallest thing every model reads; mp4 is what iOS gives and
 * it is read fine as long as it is labelled honestly.
 */
const RECORDING_TYPES = [
  { mime: "audio/webm;codecs=opus", format: "webm" },
  { mime: "audio/webm", format: "webm" },
  { mime: "audio/ogg;codecs=opus", format: "ogg" },
  { mime: "audio/mp4", format: "mp4" },
  { mime: "audio/mp4;codecs=mp4a.40.2", format: "mp4" },
  { mime: "audio/aac", format: "aac" },
];

/**
 * The first recording format this device supports, as {mime, format}.
 *
 * `supports` is injectable so this can be tested for a browser that isn't the
 * one running the test. Returns null when nothing matches, and the caller then
 * lets MediaRecorder pick for itself rather than failing outright.
 */
function pickRecordingType(supports) {
  const can = supports || (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported
    ? (m) => MediaRecorder.isTypeSupported(m)
    : null);
  if (!can) return null;
  for (const t of RECORDING_TYPES) {
    try { if (can(t.mime)) return t; } catch {}
  }
  return null;
}

/** A MIME string back to the short format name the audio API wants. */
function formatFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4") || m.includes("m4a")) return "mp4";
  if (m.includes("aac")) return "aac";
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  return "webm";
}

class Recorder {
  constructor() { this.active = null; }

  /** Record one utterance. Ends on silence, on maxMs, or when told to. */
  async record({ maxMs = 20000, onLevel, getStop, pushToTalk, isPressed }) {
    const mic = await openMic(true);
    const picked = pickRecordingType();
    const recorder = picked ? new MediaRecorder(mic.stream, { mimeType: picked.mime })
      : new MediaRecorder(mic.stream);
    const chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    let spoke = 0, silent = 0;
    const started = Date.now();
    this.active = { recorder, mic };

    const out = await new Promise((resolve) => {
      let done = false, timer = null;
      const finish = () => {
        if (done) return; done = true;
        window.clearInterval(timer);
        const settle = () => {
          closeMic(mic);
          // Whatever the recorder actually produced, not what we hoped for:
          // `recorder.mimeType` is the browser's own answer once it started.
          const mime = recorder.mimeType || (picked && picked.mime) || "audio/webm";
          resolve({
            blob: new Blob(chunks, { type: mime }),
            format: formatFromMime(mime),
            hadSpeech: spoke >= MIN_SPEECH_MS,
          });
        };
        recorder.onstop = settle;
        try { recorder.stop(); } catch { settle(); }
      };
      recorder.start();
      timer = window.setInterval(() => {
        if (getStop && getStop()) return finish();
        const lv = rms(mic.analyser, mic.buf);
        if (onLevel) onLevel(lv);
        if (lv > SPEECH_THRESHOLD) { spoke += TICK_MS; silent = 0; }
        else if (spoke >= MIN_SPEECH_MS) silent += TICK_MS;
        const elapsed = Date.now() - started;
        if (pushToTalk) { if (!isPressed() || elapsed >= maxMs) finish(); }
        else if ((spoke >= MIN_SPEECH_MS && silent >= SILENCE_HANG) || elapsed >= maxMs) finish();
      }, TICK_MS);
    });

    this.active = null;
    return out;
  }

  stop() {
    if (!this.active) return;
    try { this.active.recorder.stop(); } catch {}
    closeMic(this.active.mic);
    this.active = null;
  }
}

/* ── barge-in monitor ──────────────────────────────────────── */
async function startBargeMonitor({ isSpeaking, onInterrupt, threshold }) {
  let mic;
  try {
    // Automatic gain is off on purpose: it lifts a quiet room up to
    // conversation level and the monitor starts hearing the fridge.
    mic = await openMic(false);
  } catch (e) {
    console.warn("[Elton AI] interruption unavailable:", e.message);
    return null;
  }
  let loud = 0, since = 0;
  const timer = window.setInterval(() => {
    if (!isSpeaking()) { loud = 0; since = 0; return; }
    if (!since) since = Date.now();
    if (Date.now() - since < BARGE_GRACE_MS) return;
    const lv = rms(mic.analyser, mic.buf);
    if (lv > threshold) {
      loud += BARGE_TICK_MS;
      if (loud >= BARGE_SUSTAIN_MS) { loud = 0; since = 0; onInterrupt(); }
    } else {
      // Decay slower than growth. Real speech dips below the threshold
      // between syllables; symmetric decay meant the counter never got
      // anywhere and you had to shout in a flat tone to be heard.
      loud = Math.max(0, loud - BARGE_TICK_MS / 3);
    }
  }, BARGE_TICK_MS);

  return () => { window.clearInterval(timer); closeMic(mic); };
}

/* ── playback ──────────────────────────────────────────────── */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/** Raw 16-bit mono PCM → a .wav the browser will play. */
function pcmToWav(pcmBuffer, sampleRate = 24000) {
  const pcm = new Uint8Array(pcmBuffer);
  const numChannels = 1, bitsPerSample = 16;
  const blockAlign = numChannels * bitsPerSample / 8;
  const out = new ArrayBuffer(44 + pcm.length);
  const view = new DataView(out);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  str(36, "data");
  view.setUint32(40, pcm.length, true);
  new Uint8Array(out, 44).set(pcm);
  return out;
}

/**
 * A hand-off between the code producing an answer and the code speaking it.
 * The producer pushes each finished piece and closes when there is no more;
 * the consumer awaits them one at a time. That lets a long answer start being
 * read aloud while the rest of it is still being fetched, instead of sitting
 * in silence until the last token lands.
 */
class SegmentQueue {
  constructor() {
    this.items = [];
    this.closed = false;
    this.wake = null;
  }

  push(text) {
    if (this.closed || !text) return;
    this.items.push(text);
    this.signal();
  }

  close() {
    this.closed = true;
    this.signal();
  }

  signal() {
    const wake = this.wake;
    this.wake = null;
    if (wake) wake();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.items.length) { yield this.items.shift(); continue; }
      // Closing is checked after draining, so nothing pushed just before the
      // close is dropped on the floor.
      if (this.closed) return;
      await new Promise((resolve) => { this.wake = resolve; });
    }
  }
}

/**
 * Speech is a single object so a barge-in has one thing to cancel,
 * whichever engine produced the sound.
 */
class Speaker {
  constructor(plugin) {
    this.plugin = plugin;
    this.audio = null;
    this.speaking = false;
    this.cancelled = false;
  }

  get s() { return this.plugin.settings; }

  stop() {
    this.cancelled = true;
    this.speaking = false;
    if (this.audio) { try { this.audio.pause(); } catch {} this.audio = null; }
    try { window.speechSynthesis.cancel(); } catch {}
  }

  clean(text) { return String(text || "").replace(/[*_`#>[\]]/g, "").trim(); }

  /**
   * Turn text into something playable WITHOUT playing it.
   *
   * Split from playback on purpose: it is what lets the next sentence be
   * fetched while the current one is still being spoken. Synthesis takes
   * about as long as the audio it produces, so doing it in sequence meant a
   * silent gap before every single sentence.
   */
  async prepare(text) {
    const clean = this.clean(text);
    if (!clean || !this.s.voiceEnabled) return null;
    const engine = this.s.ttsEngine;

    if (engine === "piper") {
      try { return { buffer: await piperSpeak(this.s.piperUrl, clean), mime: "audio/wav" }; }
      catch (e) { console.warn("[Elton AI] Piper unavailable, using the system voice:", e.message); }
    } else if (engine === "cloud" && this.plugin.ai.hasCloud()) {
      try {
        const { buffer, format } = await this.plugin.ai.speech(clean);
        this._warned = false;
        // Gemini returns headerless PCM; give it a WAV header so a plain
        // <audio> element can play it without being told the sample rate.
        return format === "pcm"
          ? { buffer: pcmToWav(buffer), mime: "audio/wav" }
          : { buffer, mime: "audio/mpeg" };
      } catch (e) {
        // Say it out loud, once per session. A silent fallback to the system
        // voice looks like "the nice voice just stopped working" with nothing
        // anywhere to explain why.
        console.warn("[Elton AI] cloud voice failed:", e.message);
        if (!this._warned) {
          this._warned = true;
          new Notice(t("The voice failed, so I used the system one: {0}", e.message), 10000);
        }
      }
    }
    return { system: clean };
  }

  async playPrepared(desc) {
    if (!desc || this.cancelled) return;
    this.speaking = true;
    try {
      if (desc.system) await this.systemVoice(desc.system);
      else await this.playBuffer(desc.buffer, desc.mime);
    } finally {
      this.speaking = false;
    }
  }

  async say(text) {
    this.cancelled = false;
    await this.playPrepared(await this.prepare(text));
  }

  /**
   * Speak a whole answer, keeping several syntheses in flight at once.
   *
   * Measured against the live service, a speech request costs about 6
   * seconds of fixed latency plus ~46ms per character. That fixed part is
   * waiting, not work, so requests overlap: four chunks took 26.9s one after
   * another and 8.5s fired together — 3.2x.
   *
   * This is also why chunks must not be tiny. Each one pays the 6s toll
   * again, so cutting an answer into scraps buys a quick first word and then
   * stalls forever. The splitter aims for clauses, not words.
   */
  async sayAll(parts, { shouldStop, onFirstSound, onWaiting, onSpeaking, onChunk, window = 4 } = {}) {
    if (!parts.length) return;
    this.cancelled = false;
    const stop = () => this.cancelled || (shouldStop && shouldStop());

    const queue = new Array(parts.length).fill(null);
    const start = (i) => {
      if (i >= parts.length || queue[i]) return;
      const p = this.prepare(parts[i]);
      // An un-awaited rejection would surface as an unhandled crash, and one
      // bad chunk must not take the answer down with it.
      p.catch(() => {});
      queue[i] = p;
    };

    // Fill the window immediately: the first chunks all wait out their
    // latency together instead of in series.
    for (let i = 0; i < Math.min(window, parts.length); i++) start(i);

    for (let i = 0; i < parts.length; i++) {
      if (stop()) break;

      let desc = null;
      try {
        // If the next fragment is not back yet, this is dead air. Say so, so
        // the caller can fill it — the service's latency swings by 2x from
        // one minute to the next and no chunk size survives every case.
        const pending = queue[i];
        let waiting = false;
        const settled = Promise.race([pending, new Promise((r) => window.setTimeout(() => r("__slow__"), 250))]);
        if ((await settled) === "__slow__" && onWaiting) { waiting = true; onWaiting(); }
        desc = await pending;
        if (waiting && onSpeaking) onSpeaking();
      } catch (e) { console.warn("[Elton AI] could not synthesise a fragment:", e.message); }
      queue[i] = null;        // let the audio be collected once played
      // Refill only now that this slot has actually freed, so the number in
      // flight stays at the window rather than one over it.
      start(i + window);
      if (stop()) break;
      if (!desc) continue;

      if (onFirstSound) { onFirstSound(); onFirstSound = null; }
      // Announce the fragment as its sound starts, so a caller showing text
      // can keep it level with the voice instead of racing ahead of it.
      if (onChunk) onChunk(parts[i], i);
      await this.playPrepared(desc);
    }
  }

  playBuffer(arrayBuffer, mime) {
    return new Promise((resolve) => {
      if (this.cancelled) return resolve();
      const url = URL.createObjectURL(new Blob([arrayBuffer], { type: mime }));
      const a = new Audio(url);
      a.playbackRate = this.s.speechSpeed || 1;
      this.audio = a;
      const done = () => { URL.revokeObjectURL(url); if (this.audio === a) this.audio = null; resolve(); };
      a.onended = done;
      a.onerror = done;
      a.play().catch(done);
    });
  }

  systemVoice(text) {
    return new Promise((resolve) => {
      if (this.cancelled || !window.speechSynthesis) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = this.s.speechSpeed || 1;
      // Match the voice to the text, not to the OS: a Russian sentence read
      // by an English voice is unintelligible.
      const ru = /[Ѐ-ӿ]/.test(text);
      const voices = window.speechSynthesis.getVoices() || [];
      const pick = voices.find((v) => (ru ? /^ru/i : /^en/i).test(v.lang));
      if (pick) { u.voice = pick; u.lang = pick.lang; }
      else u.lang = ru ? "ru-RU" : "en-US";
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }
}

/* ============================================================
 *  Waiting sound
 *
 *  Synthesised rather than shipped as a file: an audio asset would
 *  bloat the plugin and a loop cut from a sample almost always
 *  clicks at the seam. Built from oscillators there is no seam at
 *  all — the pulse is scheduled, so it repeats exactly.
 *
 *  Deliberately quiet and low. This plays while you wait for an
 *  answer; it should read as "the machine is working", not as
 *  something demanding attention.
 * ========================================================== */
class Ambience {
  constructor(plugin) {
    this.plugin = plugin;
    this.ctx = null; this.timer = null; this.nodes = [];
    this.clip = null;        // object URL for the shipped sample
    this.audio = null;
    this.loop = null;
  }

  get running() { return !!this.ctx || !!this.loop; }

  /**
   * Decode the built-in clip once and keep the object URL.
   *
   * It rides inside the code rather than next to it, because a release only
   * carries main.js, manifest.json and styles.css — a .wav in the plugin
   * folder would exist for the author and for nobody else. The synthesised
   * drone below stays as the last resort, for a runtime with no atob or no
   * AudioContext at all.
   */
  load() {
    if (this.clip !== null) return this.clip;
    try {
      this.clip = URL.createObjectURL(new Blob([base64ToBytes(WAITING_WAV_B64)], { type: "audio/wav" }));
    } catch (e) {
      console.warn("[Elton AI] built-in waiting sound unavailable:", e.message);
      this.clip = false;
    }
    return this.clip;
  }

  start(volume = 0.28) {
    if (this.running) return;
    // Custom file, built-in clip, then synthesis — in that order.
    const custom = this.plugin && this.plugin.settings.waitingSoundFile;
    if (custom) { this.startFile(custom, volume); return; }
    const url = this.load();
    if (url) { this.startClip(url, volume); return; }
    this.startSynth(volume * 0.2);
  }

  async startFile(vaultPath, volume) {
    try {
      const p = normalizePath(vaultPath);
      const buf = await this.plugin.app.vault.adapter.readBinary(p);
      const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      this._custom = url;
      this.startClip(url, volume);
    } catch (e) {
      console.warn("[Elton AI] could not play the chosen waiting sound:", e.message);
      this.startSynth(volume * 0.2);
    }
  }

  /** Repeat the clip with a breath between passes, rather than back to back. */
  startClip(url, volume) {
    this._wanted = true;
    const play = () => {
      if (!this._wanted) return;
      const a = new Audio(url);
      a.volume = Math.max(0, Math.min(1, volume));
      this.audio = a;
      a.play().catch(() => {});
    };
    play();
    this.loop = window.setInterval(play, 2600);
  }

  startSynth(volume = 0.05) {
    if (this.ctx) return;
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;

      // A low drone, two detuned oscillators so it beats slowly instead of
      // sitting dead still.
      const bus = ctx.createGain();
      bus.gain.value = volume;
      bus.connect(ctx.destination);

      const drone = ctx.createGain();
      drone.gain.value = 0.35;
      drone.connect(bus);
      for (const f of [110, 110.6]) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f;
        o.connect(drone);
        o.start();
        this.nodes.push(o);
      }

      // A soft blip every 1.4s, riding on top. Scheduled ahead of time so
      // the rhythm does not drift with timer jitter.
      const blip = () => {
        if (!this.ctx) return;
        const now = ctx.currentTime;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "triangle";
        o.frequency.setValueAtTime(880, now);
        o.frequency.exponentialRampToValueAtTime(1320, now + 0.09);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.5, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
        o.connect(g); g.connect(bus);
        o.start(now); o.stop(now + 0.3);
      };
      blip();
      this.timer = window.setInterval(blip, 1400);
    } catch (e) {
      console.warn("[Elton AI] waiting sound unavailable:", e.message);
      this.ctx = null;
    }
  }

  stop() {
    this._wanted = false;
    if (this.loop) { window.clearInterval(this.loop); this.loop = null; }
    if (this.audio) { try { this.audio.pause(); } catch {} this.audio = null; }
    if (this._custom) { try { URL.revokeObjectURL(this._custom); } catch {} this._custom = null; }
    if (this.timer) { window.clearInterval(this.timer); this.timer = null; }
    if (!this.ctx) return;
    const ctx = this.ctx;
    this.ctx = null;
    // Fade before closing: cutting an oscillator dead produces a click.
    try {
      for (const o of this.nodes) { try { o.stop(ctx.currentTime + 0.12); } catch {} }
      window.setTimeout(() => { try { ctx.close(); } catch {} }, 250);
    } catch { try { ctx.close(); } catch {} }
    this.nodes = [];
  }
}

/* Chunk sizes, in characters, chosen from measured latency.
 *
 * Synthesis costs ~6s of fixed latency + ~46ms/char, and speech runs at
 * roughly 18 chars/second. So a chunk has to be long enough that the audio
 * it yields is worth the toll paid to fetch it: below ~60 characters a chunk
 * buys under 3.5 seconds of sound for a 6-second wait. Above ~160 the first
 * word simply takes too long to arrive. */
const CHUNK_MAX = 160;
const CHUNK_MIN = 60;
/* The opening chunk is shorter, because it is the only one actually waited
 * for — the rest are already in flight. But not too short: chunks fetch in
 * parallel, so the gap after the first one is
 *     0.046*(len2 - len1) - 0.055*len1
 * which stays negative only while len1 is at least ~46% of len2. Undershoot
 * that and the answer starts sooner but stutters straight after. 110 against
 * a 160 cap keeps a comfortable margin. */
const CHUNK_FIRST = 110;

/* A split point is marked before splitting rather than matched with a
   lookbehind: iOS below 16.4 does not support lookbehind at all, and a plugin
   that is not desktop-only has to parse on those phones too. */
const SPLIT_MARK = "\u0000";

/** Sentence boundaries, keeping abbreviations and decimals intact. */
function sentences(text) {
  return String(text || "")
    .replace(/([.!?…])\s+(?=[«"'(]?[A-ZА-ЯЁ0-9])/g, "$1" + SPLIT_MARK)
    .split(SPLIT_MARK)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Split an answer into pieces worth synthesising.
 *
 * Sentences first; any sentence too long to wait for is cut again at clause
 * boundaries — a comma, dash, colon or semicolon — because that is where a
 * reader would draw breath anyway, so the seam is inaudible. Cutting at an
 * arbitrary word would be heard as a stutter.
 */
function speechChunks(text, { max = CHUNK_MAX, min = CHUNK_MIN, first = CHUNK_FIRST } = {}) {
  const out = [];

  for (const sentence of sentences(text)) {
    // Only the very first piece is worth shortening; after that a smaller
    // chunk just buys another 6-second toll for no gain.
    const limit = out.length === 0 ? Math.min(first, max) : max;
    if (sentence.length <= limit) { out.push(sentence); continue; }

    // Break points, in order of how natural they sound.
    const pieces = sentence
      .replace(/([,;:—–])\s+/g, "$1" + SPLIT_MARK)
      .split(SPLIT_MARK)
      .map((x) => x.trim())
      .filter(Boolean);

    let buf = "";
    for (const piece of pieces) {
      if (!buf) { buf = piece; continue; }
      // Keep growing while the result still fits, so we end up with a few
      // solid chunks rather than many scraps. The cap follows position: the
      // opening chunk stays short, the rest fill out.
      const cap = out.length === 0 ? Math.min(first, max) : max;
      if ((buf + " " + piece).length <= cap) buf += " " + piece;
      else { out.push(buf); buf = piece; }
    }
    if (buf) out.push(buf);
  }

  // A trailing scrap costs a full round-trip to say almost nothing; fold it
  // back into the chunk before it when that stays reasonable.
  const merged = [];
  for (const c of out) {
    const prev = merged[merged.length - 1];
    // Never let a merge grow the opening chunk — that is the one piece
    // whose length is actually waited for.
    const cap = merged.length === 1 ? Math.min(first, max) : max;
    if (prev && c.length < min && (prev + " " + c).length <= cap) {
      merged[merged.length - 1] = prev + " " + c;
    } else merged.push(c);
  }
  return merged;
}
