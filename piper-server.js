/* ============================================================
 *  Piper HTTP bridge
 *
 *  Piper is a command-line program; the plugin speaks HTTP. This is
 *  the thinnest possible thing in between: one GET, one process,
 *  one WAV back.
 *
 *  Voice is picked from the text itself rather than configured,
 *  because a bilingual assistant switches language mid-conversation
 *  and a Russian sentence read by an English voice is unusable.
 *
 *    node piper-server.js [port]
 * ========================================================== */
"use strict";

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = __dirname;
const PIPER = path.join(ROOT, "piper", "piper.exe");
const VOICES = path.join(ROOT, "voices");
const PORT = Number(process.argv[2]) || 5000;

const VOICE = {
  ru: path.join(VOICES, "ru_RU-irina-medium.onnx"),
  en: path.join(VOICES, "en_US-amy-medium.onnx"),
};

function pickVoice(text) {
  return /[Ѐ-ӿ]/.test(text) ? VOICE.ru : VOICE.en;
}

function synth(text, model) {
  return new Promise((resolve, reject) => {
    // Piper writes to a file rather than stdout reliably on Windows, so
    // round-trip through a temp file and clean up after.
    const out = path.join(os.tmpdir(), `piper-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    const p = spawn(PIPER, ["--model", model, "--output_file", out], { cwd: ROOT });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`piper exited ${code}: ${err.slice(-300)}`));
      fs.readFile(out, (e, buf) => {
        fs.unlink(out, () => {});
        e ? reject(e) : resolve(buf);
      });
    });
    p.stdin.write(text);
    p.stdin.end();
  });
}

/** Read a request body as UTF-8, whatever the client's locale is. */
function readBody(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // POST carries the text in the body as explicit UTF-8. A query string
  // would work too, but only if the caller percent-encodes as UTF-8 —
  // command-line clients on a Russian Windows send cp1251 instead, and the
  // result is a voice reading mojibake aloud for half a minute.
  let text = "", want = url.searchParams.get("voice");
  if (req.method === "POST") {
    const body = await readBody(req);
    try {
      const j = JSON.parse(body);
      text = String(j.text || "");
      if (j.voice) want = j.voice;
    } catch { text = body; }
  } else {
    text = url.searchParams.get("text") || "";
  }
  text = text.slice(0, 4000).trim();
  if (!text) { res.writeHead(400); return res.end("send text in the POST body, or ?text= on a GET"); }

  const model = want === "en" ? VOICE.en : want === "ru" ? VOICE.ru : pickVoice(text);

  try {
    const wav = await synth(text, model);
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
    res.end(wav);
  } catch (e) {
    console.error("[piper]", e.message);
    res.writeHead(500);
    res.end(String(e.message));
  }
});

for (const [lang, file] of Object.entries(VOICE)) {
  if (!fs.existsSync(file)) console.warn(`[piper] ${lang} voice missing: ${file}`);
}
if (!fs.existsSync(PIPER)) { console.error(`[piper] piper.exe not found at ${PIPER}`); process.exit(1); }

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Piper speaking on http://localhost:${PORT}  — try /?text=Проверка`);
});
