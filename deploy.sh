#!/bin/sh
# Собрать плагин и положить в рабочее хранилище — то, что раньше делал
# build.sh прямо в папке плагина. Исходники теперь живут здесь, в репозитории,
# а в хранилище уезжают только те три файла, которые читает Obsidian.
#
#   sh deploy.sh
#
# Перезагрузить плагин в Obsidian после этого: Ctrl+P → "Reload app without saving".

cd "$(dirname "$0")" || exit 1
VAULT="C:/Personal development/Brain/.obsidian/plugins/elton-ai"

sh build.sh || exit 1

if [ ! -d "$VAULT" ]; then
  echo "Папки плагина нет: $VAULT" >&2
  exit 1
fi

cp main.js manifest.json styles.css "$VAULT/" || exit 1
echo "выложено в $VAULT (main.js, manifest.json, styles.css)"
