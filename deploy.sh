#!/bin/sh
# Собрать плагин и положить в рабочее хранилище — то, что раньше делал
# build.sh прямо в папке плагина. Исходники живут здесь, в репозитории,
# а в хранилище уезжают только те три файла, которые читает Obsidian.
#
#   sh deploy.sh
#
# Куда выкладывать — путь до папки плагина в вашем хранилище. Он у каждого
# свой и в репозитории ему не место, поэтому берётся снаружи, из одного
# из двух мест:
#
#   1. переменная окружения VAULT_PLUGIN_DIR
#   2. файл .vault-path рядом с этим скриптом (одна строка, он не коммитится)
#
# Например:
#   echo '/c/Users/me/Vault/.obsidian/plugins/elton-ai' > .vault-path
#
# Перезагрузить плагин в Obsidian после этого: Ctrl+P → "Reload app without saving".

cd "$(dirname "$0")" || exit 1

VAULT="$VAULT_PLUGIN_DIR"
if [ -z "$VAULT" ] && [ -f .vault-path ]; then
  VAULT=$(sed -e 's/[[:space:]]*$//' -e '/^$/d' .vault-path | head -n 1)
fi

if [ -z "$VAULT" ]; then
  echo "Не задано, куда выкладывать: заполните VAULT_PLUGIN_DIR или .vault-path" >&2
  echo "Подробности — в шапке этого скрипта." >&2
  exit 1
fi

sh build.sh || exit 1

if [ ! -d "$VAULT" ]; then
  echo "Папки плагина нет: $VAULT" >&2
  exit 1
fi

cp main.js manifest.json styles.css "$VAULT/" || exit 1
echo "выложено в $VAULT (main.js, manifest.json, styles.css)"
