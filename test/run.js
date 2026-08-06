/* ============================================================
 *  Tests
 *
 *      node test/run.js
 *
 *  No framework: the plugin has no build step and no dependencies,
 *  and a test runner would be the first. Assertions here are about
 *  behaviour that is easy to break by accident and expensive to
 *  notice — what a trigger phrase matches, which pane a note lands
 *  in, what the model is allowed to reach.
 * ========================================================== */

const H = require("./harness");

let passed = 0, failed = 0, group = "";
const results = [];

function describe(name) { group = name; results.push({ head: name }); }
function ok(cond, name, detail) {
  if (cond) { passed++; results.push({ pass: true, name }); }
  else { failed++; results.push({ pass: false, name, detail }); }
}
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, name, `ждали ${e}, получили ${a}`);
}

(async () => {
  const T = H.load();
  T.setLang("ru");

  /* ── 1. Scenario matching ──────────────────────────────── */
  describe("Сценарии: распознавание фразы");
  {
    const list = [
      { enabled: true, prompt: "P-мысли", name: "Мысли", triggers: "мысли, о чём я думал, последние мысли" },
      { enabled: true, prompt: "P-связи", name: "Связи", triggers: "найди связи, с чем это связано" },
      { enabled: true, prompt: "P-день", name: "День", triggers: "что сегодня, план на день" },
      { enabled: false, prompt: "P-выкл", name: "Выключен", triggers: "выключенный сценарий" },
      { enabled: true, prompt: "", name: "Пустой", triggers: "пустой" },
    ];
    const hit = (s) => { const m = T.matchScenario(s, list); return m ? m.scenario.name : null; };

    eq(hit("Мысли"), "Мысли", "одно слово целой фразой — срабатывает");
    eq(hit("мысли."), "Мысли", "пунктуация не мешает");
    eq(hit("МЫСЛИ"), "Мысли", "регистр не мешает");
    eq(hit("о чем я думал"), "Мысли", "«е» вместо «ё» не мешает");
    eq(hit("Запиши мои мысли о проекте"), null, "одно слово внутри фразы — НЕ срабатывает");
    eq(hit("Слушай, а о чём я думал вчера?"), "Мысли", "фраза из двух слов ловится внутри предложения");
    eq(hit("поговорим о связистах"), null, "часть слова не считается совпадением");
    eq(hit("найди связи с этой заметкой"), "Связи", "триггер в начале");
    eq(hit("выключенный сценарий"), null, "выключенный сценарий не срабатывает");
    eq(hit("пустой"), null, "сценарий без задания не срабатывает");
    eq(hit("открой заметку про Париж"), null, "обычный вопрос не перехватывается");

    const m = T.matchScenario("найди связи с этой заметкой", list);
    eq(m.rest, "с этой заметкой", "остаток фразы сохраняется как уточнение");
    ok(T.scenarioPrompt(m.scenario, m.rest).includes("с этой заметкой"), "остаток попадает в задание");
    eq(T.scenarioPrompt(m.scenario, "ну"), "P-связи", "мусорный остаток отбрасывается");

    // Самый длинный триггер должен побеждать более общий.
    const overlap = [
      { enabled: true, prompt: "p", name: "Общий", triggers: "что сегодня" },
      { enabled: true, prompt: "p", name: "Точный", triggers: "что сегодня по проекту" },
    ];
    eq(T.matchScenario("что сегодня по проекту", overlap).scenario.name, "Точный",
      "длинный триггер выигрывает у короткого");
  }

  describe("Сценарии: пресеты");
  {
    const d = T.defaultScenarios();
    eq(d.length, 3, "из коробки три сценария");
    ok(d.every((x) => x.prompt && x.triggers && x.emoji), "у каждого есть задание, фразы и эмодзи");
    ok(d.every((x) => T.matchScenario(x.triggers.split(",")[0].trim(), d)), "первая фраза каждого действительно его находит");
    const ids = new Set(d.map((x) => x.id));
    eq(ids.size, 3, "идентификаторы не повторяются");
  }

  /* ── 2. Tabs ───────────────────────────────────────────── */
  describe("Вкладки: чтение и поиск");
  {
    const app = H.fakeApp({ tabs: [
      { title: "Проект", path: "1. Projects/Проект.md" },
      { title: "Проект — архив", path: "4. Archive/Проект — архив.md" },
      { title: "Ассистент", type: T.VIEW_TYPE },
      { title: "obsidian.md", type: "webviewer" },
    ] });
    const p = H.fakePlugin(app);
    const V = p.vault;

    eq(V.listTabs().length, 4, "видит все вкладки основной области");
    eq(V.listTabs()[0].active, true, "первая помечена активной");
    eq(V.matchTabs("Проект").map((x) => x.title), ["Проект"],
      "точное имя выигрывает у вкладки, которая его содержит");
    eq(V.matchTabs("проект").map((x) => x.title), ["Проект"], "регистр не мешает");
    eq(V.matchTabs("архив").map((x) => x.title), ["Проект — архив"], "поиск по части имени");
    eq(V.matchTabs("Archive").map((x) => x.title), ["Проект — архив"], "поиск по пути");
    eq(V.matchTabs("нет такого").length, 0, "несуществующее не находится");
    eq(V.matchTabs("").length, 4, "пустой запрос — это «все»");
  }

  describe("Вкладки: закрытие");
  {
    const app = H.fakeApp({ tabs: [
      { title: "Заметка", path: "a.md" },
      { title: "Ассистент", type: T.VIEW_TYPE },
    ] });
    const V = H.fakePlugin(app).vault;

    const closed = V.closeTabs(V.matchTabs(""));
    eq(closed, ["Заметка"], "закрывает заметку, но НЕ панель ассистента");
    eq(V.listTabs().map((x) => x.title), ["Ассистент"], "панель ассистента осталась");
    eq(V.closeTabs(V.matchTabs("")), [], "повторное закрытие ничего не ломает");
  }

  /* ── 3. Web pages ──────────────────────────────────────── */
  describe("Веб-страницы: что открывается, а что нет");
  {
    const V = H.fakePlugin(H.fakeApp({ webviewer: true })).vault;
    const rejected = async (url, why) => {
      try { await V.openUrl(url); ok(false, why, "открылось, хотя не должно"); }
      catch { ok(true, why); }
    };
    await rejected("javascript:alert(1)", "javascript: отклоняется");
    await rejected("file:///C:/Windows/System32", "file: отклоняется");
    await rejected("obsidian://open?vault=x", "obsidian: отклоняется");
    await rejected("не адрес вовсе", "мусор отклоняется");
    await rejected("", "пустая строка отклоняется");

    const r = await V.openUrl("https://obsidian.md/plugins");
    eq(r.where, "obsidian", "https открывается внутри хранилища");
    eq(r.url, "https://obsidian.md/plugins", "адрес не искажается");
    const st = V.app.workspace.created.viewState;
    eq(st.type, "webviewer", "открывается именно во «Веб-просмотре»");
    eq(st.state.url, "https://obsidian.md/plugins", "адрес уходит во view state");

    const off = H.fakePlugin(H.fakeApp({ webviewer: false })).vault;
    const r2 = await off.openUrl("http://example.com/");
    eq(r2.where, "browser", "с выключенным веб-просмотром уходит в системный браузер");
  }

  /* ── 4. Which pane ─────────────────────────────────────── */
  describe("Куда открывается заметка");
  {
    const app = H.fakeApp({ tabs: [{ title: "Открытая", path: "a.md" }] });
    const V = H.fakePlugin(app).vault;
    const file = new H.TFile("b.md");

    await V.openNote(file);
    eq(app.workspace.leaves[0].opened, file, "заметка попадает в основную область, не в панель ассистента");

    await V.openNoteSplit(file);
    eq(app.workspace.created.created, "split", "«рядом» — это split, а не новая вкладка поверх");
    eq(app.workspace.created.opened, file, "и в него открывается нужный файл");
  }

  /* ── 5. Permissions decide the toolset ─────────────────── */
  describe("Права: выключенное право = отсутствие инструмента");
  {
    // buildTools asks the vault where the daily notes live, so that the
    // daily_note tool exists for people who never filled the setting in.
    const withDaily = (folder, kanban, templates) => ({
      vault: {
        dailyFolder: () => folder || "",
        kanbanReady: () => !!kanban,
        templateFolder: () => templates || "",
      },
    });
    const names = (s, plugin) =>
      T.buildTools(Object.assign({}, T.DEFAULT_SETTINGS, s), plugin || withDaily("")).map((x) => x.function.name);
    const all = names({});

    ok(all.includes("recent_notes"), "recent_notes есть — без него «за последние дни» отвечать нечем");
    ok(!all.includes("daily_note"), "daily_note нет, пока папка ежедневных заметок не найдена");
    ok(names({}, withDaily("Daily")).includes("daily_note"),
      "и появляется, когда папку удалось взять из настроек Obsidian, даже если своё поле пустое");
    ok(!names({ canRead: false }).includes("recent_notes"), "без права на чтение нет и recent_notes");

    // The whole point of read_template is that a project note comes out
    // looking like the other project notes. Offering it with no templates
    // folder would be a tool whose every call fails.
    ok(!all.includes("read_template"), "без папки шаблонов инструмент шаблонов не предлагается");
    ok(names({}, withDaily("", false, "Templates")).includes("read_template"),
      "с папкой шаблонов read_template появляется");
    ok(!names({ canCreate: false }, withDaily("", false, "Templates")).includes("read_template"),
      "и исчезает без права создавать заметки");

    ok(!all.includes("create_board"), "без плагина Kanban доску предлагать нечем");
    ok(names({}, withDaily("", true)).includes("create_board"), "с плагином Kanban инструмент появляется");
    ok(!names({ canCreate: false }, withDaily("", true)).includes("create_board"),
      "и исчезает без права создавать заметки");

    for (const n of ["list_tabs", "open_url", "close_tab", "open_beside"]) {
      ok(all.includes(n), `${n} есть, когда управление вкладками включено`);
    }
    const off = names({ canControlUI: false });
    for (const n of ["list_tabs", "open_url", "close_tab", "open_beside"]) {
      ok(!off.includes(n), `${n} исчезает, когда выключено`);
    }
    ok(!names({ canDelete: false }).includes("delete_note"), "delete_note исчезает без права на удаление");
    ok(names({ canDelete: true }).includes("delete_note"), "и появляется с ним");
    ok(!names({ canRead: false }).includes("search_notes"), "без чтения нет и поиска");
    ok(!names({ webSearch: false }).includes("search_web"), "без веб-поиска нет search_web");
    ok(!names({ webSearch: true, provider: "openai" }).includes("search_web"),
      "у OpenAI-напрямую веб-поиска нет даже с включённым тумблером");
  }

  /* ── 5b. Recent notes: the assistant's only sense of time ─ */
  describe("Свежие заметки: единственный способ понять «за последние дни»");
  {
    const day = 86400000;
    const mk = (path, daysAgo) => {
      const f = new H.TFile(path);
      f.stat = { mtime: Date.now() - daysAgo * day };
      return f;
    };
    const files = [
      mk("вчера.md", 1),
      mk("позавчера.md", 2),
      mk("сегодня.md", 0),
      mk("в феврале.md", 170),
      mk("неделю назад.md", 7),
    ];
    const app = H.fakeApp();
    app.vault.getMarkdownFiles = () => files;
    const p = H.fakePlugin(app, {});

    const three = p.vault.recentNotes(3).map((f) => f.path);
    eq(three.join(", "), "сегодня.md, вчера.md, позавчера.md",
      "за три дня — только эти три, свежая первой");
    ok(!three.includes("в феврале.md"),
      "февральская заметка в «последние дни» не попадает — это и был баг");

    eq(p.vault.recentNotes(10).length, 4, "за десять дней добавляется недельная");
    eq(p.vault.recentNotes(365).length, 5, "за год — все");
    eq(p.vault.recentNotes(3, 2).length, 2, "предел на количество соблюдается");
  }

  /* ── 6. The tools themselves ───────────────────────────── */
  describe("Инструменты агента: поведение");
  {
    const mk = (opts, settings) => {
      const app = H.fakeApp(opts);
      const p = H.fakePlugin(app, settings);
      const agent = new T.Agent(p);
      const events = [];
      const run = (name, args, confirmAnswer = true) =>
        agent.runTool(name, args, { onEvent: (e) => events.push(e.text), confirm: async () => confirmAnswer });
      return { app, p, agent, events, run };
    };

    {
      const { run } = mk({ tabs: [] });
      const r = await run("list_tabs", {});
      ok(/empty|nothing/i.test(r), "list_tabs на пустой области отвечает честно");
    }
    {
      const { run } = mk({ tabs: [{ title: "Проект", path: "a.md" }, { title: "Идеи", path: "b.md" }] });
      const r = await run("list_tabs", {});
      ok(r.includes("Проект") && r.includes("Идеи"), "list_tabs перечисляет открытое");
    }
    {
      // Одна названная вкладка — без подтверждения.
      const { app, run } = mk({ tabs: [{ title: "Проект", path: "a.md" }, { title: "Идеи", path: "b.md" }] });
      const r = await run("close_tab", { name: "Идеи" }, false);
      ok(r.includes("Идеи"), "одна названная вкладка закрывается без вопроса");
      eq(app.workspace.listAlive === undefined ? app.workspace.leaves.filter((l) => !l.detached).length : 0, 1,
        "осталась одна вкладка");
    }
    {
      // Всё сразу — только с подтверждения.
      const { app, run } = mk({ tabs: [{ title: "A", path: "a.md" }, { title: "B", path: "b.md" }] });
      const r = await run("close_tab", { all: true }, false);
      ok(/declined/i.test(r), "отказ пользователя останавливает закрытие всего");
      eq(app.workspace.leaves.filter((l) => !l.detached).length, 2, "вкладки на месте после отказа");
    }
    {
      const { app, run } = mk({ tabs: [{ title: "A", path: "a.md" }, { title: "B", path: "b.md" }] });
      await run("close_tab", { all: true }, true);
      eq(app.workspace.leaves.filter((l) => !l.detached).length, 0, "с подтверждением закрываются все");
    }
    {
      const { run } = mk({ tabs: [{ title: "Проект", path: "a.md" }] });
      const r = await run("close_tab", { name: "чего нет" });
      ok(r.includes("list_tabs"), "на несуществующую вкладку отвечает подсказкой посмотреть список");
    }
    {
      const { run } = mk({});
      const bad = await run("open_url", { url: "javascript:alert(1)" });
      ok(/could not open/i.test(bad), "open_url отказывает на javascript:");
      const good = await run("open_url", { url: "https://obsidian.md" });
      ok(/Opened https:\/\/obsidian\.md/.test(good), "и открывает обычный адрес");
    }
    {
      // Выключённое право должно отбиваться и на уровне исполнения, не только
      // в списке инструментов — модель могла запомнить инструмент из прошлого хода.
      const { run } = mk({ tabs: [{ title: "A", path: "a.md" }] }, { canControlUI: false });
      for (const n of ["list_tabs", "open_url", "close_tab", "open_beside"]) {
        const r = await run(n, { url: "https://obsidian.md", name: "A", path: "a.md" });
        ok(/switched off/i.test(r), `${n} отказывает при выключенном праве`);
      }
    }
  }

  /* ── 7. Models ─────────────────────────────────────────── */
  describe("Список моделей");
  {
    ok(T.modelChoices("obsimind").length > 0, "у Elton AI есть список моделей");
    eq(T.modelChoices("openrouter"), T.modelChoices("obsimind"), "у OpenRouter тот же список");
    eq(T.modelChoices("local").length, 0, "у локальной модели списка нет — там работает опрос сервера");
    eq(T.canListModels("obsimind"), false, "у прокси кнопка обновления скрыта (он отвечает 405)");
    eq(T.canListModels("local"), true, "у локальной — доступна");
    const def = T.DEFAULT_SETTINGS.models.obsimind;
    ok(T.modelChoices("obsimind").some((m) => m.id === def), "модель по умолчанию есть в списке");
  }

  /* ── 8. The embedded sound ─────────────────────────────── */
  describe("Встроенный звук ожидания");
  {
    const bytes = T.base64ToBytes(T.WAITING_WAV_B64);
    const head = Buffer.from(bytes.slice(0, 12)).toString("ascii");
    ok(head.startsWith("RIFF") && head.includes("WAVE"), "декодируется в настоящий WAV");
    const fs = require("fs"), path = require("path"), crypto = require("crypto");
    const orig = fs.readFileSync(path.join(__dirname, "..", "waiting.wav"));
    const h = (b) => crypto.createHash("sha1").update(Buffer.from(b)).digest("hex");
    eq(h(bytes), h(orig), "совпадает с waiting.wav побайтово");
  }

  /* ── 9. Mobile ─────────────────────────────────────────── */
  describe("Мобилка: формат записи");
  {
    // Что каждая платформа реально умеет. Списки — то, что возвращает
    // MediaRecorder.isTypeSupported в этих браузерах.
    const DESKTOP = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
    const ANDROID = ["audio/webm;codecs=opus", "audio/webm"];
    const IOS = ["audio/mp4", "audio/mp4;codecs=mp4a.40.2", "audio/aac"];

    const on = (list) => T.pickRecordingType((m) => list.includes(m));

    eq(on(DESKTOP).format, "webm", "десктоп пишет в webm/opus");
    eq(on(ANDROID).format, "webm", "Android пишет в webm");
    eq(on(IOS).format, "mp4", "iOS пишет в mp4 — И ЭТО ГЛАВНОЕ: раньше отдавалось как webm");
    eq(on(IOS).mime, "audio/mp4", "и mime у него честный");
    eq(on([]), null, "если ничего не поддерживается — решает сам MediaRecorder");
    eq(T.pickRecordingType(null), null, "без MediaRecorder не падает");

    // Ярлык формата выводится из того, что вернул сам браузер, а не из надежд.
    eq(T.formatFromMime("audio/webm;codecs=opus"), "webm", "webm распознаётся");
    eq(T.formatFromMime("audio/mp4"), "mp4", "mp4 распознаётся");
    eq(T.formatFromMime("audio/x-m4a"), "mp4", "m4a — это тот же mp4");
    eq(T.formatFromMime("audio/aac"), "aac", "aac распознаётся");
    eq(T.formatFromMime("audio/ogg; codecs=opus"), "ogg", "ogg распознаётся");
    eq(T.formatFromMime(""), "webm", "пустой mime — разумное умолчание");

    // Порядок предпочтений: opus раньше mp4, иначе десктоп зря льёт AAC.
    const iOpus = T.RECORDING_TYPES.findIndex((x) => x.mime.includes("opus"));
    const iMp4 = T.RECORDING_TYPES.findIndex((x) => x.mime.includes("mp4"));
    ok(iOpus >= 0 && iOpus < iMp4, "opus предпочитается mp4, где есть выбор");
  }

  /* ── 10. The selected passage ──────────────────────────── */
  describe("Выделенный текст");
  {
    const mk = (x) => T.EltonAI.selectionPrompt(x);
    eq(mk(""), "", "пустое выделение не даёт задания");
    eq(mk("   \n  "), "", "одни пробелы — то же самое");

    const p = mk("Выгорание наступает не от нагрузки, а от бессмысленности.");
    ok(p.includes("Выгорание наступает не от нагрузки"), "выделенный текст попадает в задание целиком");
    ok(p.includes("именно про этот фрагмент"), "задание требует отвечать про фрагмент, а не про заметку");
    ok(!p.includes("{0}"), "плейсхолдер подставлен, а не оставлен как есть");

    // Ловушка: выделенное слово, совпадающее с триггером сценария, — это
    // текст заметки, а не команда. Оно обязано уехать цитатой внутри задания.
    const trap = mk("мысли");
    ok(trap.includes("«мысли»"), "слово-триггер уходит цитатой, а не как команда");
    ok(trap.length > 100, "и задание вокруг него длиннее, чем сам триггер");
    // askAbout передаёт готовый бриф как scenario, поэтому сопоставитель
    // триггеров вообще не смотрит на текст — проверяем это прямо.
    eq(T.matchScenario("мысли", T.defaultScenarios()).scenario.name, "О чём я думал",
      "для сравнения: то же слово, сказанное голосом, сценарий запускает");
  }

  /* ── 11. Streaming, on real captured traffic ───────────── */
  describe("Стриминг: разбор реального потока");
  {
    const fs = require("fs"), path = require("path");
    const fx = (n) => fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8");
    const TEXT = fx("sse-text.txt");
    const TOOL = fx("sse-tool.txt");

    // Обычный текстовый ответ.
    {
      const { msg, deltas, acc } = H.replaySSE(TEXT);
      ok(msg.content.length > 100, "текст собирается целиком");
      ok(msg.content.includes("заметки"), "и это осмысленный текст, а не куски");
      ok(!msg.tool_calls, "инструментов в текстовом ответе нет");
      // Захват делался с max_tokens: 120, и ответ в него упёрся — поэтому тут
      // именно "length". Это ценнее, чем "stop": сигнал обрыва обязан пережить
      // стриминг, иначе finishAnswer не узнает, что надо дозапросить остаток.
      eq(msg.finishReason, "length", "сигнал обрыва по лимиту токенов переживает стриминг");
      ok(deltas.length > 10, "ответ отдавался частями, а не одним куском (" + deltas.length + ")");
      eq(deltas.join(""), msg.content, "склейка кусков даёт ровно итоговый текст");
      ok(acc.usage && acc.usage.cost > 0, "стоимость выловлена из хвоста потока");
    }

    // Тот же поток, порезанный по-другому: границы чанков не должны ничего менять.
    for (const size of [1, 7, 100, 5000]) {
      const r = H.replaySSE(TEXT, size);
      eq(r.msg.content, H.replaySSE(TEXT).msg.content,
        "результат не зависит от размера сетевого чанка (" + size + " байт)");
    }

    // Вызов инструмента — самое хрупкое: имя в одном событии, аргументы по кускам.
    {
      const { msg, acc } = H.replaySSE(TOOL);
      ok(msg.tool_calls && msg.tool_calls.length === 1, "вызов инструмента собран");
      const call = msg.tool_calls[0];
      eq(call.function.name, "search_notes", "имя инструмента восстановлено");
      ok(call.id.startsWith("toolu_"), "идентификатор вызова сохранён");
      let args = null;
      try { args = JSON.parse(call.function.arguments); } catch {}
      ok(args !== null, "аргументы — валидный JSON после склейки из 4 кусков");
      eq(args && args.query, "выгорание", "и значение собралось верно, включая кириллицу");
      eq(msg.finishReason, "tool_calls", "причина остановки — вызов инструмента");
      ok(acc.usage && acc.usage.cost > 0, "стоимость есть и в потоке с инструментом");
    }
    // Резать посреди UTF-8 нельзя было бы на байтах, но на строках проверим,
    // что склейка аргументов не зависит от границ.
    for (const size of [3, 11, 250]) {
      const r = H.replaySSE(TOOL, size);
      eq(JSON.parse(r.msg.tool_calls[0].function.arguments).query, "выгорание",
        "аргументы целы при нарезке по " + size + " байт");
    }

    // Мусор в потоке не должен ронять разбор.
    {
      const T2 = H.load();
      const acc = T2.newStreamAcc();
      let buf = "";
      const junk = ": keep-alive\n\ndata: {битый json\n\ndata: [DONE]\n\n";
      buf = T2.readStreamChunk(buf + junk, (j) => T2.foldStreamEvent(acc, j));
      ok(true, "битое событие и keep-alive не роняют разбор");
      eq(T2.finishStreamAcc(acc).content, "", "и ничего не выдумывают");
    }
  }

  /* ── 12. Cost ──────────────────────────────────────────── */
  describe("Стоимость ответа");
  {
    eq(T.formatMoney(0, "₽"), "0 ₽", "ноль — просто ноль");
    eq(T.formatMoney(0.0000047, "₽"), "0 ₽", "неразличимо малое не притворяется числом");
    eq(T.formatMoney(0.0085, "₽"), "0.0085 ₽", "копейки показываются с точностью");
    eq(T.formatMoney(0.5, "₽"), "0.5 ₽", "хвостовые нули отброшены");
    eq(T.formatMoney(12.3456, "₽"), "12.35 ₽", "рубли — до копеек");
    eq(T.formatMoney(524.925163, "₽"), "525 ₽", "сотни — без дробей");
    eq(T.formatMoney(0.000047, ""), "0", "доллары OpenRouter тоже сжимаются");

    const mk = (provider) => {
      const p = H.fakePlugin(H.fakeApp(), { provider, showCost: true });
      p.spend = new T.SpendTracker(p);
      return p;
    };

    // Через Elton AI показывается списание с баланса, не цена OpenRouter.
    {
      const p = mk("obsimind");
      p.spend.add({ prompt_tokens: 17, completion_tokens: 6, cost: 0.000047 });
      p.spend.add({ prompt_tokens: 900, completion_tokens: 300, cost: 0.004 });
      p.spend.turn.charged = 0.73;
      p.spend.balance = 524.925163;
      const line = p.spend.line();
      ok(line.includes("0.73"), "показано списание с баланса");
      ok(line.includes("525"), "и остаток");
      ok(line.includes("1223"), "токены сложены по всем вызовам хода");
      ok(!line.includes("0.004"), "СЫРАЯ ЦЕНА OpenRouter НЕ показывается — маржа не видна");
      ok(line.includes("2"), "число шагов есть");
    }
    // Со своим ключом OpenRouter скрывать нечего — там это ваши же деньги.
    {
      const p = mk("openrouter");
      p.spend.add({ prompt_tokens: 100, completion_tokens: 50, cost: 0.0031 });
      ok(p.spend.line().includes("$"), "со своим ключом показывается цена в долларах");
    }
    // Локальная модель денег не стоит — только токены.
    {
      const p = mk("local");
      p.spend.add({ prompt_tokens: 10, completion_tokens: 5 });
      const line = p.spend.line();
      ok(!line.includes("$") && !line.includes("₽"), "у локальной модели денег нет");
      ok(line.includes("15"), "но токены посчитаны");
    }
    // Пополнение посреди хода не должно рисовать отрицательный расход.
    {
      const p = mk("obsimind");
      // openTurn no longer waits for the reading, it hands closeTurn a promise.
      p.spend._beforeAt = Promise.resolve(100);
      p.spend.viaBalanceStub = true;
      p.spend.add({ prompt_tokens: 5, completion_tokens: 5, cost: 0.001 });
      p.spend.readBalance = async () => { p.spend.balance = 500; return 500; };
      const turn = await p.spend.closeTurn();
      eq(turn.charged, null, "баланс вырос — расход не показывается вместо вранья");
    }
    // Пустой ход не рисует строчку вообще.
    {
      const p = mk("obsimind");
      eq(p.spend.line(), "", "без вызовов строки нет");
    }
  }

  /* ── 9. The speaker actually gets through the whole answer ─
   * Written after sayAll spent a week throwing on its first fragment: a
   * parameter called `window` shadowed the global one, so window.setTimeout
   * inside the loop resolved to a number. Nothing caught it because nothing
   * had ever driven this loop end to end. */
  describe("Озвучка: весь ответ проговаривается, а не первый кусок");
  {
    /**
     * A speaker whose synthesis is slow, the way the real one is.
     *
     * The delay is the test, not decoration. sayAll races each fragment
     * against a 250ms timer to decide whether to fill the silence; with an
     * instant stub the fragment always wins that race and the timer is never
     * built — which is exactly why the shadowed `window` went unnoticed.
     * Synthesis takes seconds in life, so here it takes a few milliseconds.
     */
    const mkSpeaker = (opts = {}) => {
      const played = [];
      const sp = new T.Speaker({ settings: Object.assign({}, T.DEFAULT_SETTINGS), ai: {} });
      sp.prepare = async (text) => {
        await new Promise((r) => setTimeout(r, opts.slow ? 300 : 3));
        if (opts.failOn && opts.failOn(text)) throw new Error("синтез не вышел");
        return { spoken: text };
      };
      sp.playPrepared = async (desc) => { if (desc) played.push(desc.spoken); };
      return { sp, played };
    };

    {
      // The one that reproduces it: synthesis slower than the 250ms the loop
      // is willing to wait, so the timer really does get built.
      const { sp, played } = mkSpeaker({ slow: true });
      const waited = [];
      await sp.sayAll(["Первая фраза.", "Вторая фраза."], { onWaiting: () => waited.push(1) });
      eq(played.join(" | "), "Первая фраза. | Вторая фраза.",
        "медленный синтез: куски всё равно проговариваются, а не отбрасываются");
      ok(waited.length > 0, "и о паузе сообщено, чтобы её было чем заполнить");
    }

    {
      const { sp, played } = mkSpeaker();
      const parts = ["Первая фраза.", "Вторая фраза.", "Третья фраза.", "Четвёртая.", "Пятая.", "Шестая."];
      const said = [];
      await sp.sayAll(parts, { onChunk: (p) => said.push(p) });
      eq(played.join(" | "), parts.join(" | "), "проговорены все шесть кусков по порядку");
      eq(said.length, parts.length, "и о каждом сообщено через onChunk");
    }
    {
      // The lookahead is more than the number of parts: the loop must not
      // read past the end of its own queue.
      const { sp, played } = mkSpeaker();
      await sp.sayAll(["Одна фраза."]);
      eq(played.length, 1, "один кусок — тоже один кусок, а не падение");
    }
    {
      // One bad fragment is skipped, the rest still get said.
      const { sp, played } = mkSpeaker({ failOn: (t2) => t2.includes("Вторая") });
      await sp.sayAll(["Первая.", "Вторая.", "Третья."]);
      eq(played.join(" | "), "Первая. | Третья.", "неудачный кусок пропускается, ответ не обрывается");
    }
    {
      // Every fragment failing is the case that has to be said out loud.
      const { sp, played } = mkSpeaker({ failOn: () => true });
      const before = H.OBSIDIAN_STUB.Notice.seen ? H.OBSIDIAN_STUB.Notice.seen.length : 0;
      await sp.sayAll(["Раз.", "Два."]);
      eq(played.length, 0, "не сыграно ничего");
      const after = H.OBSIDIAN_STUB.Notice.seen || [];
      ok(after.length > before && /Озвучить не вышло/.test(after[after.length - 1]),
        "и об этом сказано на экране, а не только в консоли");
    }
    {
      // Stopping means stopping — the rest of the queue is not played.
      const { sp, played } = mkSpeaker();
      let n = 0;
      await sp.sayAll(["А.", "Б.", "В.", "Г."], { shouldStop: () => ++n > 2 });
      ok(played.length < 4, `остановка обрывает очередь (сыграно ${played.length})`);
    }
    {
      // The reactor speaks whatever speechChunks hands it, so the two have to
      // agree: a real answer must come out in one piece.
      const { sp, played } = mkSpeaker();
      const answer = "Привет, Элтон. Последние пару дней ты правил плагин. "
        + "Тридцать первого июля разбирался с кнопками, первого августа — со сценариями. "
        + "Осталось выложить релиз.";
      await sp.sayAll(T.speechChunks(answer));
      eq(played.join(" ").replace(/\s+/g, " "), answer.replace(/\s+/g, " "),
        "нарезанный ответ склеивается обратно в тот же текст");
    }
  }

  /* ── 10. The waiting sound is a signal, not a metronome ── */
  describe("Звук ожидания: не долбит и не остаётся включённым");
  {
    // The clip is 1.9s long, so the gap between passes is what decides
    // whether this reads as "still working" or as a noise.
    ok(T.AMBIENCE_REPEAT_MS >= 10000,
      `между повторами не меньше 10 с (сейчас ${T.AMBIENCE_REPEAT_MS / 1000} с, клип длится 1.9 с)`);

    // A custom file is read from the vault, and the answer can arrive while
    // it is still being read. The sound must not start after that.
    {
      let started = 0;
      let release;
      const held = new Promise((r) => { release = r; });
      const plugin = {
        settings: Object.assign({}, T.DEFAULT_SETTINGS, { waitingSoundFile: "звук.wav" }),
        app: { vault: { adapter: { readBinary: async () => { await held; return new ArrayBuffer(8); } } } },
      };
      const amb = new T.Ambience(plugin);
      amb.startClip = () => { started++; };
      amb.startSynth = () => { started++; };

      const pending = amb.startFile("звук.wav", 0.3);
      amb.stop();          // the answer arrived while the file was loading
      release();
      await pending;
      eq(started, 0, "звук не включается уже после остановки");
    }
    {
      // And the ordinary case still plays.
      let started = 0;
      const plugin = {
        settings: Object.assign({}, T.DEFAULT_SETTINGS, { waitingSoundFile: "звук.wav" }),
        app: { vault: { adapter: { readBinary: async () => new ArrayBuffer(8) } } },
      };
      const amb = new T.Ambience(plugin);
      amb.startClip = () => { started++; };
      await amb.startFile("звук.wav", 0.3);
      eq(started, 1, "без остановки — играет как обычно");
    }
  }

  /* ── 11. A board has to BE a board ────────────────────────
   * Asked for one, the model wrote plain headings and checkboxes. That file
   * opens as text: the board view is chosen by the frontmatter and nothing
   * else. All three things it got wrong are asserted here. */
  describe("Канбан-доска: файл, который Obsidian откроет доской");
  {
    const app = H.fakeApp();
    let written = null;
    app.vault.create = async (p, content) => { written = { path: p, content }; return new H.TFile(p); };
    app.vault.getAbstractFileByPath = () => null;
    app.vault.createFolder = async () => {};
    app.vault.getAllLoadedFiles = () => [];
    app.vault.getRoot = () => ({ path: "/", children: [] });
    const p = H.fakePlugin(app, {});

    const f = await p.vault.createBoard("Проект на ESP32", [
      { name: "Идея", cards: ["Изучить ESP32", "Собрать список деталей"] },
      { name: "В процессе", cards: [] },
      { name: "Готово" },
    ], "1. Projects");

    const c = written.content;
    ok(/^---\nkanban-plugin: board\n---/.test(c),
      "свойство kanban-plugin: board стоит первым — без него это обычная заметка");
    ok(c.includes("## Идея") && c.includes("## В процессе") && c.includes("## Готово"),
      "колонки — заголовки второго уровня, а не жирный текст");
    ok(c.includes("- [ ] Изучить ESP32"), "карточки — чекбоксы под своей колонкой");

    const m = c.match(/%% kanban:settings\n```\n([\s\S]*?)\n```\n%%/);
    ok(!!m, "блок настроек на месте и с настоящим ограждением кода");
    const cfg = m ? JSON.parse(m[1]) : {};
    eq(cfg["kanban-plugin"], "board", "в настройках лежит валидный JSON");
    eq((cfg["list-collapse"] || []).length, 3, "по одному флагу свёрнутости на колонку");

    eq(f.path, "1. Projects/Проект на ESP32.md", "файл лёг в названную папку");

    let threw = false;
    try { await p.vault.createBoard("Пустая", []); } catch { threw = true; }
    ok(threw, "доска без колонок — это не доска, а ошибка");
  }

  /* ── 12. The guides ship inside the plugin ─────────────── */
  describe("Встроенные знания: внутри main.js, без докачки");
  {
    const withPlugins = (...ids) => ({ plugins: { plugins: Object.fromEntries(ids.map((i) => [i, {}])) } });

    const bare = T.builtinSkillsFor(withPlugins()).map((x) => x.name);
    ok(bare.includes("obsidian-notes"), "заметки Obsidian — знание для всех, плагин не нужен");
    ok(bare.includes("diagrams-mermaid"), "как и mermaid: он встроен в Obsidian");
    ok(!bare.includes("kanban-boards"), "а гайда по канбану нет, пока плагин не стоит");
    ok(!bare.includes("dataview-queries"), "и по dataview тоже");

    const rich = T.builtinSkillsFor(withPlugins("obsidian-kanban", "dataview")).map((x) => x.name);
    ok(rich.includes("kanban-boards") && rich.includes("dataview-queries"),
      "с установленными плагинами гайды появляются");

    ok(T.builtinSkillText("kanban-boards").includes("kanban-plugin: board"),
      "в гайде по канбану есть то самое свойство");
    eq(T.builtinSkillText("нет такого"), "", "несуществующий гайд возвращает пусто, а не мусор");

    for (const s2 of T.builtinSkillsFor(withPlugins("obsidian-kanban", "dataview", "templater-obsidian",
      "obsidian-excalidraw-plugin", "obsidian-charts", "obsidian-meta-bind-plugin"))) {
      ok(T.builtinSkillText(s2.name).length > 200, `гайд «${s2.name}» не пустой`);
    }
  }

  /* ── 13. Two models: quick one searches, chosen one answers ── */
  describe("Быстрая модель: ищет она, отвечает выбранная");
  {
    const S = (over) => Object.assign({}, T.DEFAULT_SETTINGS, over);

    eq(T.fastModelFor(S({ provider: "obsimind" })), T.FAST_MODELS.obsimind,
      "по умолчанию поиск идёт быстрой моделью провайдера");
    eq(T.fastModelFor(S({ provider: "obsimind", fastModel: "" })), "",
      "выключить можно — тогда всё на одной модели");
    eq(T.fastModelFor(S({ provider: "obsimind", fastModel: "openai/gpt-4.1-mini" })), "openai/gpt-4.1-mini",
      "или назначить свою");
    eq(T.fastModelFor(S({ provider: "local" })), "",
      "у локальной модели второй нет — она бы дралась за ту же видеокарту");

    // Same model twice is a handover that buys nothing and costs a round trip.
    const same = S({ provider: "obsimind", fastModel: "anthropic/claude-sonnet-4.5" });
    same.models = Object.assign({}, same.models, { obsimind: "anthropic/claude-sonnet-4.5" });
    eq(T.fastModelFor(same), "", "если быстрая совпала с основной — переключаться не на что");
  }

  /* ── 14. Stopping stays stopped ───────────────────────────
   * Press stop, say the next thing, and two voices talked over each other:
   * stopping set a flag, and every new turn began by clearing it, so the
   * turn that had been stopped simply resumed. */
  describe("Остановка держится: старый ход не оживает под новым");
  {
    /** The two halves of the view this actually depends on. */
    const mkView = () => ({
      _gen: 0,
      interrupted: false,
      agent: null,
      plugin: { speaker: { stop() {} }, ambience: { stop() {} } },
      stopTurn: T.AssistantView.prototype.stopTurn,
    });

    {
      const v = mkView();
      const gen = ++v._gen;                       // turn A starts
      const staleA = () => v.interrupted || gen !== v._gen;
      ok(!staleA(), "пока идёт свой ход — говорить можно");

      v.stopTurn.call(v);                         // stop
      ok(staleA(), "после остановки ход А замолкает");

      const genB = ++v._gen;                      // turn B starts
      v.interrupted = false;                      // as turn() does
      const staleB = () => v.interrupted || genB !== v._gen;
      ok(staleA(), "и НЕ оживает от того, что начался ход Б — вот это и было дублирование");
      ok(!staleB(), "а новый ход при этом говорит нормально");
    }
    {
      // Stopping the current turn must not silence the one started after it.
      const v = mkView();
      const genA = ++v._gen;
      v.stopTurn.call(v);
      const genB = ++v._gen;
      v.interrupted = false;
      ok(genA !== v._gen && genB === v._gen, "номер хода растёт, старый уже не совпадает");
    }
  }

  /* ── 15. Notes fit the folder they land in ────────────────
   * The created project was filed nowhere: nothing linked to it, because the
   * convention lives in the neighbours and the model had no way to look.
   * Nothing here is hard-coded — every vault has its own shape and this reads
   * whichever one it finds. */
  describe("Соглашения папки: читаются из хранилища, а не зашиты");
  {
    const vaultWith = (byPath) => {
      const files = Object.keys(byPath).map((p) => {
        const f = new H.TFile(p);
        f.stat = { mtime: Date.now() };
        return f;
      });
      const app = H.fakeApp();
      app.vault.getMarkdownFiles = () => files;
      app.metadataCache.getFileCache = (f) => ({ frontmatter: byPath[f.path] });
      return H.fakePlugin(app, {});
    };

    {
      // One person's vault: projects carry a link back to their MOC.
      const p = vaultWith({
        "1. Projects/А.md": { "MOC-родитель": ["[[MOC - Projects]]"], "Статус": "активен" },
        "1. Projects/Б.md": { "MOC-родитель": ["[[MOC - Projects]]"], "Статус": "пауза" },
        "1. Projects/В.md": { "MOC-родитель": ["[[MOC - Projects]]"], "Статус": "активен" },
      });
      const hint = p.vault.folderConventions("1. Projects");
      ok(hint.includes("MOC-родитель"), "нашёл свойство со ссылкой на MOC");
      ok(hint.includes("MOC - Projects"), "и показал пример значения, чтобы было что подставить");
    }
    {
      // Another person's, in English and with entirely different keys.
      const p = vaultWith({
        "Projects/One.md": { area: "work", status: "doing", parent: ["[[Index]]"] },
        "Projects/Two.md": { area: "home", status: "done", parent: ["[[Index]]"] },
      });
      const hint = p.vault.folderConventions("Projects");
      ok(hint.includes("area") && hint.includes("status") && hint.includes("parent"),
        "у другого хранилища — другие свойства, ничего не зашито");
      ok(!hint.includes("MOC-родитель"), "и чужие соглашения к нему не липнут");
    }
    {
      // A property only one note has is not a convention.
      const p = vaultWith({
        "Notes/A.md": { tags: ["a"], oddity: 1 },
        "Notes/B.md": { tags: ["b"] },
        "Notes/C.md": { tags: ["c"] },
      });
      const hint = p.vault.folderConventions("Notes");
      ok(hint.includes("tags"), "общее свойство попадает в подсказку");
      ok(!hint.includes("oddity"), "а случайное у одной заметки — нет");
    }
    {
      const p = vaultWith({ "Пусто/Одна.md": { tags: ["x"] } });
      eq(p.vault.folderConventions("Пусто"), "", "по одной заметке соглашения не выводятся");
      eq(p.vault.folderConventions(""), "", "без папки — молчание, а не догадки");
    }
  }

  /* ── 16. The phone ────────────────────────────────────────
   * Nothing here can press a button on a real phone. What it CAN do is hold
   * the stylesheet to the rule a thumb imposes, so the next restyle does not
   * quietly shrink a control back below it. */
  describe("Телефон: до чего можно дотянуться пальцем");
  {
    const css = require("fs").readFileSync(require("path").join(__dirname, "..", "styles.css"), "utf8");
    /** The declarations of one selector, last one wins. */
    const rule = (sel) => {
      const out = {};
      const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(?:,[^{]*)?\\{([^}]*)\\}", "g");
      let m;
      while ((m = re.exec(css))) {
        for (const decl of m[1].split(";")) {
          const [k, v] = decl.split(":");
          if (k && v) out[k.trim()] = v.trim();
        }
      }
      return out;
    };
    const px = (v) => (v && /^(\d+)px$/.test(v) ? Number(RegExp.$1) : 0);

    // Every control the reactor and the settings put under a thumb.
    const targets = [
      ["body.is-mobile .oa-iconbtn", "иконки в шапке панели"],
      ["body.is-mobile .oa-send", "кнопка отправки"],
      ["body.is-mobile .oa-day", "дни недели в автоматизациях"],
    ];
    for (const [sel, what] of targets) {
      const r = rule(sel);
      const size = Math.max(px(r.width), px(r["min-width"]));
      const tall = Math.max(px(r.height), px(r["min-height"]));
      ok(size >= 44 && tall >= 44, `${what}: ${size}×${tall} — не меньше 44 на телефоне`);
    }

    // These are already big enough everywhere, so they need no mobile rule —
    // but if someone shrinks them, this says so.
    for (const [sel, what] of [[".oa-mic", "микрофон"], [".oa-cbtn", "да/нет при удалении"]]) {
      const r = rule(sel);
      ok(px(r.width) >= 44 && px(r.height) >= 44, `${what}: ${px(r.width)}×${px(r.height)} — крупный и без мобильного правила`);
    }
    {
      const r = rule("body.is-mobile .oa-scen-chip");
      ok(px(r["min-height"]) >= 44, `кнопки сценариев: ${px(r["min-height"])} в высоту`);
    }
    {
      // iOS zooms the page when a focused field is under 16px. That zoom does
      // not come back on its own.
      const r = rule("body.is-mobile .oa-textrow input");
      ok(r["font-size"] === "16px" || px(r["font-size"]) >= 16,
        "поле ввода 16px — иначе iOS зумит страницу при фокусе");
      ok(px(r["min-height"]) >= 44, "и само поле не меньше 44");
    }
    {
      // With the keyboard up the panel is short, and the stage used to clip
      // rather than scroll — losing the very field being typed into.
      ok(/@media \(max-height: \d+px\)/.test(css), "есть правило для низкого экрана");
      const short = css.split("@media (max-height:")[1] || "";
      ok(/overflow-y:\s*auto/.test(short), "на низком экране сцена прокручивается, а не обрезает");
      ok(/justify-content:\s*flex-start/.test(short), "и выкладывается сверху, а не по центру");
    }
  }

  /* ── Privacy: what must never leave the machine ────────── */
  describe("Приватность: личные папки не уходят наружу");
  {
    const V = (settings) => H.fakePlugin(H.fakeApp({}), settings).vault;

    // Private wins over everything, including "whole vault".
    const priv = V({ scopeMode: "all", privateFolders: "2. Areas/Здоровье\n3. Resources/Финансы" });
    ok(!priv.inScope("2. Areas/Здоровье/Анализы.md"), "личная папка закрыта даже в режиме «всё хранилище»");
    ok(!priv.inScope("2. Areas/Здоровье/Врачи/Терапевт.md"), "вложенные папки тоже закрыты");
    ok(!priv.inScope("3. Resources/Финансы/Кредит.md"), "вторая папка из списка закрыта");
    ok(priv.inScope("1. Projects/ESP32.md"), "остальное хранилище открыто");
    // A folder whose name merely starts the same is a different folder.
    ok(priv.inScope("2. Areas/Здоровье питания.md"), "похожее название не считается той же папкой");

    // And over an explicit include-list, which is the case a single
    // three-mode setting could never express.
    const both = V({ scopeMode: "include", scopeFolders: "2. Areas", privateFolders: "2. Areas/Здоровье" });
    ok(both.inScope("2. Areas/Спорт.md"), "внутри рабочей области — читает");
    ok(!both.inScope("2. Areas/Здоровье/Анализы.md"), "но личное внутри рабочей области — нет");
    ok(!both.inScope("1. Projects/ESP32.md"), "вне рабочей области — тоже нет");

    const none = V({ scopeMode: "all", privateFolders: "" });
    ok(none.inScope("что угодно.md"), "без списка ничего не закрывается");
    ok(!none.isPrivate("что угодно.md"), "и isPrivate честно отвечает «нет»");

    // Leaving folders out of the index is a weaker promise: readable when
    // asked for, never swept up in bulk.
    /* The daily note was the one hole in it.
       Everything else reaches a note through files() or resolve(), which both
       check the scope; this one built a path and asked for it directly, so a
       private daily-notes folder was read anyway. */
    {
      const files = [new H.TFile("Дневник/06-08-2026.md")];
      const app = H.fakeApp({});
      app.vault.getMarkdownFiles = () => files;
      app.vault.getAbstractFileByPath = (p) => files.find((f) => f.path === p) || null;
      const open = H.fakePlugin(app, { dailyFolder: "Дневник" }).vault;
      ok(open.dailyNote("today"), "обычная ежедневная заметка находится");

      const shut = H.fakePlugin(app, { dailyFolder: "Дневник", privateFolders: "Дневник" }).vault;
      eq(shut.dailyNote("today"), null, "а личная — нет, даже по прямому запросу даты");
    }

    const noidx = V({ noIndexFolders: "4. Archive" });
    ok(!noidx.indexable("4. Archive/2019/Старое.md"), "исключённая из индекса папка не индексируется");
    ok(noidx.indexable("1. Projects/ESP32.md"), "остальное индексируется");
    ok(noidx.inScope("4. Archive/2019/Старое.md"), "но прочитать её по прямой просьбе всё ещё можно");
  }

  /* ── Telegram: splitting, and who gets answered ────────── */
  describe("Телеграм: длинные ответы и чужие сообщения");
  {
    const long = ("Первое предложение. Второе предложение. ".repeat(300)).trim();
    const parts = T.splitForTelegram(long);
    ok(parts.length > 1, "длинный ответ режется на несколько сообщений");
    ok(parts.every((p) => p.length <= 4096), "ни один кусок не превышает лимит Telegram");
    ok(parts.every((p) => p.trim().length), "пустых сообщений не появляется");
    eq(parts.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " "), "текст не теряется при нарезке");

    const short = T.splitForTelegram("Короткий ответ.");
    eq(short, ["Короткий ответ."], "короткий ответ уходит одним сообщением");

    // A rich message holds eight times as much, and that is the point: an
    // answer that fits in one bubble reads as one answer.
    eq(T.splitForTelegram(long, 30000).length, 1, "в rich-сообщение тот же ответ влезает целиком");
    // A paragraph break is a better place to cut than a character count.
    const para = T.splitForTelegram("а".repeat(3000) + "\n\n" + "б".repeat(1500), 4000);
    ok(para[0].endsWith("а"), "режет по границе абзаца, а не посреди слова");

    // Authorisation is the whole security model: a bot token in the wrong
    // hands must not become a vault in the wrong hands.
    const saved = [];
    const bridge = new T.TelegramBridge({
      settings: { telegram: { enabled: true, token: "x", userId: "111" } },
      saveSettings: async () => {},
    });
    bridge.send = async (chat, text) => { saved.push([chat, text]); };

    ok(!(await bridge.authorise({ chat: { id: 9 }, from: { id: 222 }, text: "привет" })),
      "сообщение от чужого аккаунта не проходит");
    eq(saved.length, 0, "и чужому ничего не отвечают — он не должен узнать, что бот живой");
    ok(await bridge.authorise({ chat: { id: 9 }, from: { id: 111 }, text: "привет" }),
      "сообщение от владельца проходит");

    const fresh = new T.TelegramBridge({
      settings: { telegram: { enabled: true, token: "x", userId: "" } },
      saveSettings: async () => {},
    });
    fresh.send = async () => {};
    ok(!(await fresh.authorise({ chat: { id: 9 }, from: { id: 777 }, text: "/start" })),
      "первый /start не отвечает на само сообщение — он привязывает");
    eq(fresh.cfg.userId, "777", "и запоминает того, кто его отправил");
    ok(!(await fresh.authorise({ chat: { id: 9 }, from: { id: 888 }, text: "/start" })),
      "второй желающий уже не проходит");
  }

  /* ── Telegram: scenarios as slash commands ─────────────── */
  describe("Телеграм: сценарии командами через /");
  {
    eq(T.slugForCommand("О чём я думал"), "o_chem_ya_dumal", "кириллица превращается в латиницу");
    eq(T.slugForCommand("Что сегодня"), "chto_segodnya", "и во втором случае тоже");
    eq(T.slugForCommand("📖 Объясни заметку!"), "obyasni_zametku", "эмодзи и знаки выбрасываются");
    eq(T.slugForCommand("Weekly Review"), "weekly_review", "латиница просто опускается в нижний регистр");
    eq(T.slugForCommand("💭💭💭"), "", "из одних эмодзи команды не выйдет");
    ok(T.slugForCommand("а".repeat(60)).length <= 32, "длина не превышает предел Telegram");

    const plugin = {
      settings: {
        telegram: { enabled: true, token: "x", userId: "1" },
        canCreate: true,
        scenarios: [
          { id: "1", enabled: true, prompt: "P1", name: "О чём я думал", emoji: "💭" },
          { id: "2", enabled: true, prompt: "P2", name: "Что сегодня", emoji: "📅" },
          // Same name twice: Telegram would silently keep only one.
          { id: "3", enabled: true, prompt: "P3", name: "Что сегодня", emoji: "📅" },
          { id: "4", enabled: false, prompt: "P4", name: "Выключенный" },
          { id: "5", enabled: true, prompt: "", name: "Пустой" },
        ],
      },
      saveSettings: async () => {},
    };
    const bridge = new T.TelegramBridge(plugin);
    const map = bridge.commandMap();

    ok(map.has("o_chem_ya_dumal"), "сценарий стал командой");
    ok(map.has("chto_segodnya") && map.has("chto_segodnya_2"), "одинаковые имена не затирают друг друга");
    ok(!map.has("vyklyuchennyy"), "выключенный сценарий команды не получает");
    eq(map.size, 3, "пустой сценарий тоже не считается");

    const help = bridge.helpText();
    ok(help.includes("/o_chem_ya_dumal"), "справка перечисляет команды сценариев");
    ok(help.includes("/new") && help.includes("/help"), "и служебные команды тоже");
  }

  /* ── Automations: when do they fire, and where do they land ─ */
  describe("Автоматизации: расписание и доставка в телеграм");
  {
    const fresh = T.newAutomation("digest");
    eq(fresh.telegram, false, "новая автоматизация в телеграм молча не пишет");

    // The schedule is forgiving on purpose: Obsidian is not a server, so an
    // automation fires the first time the vault is open past its hour.
    const S = new T.AutomationScheduler({ settings: { automations: [] }, saveSettings: async () => {} });
    const at = (h, m) => { const d = new Date(2026, 7, 6, h, m); return d; };
    const auto = { enabled: true, time: "08:30", days: [], lastRun: "" };
    ok(!S.due(auto, at(8, 0)), "до назначенного времени не срабатывает");
    ok(S.due(auto, at(8, 31)), "сразу после — срабатывает");
    ok(S.due(auto, at(23, 0)), "и позже в тот же день тоже — волт мог быть закрыт всё утро");
    ok(!S.due(Object.assign({}, auto, { lastRun: T.todayKey(at(9, 0)) }), at(9, 0)),
      "но второй раз за день — нет");
    ok(!S.due(Object.assign({}, auto, { enabled: false }), at(9, 0)), "выключенная не срабатывает");
    // 6 August 2026 is a Thursday.
    ok(!S.due(Object.assign({}, auto, { days: [1] }), at(9, 0)), "в чужой день недели не срабатывает");
    ok(S.due(Object.assign({}, auto, { days: [4] }), at(9, 0)), "в свой — срабатывает");

    // Delivery: the note is always written; the chat is extra.
    const sent = [];
    const written = [];
    const plugin = {
      settings: { automations: [], newNoteFolder: "", telegram: { enabled: true, token: "x", userId: "1" } },
      saveSettings: async () => {},
      telegram: { push: async (text) => { sent.push(text); return true; } },
      app: { vault: { create: async () => null } },
      vault: {
        createNote: async (title, body) => { written.push([title, body]); return { path: "Inbox/" + title + ".md" }; },
        dailyNote: () => null,
        dailyFolder: () => "",
        ensureFolder: async () => {},
        appendToNote: async () => {},
      },
    };
    const sched = new T.AutomationScheduler(plugin);

    await sched.deliver({ name: "Дайджест", target: "note", notify: false, telegram: false }, "тело ответа", []);
    eq(sent.length, 0, "без галочки в телеграм ничего не уходит");
    eq(written.length, 1, "а заметка пишется всё равно");

    await sched.deliver({ name: "Дайджест", target: "note", notify: false, telegram: true }, "тело ответа", []);
    eq(sent.length, 1, "с галочкой уходит одно сообщение");
    ok(sent[0].includes("тело ответа"), "и в нём сам ответ");
    ok(sent[0].startsWith("## Дайджест"), "с заголовком — телеграм теперь умеет их рисовать");
    ok(sent[0].includes("Inbox/Дайджест"), "и путём заметки, в которую это легло");
    eq(written.length, 2, "заметка всё так же пишется — чат её не заменяет");

    // A bot that is down must not make a finished automation look failed.
    plugin.telegram.push = async () => { throw new Error("нет сети"); };
    let threw = false;
    try { await sched.deliver({ name: "Д", target: "note", notify: false, telegram: true }, "тело", []); }
    catch { threw = true; }
    ok(!threw, "упавшая отправка не роняет автоматизацию");
  }

  /* ── Hold-to-talk: the combination is physical ──────────── */
  describe("Клавиша «зажать и говорить»");
  {
    const ev = (code, mods = {}) => Object.assign({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, mods);
    const hk = T.hotkeyFromEvent(ev("Space", { ctrlKey: true, shiftKey: true }));
    eq(hk, { code: "Space", ctrl: true, shift: true, alt: false, meta: false }, "сочетание снимается с события");
    eq(T.hotkeyFromEvent(ev("ControlLeft", { ctrlKey: true })), null, "один модификатор — ещё не сочетание");

    ok(T.hotkeyMatches(hk, ev("Space", { ctrlKey: true, shiftKey: true })), "то же сочетание — совпадает");
    ok(!T.hotkeyMatches(hk, ev("Space", { ctrlKey: true })), "без Shift — уже другое сочетание");
    ok(!T.hotkeyMatches(hk, ev("KeyS", { ctrlKey: true, shiftKey: true })), "другая клавиша — не совпадает");
    ok(!T.hotkeyMatches(null, ev("Space")), "когда сочетание не задано, не срабатывает ничего");
    // `code`, not `key`: a combination set on a Russian layout has to keep
    // working on an English one.
    ok(T.hotkeyLabel(hk).includes("Ctrl") && T.hotkeyLabel(hk).includes("Space"), "подпись читаемая");
  }

  /* ── Layout containers must not be <button> ────────────── */
  describe("Вёрстка: кликабельные блоки — не button");
  {
    // This has now broken twice. A theme is entitled to restyle `button` —
    // this vault's gives it a fixed height and a panel background — and a
    // multi-line tile or row inside one collapses to a single line with its
    // contents spilling over the element below.
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "main.js"), "utf8");
    for (const cls of ["oa-tile", "oa-row-main"]) {
      ok(!src.includes(`createEl("button", { cls: "${cls}"`),
        `${cls} не создаётся как button — тема ломает такие блоки`);
      ok(src.includes(`cls: "${cls}"`), `${cls} вообще существует — тест не устарел`);
    }
    // And a div has to be given back what a button provided.
    ok(/function clickable\(el\)[\s\S]*role", "button"[\s\S]*tabindex[\s\S]*keydown/.test(src),
      "clickable возвращает роль, фокус и Enter/Space");
  }

  /* ── Redraws must not lose the reader's place ──────────── */
  describe("Перерисовка не сбрасывает прокрутку");
  {
    // Chased one place at a time for two days: the daily-notes field, the
    // vault map, the scope dropdown. Every redraw of a page that is still the
    // same page has to hold its scroll position, so this checks all of them at
    // once — each function that empties a container also keeps the scroll.
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "src");
    const redrawers = [
      ["70-settings.js", "display()", "display"],
      ["70-settings.js", "OnboardingModal", "draw"],
      ["45-schedule.js", "AutomationEditModal", "draw"],
      ["57-telegram.js", "TelegramSetupModal", "draw"],
    ];
    for (const [file, what, fn] of redrawers) {
      // Line endings normalised: these files are CRLF on this machine, and
      // searching for "\n  }" in them silently matches nothing.
      const text = fs.readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n");
      // The whole method: from its signature to the line that closes it at
      // method indentation. Reading only the first N characters was not
      // enough — it found the `const back = keepScroll(...)` at the top and
      // passed even with the call that restores it deleted.
      const at = text.indexOf(`\n  ${fn}(`);
      const end = at >= 0 ? text.indexOf("\n  }\n", at) : -1;
      const body = at >= 0 && end > at ? text.slice(at, end) : "";
      ok(body.length > 0, `${what}: метод ${fn} найден — тест не устарел`);
      ok(/keepScroll\(/.test(body), `${what}: позиция запоминается перед перерисовкой`);
      ok(/\bback\(\)/.test(body), `${what}: и восстанавливается после неё`);
    }
    // The group window rebuilds its scrolling box, so it carries the position
    // across by hand rather than with the helper.
    const st = fs.readFileSync(path.join(dir, "70-settings.js"), "utf8");
    ok(/this\.bodyEl\.scrollTop = was/.test(st), "окно группы переносит позицию в новый блок");
  }

  /* ── report ────────────────────────────────────────────── */
  console.log();
  for (const r of results) {
    if (r.head) { console.log(`\n  ${r.head}`); continue; }
    if (r.pass) console.log(`    ✓ ${r.name}`);
    else console.log(`    ✗ ${r.name}\n        ${r.detail || ""}`);
  }
  console.log(`\n  ${passed} прошло, ${failed} упало\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("\nхарнесс упал:", e);
  process.exit(1);
});
