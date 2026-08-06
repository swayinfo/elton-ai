/* ============================================================
 *  Elton AI — a voice/text assistant that works on the
 *  notes you already have.
 *
 *  The plugin never ships a key of its own: every request goes
 *  through a provider the user configured (Elton AI, OpenRouter,
 *  a local Ollama/LM Studio server, or OpenAI). All four speak the
 *  OpenAI chat-completions dialect, so the transport is one code
 *  path and a provider is just a base URL, a key and a model.
 * ========================================================== */
"use strict";

/* build.sh concatenates src/ into main.js — there is no bundler to turn an
   `import` into the CommonJS Obsidian actually loads, so the require stays. */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- no bundler in this build, so the CommonJS form is the one Obsidian loads
const obsidian = require("obsidian");
const {
  PluginSettingTab, Setting, ItemView, Notice, Modal,
  TFile, TFolder, normalizePath, requestUrl, setIcon, MarkdownRenderer, Platform,
  getLanguage,
} = obsidian;
/* `Plugin` is also the name of a DOM global, so it is taken off the namespace
   rather than destructured — otherwise it reads as a redeclaration. */
const ObsidianPlugin = obsidian.Plugin;

/* Obsidian has shipped Platform for far longer than this plugin's
   minAppVersion, but a missing one would take the whole plugin down at load —
   too high a price for a phone check. */
const isPhone = () => !!(Platform && (Platform.isPhone || (Platform.isMobile && !Platform.isTablet)));
const isMobile = () => !!(Platform && Platform.isMobile);

const VIEW_TYPE = "obsimind-assistant-view";
/* Версия набора скиллов на прокси. Скиллы лежат в папке версии контента
   (scripts/<версия>/skills) и объясняют модели устройство этого хранилища:
   структура, форматы, скрипты, оформление. */
const SKILLS_VERSION = "v2";

/* ── i18n ──────────────────────────────────────────────────────
 * Source strings are English; Russian comes from the table. The
 * vault's own language is the default, so a Russian user never has
 * to find a language switch before they can read the onboarding.
 */
const RU = {
  // ── generic ──
  "Elton AI": "Elton AI",
  "Assistant": "Ассистент",
  "Settings": "Настройки",
  "Save": "Сохранить",
  "Cancel": "Отмена",
  "Close": "Закрыть",
  "Delete": "Удалить",
  "Back": "Назад",
  "Next": "Далее",
  "Done": "Готово",
  "Skip": "Пропустить",
  "Enabled": "Включено",
  "Disabled": "Выключено",
  "Not set": "Не задано",
  "Checking…": "Проверяю…",
  "Test connection": "Проверить связь",
  "Connection works": "Связь работает",
  "Connection failed: {0}": "Связь не установилась: {0}",

  // ── settings: tabs ──
  "Connection": "Подключение",
  "Assistant name": "Ассистент",
  "Notes": "Заметки",
  "Expand": "Развернуть",
  "Collapse": "Свернуть",
  "All scenarios": "Все сценарии",
  "Open the panel": "Открыть панель",
  "Looking at the last {0} days": "Смотрю последние дни: {0}",
  "Add": "Добавить",
  "Blank, or start from one of the ready-made briefs.": "Пустой — или на основе одного из готовых.",
  "already added": "уже есть",
  "Empty — write what it should ask for": "Пустой — впишите, что он должен просить",
  "Answering… click to stop": "Отвечаю… клик — прервать",
  "Listening while it speaks is on — headphones recommended": "Перебивание голосом включено — лучше в наушниках",
  "Talk over it to interrupt: off. Click the reactor to stop it.": "Перебивание голосом выключено. Прервать — клик по реактору.",
  "Applies to the next conversation": "Подействует со следующего разговора",
  "Nothing could be spoken: {0}": "Озвучить не вышло совсем: {0}",
  "Board created: {0}": "Доска создана: {0}",
  "Quick model for searching": "Быстрая модель для поиска",
  "Finding the right notes is a lot of small decisions, and a quick model makes them just as well as a clever one — about three times faster. The answer itself is still written by the model above.":
    "Найти нужные заметки — это много мелких решений, и быстрая модель принимает их не хуже умной, но примерно втрое быстрее. Сам ответ по-прежнему пишет модель, выбранная выше.",
  "Automatic ({0})": "Автоматически ({0})",
  "Off — one model for everything": "Выключено — одна модель на всё",
  "Conversation is being saved: {0}": "Разговор сохраняется сюда: {0}",
  "Voice": "Голос",
  "Notes access": "Доступ к заметкам",
  "Search": "Поиск",
  "Interface": "Интерфейс",
  "About": "О плагине",

  // ── onboarding ──
  "Getting started": "С чего начать",
  "Open the setup guide": "Открыть пошаговую настройку",
  "Walks you through the provider, the assistant's name and what it may touch. Two minutes.":
    "Проведу по шагам: провайдер, имя ассистента и что ему можно трогать. Две минуты.",
  "Welcome": "Знакомство",
  "Meet your assistant": "Ваш ассистент",
  "It reads and writes the notes you already have. Talk to it or type — it searches your vault, answers from it, and edits notes when you ask.":
    "Он работает с заметками, которые у вас уже есть. Говорите голосом или пишите — он ищет по хранилищу, отвечает по нему и правит заметки, когда попросите.",
  "Pick where the brains come from": "Выберите, откуда берётся ИИ",
  "Four options: Elton AI, OpenRouter, a local model on your own machine, or OpenAI directly. You bring the key — the plugin stores it only in this vault.":
    "Четыре варианта: Elton AI, OpenRouter, локальная модель на вашем компьютере или OpenAI напрямую. Ключ ваш — плагин хранит его только в этом хранилище.",
  "Give it a name": "Дайте ему имя",
  "Call it whatever you like. The name is what it answers to and how it introduces itself.":
    "Назовите как хотите. На это имя он отзывается и так себя представляет.",
  "Decide what it may touch": "Решите, что ему можно трогать",
  "By default it can read the whole vault, and create or edit notes. Deleting always asks you first. You can narrow it to specific folders.":
    "По умолчанию он читает всё хранилище, создаёт и правит заметки. Удаление всегда спрашивает подтверждение. Можно ограничить его отдельными папками.",
  "You're set": "Всё готово",
  "Open the panel from the ribbon or the command palette. Everything here can be changed later in settings.":
    "Панель открывается с ленты слева или из палитры команд. Всё это можно поменять позже в настройках.",
  "Open settings": "Открыть настройки",
  "Start talking": "Начать разговор",

  // ── connection ──
  "AI provider": "Провайдер ИИ",
  "Where requests go. All four speak the same protocol — switching keeps your other settings.":
    "Куда уходят запросы. Все четыре говорят на одном протоколе — при смене остальные настройки сохраняются.",
  "OpenRouter": "OpenRouter",
  "Local model (Ollama / LM Studio)": "Локальная модель (Ollama / LM Studio)",
  "OpenAI": "OpenAI",
  "API key": "API-ключ",
  "Paste your key here": "Вставьте сюда ключ",
  "Stored in this vault's plugin folder in plain text, like every Obsidian plugin. Don't put it in a vault you share or sync publicly.":
    "Хранится в папке плагина этого хранилища открытым текстом, как у любого плагина Obsidian. Не держите его в хранилище, которым делитесь публично.",
  "Server address": "Адрес сервера",
  "Ollama's default is http://localhost:11434/v1 · LM Studio's is http://localhost:1234/v1":
    "У Ollama по умолчанию http://localhost:11434/v1 · у LM Studio — http://localhost:1234/v1",
  "Model": "Модель",
  "The model that answers and calls tools. It must support tool calling, or the assistant can only chat.":
    "Модель, которая отвечает и вызывает инструменты. Она обязана уметь вызов инструментов, иначе ассистент сможет только болтать.",
  "Refresh model list": "Обновить список моделей",
  // ── стриминг и стоимость ──
  "Show the answer as it's written": "Показывать ответ по мере написания",
  "The reply appears word by word instead of all at once when it's done. Falls back on its own if the provider can't stream.":
    "Ответ появляется по словам, а не целиком в конце. Если провайдер так не умеет, плагин сам вернётся к обычному режиму.",
  "Show what it cost": "Показывать стоимость",
  "A quiet line under each answer: what left your balance and how many tokens it took.":
    "Тихая строчка под ответом: сколько ушло с баланса и сколько потрачено токенов.",
  "{0} tokens": "{0} токенов",
  "{0} steps": "{0} шага",
  "{0} left": "осталось {0}",
  "{0} answers": "ответов: {0}",
  "Nothing spent yet this session.": "За этот сеанс пока ничего не потрачено.",
  "Spent this session": "Потрачено за сеанс",

  // ── выделенный текст ──
  "Ask about the selected text": "Спросить о выделенном тексте",
  "Ask the assistant": "Спросить ассистента",
  "Select some text first": "Сначала выделите текст",
  "Selected text": "Выделенный текст",
  "The user highlighted this passage in the note they are reading:\n\n«{0}»\n\nAnswer about this passage specifically, not about the note as a whole. Explain what it means and why it matters, and say plainly if it is unclear or unfinished. Search their other notes if that helps place it.":
    "Пользователь выделил этот фрагмент в заметке, которую читает:\n\n«{0}»\n\nОтвечай именно про этот фрагмент, а не про заметку целиком. Объясни, что он значит и почему это важно, и скажи прямо, если он непонятен или недописан. Поищи в других заметках, если это поможет поставить его в контекст.",

  // ── вкладки и экран ──
  "Manage tabs and windows": "Управлять вкладками и окнами",
  "Let it open notes beside each other, open web pages inside the vault and close tabs you're done with. It never touches its own panel, and closing several at once still asks you.":
    "Разрешить открывать заметки рядом, открывать веб-страницы прямо в хранилище и закрывать вкладки, с которыми вы закончили. Свою панель он не трогает, а закрытие нескольких вкладок всё равно спросит подтверждение.",
  "Looking at what's open": "Смотрю, что открыто",
  "Opened beside: {0}": "Открыл рядом: {0}",
  "Closed: {0}": "Закрыл вкладок: {0}",
  "Close tabs?": "Закрыть вкладки?",
  "Notes save as you type, so nothing is lost.": "Заметки сохраняются на ходу, поэтому ничего не потеряется.",
  "Untitled": "Без названия",
  "That isn't a valid address.": "Это не похоже на адрес.",
  "Only ordinary web addresses can be opened.": "Открыть можно только обычный веб-адрес.",
  "Web viewer is switched off": "Веб-просмотр выключен",
  "Pages will open in your system browser instead. Turn on the core plugin «Web viewer» to have them open inside the vault.":
    "Страницы будут открываться в обычном браузере. Включите стандартный плагин «Веб-просмотр», чтобы они открывались внутри хранилища.",

  "Advanced": "Дополнительно",
  "This index belongs to another tool": "Этот индекс ведёт другая программа",
  "Updating adds only notes it hasn't seen — nothing existing is rewritten or deleted, so whatever maintains this file keeps working.":
    "Обновление добавит только те заметки, которых в нём ещё нет. Ничего из уже записанного не переписывается и не удаляется, поэтому та программа, что ведёт этот файл, продолжит работать как раньше.",
  "Index {0} new notes": "Проиндексировать новые: {0}",
  "Everything is indexed": "Всё проиндексировано",
  "Another model…": "Другая модель…",
  "your own": "своя",
  "Model id": "Идентификатор модели",
  "Exactly as the provider spells it, for example anthropic/claude-sonnet-4.6.":
    "Ровно так, как он называется у провайдера, например anthropic/claude-sonnet-4.6.",
  "Cloud fallback for voice": "Облако для голоса",
  "A local model can't transcribe speech or speak. Point this at a cloud key and voice keeps working while text stays local.":
    "Локальная модель не распознаёт и не синтезирует речь. Укажите здесь облачный ключ — голос будет работать, а текст останется локальным.",
  "No models found at that address. Is the server running?":
    "По этому адресу моделей нет. Сервер запущен?",
  "Found {0} models": "Найдено моделей: {0}",

  // ── persona ──
  "What should it be called?": "Как его будут звать?",
  "Answer length": "Длина ответа",
  "How much the assistant may write in one go. If an answer still runs past it, the rest is fetched and joined on — you never get a sentence that stops mid-word. Longer answers cost more tokens.":
    "Сколько ассистент может написать за один раз. Если ответ всё равно не уместится, остаток подтянется и приклеится — фраза никогда не оборвётся на полуслове. Длинные ответы тратят больше токенов.",
  "Short — a few paragraphs": "Короткий — несколько абзацев",
  "Normal — a full explanation": "Обычный — полное объяснение",
  "Long — detailed and thorough": "Длинный — подробно и обстоятельно",

  "The assistant answers to this name and uses it when it introduces itself.":
    "На это имя ассистент отзывается и так себя представляет.",
  "How should it address you?": "Как обращаться к вам?",
  "Your name, so it doesn't have to say \"you\" for everything. Leave empty to stay anonymous.":
    "Ваше имя, чтобы не сводить всё к «вы». Оставьте пустым — останетесь анонимом.",
  "Character": "Характер",
  "Sets the tone of every reply.": "Задаёт тон всех ответов.",
  "Calm and precise": "Спокойный и точный",
  "Warm and chatty": "Тёплый и разговорчивый",
  "Short and blunt": "Короткий и прямой",
  "Custom": "Свой",
  "Custom character": "Свой характер",
  "Describe how it should behave. Replaces the preset above.":
    "Опишите, как он должен себя вести. Заменяет пресет выше.",
  "Context note": "Заметка с контекстом",
  "A note the assistant reads before every reply — your projects, your goals, how you like things phrased. Path inside the vault.":
    "Заметка, которую ассистент читает перед каждым ответом: ваши проекты, цели, как вам удобнее формулировать. Путь внутри хранилища.",
  "⚠ This note is sent to your AI provider with every single request. Never put passwords, keys, financial or medical records, or anything about other people in it. Keep it to what you would say out loud in a meeting.":
    "⚠ Эта заметка уходит вашему провайдеру ИИ с КАЖДЫМ запросом. Категорически не указывайте в ней пароли, ключи, финансовые или медицинские данные, а также сведения о других людях. Пишите только то, что сказали бы вслух на встрече.",
  "Create this note": "Создать эту заметку",

  // ── voice ──
  "Voice replies": "Ответы голосом",
  "Read answers out loud. Turn off for a text-only assistant.":
    "Проговаривать ответы вслух. Выключите — останется только текст.",
  "Speech engine": "Движок озвучки",
  "System voice (free, offline)": "Системный голос (бесплатно, офлайн)",
  "Piper (local, natural sounding)": "Piper (локально, живой голос)",
  "Cloud voice (best quality, costs tokens)": "Облачный голос (лучшее качество, тратит токены)",
  "Piper server address": "Адрес сервера Piper",
  "Piper runs as a small local HTTP server. Leave the default unless you changed the port.":
    "Piper работает как маленький локальный HTTP-сервер. Оставьте как есть, если не меняли порт.",
  "Cloud voice": "Облачный голос",
  "Voices your provider offers. Puck is lively and reads Russian well.":
    "Голоса, которые даёт ваш провайдер. Puck живой и хорошо читает по-русски.",
  "The voice failed, so I used the system one: {0}":
    "Голос не отозвался, говорю системным: {0}",
  "Speech speed": "Скорость речи",
  "Let me interrupt": "Разрешить перебивать",
  "Start talking while it's speaking and it stops immediately to listen. Off by default: it keeps a microphone open while it talks, and through speakers rather than headphones it hears itself and stops on its own first sentence. Clicking the reactor stops it either way.":
    "Начните говорить, пока он отвечает — он тут же замолчит и станет слушать. По умолчанию выключено: пока он говорит, микрофон держится открытым, и через динамики (а не наушники) он слышит сам себя и замолкает на первой же фразе. Прервать его в любом случае можно кликом по реактору.",
  "Interrupt sensitivity": "Чувствительность перебивания",
  "Lower means it gives up the floor sooner. Raise it if background noise keeps cutting it off.":
    "Ниже — быстрее уступает слово. Поднимите, если его обрывает фоновый шум.",
  "Microphone mode": "Режим микрофона",
  "Hands-free — it listens until you go quiet.": "Свободные руки — слушает, пока вы не замолчите.",
  "Push to talk — hold the button while you speak.": "Нажми и говори — держите кнопку, пока говорите.",
  "Test the voice": "Проверить голос",
  "Speaking a test phrase…": "Произношу пробную фразу…",

  // ── notes access ──
  "What the assistant may do": "Что ассистенту можно",
  "Read notes": "Читать заметки",
  "Search and read. Without this it can only chat — it won't see your vault at all.":
    "Искать и читать. Без этого он сможет только болтать — хранилища он не увидит.",
  "Create notes": "Создавать заметки",
  "Edit notes": "Править заметки",
  "Change existing notes. Every edit is backed up first, so \"undo that\" always works.":
    "Менять существующие заметки. Перед каждой правкой снимается копия, поэтому «отмени» работает всегда.",
  "Delete notes": "Удалять заметки",
  "Even with this on, every deletion stops and waits for you to confirm from the keyboard. It can never delete anything on its own.":
    "Даже когда включено, каждое удаление останавливается и ждёт вашего подтверждения с клавиатуры. Сам он не удалит ничего.",
  "Where it may work": "Где ему можно работать",
  "Whole vault": "Всё хранилище",
  "Only these folders": "Только эти папки",
  "Everything except these folders": "Всё, кроме этих папок",
  "Folders": "Папки",
  "One path per line, relative to the vault root.": "По одному пути в строке, относительно корня хранилища.",
  "Folder for new notes": "Папка для новых заметок",
  "Where notes the assistant creates end up.": "Куда попадают заметки, созданные ассистентом.",
  "Daily notes folder": "Папка ежедневных заметок",
  "Lets it answer \"what did I do yesterday\". Taken from your Obsidian daily notes settings: {0}":
    "Позволяет отвечать на «что я вчера делал». Взята из настроек ежедневных заметок Obsidian: {0}",
  "Lets it answer \"what did I do yesterday\". Empty means the folder from your Obsidian daily notes settings.":
    "Позволяет отвечать на «что я вчера делал». Пусто — берётся папка из настроек ежедневных заметок Obsidian.",
  "Confirm every edit": "Подтверждать каждую правку",
  "Ask before writing anything, not just before deleting. Safer, slower.":
    "Спрашивать перед любой записью, а не только перед удалением. Надёжнее, но медленнее.",

  // ── search ──
  "Word search is always on": "Поиск по словам работает всегда",
  "It builds itself from your vault in a second, costs nothing and needs no key.":
    "Он строится по хранилищу за секунду, ничего не стоит и не требует ключа.",
  "Meaning-based search": "Поиск по смыслу",
  "Also find notes that mean the same thing in different words. Needs a one-time pass over your vault that costs tokens.":
    "Находить и те заметки, где та же мысль сказана другими словами. Нужен разовый проход по хранилищу, он тратит токены.",
  "Embedding model": "Модель эмбеддингов",
  "Build the index": "Построить индекс",
  "Rebuild the index": "Перестроить индекс",
  "Indexed {0} of {1} notes": "Проиндексировано {0} из {1} заметок",
  "Index file": "Файл индекса",
  "Already have an index from another script? Point at its .json and it gets reused — no re-indexing, no tokens spent. Leave empty to keep a private one.":
    "Уже есть индекс от другого скрипта? Укажите его .json — он подхватится как есть, без переиндексации и трат. Пусто — плагин заведёт свой.",
  "That file isn't a usable index": "Это не похоже на индекс",
  "Sound while you wait": "Звук ожидания",
  "A quiet pulse while an answer is being prepared, so the silence doesn't read as a freeze.":
    "Тихий сигнал, пока готовится ответ, — чтобы тишина не читалась как зависание.",
  "Waiting sound volume": "Громкость звука ожидания",
  "Your own waiting sound": "Свой звук ожидания",
  "A .wav from your vault. Leave empty for the built-in sound. Short clips work best — it repeats every few seconds.":
    "Файл .wav из хранилища. Пусто — играет встроенный звук. Лучше короткий: он повторяется раз в несколько секунд.",
  "Play it": "Проиграть",
  "{0} notes in the index": "В индексе заметок: {0}",
  "Nothing indexed yet": "Индекса пока нет",
  "{0} waiting: notes written or changed since the last pass.": "Ждут очереди: {0} — заметки, написанные или изменённые после прошлого прохода.",
  "Everything in your vault is in it.": "Всё хранилище в нём.",
  "{0} added": "добавлено: {0}",
  "{0} too short to be worth a vector": "слишком коротких, чтобы их индексировать: {0}",
  "{0} failed": "не получилось: {0}",
  "Nothing left to index": "Индексировать нечего",
  "{0} notes could not be indexed. The provider said: {1}": "{0} заметок не проиндексировались. Провайдер ответил: {1}",
  "Nothing could be indexed — every request was refused. The provider said: {0}. Check the embedding model and your key on the Connection tab.": "Не проиндексировалось ничего — провайдер отклонил все запросы. Ответ: {0}. Проверьте модель эмбеддингов и ключ на вкладке «Подключение».",
  "The index could not be saved: {0}": "Не удалось сохранить индекс: {0}",
  "Indexing… {0}/{1}": "Индексирую… {0}/{1}",
  "Stop": "Остановить",

  // ── web search ──
  "Search the web": "Поиск в интернете",
  "Web access": "Доступ в интернет",
  "Let the assistant look things up online — news, facts, anything outside your vault. Answers are still grounded in your notes first; the web is a second source it can reach when the notes don't have it.":
    "Разрешить ассистенту искать в сети — новости, факты, всё, чего нет в хранилище. Ответы по-прежнему опираются сначала на ваши заметки; интернет — второй источник, к которому он может обратиться, когда в заметках ответа нет.",
  "Only Elton AI and OpenRouter can search the web. Switch to one of them on the Connection tab to turn this on.":
    "В сеть умеют ходить только Elton AI и OpenRouter. Переключитесь на один из них во вкладке «Подключение», чтобы включить это.",
  "How many results": "Сколько результатов",
  "More results mean a fuller answer and a slightly higher cost per search.":
    "Больше результатов — полнее ответ и чуть выше цена одного поиска.",
  "Searching the web: {0}": "Ищу в интернете: {0}",

  // ── scenarios ──
  "Scenarios": "Сценарии",
  "Run a scenario": "Запустить сценарий",
  "Scenario: {0}": "Сценарий: {0}",
  "Custom scenario": "Свой сценарий",
  "No scenarios yet. Add one in settings.": "Сценариев пока нет. Добавьте их в настройках.",
  "No scenarios yet. Add one and it appears as a button under the reactor.":
    "Сценариев пока нет. Добавьте — и он появится кнопкой под реактором.",
  "A scenario is a long brief hiding behind a short phrase. Say the phrase and the assistant gets the whole brief instead of the two words you said — so it starts answering straight away rather than working out what you meant.":
    "Сценарий — это длинное задание, спрятанное за короткой фразой. Вы говорите фразу, а ассистент получает всё задание целиком вместо двух сказанных слов — и сразу начинает отвечать, а не разбираться, что вы имели в виду.",
  "How a phrase is matched": "Как распознаётся фраза",
  "A one-word trigger fires only when it is the whole thing you said. Two words or more also fire inside a longer sentence, so \"what was I thinking\" catches \"listen, what was I thinking about yesterday\". Anything you say around the trigger is passed along as context.":
    "Триггер из одного слова срабатывает, только если вы сказали ровно его. Из двух слов и длиннее — ещё и внутри длинной фразы: «о чём я думал» поймает «слушай, а о чём я думал вчера». Всё сказанное вокруг триггера уходит ассистенту как уточнение.",
  "Add scenario": "Добавить сценарий",
  "Trigger phrases": "Фразы-триггеры",
  "Separated by commas. Say any of them and this scenario runs.":
    "Через запятую. Скажете любую — запустится этот сценарий.",
  "What it asks for": "Что он просит",
  "The brief the assistant actually receives. Write it as if you were asking in full.":
    "Задание, которое реально получит ассистент. Пишите так, будто просите словами целиком.",
  "Show as a button": "Показывать кнопкой",
  "Puts it under the reactor and in an empty chat, for the days you would rather tap than talk.":
    "Появится под реактором и в пустом чате — для дней, когда проще нажать, чем говорить.",
  "No trigger phrase — button only": "Фразы нет — только кнопкой",
  "Delete this scenario": "Удалить этот сценарий",
  "Emoji": "Эмодзи",
  "Or just say: {0}": "Или просто скажите: {0}",
  "The user also said: \"{0}\". Take it into account.":
    "Пользователь ещё сказал: «{0}». Учти это.",

  // ── scenario presets ──
  "What I was thinking": "О чём я думал",
  "thoughts, what was I thinking, recent thoughts": "мысли, о чём я думал, последние мысли",
  "Go through my daily notes and everything I wrote over the last few days. Tell me what I was actually thinking about: the ideas that came up, the questions I left hanging, the threads I started and dropped. Pick the two or three that matter most and tell them as one connected story rather than a list. Only what is genuinely in my notes — do not fill the gaps.":
    "Пройдись по моим ежедневным заметкам и всему, что я записал за последние несколько дней. Расскажи, о чём я на самом деле думал: какие идеи всплывали, какие вопросы остались висеть, какие ветки я начал и бросил. Выбери две-три самые важные и расскажи их как одну связную историю, а не списком. Только то, что действительно есть в заметках — не додумывай.",
  "What's on today": "Что сегодня",
  "what's on today, plan for today": "что сегодня, план на день",
  "Look at today's daily note and my most recent notes. Tell me what is planned for today, what is still open from yesterday, and what deserves my attention first. Short and concrete — no encouragement, no padding.":
    "Посмотри мою сегодняшнюю ежедневную заметку и самые свежие записи. Расскажи, что запланировано на сегодня, что осталось незакрытым со вчера и на что стоит потратить внимание в первую очередь. Коротко и конкретно, без подбадриваний и воды.",
  "Wrap up the day": "Итоги дня",
  "wrap up the day, sum up the day": "итоги дня, подведи итоги дня",
  "Look at today's daily note and the notes I touched today. Sum the day up: what I did, what came of it, what I left unfinished. Then ask me one question worth answering before I close the vault.":
    "Посмотри сегодняшнюю ежедневную заметку и всё, что я сегодня трогал. Подведи итог дня: что я сделал, что из этого вышло, что осталось недоделанным. И задай мне один вопрос, на который стоит ответить, прежде чем я закрою хранилище.",
  "Explain this note": "Объясни заметку",
  "explain this, retell this note": "объясни, перескажи заметку",
  "Take the note that is open on my screen and explain it out loud, simply, as if I had not read it. The point of it in one sentence first, then the parts that actually matter. If something in it is unclear, thin or unfinished, say so plainly.":
    "Возьми заметку, открытую у меня на экране, и объясни её вслух, простыми словами, будто я её не читал. Сначала суть одним предложением, потом то, что действительно важно. Если что-то в ней непонятно, жидко или недописано — скажи прямо.",
  "Find connections": "Найди связи",
  "find connections, what is this connected to": "найди связи, с чем это связано",
  "Take the note that is open on my screen, then search my vault for other notes that touch the same ideas — including ones that use different words for it. Tell me what connects them and what I seem to have missed myself.":
    "Возьми заметку, открытую у меня на экране, и поищи в хранилище другие заметки о том же самом — в том числе те, где это названо другими словами. Расскажи, что их связывает и чего я сам, похоже, не заметил.",
  "The week in review": "Итоги недели",
  "the week, how was my week, weekly review": "итоги недели, как прошла неделя, разбор недели",
  "Go through my daily notes and everything I wrote in the last seven days. Tell me how the week actually went: what I spent it on, what moved, what stalled, and what came up more than once without my noticing. End with the one thing worth carrying into next week. Only what is in my notes — if a day is empty, say it is empty.":
    "Пройдись по ежедневным заметкам и всему, что я написал за последние семь дней. Расскажи, как неделя прошла на самом деле: на что она ушла, что сдвинулось, что встало и что всплывало не по одному разу, а я этого не замечал. В конце — одна вещь, которую стоит взять в следующую неделю. Только то, что есть в заметках: если день пустой, так и скажи.",
  "Sort out the inbox": "Разбери входящие",
  "the inbox, sort the inbox, what's in my inbox": "входящие, разбери входящие, что во входящих",
  "Look in my inbox folder and at the notes I have not filed anywhere. Go through them and tell me, in order: what can be thrown away, what is already finished and just needs putting somewhere, and what is a real idea that deserves a note of its own. Do not move or delete anything — tell me, and I will decide.":
    "Загляни в мою папку входящих и в заметки, которые я никуда не разложил. Пройдись по ним и скажи по порядку: что можно выбросить, что уже готово и просто ждёт своего места, а что — настоящая идея, заслуживающая отдельной заметки. Ничего не перемещай и не удаляй: скажи мне, а решу я.",
  "Loose ends": "Незакрытые хвосты",
  "loose ends, what did I leave unfinished, what did I forget": "хвосты, что я не закончил, что я забыл",
  "Search my recent notes for things I started and never closed: tasks with no follow-up, questions I asked myself and never answered, notes that stop mid-thought. List them shortest-first, each with where it came from and what the next step would be. Nothing invented — only what is genuinely left hanging.":
    "Поищи в свежих заметках то, что я начал и не закрыл: задачи без продолжения, вопросы, которые я себе задал и не ответил, заметки, обрывающиеся на полумысли. Перечисли, начиная с самого короткого, — откуда оно и каким был бы следующий шаг. Ничего не выдумывай: только то, что действительно висит.",
  "Test me": "Проверь меня",
  "test me, quiz me, check what I remember": "проверь меня, устрой проверку, что я помню",
  "Take the note on my screen — or, if there is none, whatever I have been writing about lately — and test whether I actually understood it. Ask me ONE question and stop. Wait for my answer, say plainly whether it was right, add what I missed, and only then ask the next one. Questions about the meaning, not about the wording.":
    "Возьми заметку у меня на экране — а если её нет, то то, о чём я писал в последнее время, — и проверь, понял ли я это на самом деле. Задай ОДИН вопрос и остановись. Дождись ответа, честно скажи, верно или нет, добавь то, что я упустил, и только потом задавай следующий. Спрашивай про смысл, а не про формулировки.",
  "What I've forgotten": "Забытые заметки",
  "what have I forgotten, forgotten notes, old notes": "что я забыл, забытые заметки, старые заметки",
  "Find notes I have not touched in a long time that are about what I am working on now. For each one say what is in it and why it is worth reopening today. I am looking for the thing I wrote once and lost, not a list of old files.":
    "Найди заметки, которых я давно не трогал, но которые про то, чем я занимаюсь сейчас. По каждой скажи, что в ней и почему её стоит открыть именно сегодня. Мне нужно то, что я когда-то записал и потерял, а не список старых файлов.",
  "Draft it out": "Собери черновик",
  "draft it out, put together a draft, collect the material": "собери черновик, набросай черновик, собери материал",
  "I want to write something on the subject I am about to name. Search my vault for everything I have already said about it — including notes that use other words for it — and lay it out as a draft: what I already think, in what order it holds together, and where the holes are that I have nothing on yet. My own material only; the gaps stay gaps.":
    "Я хочу написать текст на тему, которую сейчас назову. Собери из хранилища всё, что я уже про это говорил, — в том числе там, где это названо другими словами, — и разложи черновиком: что я уже думаю, в каком порядке это складывается и где дыры, по которым у меня ничего нет. Только мой материал; дыры остаются дырами.",

  // ── automations ──
  "Automations": "Автоматизации",
  "Scheduled runs that write into your vault on their own — a morning digest, a catch-up on recent thoughts. Each one is the assistant answering a saved prompt at a time you choose.":
    "Задачи по расписанию, которые сами пишут в ваше хранилище: утренний дайджест, свод мыслей за последние дни. Каждая — это ассистент, отвечающий на сохранённый запрос в выбранное вами время.",
  "Add automation": "Добавить автоматизацию",
  "Morning digest": "Утренний дайджест",
  "Catch up on recent thoughts": "Свод мыслей за последние дни",
  "Custom automation": "Своя автоматизация",
  "Name": "Название",
  "Time": "Время",
  "Days": "Дни",
  "Every day": "Каждый день",
  "None selected = every day.": "Ничего не выбрано — значит каждый день.",
  "Where it writes": "Куда пишет",
  "Today's daily note": "В сегодняшнюю ежедневную заметку",
  "A new note": "В новую заметку",
  "Heading": "Заголовок раздела",
  "Under this heading in the daily note.": "Под этим заголовком в ежедневной заметке.",
  "Folder": "Папка",
  "Where the new note goes.": "Куда попадает новая заметка.",
  "Prompt": "Запрос",
  "What the assistant should do. It has the same tools as in a normal chat — it can read your notes, your daily entries, and search the web if that's on.":
    "Что должен сделать ассистент. У него те же инструменты, что и в обычном чате: он читает ваши заметки, ежедневные записи и может искать в сети, если поиск включён.",
  "Notify me when it's done": "Сообщать, когда готово",
  "Run now": "Запустить сейчас",
  "Running…": "Выполняю…",
  "Delete this automation": "Удалить эту автоматизацию",
  "{0} is ready": "«{0}» готов",
  "Nothing to write — the run came back empty.": "Писать нечего — запуск вернул пустой ответ.",
  "No automations yet. Add one to have the assistant work while you sleep.":
    "Пока нет ни одной. Добавьте — и ассистент будет работать, пока вы спите.",
  "Mon": "Пн", "Tue": "Вт", "Wed": "Ср", "Thu": "Чт", "Fri": "Пт", "Sat": "Сб", "Sun": "Вс",

  "Put together a short morning briefing for me. Look at my daily note for yesterday and my notes from the last two or three days. Remind me what I did, what ideas and thoughts came up, what's still open, and what's worth focusing on today. Warm and to the point, in the second person. Don't invent anything — only what's actually in my notes.":
    "Собери для меня короткий утренний дайджест. Загляни в мою вчерашнюю ежедневную заметку и в записи за последние два-три дня. Напомни, что я делал, какие идеи и мысли появились, что осталось незакрытым и на чём стоит сфокусироваться сегодня. Тепло и по делу, обращаясь ко мне на «ты». Ничего не выдумывай — только то, что реально есть в заметках.",
  "Catch me up on the last few days. Go through my recent notes and daily entries and pull the main threads into a short, connected read: what I've been thinking about, ideas that came up, tasks in flight, recurring themes, and anything I seem to have dropped.":
    "Введи меня в курс дела за последние несколько дней. Пройдись по свежим заметкам и ежедневным записям и собери главное в короткий связный рассказ: о чём я думал, какие идеи появлялись, какие задачи в работе, какие темы повторяются и что я, кажется, забросил.",

  // ── interface ──
  "Where the panel opens": "Где открывается панель",
  "Right sidebar": "Правая панель",
  "Left sidebar": "Левая панель",
  "Main area (as a tab)": "Основная область (вкладкой)",
  "Open on startup": "Открывать при запуске",
  "Language": "Язык",
  "Follow Obsidian": "Как в Obsidian",
  "Russian": "Русский",
  "English": "Английский",
  "Show the answer as text": "Показывать текст ответа",
  "The written answer arrives before the voice reaches it, so you read it and then hear it again. Off, the text keeps pace with the speech and the rest is a tap away. On, the whole answer appears at once.":
    "Написанный ответ приходит раньше, чем до него доберётся голос, — вы прочитываете его, а потом слушаете второй раз. Выключено — текст идёт вровень с речью, остальное открывается по нажатию. Включено — весь ответ появляется сразу.",
  "Show answer": "Показать ответ",
  "Hide answer": "Скрыть ответ",
  "Show what it's doing": "Показывать, что он делает",
  "Print each search and edit in the conversation, so you can see how it got there.":
    "Печатать каждый поиск и правку в диалоге, чтобы видеть, как он пришёл к ответу.",
  "Save conversations": "Сохранять разговоры",
  "Off, nothing is written down and a conversation is gone when you close the panel. On, each one becomes a note you can search and link to.":
    "Выключено — ничего не записывается, и разговор пропадает вместе с закрытой панелью. Включено — каждый становится заметкой, которую можно найти поиском и на которую можно сослаться.",
  "One note per conversation, named after the assistant and the time. Empty means the root of your vault.":
    "По заметке на разговор, в названии имя ассистента и время. Пусто — корень хранилища.",
  "Conversations folder": "Папка разговоров",

  // ── view ──
  "At your service": "К вашим услугам",
  "Switch to text": "Перейти в текстовый режим",
  "Switch to voice": "Перейти в голосовой режим",
  "Type a message…": "Напишите сообщение…",
  "Send": "Отправить",
  "Dictate": "Надиктовать",
  "Copy": "Копировать",
  "Copied": "Скопировано",
  "Could not copy": "Не удалось скопировать",
  "Read aloud": "Озвучить",
  "Sources: ": "Источники: ",
  "New conversation": "Новый разговор",
  "Confirmed": "Подтверждено",
  "Ask me anything about your notes": "Спросите что угодно о ваших заметках",
  "I search your vault and answer from it. Switch to the reactor any time to talk instead.":
    "Я ищу по хранилищу и отвечаю по нему. В любой момент можно вернуться к реактору и поговорить голосом.",
  "Add a provider and a key in settings, then we can start.":
    "Добавьте провайдера и ключ в настройках, тогда и начнём.",
  "How the panel opens": "Как открывается панель",
  "Reactor — voice first, one big dial that shows what's happening.":
    "Реактор — голос на первом месте, вся жизнь панели в одном круге.",
  "Text — a conversation you read, with sources and copy buttons.":
    "Текст — разговор, который читаешь: с источниками и кнопкой копирования.",
  "You can switch any time from the button in the panel header.":
    "Переключаться можно в любой момент кнопкой в шапке панели.",
  "or type…": "или напишите…",
  "On screen: {0}": "На экране: {0}",
  "Waiting for your confirmation": "Жду подтверждения",
  "Answering…": "Отвечаю…",
  "Listening…": "Слушаю…",
  "Thinking…": "Думаю…",
  "Hold to talk": "Держите, чтобы говорить",
  "Stop talking": "Закончить разговор",
  "You interrupted": "Вы перебили",
  "Set up the plugin first": "Сначала настройте плагин",
  "Searching: {0}": "Ищу: {0}",
  "Looking in: {0}": "Смотрю в: {0}",
  "Read: {0}": "Читаю: {0}",
  "Opened: {0}": "Открыл: {0}",
  "Created: {0}": "Создал: {0}",
  "Edited: {0}": "Правлю: {0}",
  "Deleted: {0}": "Удалил: {0}",
  "Undone": "Отменил",
  "Nothing to undo": "Нечего отменять",
  "Microphone unavailable: {0}": "Микрофон недоступен: {0}",
  "Didn't catch that": "Не расслышал",
  "Something went wrong: {0}": "Что-то пошло не так: {0}",

  // ── confirmation ──
  "Confirm deletion": "Подтвердите удаление",
  "Delete this note?": "Удалить эту заметку?",
  "It goes to the system trash, so it can still be recovered from there.":
    "Она уйдёт в системную корзину, откуда её ещё можно восстановить.",
  "Press Enter to delete, Esc to keep it.": "Enter — удалить, Esc — оставить.",
  "Confirm change": "Подтвердите правку",
  "Press Enter to apply, Esc to cancel.": "Enter — применить, Esc — отменить.",
  "Kept": "Оставил",
  "Cancelled": "Отменено",

  // ── about ──
  "Version {0}": "Версия {0}",
  "Your notes stay in your vault. Only the text needed to answer a question is sent to the provider you chose — and with a local model, nothing leaves your machine at all.":
    "Заметки остаются в вашем хранилище. Провайдеру уходит только текст, нужный для ответа на вопрос, — а с локальной моделью не уходит вообще ничего.",
  "Show the setup guide again": "Показать пошаговую настройку заново",

  // ── the note on screen, dictation ──
  "Reading the guide: {0}": "Читаю руководство: {0}",
  "Reading the template: {0}": "Читаю шаблон: {0}",
  "No note in front of you": "Заметка не открыта",
  "Re-read the note on screen": "Перечитать открытую заметку",
  "Now reading: {0}": "Теперь читаю: {0}",
  "Stop dictating": "Остановить запись",
  "Speaking… let go when you're done": "Говорите… отпустите, когда закончите",

  // ── the vault's own shape ──
  "Vault": "Хранилище",
  "Tasks": "Задания",
  "Let it learn your vault": "Пусть изучит хранилище",
  "Before it writes anything it needs to know how your vault is arranged — which folders hold what, and which templates a new note should be built from. Here is what it found. Correct it if it got something wrong.":
    "Прежде чем что-то писать, ассистенту нужно понять, как устроено ваше хранилище: какие папки за что отвечают и по каким шаблонам создавать заметки. Вот что он нашёл сам — поправьте, если ошибся.",
  "Where things live": "Где что лежит",
  "Where notes the assistant creates end up when it has no better idea.":
    "Куда попадают созданные ассистентом заметки, если он не придумал места лучше.",
  "Templates folder": "Папка шаблонов",
  "Found on its own: {0}": "Нашёл сам: {0}",
  "None found — point at it if you have one.": "Не нашёл — укажите, если она есть.",
  "The assistant reads a template before creating a note of that kind, so a project note comes out looking like your other project notes. Found on its own: {0}":
    "Перед созданием заметки ассистент прочитает подходящий шаблон — чтобы заметка проекта выглядела как остальные заметки проектов. Нашёл сам: {0}",
  "The assistant reads a template before creating a note of that kind, so a project note comes out looking like your other project notes. Empty means it asks the Templates or Templater plugin where they are.":
    "Перед созданием заметки ассистент прочитает подходящий шаблон — чтобы заметка проекта выглядела как остальные заметки проектов. Пусто — спросит папку у плагина «Шаблоны» или Templater.",
  "Learn the vault's structure": "Изучать структуру хранилища",
  "Folds a map of your vault into every request — the folders, what is in them, which templates exist. This is what stops it filing a project note in the root and inventing a shape for it.":
    "Вкладывает карту хранилища в каждый запрос: папки, что в них лежит, какие есть шаблоны. Именно это мешает ему бросить заметку проекта в корень и выдумать ей вид.",
  "What it sees": "Что он видит",
  "Nothing here was written by hand or asked of a model. The plugin walks the file list Obsidian already keeps: folders with how many notes are under each, the folders one level in, the contents of your templates folder, and the daily-notes folder from your Obsidian settings. It costs nothing, rebuilds itself when the vault changes, and goes into every request as the text below.":
    "Здесь ничего не написано руками и ничего не спрошено у модели. Плагин проходит по списку файлов, который Obsidian и так ведёт: папки и сколько заметок в каждой, папки на уровень внутрь, содержимое вашей папки шаблонов и папка ежедневных заметок из настроек Obsidian. Это ничего не стоит, пересобирается само при изменениях в хранилище и уходит в каждый запрос ровно в том виде, что ниже.",
  "Anything it should know about your system": "Что ещё стоит знать о вашей системе",
  "Read the map above; whatever it cannot tell from folder names, write here. \"Projects live in 1. Projects, one note each, always linked from the MOC\" is the kind of thing that saves a dozen wrong guesses.":
    "Посмотрите карту выше и допишите то, чего не видно по названиям папок. «Проекты лежат в 1. Projects, по заметке на проект, всегда со ссылкой из MOC» — вот такая строчка экономит десяток неверных догадок.",
  "Whatever the folder names don't say. Optional — you can fill this in later.":
    "То, чего не видно по названиям папок. Необязательно — можно заполнить потом.",

  // ── hold a key and talk ──
  "Hold a key and talk": "Зажать клавишу и говорить",
  "Works anywhere in Obsidian, from any note. Hold the keys, say what you want, let go — the panel opens itself if it was closed. It is a combination the plugin watches directly, so it is set by pressing it rather than by typing it.":
    "Работает в любом месте Obsidian, из любой заметки. Зажали, сказали, отпустили — панель откроется сама, если была закрыта. Сочетание плагин слушает напрямую, поэтому его не вписывают, а нажимают.",
  "Key combination": "Сочетание клавиш",
  "Press the keys…": "Нажмите сочетание…",
  "Set": "Задать",
  "Change": "Изменить",
  "Turn it off": "Выключить",

  // ── saved tasks ──
  "By phrase": "По фразе",
  "On a schedule": "По расписанию",

  // ── telegram ──
  "Telegram": "Telegram",
  "Write to your vault from your phone. A bot you own passes your messages — typed or spoken — to this assistant, and sends its answers back. It has the same access to your notes as the panel does.":
    "Пишите своему хранилищу с телефона. Ваш собственный бот передаёт сообщения — текстом или голосом — этому ассистенту и возвращает ответы. Доступ к заметкам у него такой же, как у панели.",
  "⚠ Access to Telegram is restricted by some providers in Russia, and connections to it may be slow or fail entirely. If Telegram does not open normally on this computer, the bot will not answer reliably either.":
    "⚠ В России часть операторов ограничивает доступ к Telegram: соединение может быть медленным или не устанавливаться вовсе. Если Telegram на этом компьютере открывается с трудом, бот тоже будет отвечать с перебоями.",
  "⚠ Access to Telegram is restricted by some providers in Russia, and connections to it may be slow or fail entirely. If Telegram does not open normally for you, this bot will not work reliably either.":
    "⚠ В России часть операторов ограничивает доступ к Telegram: соединение может быть медленным или не устанавливаться вовсе. Если Telegram у вас открывается с трудом, бот тоже будет работать с перебоями.",
  "Connect a bot": "Подключить бота",
  "Four steps, with what you'll see at each one. No experience with Telegram bots needed.":
    "Четыре шага, и на каждом написано, что вы увидите. Опыт с ботами не нужен.",
  "Set up Telegram": "Настроить Telegram",
  "Answer messages": "Отвечать на сообщения",
  "Only while Obsidian is open on this computer. Anything sent while it is closed arrives the next time you open the vault.":
    "Только пока Obsidian открыт на этом компьютере. Всё, что придёт при закрытом, дождётся следующего запуска хранилища.",
  "Bot token": "Токен бота",
  "From BotFather. It is a password — anyone holding it can talk to your bot.":
    "Тот, что выдал BotFather. Это пароль: у кого он есть, тот может писать вашему боту.",
  "Check the token": "Проверить токен",
  "Paste the token first.": "Сначала вставьте токен.",
  "No token yet.": "Токена пока нет.",
  "This is a phone — the bot runs on the computer that holds the vault.":
    "Это телефон — бот работает на компьютере, где лежит хранилище.",
  "Send it to Telegram too": "Прислать ещё и в Telegram",
  "The result arrives in the chat as well as being written into your vault.":
    "Результат придёт в чат — и всё так же будет записан в хранилище.",
  "Connect a bot on the Telegram tab first — then this can send the result to your phone.":
    "Сначала подключите бота на вкладке Telegram — тогда результат сможет приходить на телефон.",
  "Written to: {0}": "Записано в: {0}",
  // ── privacy ──
  "Private folders": "Личные папки",
  "⚠ Answering a question sends parts of your notes to your AI provider. Anything in the folders below is never read, never searched, never indexed and never sent — even when it is the note open on your screen. This is the place for medical records, finances, passwords, other people's information, anything under an agreement.":
    "⚠ Чтобы ответить, ассистент отправляет куски ваших заметок ИИ-провайдеру. Всё, что лежит в папках ниже, он не читает, не ищет, не индексирует и никуда не отправляет — даже если эта заметка открыта у вас на экране. Сюда: медицина, финансы, пароли, сведения о других людях, всё, что под соглашением о неразглашении.",
  "One folder per line, relative to the vault root. Subfolders are covered too.":
    "По одной папке в строке, путь от корня хранилища. Вложенные папки тоже закрыты.",
  "{0} notes are hidden from the assistant right now.": "Сейчас от ассистента скрыто заметок: {0}.",
  "A narrower question than privacy: which part of the vault it works in day to day. Private folders stay hidden whatever you choose here.":
    "Вопрос поуже, чем приватность: в какой части хранилища он работает изо дня в день. Личные папки остаются скрытыми при любом выборе здесь.",
  "Left out of the index": "Не индексировать",
  "Folders that are not indexed. The assistant can still open these notes when you ask for one by name — they are just never sent away in bulk. Private folders are already excluded and do not need repeating here.":
    "Папки, которые не попадают в индекс. Ассистент по-прежнему откроет такую заметку, если попросить её по имени, — просто они не уезжают пачкой. Личные папки исключены и так, их здесь повторять не нужно.",

  // ── what indexing is ──
  "What indexing does, in plain words": "Что такое индексация, простыми словами",
  "Word search only finds notes containing the words you typed. Ask about «усталость» and a note that says «сил нет совсем» will not come up, though it is exactly what you meant.":
    "Поиск по словам находит только те заметки, где встречаются написанные вами слова. Спросите про «усталость» — заметка со словами «сил нет совсем» не найдётся, хотя это ровно про то же.",
  "Indexing fixes that. Each note is sent once to your provider, which returns a long list of numbers describing what the note is about — its meaning, expressed as coordinates. That list is kept in a file inside your vault. When you ask something, your question is turned into the same kind of numbers and compared against them, so notes about the same thing come up whatever words they use.":
    "Индексация это чинит. Каждая заметка один раз уезжает к провайдеру, а обратно приходит длинный список чисел, описывающий, о чём она, — смысл, записанный координатами. Этот список лежит файлом в вашем хранилище. Когда вы о чём-то спрашиваете, вопрос превращается в такие же числа и сравнивается с ними — поэтому заметки про одно и то же находятся, какими бы словами они ни были написаны.",
  "Two things to know: the pass costs tokens, roughly a small fraction of a cent per note, and it happens once per note — only notes you change afterwards are done again. And the text of every note that gets indexed is sent to your provider, which is why private folders are excluded from it and why you can leave more folders out below.":
    "Два важных момента. Проход стоит токенов — доли цента за заметку, и делается он один раз на заметку: заново уезжают только те, которые вы потом изменили. И текст каждой попавшей в индекс заметки уходит провайдеру — именно поэтому личные папки в индекс не берутся, а ниже можно исключить и другие.",
  "In your notes": "В ваших заметках",
  "Outside your notes": "За пределами заметок",
  "Also search by meaning": "Искать ещё и по смыслу",
  "Finds notes that say the same thing in different words.":
    "Находит заметки, где та же мысль сказана другими словами.",
  "Word search is always on: it builds itself from your vault in a second, costs nothing and needs no key.":
    "Поиск по словам работает всегда: индекс строится по хранилищу за секунду, ничего не стоит и не требует ключа.",
  "Let the assistant look things up online — news, facts, anything outside your vault. Answers are still grounded in your notes first.":
    "Разрешить ассистенту смотреть в интернет — новости, факты, всё, чего нет в хранилище. Отвечать он всё равно будет сначала по вашим заметкам.",
  "Made by Elton": "Сделал Элтон",
  "Who made this": "Кто это сделал",
  "Elton — I build tools for Obsidian and use this one every day. What the plugin sends, where it sends it and what it never touches is written out in full on the Vault tab and in the readme: ":
    "Элтон — делаю инструменты для Obsidian и этим пользуюсь сам каждый день. Что плагин отправляет, куда именно и чего не трогает никогда — расписано на вкладке «Хранилище» и в описании: ",
  "What it may do": "Что ему можно",
  "chosen folders only": "только выбранные папки",
  "all but some folders": "всё, кроме некоторых папок",
  "new notes: root": "новые заметки: корень",
  "no daily notes": "нет ежедневных",
  "{0} templates": "шаблонов: {0}",
  "off — it files notes blind": "выключено — создаёт вслепую",
  "nothing from you": "без ваших пояснений",
  "by words": "по словам",
  "by meaning": "по смыслу",
  "the web": "интернет",

  // ── the vault tab, as four lines ──
  "What it may do with notes": "Что ему можно делать с заметками",
  "reads": "читает",
  "creates": "создаёт",
  "edits": "правит",
  "deletes": "удаляет",
  "runs your tabs": "управляет вкладками",
  "nothing — it can only chat": "ничего — только разговаривает",
  "whole vault": "всё хранилище",
  "only chosen folders": "только выбранные папки",
  "all but chosen folders": "всё, кроме выбранных папок",
  "new notes: vault root": "новые заметки: корень хранилища",
  "no daily notes folder": "папка ежедневных не задана",
  "no templates": "шаблонов нет",
  "What it knows about your vault": "Что он знает о хранилище",
  "switched off — it files notes blind": "выключено — заметки создаются вслепую",
  "map on": "карта включена",
  "{0} templates found": "шаблонов найдено: {0}",
  "no templates found": "шаблонов не найдено",
  "your notes added": "есть ваши пояснения",
  "Search and the web": "Поиск и интернет",
  "word search always on": "по словам — всегда",
  "meaning search on": "по смыслу — включён",
  "meaning search off": "по смыслу — выключен",
  "web on": "интернет включён",
  "web off": "интернет выключен",
  "A switched-off permission is not an instruction the assistant is asked to respect — the tool simply stops existing for it. It cannot be talked into using one.":
    "Выключенное право — это не просьба к ассистенту его соблюдать: инструмент просто перестаёт для него существовать. Уговорить его нельзя.",
  "Your screen": "Ваш экран",
  "The restriction applies to search as well: notes outside the scope never appear in results.":
    "Ограничение действует и на поиск: заметки вне области не появятся даже в выдаче.",
  "These three decide where a new note lands and what shape it takes. Left empty, the assistant guesses — and a guess is how a project note ends up in the vault root with nothing linking to it.":
    "Эти три поля решают, куда попадёт новая заметка и какой она будет. Если оставить пусто, ассистент гадает — а гадание и есть та причина, по которой заметка проекта оказывается в корне и на неё ничего не ссылается.",
  "Templates it can build from: {0}": "Шаблонов, по которым он может создавать: {0}",
  "No templates in that folder yet.": "В этой папке пока нет шаблонов.",
  "Set this up on your computer": "Настраивается на компьютере",
  "The bot is answered by the computer that holds your vault — that is the whole point of it, and it is why a phone is where you write TO the bot rather than where it runs. These settings are on the Telegram tab there.":
    "Боту отвечает компьютер, на котором лежит хранилище, — в этом весь смысл: с телефона вы боту пишете, а работает он там. Настройки — на вкладке Telegram на компьютере.",
  "It is switched on for this vault, so your computer answers whenever Obsidian is open on it.":
    "Для этого хранилища бот включён — компьютер отвечает, пока на нём открыт Obsidian.",
  "It is not switched on yet.": "Пока не включён.",
  "Switched off.": "Выключено.",
  "Listening. Linked to your Telegram account.": "Слушает. Привязан к вашему аккаунту Telegram.",
  "Not running — reopen the vault or switch it off and on.":
    "Не запущен — перезапустите хранилище или выключите и включите обратно.",
  "Telegram refused the token: {0}": "Telegram отклонил токен: {0}",
  "Works — the bot is @{0}. Now go and say /start to it.":
    "Работает, бот @{0}. Теперь напишите ему /start.",
  "Send me a test message": "Прислать мне тестовое сообщение",
  "This is {0}, speaking from your vault. Everything works.":
    "Это {0}, пишу из вашего хранилища. Всё работает.",
  "Sent.": "Отправлено.",
  "Nobody is linked yet — send /start to the bot first.":
    "Пока никто не привязан — сначала напишите боту /start.",
  "Linked account": "Привязанный аккаунт",
  "The only Telegram account this bot answers. Clearing it lets the next person to send /start take over — do that only if it is you.":
    "Единственный аккаунт Telegram, которому бот отвечает. Если стереть, ботом завладеет следующий, кто напишет /start, — делайте это, только если это будете вы.",
  "Linked to your Telegram account. It is listening.": "Привязан к вашему аккаунту Telegram. Слушает.",
  "Waiting for /start. Send it from the phone you want to use.":
    "Жду /start. Напишите его с того телефона, с которого будете пользоваться.",
  "Forget the linked account": "Забыть привязанный аккаунт",
  "What this actually is": "Что это вообще такое",
  "A Telegram bot is a chat account you own. You write to it from your phone, and the assistant on this computer answers — the same one as in the panel, with the same access to your notes. Nothing is published anywhere: the bot talks only to you.":
    "Бот в Telegram — это ваш собственный собеседник. Вы пишете ему с телефона, а отвечает ассистент с этого компьютера: тот же самый, что в панели, и с тем же доступом к заметкам. Никуда ничего не публикуется — бот говорит только с вами.",
  "Two things to know first": "Две вещи, которые стоит знать сразу",
  "It answers only while Obsidian is open on this computer. Messages sent while it is closed arrive the next time you open the vault.":
    "Отвечает, только пока Obsidian открыт на этом компьютере. Сообщения, отправленные при закрытом, придут при следующем запуске.",
  "Set it up on one computer only. Two would take turns answering at random.":
    "Настраивайте только на одном компьютере. Два будут отвечать по очереди в случайном порядке.",
  "Make the bot": "Создайте бота",
  "In Telegram, find the account called BotFather — the one with the blue tick. Send it /newbot. It asks for a name (anything, e.g. «My vault»), then for a username, which must end in bot (e.g. elton_vault_bot). It replies with a long line of letters and digits after «Use this token to access the HTTP API» — that line is the token.":
    "В Telegram найдите аккаунт BotFather — тот, что с синей галочкой. Отправьте ему /newbot. Он спросит название (любое, например «Моё хранилище»), потом имя пользователя — оно обязано заканчиваться на bot (например elton_vault_bot). В ответ придёт длинная строка из букв и цифр после слов «Use this token to access the HTTP API». Эта строка и есть токен.",
  "The token looks like this": "Токен выглядит так",
  "It is a password. Anyone who has it can talk to your bot, so do not put it in a note or send it to anyone.":
    "Это пароль. Кто им завладеет, тот сможет писать вашему боту, — не кладите его в заметку и никому не пересылайте.",
  "Paste the token": "Вставьте токен",
  "Paste it here and press check. The plugin asks Telegram whether the token is real and tells you the bot's name back — if the name is right, the token is right.":
    "Вставьте его сюда и нажмите проверку. Плагин спросит у Telegram, настоящий ли токен, и покажет имя бота: имя верное — значит, и токен верный.",
  "Say hello to it": "Поздоровайтесь с ним",
  "Open your bot in Telegram — BotFather gave you a t.me link to it — and send it /start. The first person to do that becomes the owner, and from then on it answers nobody else.":
    "Откройте своего бота в Telegram (BotFather прислал ссылку t.me) и отправьте ему /start. Кто сделает это первым, тот и станет владельцем: больше бот не ответит никому.",
  "What it can and cannot do": "Что он умеет и чего не умеет",
  "It searches, reads, creates and edits notes exactly as the panel does. It cannot delete: deleting waits for a key press at the keyboard, and over a chat there is nobody to press it — so it declines and says so.":
    "Ищет, читает, создаёт и правит заметки ровно как панель. Удалять не может: удаление ждёт нажатия клавиши на клавиатуре, а в переписке нажимать некому — поэтому он отказывается и прямо об этом говорит.",
  "Voice messages are transcribed with your provider, the same way the panel hears you.":
    "Голосовые расшифровывает ваш провайдер — так же, как панель слышит вас.",
  "Send /new in the chat to make it forget the conversation so far.":
    "Напишите в чат /new, чтобы он забыл предыдущий разговор.",
  "Set it up on one computer only: Telegram gives each message to whoever asks first, so two would answer half each.":
    "Настраивайте только на одном компьютере: Telegram отдаёт сообщение тому, кто спросил первым, — два устройства ответят по половине каждое.",
  // ── what the bot itself says ──
  "Send /start to link this bot to your vault.": "Отправьте /start, чтобы привязать бота к хранилищу.",
  "Linked. This bot now answers only you, and only while Obsidian is open on your computer.\n\nWrite to it the way you would speak to the panel — ask about your notes, or ask it to write one. Voice messages work too.":
    "Привязал. Теперь бот отвечает только вам и только пока Obsidian открыт на компьютере.\n\nПишите ему так же, как говорили бы с панелью: спрашивайте о заметках или просите что-нибудь записать. Голосовые тоже понимает.",
  "Ready. Ask about your notes, or ask for one to be written.":
    "Готов. Спрашивайте о заметках или просите что-нибудь записать.",
  "Forgotten. Starting fresh.": "Забыл. Начинаем заново.",
  "Still working on the last one — one moment.": "Ещё отвечаю на прошлое — секунду.",
  "I can read text and listen to voice messages — nothing else yet.":
    "Я понимаю текст и голосовые — больше пока ничего.",
  "I couldn't make that out. Try again?": "Не разобрал. Ещё раз?",
  "I have nothing to say to that.": "Мне нечего на это ответить.",
  "From your notes:": "Из ваших заметок:",
  "Thinking about your answer…": "Думаю над вашим ответом…",
  "What this bot can do": "Что умеет этот бот",
  "Telegram would not take the formatted message ({0}), so answers are being sent as plain text.":
    "Telegram не принял сообщение с оформлением ({0}) — ответы уходят простым текстом.",
  "If you can read this as a heading and the list below as a list, formatting is working.":
    "Если сверху виден заголовок, а ниже — список, значит оформление работает.",
  "Search and read your notes": "Искать и читать ваши заметки",
  "Create and edit them": "Создавать и править их",
  "Listen to voice messages": "Понимать голосовые",
  "A fold, like the one your sources arrive in": "Сворачиваемый блок — в таком приходят источники",
  "Tap it to open.": "Нажмите, чтобы раскрыть.",
  "Forget the conversation so far": "Забыть предыдущий разговор",
  "What I can do": "Что я умею",
  "Write to me the way you would speak to the panel — about your notes, or asking for one to be written. Voice messages work too.":
    "Пишите мне так же, как говорили бы с панелью: о своих заметках или с просьбой что-нибудь записать. Голосовые тоже понимаю.",
  "Commands": "Команды",
  "Your scenarios": "Ваши сценарии",
  "Each one also works as a spoken phrase — just write it out.":
    "Каждый работает и обычной фразой — просто напишите её словами.",
  "I can search, read, create and edit notes. I cannot delete — that waits for a key press at the keyboard, and there is nobody here to press it.":
    "Я умею искать, читать, создавать и править заметки. Удалять не умею: удаление ждёт нажатия клавиши на клавиатуре, а здесь нажимать некому.",
  "Creating notes is switched off in settings right now.":
    "Создание заметок сейчас выключено в настройках.",
  "I don't know that command. Send /help for the list.":
    "Не знаю такой команды. Отправьте /help — покажу список.",
  "In Telegram this scenario answers to /{0}": "В Telegram этот сценарий отзывается на /{0}",
  "What it is called on the button and in the bot's menu.":
    "Как он называется на кнопке и в меню бота.",
  "Listening to your message…": "Слушаю ваше сообщение…",
  // The unit on the clock in the waiting caption: "Думаю… · 45 с".
  "s": "с",
  "Show an animation while it thinks": "Показывать анимацию, пока он думает",
  "An answer takes tens of seconds. A moving picture appears the moment you write, its caption says what the assistant is doing right now — searching, reading, writing — and it disappears when the answer arrives.":
    "Ответ готовится десятки секунд. Картинка появляется сразу, как вы написали, в подписи видно, чем ассистент занят прямо сейчас — ищет, читает, пишет, — и она исчезает, когда ответ готов.",
  "Your own animation": "Своя анимация",
  "A link to a .gif or .mp4. Empty means the built-in one. It is uploaded once and then reused from Telegram's own storage.":
    "Ссылка на .gif или .mp4. Пусто — встроенная. Загружается один раз, дальше берётся из хранилища самого Telegram.",
  "Link to a GIF": "Ссылка на GIF",
};

let LANG = "en";
function setLang(mode) {
  if (mode === "ru" || mode === "en") { LANG = mode; return; }
  const l = getLanguage() || "en";
  LANG = l === "ru" ? "ru" : "en";
}
/** Translate + interpolate {0}, {1}… */
function t(s, ...args) {
  let out = LANG === "ru" && RU[s] ? RU[s] : s;
  for (let i = 0; i < args.length; i++) out = out.split("{" + i + "}").join(String(args[i]));
  return out;
}

/* ── settings ─────────────────────────────────────────────── */
const PROVIDERS = {
  // fixedBase: the address is part of the service, not a user setting, so it
  // is never shown in the settings UI.
  obsimind:   { label: "Elton AI", needsKey: true,  base: "https://api.eltonlabs.org", model: "anthropic/claude-sonnet-4.5", proxyHeader: true, fixedBase: true },
  openrouter: { label: "OpenRouter",  needsKey: true,  base: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5" },
  // qwen2.5:3b rather than a reasoning model like qwen3: on a laptop GPU the
  // thinking pass costs 15-20s per turn before a word is spoken, which is
  // fatal for a voice assistant. This one answers and calls tools in under a
  // second on the same hardware.
  local:      { label: "Local model (Ollama / LM Studio)", needsKey: false, base: "http://localhost:11434/v1", model: "qwen2.5:3b" },
  openai:     { label: "OpenAI",      needsKey: true,  base: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
};

/* ── model catalogue ───────────────────────────────────────────
 * A short list beats a text box. The proxy does not answer
 * GET /v1/models (405), so there is nothing to fetch there, and
 * typing a model id from memory is how you end up with a setting
 * that fails on the first question with an unhelpful 404.
 *
 * Every model here must support tool calling — without it the
 * assistant can talk but cannot search or edit, which reads as a
 * broken plugin rather than a wrong setting.
 *
 * This list is a convenience, not a limit: "Another model" still
 * takes anything the provider accepts. Enforcement belongs on the
 * server, which is the only place a client cannot argue with.
 */
const MODEL_CATALOG = {
  // Elton AI and OpenRouter share an upstream, so they share a list.
  obsimind: [
    { id: "anthropic/claude-sonnet-4.6", note: "умный, лучший баланс" },
    { id: "anthropic/claude-sonnet-4.5", note: "проверенный, чуть дешевле" },
    { id: "anthropic/claude-haiku-4.5", note: "быстрый и дешёвый" },
    { id: "openai/gpt-5.5", note: "умный" },
    { id: "openai/gpt-4.1-mini", note: "быстрый и дешёвый" },
    { id: "google/gemini-3.5-flash", note: "самый быстрый" },
    { id: "google/gemini-2.5-pro", note: "большой контекст" },
    { id: "deepseek/deepseek-chat", note: "самый дешёвый" },
  ],
  openai: [
    { id: "gpt-5.5", note: "умный" },
    { id: "gpt-4.1", note: "баланс" },
    { id: "gpt-4.1-mini", note: "быстрый и дешёвый" },
    { id: "gpt-4o-mini", note: "самый дешёвый" },
  ],
  // Local models are named by whatever the user pulled, and Ollama does
  // answer /v1/models — so there the refresh button is the right tool.
  local: [],
};
MODEL_CATALOG.openrouter = MODEL_CATALOG.obsimind;

/**
 * The model that runs the searching, per provider, for `fastModel: "auto"`.
 *
 * Chosen by measurement through the proxy, on the same tool-calling request:
 * gemini-2.5-flash 0.9s, gpt-4.1-mini 1.0s, haiku-4.5 1.1s, sonnet-4.5 2.6s —
 * and every one of them picked the same tool. Note that a newer name is not
 * automatically quicker: gemini-3.5-flash took 3.1s on the same call.
 *
 * Local is deliberately empty. There is one small model on the machine
 * already; a second would compete for the same GPU rather than overlap.
 */
const FAST_MODELS = {
  obsimind: "google/gemini-2.5-flash",
  openrouter: "google/gemini-2.5-flash",
  openai: "gpt-4.1-mini",
  local: "",
};

/** Does this provider have a list worth showing instead of a text box? */
function modelChoices(providerId) {
  return MODEL_CATALOG[providerId] || [];
}

/** Can we ask this provider what it offers? The proxy answers 405. */
function canListModels(providerId) {
  return providerId === "local" || providerId === "openrouter" || providerId === "openai";
}

const DEFAULT_SETTINGS = {
  onboarded: false,
  lang: "auto",

  provider: "obsimind",
  keys: { obsimind: "", openrouter: "", local: "", openai: "" },
  bases: { obsimind: PROVIDERS.obsimind.base, openrouter: PROVIDERS.openrouter.base, local: PROVIDERS.local.base, openai: PROVIDERS.openai.base },
  // Cloud is the default engine: with Elton AI or any other cloud key the
  // voice should just work, exactly as it did before, with no extra setup.
  models: { obsimind: PROVIDERS.obsimind.model, openrouter: PROVIDERS.openrouter.model, local: PROVIDERS.local.model, openai: PROVIDERS.openai.model },
  // A local model can't hear or speak; this key keeps voice alive without
  // sending note text to the cloud.
  cloudFallback: { enabled: false, provider: "obsimind", key: "" },

  assistantName: "Assistant",
  userName: "",
  persona: "calm",
  personaCustom: "",
  // 900 was the old hard-coded ceiling and it guillotined long explanations
  // mid-word. Truncation is now recovered from, so this is a budget, not a cliff.
  replyTokens: 2000,
  // "auto" picks the quick model for the provider; "" runs everything on one.
  fastModel: "auto",
  contextNote: "",
  // Fold the shape of the vault into every prompt: top-level folders, what is
  // inside them, which templates exist, where the daily notes are. Costs a few
  // hundred tokens and is the difference between a note filed where it belongs
  // and one dropped wherever the model last looked.
  vaultMap: true,
  vaultNotes: "",

  voiceEnabled: true,
  ttsEngine: "cloud",
  piperUrl: "http://localhost:5000",
  cloudVoice: "Puck",
  speechSpeed: 1.1,
  // Off. Barge-in needs a microphone open while the assistant is talking, and
  // on any machine without headphones that microphone hears the speakers —
  // so the assistant interrupts itself on its own first sentence and the whole
  // answer arrives as silence. Clicking the reactor stops it, which is what
  // people reach for anyway. Anyone in headphones can switch it back on.
  allowInterrupt: false,
  interruptSensitivity: 8,
  micMode: "handsfree",
  // Hold a key anywhere in Obsidian and talk. Obsidian's own hotkeys fire on
  // the way down and never tell you about the way up, so this cannot be one of
  // them — it is a key combination watched directly. Off until it is given one.
  holdKey: null,          // { code, ctrl, shift, alt, meta }

  canRead: true,
  canCreate: true,
  canEdit: true,
  canDelete: false,
  // Tabs, splits and web pages. On by default: none of it touches a note, and
  // an assistant that can talk about a note but not show it is half an
  // assistant. Closing several at once still stops for a keypress.
  canControlUI: true,
  confirmEveryEdit: false,
  scopeMode: "all",
  scopeFolders: "",
  // Never read, whatever else is set. Checked before the scope, so it holds
  // even in "whole vault" mode and even for the note open on screen.
  privateFolders: "",
  // Readable when asked for, but never swept into the embedding index — which
  // is the one operation that sends every note in the vault to a provider.
  noIndexFolders: "",
  newNoteFolder: "",
  dailyFolder: "",
  // Where this vault keeps its templates. Empty means: ask the Templates core
  // plugin, then Templater, then look for a folder called that.
  templateFolder: "",

  // The bot that puts the vault on a phone. Off, and with no token, until
  // someone deliberately connects one.
  // `gifId` is filled in by Telegram itself the first time the waiting
  // animation is sent, so it is never downloaded twice.
  telegram: { enabled: false, token: "", userId: "", thinkingGif: true, thinkingGifUrl: "", gifId: "" },

  // Let the assistant reach the public internet. Only providers that route
  // through OpenRouter (Elton AI, OpenRouter) can do it, so the tool is
  // offered only for those — see buildTools.
  // Поиск в интернете включён сразу: без него ассистент отказывается искать
  // новости и факты, и это выглядит как поломка, а не как настройка.
  webSearch: true,
  webSearchResults: 5,

  // Scheduled runs of the assistant — a morning digest, a weekly review.
  // Each is a saved prompt with a time and a place to write the answer.
  automations: [],

  // Saved briefs behind a short phrase. Null rather than [] so a first run can
  // be told apart from someone who deleted every one of them.
  scenarios: null,

  semanticSearch: false,
  embedModel: "baai/bge-m3",
  // Point at an index another tool already built instead of paying to
  // rebuild one. Empty means the plugin keeps its own inside its folder.
  embedIndexPath: "",
  waitingSound: true,
  waitingSoundFile: "",     // empty = the sample shipped with the plugin
  waitingVolume: 0.28,

  // The answer as it is written, rather than after it is finished. Costs
  // nothing and removes most of the waiting; falls back on its own where the
  // transport can't do it.
  streamReplies: true,
  // What the turn cost, under the answer. On because the alternative is
  // guessing, and guessing about money makes people use it less.
  showCost: true,

  viewLocation: "right",
  viewMode: "reactor",
  openOnStartup: false,
  // Off by default: the text lands well before the voice reaches it, so you
  // end up reading the answer and then listening to it a second time.
  showReplyText: false,
  showActions: true,
  saveConversations: false,
  conversationFolder: "",
};

/* ── small helpers ─────────────────────────────────────────── */
const wait = (ms) => new Promise((r) => window.setTimeout(r, ms));

/* ── a key combination you hold ────────────────────────────────
 * Stored by `code`, not by `key`: the physical key is what a finger
 * holds down, and `key` changes with the keyboard layout — a
 * combination set on a Russian layout would stop firing on an
 * English one, which is not a thing anyone would think to check.
 * ────────────────────────────────────────────────────────────── */
function hotkeyFromEvent(e) {
  if (!e.code || /^(Control|Shift|Alt|Meta)/.test(e.code)) return null;
  return { code: e.code, ctrl: !!e.ctrlKey, shift: !!e.shiftKey, alt: !!e.altKey, meta: !!e.metaKey };
}

function hotkeyMatches(hk, e) {
  return !!hk && e.code === hk.code
    && !!e.ctrlKey === !!hk.ctrl && !!e.shiftKey === !!hk.shift
    && !!e.altKey === !!hk.alt && !!e.metaKey === !!hk.meta;
}

function hotkeyLabel(hk) {
  if (!hk) return t("Not set");
  const parts = [];
  if (hk.ctrl) parts.push("Ctrl");
  if (hk.shift) parts.push("Shift");
  if (hk.alt) parts.push("Alt");
  if (hk.meta) parts.push(Platform && Platform.isMacOS ? "Cmd" : "Win");
  parts.push(String(hk.code).replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num "));
  return parts.join(" + ");
}

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "");
  // Bases are configured with or without the /v1 suffix; don't double it.
  if (/\/v\d+$/.test(b) && p.startsWith("/v1/")) return b + p.slice(3);
  return b + p;
}

function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/**
 * Hold the reader's place across a redraw.
 *
 * Half the settings in this plugin decide whether the others exist, so
 * touching one rebuilds the page or the window it lives on. Every one of those
 * rebuilds used to start again at the top, which means the control you just
 * used scrolls out from under your cursor — and in a text field it means you
 * cannot type a second character.
 *
 * Call before emptying the container; call the returned function after
 * refilling it. Twice, because immediately after a redraw the box can still be
 * shorter than the position being restored — the frame after, it is not.
 *
 *   const back = keepScroll(el);
 *   el.empty(); rebuild(el);
 *   back();
 */
function keepScroll(el) {
  const was = el ? el.scrollTop : 0;
  return () => {
    if (!el || !was) return;
    el.scrollTop = was;
    window.requestAnimationFrame(() => { el.scrollTop = was; });
  };
}

/**
 * Make a plain element behave like a button.
 *
 * Used instead of an actual <button> wherever the clickable thing is a layout
 * — a tile, a row — rather than a control. Themes are entitled to restyle
 * buttons, and they do: a fixed height, a panel background, centred content.
 * A two-line tile inside that collapses and spills over its neighbour. A div
 * inherits nothing, so this hands back the three things a button gave us:
 * the role, the tab stop, and Enter/Space.
 */
function clickable(el) {
  el.setAttr("role", "button");
  el.setAttr("tabindex", "0");
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    el.click();
  });
  return el;
}

/** The last segment of a path — what a folder is actually called. */
function tail(path) {
  const p = String(path || "").replace(/\/+$/, "");
  return p.slice(p.lastIndexOf("/") + 1) || p;
}

/** Strip characters Obsidian won't accept in a file name. */
function safeTitle(s) {
  return String(s || "").replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "Untitled";
}

/** Markdown/frontmatter noise removed, so search and prompts see prose. */
function stripMarkdown(text) {
  return String(text || "")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[\[[^\]]*\]\]/g, " ")
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`>]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
