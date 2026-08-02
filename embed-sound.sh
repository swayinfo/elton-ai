#!/bin/sh
# Перегенерировать src/15-waiting-sound.js из waiting.wav.
#
# Звук ожидания едет внутри main.js, потому что релиз несёт только три файла
# и .wav рядом с ними не доедет ни до кого. Запускать после того, как поменял
# waiting.wav; потом обычный deploy.sh.

cd "$(dirname "$0")" || exit 1
node -e '
const fs = require("fs");
const b64 = fs.readFileSync("waiting.wav").toString("base64");
const lines = [];
for (let i = 0; i < b64.length; i += 120) lines.push("  \"" + b64.slice(i, i + 120) + "\"");
const head = fs.readFileSync("src/15-waiting-sound.js", "utf8").split("const WAITING_WAV_B64")[0];
// Separate array elements, never a chain of "+": a thousand nested binary
// expressions overflows the stack of every JS parser that reads this file,
// linters included, and the file stops being analysable at all.
const tail = `const WAITING_WAV_B64 = [
${lines.join(",\n")}
].join("");

/** base64 → bytes, for a Blob the audio element can play. */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
`;
fs.writeFileSync("src/15-waiting-sound.js", head + tail);
console.log("src/15-waiting-sound.js обновлён из waiting.wav");
' || exit 1
