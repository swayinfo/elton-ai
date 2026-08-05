#!/bin/sh
# Concatenate the sources into the single main.js Obsidian loads.
# Order matters: 10-core declares what the rest closes over.
cd "$(dirname "$0")" || exit 1
cat src/10-core.js src/15-waiting-sound.js src/20-ai.js src/25-spend.js src/30-vault.js src/40-agent.js src/45-schedule.js \
    src/47-scenarios.js src/48-skills.js src/50-audio.js src/55-chat.js src/60-view.js src/65-suggest.js \
    src/70-settings.js src/80-main.js > main.js
node --check main.js && echo "built main.js ($(wc -l < main.js) lines)"
