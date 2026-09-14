/* ============================================================
 *  The connector
 *
 *  Второй вход в того же ассистента, что отвечает в панели
 *  и в Telegram. Здесь только транспорт: забрать сообщение
 *  с сервера-релея, отдать его агенту, вернуть ответ. Своей
 *  логики про заметки тут нет и быть не должно — иначе
 *  ответы начнут расходиться между каналами.
 *
 *  Плагин сам ходит на сервер и ждёт там ответа до 25 секунд.
 *  Входящих соединений он не принимает и портов не открывает:
 *  для человека за домашним роутером это единственный способ,
 *  который вообще работает.
 * ========================================================== */
class ConnectorBridge {
  constructor(plugin) {
    this.plugin = plugin;
    this.running = false;
    this.lastError = "";
    // Своя история на каждый чат: в браузере их может быть несколько,
    // и мешать их в одну кучу — значит путать ассистента.
    this.chatHistory = new Map();
    this.toldAbout = false;
    // Общий секрет на каждое устройство свой: телефон не может прочитать
    // переписку планшета, даже если оба привязаны к одному хранилищу.
    this.secrets = new Map();
    this.keysChecked = 0;
    // Какой из адресов сейчас рабочий и когда мы на него перешли.
    this.hostIdx = 0;
    this.hostSince = 0;
  }

  get cfg() {
    const s = this.plugin.settings;
    if (!s.connector) s.connector = { enabled: false, code: "", server: "https://app.eltonlabs.org" };
    return s.connector;
  }

  configured() { return !!(this.cfg.enabled && this.cfg.code); }

  /**
   * Закрепить код за собой, предъявив ключ ObsiMind.
   * Сервер пускает только по закреплённым кодам: иначе достаточно было бы
   * придумать двенадцать знаков, чтобы попасть в чужое хранилище.
   * Ключ уходит один раз при подключении и на сервере не хранится —
   * там остаётся только владелец.
   */
  async claimCode() {
    const key = (this.plugin.settings.keys && this.plugin.settings.keys.obsimind) || "";
    if (!key) { this.lastError = t("No key"); return false; }
    try {
      await this.req("/api/claim", { code: this.cfg.code, key });
      return true;
    } catch (e) {
      this.lastError = e.message || String(e);
      return false;
    }
  }

  start() {
    // На телефоне не запускаем по той же причине, что и телеграм: настройки
    // синхронизируются, и второй разборщик очереди отобрал бы половину
    // сообщений у компьютера, на котором лежит хранилище.
    if (isMobile()) return;
    if (this.running || !this.configured()) return;
    this.running = true;
    this.lastError = "";
    this.claimedAt = 0;
    this.loop();
  }

  stop() { this.running = false; }

  restart() { this.stop(); window.setTimeout(() => this.start(), 300); }

  /**
   * Куда стучаться. Основной адрес — первый, за ним запасной вход.
   *
   * Зеркало подставляем только для нашего собственного адреса: если человек
   * прописал свой сервер, подменять его чужим — самоуправство.
   */
  hostList() {
    const main = String(this.cfg.server || "").replace(/\/+$/, "");
    return main === "https://app.eltonlabs.org"
      ? [main, "https://relay.eltonlabs.org"]
      : [main];
  }

  async req(path, body) {
    const hosts = this.hostList();
    // Раз в десять минут возвращаемся к основному адресу: связь могла
    // почининиться, а сидеть на запасном входе вечно незачем — он дальше.
    if (this.hostIdx && Date.now() - (this.hostSince || 0) > 600e3) this.hostIdx = 0;

    let last = null;
    for (let i = 0; i < hosts.length; i++) {
      const idx = (this.hostIdx + i) % hosts.length;
      try {
        const res = await requestUrl({
          url: hosts[idx] + path,
          method: body ? "POST" : "GET",
          headers: body ? { "Content-Type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
          throw: false,
        });
        if (res.status >= 400) throw new Error(String(res.status));
        if (idx !== this.hostIdx) { this.hostIdx = idx; this.hostSince = Date.now(); }
        return res.json;
      } catch (e) {
        // Ответ с ошибкой — это всё-таки ответ: сервер жив, и менять его
        // не на что. Переключаемся только когда связи нет совсем.
        if (/^[0-9]{3}$/.test(String(e && e.message))) throw e;
        last = e;
      }
    }
    throw last || new Error("нет связи");
  }

  async loop() {
    while (this.running) {
      if (!this.configured()) { this.running = false; return; }
      try {
        // Раз в сутки подтверждаем право на код: подписка могла кончиться.
        if (Date.now() - (this.claimedAt || 0) > 2 * 3600e3) {
          if (!(await this.claimCode())) {
            // Ключа нет или сервер недоступен — пробуем снова через полминуты,
            // а не молчим до конца срока.
            this.claimedAt = 0;
            await new Promise((r) => window.setTimeout(r, 30000));
            continue;
          }
          this.claimedAt = Date.now();
        }
        const r = await this.req("/api/pull?code=" + encodeURIComponent(this.cfg.code));
        this.lastError = "";
        if (!this.toldAbout) { this.toldAbout = true; this.tellAbout().catch(() => {}); }
        this.syncKeys(false).catch(() => {});
        for (const m of (r && r.msgs) || []) {
          if (!this.running) return;
          await this.handle(m);
        }
      } catch (e) {
        this.lastError = e.message || String(e);
        // 403 значит, что сервер забыл код: перезапустился, почистил базу
        // или подписка на миг отвалилась. Ждать своего таймера бессмысленно —
        // предъявляем ключ заново на следующем же круге.
        if (String(e.message) === "403") this.claimedAt = 0;
        // Пауза только после ошибки: при удачном запросе сервер сам держал
        // соединение, и спать после него значило бы тормозить ответы.
        await new Promise((r) => window.setTimeout(r, 5000));
      }
    }
  }

  /**
   * Что телефону полезно знать о нас: как называется хранилище и какие
   * готовые промпты заведены. Промпты — это сценарии Elton AI, те же самые,
   * что срабатывают на фразу голосом.
   */
  /**
   * Рассказать о себе заново.
   *
   * Имя хранилища и список промптов уходят на сервер один раз, при
   * подключении. После правки сценария приложение об этом не знает и
   * показывает вчерашний список — до перезапуска Obsidian. Сбрасываем
   * отметку: цикл сам расскажет заново на ближайшем круге, в пределах
   * получаса ожидания, а обычно за секунды.
   */
  refreshAbout() {
    if (this.configured()) this.toldAbout = false;
  }

  async tellAbout() {
    const list = (this.plugin.settings.scenarios || [])
      .filter((x) => x && x.enabled && x.prompt)
      .map((x) => ({
        name: String(x.name || (x.triggers || "").split(",")[0] || "").trim(),
        hint: String(x.prompt || "").replace(/\s+/g, " ").slice(0, 160),
      }))
      .filter((x) => x.name);
    await this.req("/api/meta", {
      code: this.cfg.code,
      vault: this.plugin.app.vault.getName(),
      prompts: list,
    });
  }

  /**
   * Отправить уведомление на телефон.
   * Текст шифруется на сервере ключами подписки, поэтому по дороге его
   * не видит ни релей, ни сервер браузера.
   */
  async notify(title, body, chat) {
    if (!this.configured()) return false;
    try {
      const r = await this.req("/api/push/send", {
        code: this.cfg.code,
        title: String(title || "Хранилище").slice(0, 90),
        body: String(body || "").replace(/[#*`>_]/g, "").replace(/\s+/g, " ").trim().slice(0, 400),
        chat: chat || "main",
      });
      return !!(r && r.sent);
    } catch { return false; }
  }

  /** Своя пара ключей. Заводится один раз и хранится в настройках. */
  async ownKeys() {
    const s = this.plugin.settings;
    if (!s.connectorKeys || !s.connectorKeys.pub) {
      s.connectorKeys = await cnMakeKeys();
      await this.plugin.saveSettings();
    }
    return s.connectorKeys;
  }

  /**
   * Раздать свой открытый ключ устройствам, которые его ещё не получили,
   * и посчитать с ними общий секрет. Раз в минуту — чаще незачем,
   * устройства добавляются редко.
   */
  async syncKeys(force) {
    if (!force && Date.now() - this.keysChecked < 60e3) return;
    this.keysChecked = Date.now();
    const mine = await this.ownKeys();
    for (const d of await this.listDevices()) {
      if (!d.pub) continue;                       // старое приложение, без ключей
      if (!this.secrets.has(d.id)) {
        try { this.secrets.set(d.id, await cnShared(mine.priv, d.pub)); } catch { continue; }
      }
      if (!d.paired) {
        await this.req("/api/devices/key", { code: this.cfg.code, id: d.id, peer: mine.pub })
          .catch(() => {});
      }
    }
  }

  /** Зашифровать для конкретного устройства, если с ним есть общий секрет. */
  async sealFor(id, text) {
    const key = id && this.secrets.get(id);
    return key ? cnSeal(key, text) : text;
  }

  /** Расшифровать пришедшее от устройства. */
  async openFrom(id, text) {
    if (!cnSealed(text)) return text;
    const key = id && this.secrets.get(id);
    if (!key) { await this.syncKeys(true); }
    const k = id && this.secrets.get(id);
    return k ? cnOpen(k, text) : "";
  }

  /** Какие телефоны подключены к этому коду. */
  async listDevices() {
    if (!this.configured()) return [];
    try {
      const r = await this.req("/api/devices?code=" + encodeURIComponent(this.cfg.code));
      return (r && r.devices) || [];
    } catch { return []; }
  }

  /** Отключить одно устройство. Остальные продолжают работать. */
  async dropDevice(id) {
    if (!this.configured()) return false;
    try {
      const r = await this.req("/api/devices/drop", { code: this.cfg.code, id });
      return !!(r && r.dropped);
    } catch { return false; }
  }

  /** Положить готовый текст в чат приложения, как будто его прислал ассистент. */
  /**
   * Положить сообщение в названный чат телефона.
   *
   * Это разговор, который начинает компьютер: результат автоматизации.
   * Ответом на вопрос его отправить нельзя — телефон слушает только свои
   * вопросы, и такой текст просто пропадал.
   *
   * Каждому устройству своё тело: общий секрет у них разный, и одного
   * текста на всех тут быть не может. Кнопке быстрой записи не шлём —
   * она ничего не показывает, у неё нет экрана.
   */
  async post(text, chat, title) {
    if (!this.configured()) return false;
    try {
      await this.syncKeys();
      const payload = JSON.stringify({ title: String(title || ""), text: String(text || "") });
      const items = [];
      for (const d of await this.listDevices()) {
        if (!d || !d.id || d.name === QUICK_NAME) continue;
        items.push({ device: d.id, body: await this.sealFor(d.id, payload) });
      }
      if (!items.length) return false;
      await this.req("/api/post", {
        code: this.cfg.code, chat: String(chat || "main").slice(0, 64), items,
      });
      return true;
    } catch { return false; }
  }

  /**
   * Ответ уходит кусками — на телефоне текст появляется по мере готовности.
   * Но если с устройством есть общий секрет, кусками нельзя: часть
   * шифротекста расшифровать невозможно. Тогда отправляем целиком.
   */
  /**
   * Три коротких «а дальше?» под ответом.
   *
   * Берём не выдумку модели, а то, что рядом лежит в хранилище: заметки, до
   * которых агент дотянулся в этом ходе, и ближайшие по смыслу из индекса.
   * Вопрос, ведущий к своей записи, человек нажмёт; общий — нет.
   *
   * Ошибка тут ничего не стоит: вернём пустой список, и ответ уйдёт без
   * подсказок. Ради них задерживать готовый ответ нельзя.
   */
  /**
   * Три следующих вопроса — те, что показываются кнопками под ответом.
   *
   * Смысл не в том, чтобы придумать продолжение разговора, а в том, чтобы
   * предложить продолжение ПО ЭТОМУ хранилищу. Поэтому модель получает не
   * список названий, а названия вместе с тем, что внутри: по одному
   * заголовку она может сочинить только «расскажи про Сентябрь», а увидев
   * в заметке строки расходов — «на что ушло больше всего в сентябре».
   *
   * Раньше сюда уходили ровно заголовки, причём соседей по смыслу легко
   * вытесняли заметки, которые агент и так уже прочитал: списки сливались
   * в один и обрезались восьмым элементом. Отсюда и брались подсказки
   * вида «а что там ещё есть» — модели было нечем быть конкретной.
   */
  async nextSteps(question, answer, sources) {
    const s = this.plugin.settings;
    const V = this.plugin.vault;

    // Сколько соседей берём и насколько далёких пускаем. Порог
    // относительный, а не абсолютный: косинус у разных моделей эмбеддингов
    // живёт в разных диапазонах, и число вроде 0.45 пришлось бы подбирать
    // заново под каждую. «Не хуже 82% от лучшего соседа» держится само.
    const KEEP = 5;
    const RATIO = 0.82;
    /* Пустой шаблон без текста: вектор у такой заметки есть, но он
       врёт — считается практически от одних заголовков и тянется к чему угодно.

       Число — пол под пустые шаблоны, а не планка качества. Сначала
       стояло 80 — столько берёт отсев при индексации, но там судят по
       целой заметке. Здесь же — по окну в 220 знаков, и на живом примере
       порог выбросил запись «Тонометр Omron M3 — 4 900 ₽, забрать в пятницу»:
       шестьдесят восемь знаков, и лучшая подсказка из всего, что было рядом. */
    const MIN_BODY = 60;

    const seen = new Set();

    /* Что агент читал сам — это точно по делу. Но он мог и вовсе не
       заглядывать в хранилище, поэтому список бывает пустым. */
    const used = [];
    for (const x of (sources || [])) {
      const name = String((x && (x.title || x.path)) || "").trim();
      const key = String((x && (x.path || x.title)) || "").trim();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      used.push(name);
    }

    /* Карта смыслов. Ищем по вопросу И ответу: тема разговора живёт в
       ответе не меньше, чем в вопросе, а иногда только в нём — «сколько я
       потратил» само по себе не указывает ни на месяц, ни на заметку. */
    const near = [];
    if (s.semanticSearch) {
      const probe = (String(question || "") + "\n"
        + String(answer || "").replace(/\s+/g, " ")).slice(0, 1200);
      try {
        const hits = await V.semanticSearch(probe, 12);
        const best = hits.length ? hits[0].score : 0;
        for (const h of hits) {
          if (near.length >= KEEP) break;
          // Список отсортирован по убыванию, поэтому первый далёкий сосед
          // означает, что дальше пойдут только хуже.
          if (best > 0 && h.score < best * RATIO) break;
          if (seen.has(h.path)) continue;
          // Через resolve, а не напрямую: он же проверяет область и
          // приватные папки. Подсказка — это текст заметки на экране.
          const file = V.resolve(h.path);
          if (!file) continue;
          let body = "";
          try { body = await V.snippet(file, probe, 220); } catch { continue; }
          const clean = String(body).replace(/[\s…]+/g, " ").trim();
          if (clean.length < MIN_BODY) continue;
          seen.add(h.path);
          near.push({ name: String(h.title || h.path), body: clean });
        }
      } catch { /* индекса нет или он от другой модели — обойдёмся */ }
    }

    const material = [
      used.length
        ? "Уже прочитано по этому вопросу: " + used.slice(0, 6).join("; ")
        : "",
      near.length
        ? "Рядом по смыслу, с началом текста:\n"
          + near.map((n) => "— " + n.name + ": " + n.body).join("\n")
        : "",
    ].filter(Boolean).join("\n\n");

    const ask = "Человек спросил своё хранилище заметок и получил ответ. "
      + "Предложи три следующих вопроса — такие, чтобы он нажал на них "
      + "пальцем и разговор пошёл дальше по ЕГО заметкам.\n\n"
      + "Ассистент умеет искать и читать заметки, сравнивать их, подводить "
      + "итоги, дописывать в заметку и создавать новые. Предлагай только "
      + "то, что он правда может сделать.\n\n"
      + "Правила:\n"
      + "— Опирайся на конкретное из материала ниже: имя, число, срок, "
      + "название заметки. Общие вопросы вроде «расскажи подробнее» или "
      + "«что там ещё есть» не годятся.\n"
      + "— Живой разговорной речью, как спросил бы сам человек.\n"
      + "— Коротко, до 45 знаков: подсказка — это кнопка в одну строку "
      + "на телефоне. Коротко и конкретно одновременно — в этом вся задача.\n"
      + "— На языке вопроса.\n"
      + "— Не повторять заданный вопрос и не пересказывать ответ.\n"
      + "— Три разных хода, а не один вопрос в трёх видах.\n\n"
      + "В ответе только массив JSON из трёх строк, ничего больше.\n\n"
      + "Вопрос: " + String(question).slice(0, 300) + "\n"
      + "Ответ: " + String(answer).replace(/\s+/g, " ").slice(0, 700)
      + (material ? "\n\n" + material : "");

    try {
      const msg = await this.plugin.ai.chat(
        [{ role: "user", content: ask }],
        // Температура выше прежней 0.4: три подсказки должны быть тремя
        // разными ходами, а на низкой модель давала вариации одного.
        { model: fastModelFor(s) || undefined, maxTokens: 300, temperature: 0.7 });
      const raw = String((msg && msg.content) || "");
      const m = raw.match(/\[[\s\S]*\]/);
      if (!m) return [];
      const list = JSON.parse(m[0]);
      if (!Array.isArray(list)) return [];
      const out = [];
      for (const x of list) {
        const v = String(x || "").replace(/\s+/g, " ").trim();
        /* Подсказка живёт в кнопке-таблетке с радиусом 100px, а такая кнопка
           хороша только в одну строку. На телефоне лента шириной около
           350px, внутри кнопки остаётся ~322px при кегле 14.5px — это и
           есть те самые сорок с лишним знаков. Значит число ниже не
           произвольное: поднимешь его — таблетка перенесётся на две
           строки и рассыпется. Просим 45, пускаем 60: промах на слово —
           не причина терять подсказку, а длиннее — уже не кнопка. */
        if (v && v.length <= 60 && v.toLowerCase() !== String(question).toLowerCase()
            && !out.includes(v)) out.push(v);
        if (out.length === 3) break;
      }
      return out;
    } catch { return []; }
  }

  async reply(ref, text, forDevice, sealedIn) {
    const body = String(text || "");
    // Шифруем только если собеседник сам говорил шифром. Иначе ключа
    // у него ещё нет, и зашифрованный ответ он просто не прочтёт.
    const key = sealedIn && forDevice && this.secrets.get(forDevice);
    if (key) {
      await this.req("/api/reply", {
        code: this.cfg.code, ref, chunk: await cnSeal(key, body), done: true,
      });
      return;
    }
    const step = 64;
    for (let i = 0; i < body.length; i += step) {
      if (!this.running) return;
      await this.req("/api/reply", { code: this.cfg.code, ref, chunk: body.slice(i, i + step) });
    }
    await this.req("/api/reply", { code: this.cfg.code, ref, chunk: "", done: true });
  }

  /**
   * Фотография: прочитать текст и составить обычную просьбу.
   *
   * Дальше всё идёт по общему пути — поэтому заметка создаётся так же, как
   * если бы человек надиктовал её словами: по шаблону, в нужной папке.
   *
   * Возвращает пустое, если работать не с чем: тогда человеку уже отправлено
   * объяснение, и продолжать нечего.
   */
  async fromPhoto(m, kind, payload, from, sealedIn) {
    let caption = "";
    let image = "";
    try {
      const j = JSON.parse(payload);
      caption = String(j.caption || "").trim();
      image = String(j.image || "");
    } catch { image = payload; }

    if (!image) {
      await this.reply(m.id, "Фотография не дошла целиком. Пришлите ещё раз.", from, sealedIn)
        .catch(() => {});
      return "";
    }

    const mime = kind.includes("png") ? "image/png" : "image/jpeg";
    let seen = "";
    try {
      seen = await this.plugin.ai.readPhoto(image, mime);
    } catch (e) {
      const why = String((e && e.message) || e);
      await this.reply(m.id, why === "no-cloud"
        ? "Локальная модель не читает фотографии — нужен облачный ключ."
        : "Не получилось прочитать фотографию: " + why, from, sealedIn).catch(() => {});
      return "";
    }

    if (!seen || seen === "NOTEXT") {
      await this.reply(m.id, "На фотографии не видно текста. "
        + "Снимите ближе и при ровном свете.", from, sealedIn).catch(() => {});
      return "";
    }

    /* Пометка человека идёт первой строкой, потому что именно она говорит,
       что с этим делать: «по экономике», «в дневник», «это рецепт». Без неё
       ассистент решит сам — и обычно правильно, но пусть решает по просьбе,
       а не по догадке. */
    return "[Ниже — текст, прочитанный с фотографии: человек снял бумажную "
      + "запись и хочет сохранить её в заметках. Сохрани как заметку: приведи "
      + "в порядок разметку, но ничего не дописывай от себя — на фото этого "
      + "нет. Пометки [неразборчиво] оставь как есть.]\n\n"
      + (caption ? "Просьба человека: " + caption + "\n\n" : "")
      + "Текст с фотографии:\n" + seen;
  }

  /**
   * Голос с телефона: расшифровать и вернуть текст.
   *
   * Формат обязателен и приходит вместе с видом сообщения: айфон пишет
   * mp4, всё остальное — webm. Прислать один под именем другого — верный
   * способ получить в ответ бессмыслицу.
   */
  async doVoice(m, kind, base64, from, sealedIn) {
    const fmt = kind.split(".")[1] || "webm";
    try {
      const said = String((await this.plugin.ai.transcribe(base64, fmt)) || "").trim();
      await this.reply(m.id, said || "!Ничего не расслышал.", from, sealedIn);
    } catch (e) {
      const why = String((e && e.message) || e);
      // Восклицательный знак в начале — знак приложению, что это не текст
      // сказанного, а причина неудачи: его покажут, а не вставят в поле.
      await this.reply(m.id, why === "no-cloud"
        ? "!Локальная модель не распознаёт речь — нужен облачный ключ."
        : "!Не получилось расшифровать: " + why, from, sealedIn).catch(() => {});
    }
  }

  /** Остаток на счёте. Ответ — короткий JSON, его читает приложение. */

  /**
   * Отдельное устройство только для быстрой записи.
   *
   * Заводится тем же способом, что и телефон, — через /api/pair, — но
   * без открытого ключа: «Команды» и виджеты шифровать не умеют. Взамен
   * такой ключ почти ничего и не может: см. doQuick.
   */
  async makeQuickKey() {
    /* Старые кнопки убираем до того, как завести новую. Забытый ключ остался
       бы жить на сервере, а плагин уже не считал бы его кнопкой — и пустил бы
       его сообщения к ассистенту со всеми правами. */
    try {
      const old = await this.listDevices();
      for (const d of old) {
        if (d && d.name === QUICK_NAME && d.id) await this.dropDevice(d.id).catch(() => {});
      }
    } catch { /* до списка не достучались — заводим как есть */ }
    const r = await this.req("/api/pair", {
      code: this.cfg.code, name: QUICK_NAME, pub: "",
    });
    if (!r || !r.token) throw new Error("no token");
    /* Сервер отдаёт только токен, а нам нужен ещё и номер устройства:
       по нему плагин узнаёт, что сообщение пришло от кнопки, а не от
       телефона. Берём самое свежее устройство с нашим именем. */
    let device = "";
    try {
      const list = await this.listDevices();
      const mine = list.filter((d) => d && d.name === QUICK_NAME)
        .sort((a, b) => (b.seen || 0) - (a.seen || 0))[0];
      device = (mine && mine.id) || "";
    } catch { /* список не ответил — разберёмся ниже */ }
    /* Без номера устройства ключ отдавать нельзя: плагин не узнает в нём
       кнопку и пустит его сообщения к ассистенту со всеми правами. Токен
       мы никому не показали, так что он безвреден; заведённое устройство
       видно в списке выше и отключается там же. */
    if (!device) throw new Error(t("Could not read the device list — try again."));
    return { token: r.token, device };
  }

  /**
   * Быстрая запись: текст в заметку, без ассистента и без модели.
   *
   * Тут нарочно нет ни поиска, ни чтения, ни правки — не потому, что они
   * запрещены проверкой, а потому, что их тут просто нет. Единственное, что
   * умеет этот путь, — создать файл; и даже он проходит через createNote,
   * который сам не пустит в личные папки.
   */
  async doQuick(m, text) {
    const from = (m && m.device) || null;
    const s = this.plugin.settings;
    if (!s.canCreate) {
      await this.reply(m.id, t("Creating notes is switched off in settings."), from).catch(() => {});
      return;
    }
    const body = String(text || "").trim();
    if (!body) return;
    // Заголовок — первая строка, без того, что файловая система не примет.
    const first = body.split("\n")[0].replace(/\s+/g, " ").trim();
    const title = (first.slice(0, 70).replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim())
      || t("Quick capture");
    const now = new Date();
    const two = (n) => String(n).padStart(2, "0");
    const stamp = `${two(now.getDate())}-${two(now.getMonth() + 1)}-${now.getFullYear()} ${two(now.getHours())}:${two(now.getMinutes())}`;
    const note = `${body}\n\n— ${t("Written from the phone")}, ${stamp}\n`;
    try {
      /* Две судьбы у одной мысли, и обе законные: отдельная заметка во
         входящих, если мысль самостоятельная, или строка в конце сегодняшнего
         дня, если это дневник. Второе — не то же самое, что «ассистент
         дописал в ежедневную»: здесь человек сам выбрал этот адрес, а строка
         идёт ровно в конец файла и ничего в нём не трогает. */
      if (this.cfg.quickTo === "daily") {
        // Дописать в существующую заметку — правка, а не создание, и
        // отдельный выключатель для правки здесь действует так же.
        if (!s.canEdit) {
          await this.reply(m.id, t("Editing notes is switched off in settings."), from).catch(() => {});
          return;
        }
        const day = await this.plugin.vault.ensureDailyNote("today");
        if (!day) throw new Error(t("There is no daily note and Obsidian could not make one."));
        // Пунктом списка и со временем: голая строка после списка прилипла бы
        // к последнему пункту, а время — единственное, чего в самой мысли нет.
        const line = `- ${two(now.getHours())}:${two(now.getMinutes())} ${body.replace(/\n+/g, " ")}`;
        await this.plugin.vault.appendToNote(day, line);
        await this.reply(m.id, t("Added to {0}", day.basename), from).catch(() => {});
        return;
      }
      const where = this.cfg.quickFolder || this.plugin.settings.newNoteFolder || "inbox";
      const f = await this.plugin.vault.createNote(title, note, where);
      await this.reply(m.id, t("Saved: {0}", f.basename), from).catch(() => {});
    } catch (e) {
      await this.reply(m.id, String((e && e.message) || e), from).catch(() => {});
    }
  }

  async doBalance(m, from, sealedIn) {
    let balance = null;
    try { balance = await this.plugin.spend.readBalance(); } catch { /* нет связи */ }
    await this.reply(m.id, JSON.stringify({
      balance,
      provider: this.plugin.settings.provider,
    }), from, sealedIn).catch(() => {});
  }

  /** Ссылка на оплату. Ключ остаётся здесь — наружу уходит только адрес. */
  async doTopup(m, kind, from, sealedIn) {
    const amount = Math.round(Number(kind.split(":")[1]));
    const key = (this.plugin.settings.keys && this.plugin.settings.keys.obsimind) || "";
    if (!key) {
      await this.reply(m.id, JSON.stringify({ error: "no_key" }), from, sealedIn).catch(() => {});
      return;
    }
    try {
      const res = await requestUrl({
        url: "https://base.eltonlabs.org/api/key/topup-direct",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: key, amount }),
        throw: false,
      });
      await this.reply(m.id, JSON.stringify(res.json || { error: "bad_reply" }), from, sealedIn);
    } catch (e) {
      await this.reply(m.id, JSON.stringify({ error: String((e && e.message) || e) }), from, sealedIn)
        .catch(() => {});
    }
  }

  /**
   * Это кнопка быстрой записи?
   *
   * Сохранённый номер устройства — не единственный ответ, потому что он
   * теряется: ключ завели, а в настройках пусто (создали на другом
   * компьютере, перенесли хранилище, нажали кнопку дважды). Тогда
   * сообщение от кнопки шло к ассистенту, и человек видел не заметку,
   * а разговор — ровно так это и выглядело со стороны: «пишу, и ничего
   * не происходит».
   *
   * Поэтому спрашиваем сервер, как устройство называется. Ошибиться в
   * опасную сторону это не может: узнавание по имени только урезает
   * права до «создать заметку» и никогда их не расширяет.
   */
  async isQuick(from) {
    if (!from) return false;
    if (this.cfg.quick && from === this.cfg.quick) return true;
    // Список спрашиваем не чаще раза в минуту: сообщений может быть много,
    // а имена устройств меняются раз в жизни.
    if (!this.quickIds || Date.now() - (this.quickAt || 0) > 60e3) {
      try {
        const list = await this.listDevices();
        this.quickIds = new Set(list.filter((d) => d && d.name === QUICK_NAME).map((d) => d.id));
        this.quickAt = Date.now();
      } catch { /* без связи решаем по сохранённому номеру */ }
    }
    return !!(this.quickIds && this.quickIds.has(from));
  }

  /**
   * Кнопка «остановить» на телефоне.
   *
   * Пока агент думает, цикл коннектора стоит на нём и ничего не слышит:
   * очередь разбирается только между сообщениями. Поэтому про отмену
   * спрашиваем короткими запросами в стороне от основного потока.
   *
   * Сервер может про такой адрес и не знать — например, обновился плагин,
   * а релей ещё нет. Тогда запрос просто не удаётся, и всё работает как
   * раньше: кнопки на телефоне нет, ход доходит до конца.
   *
   * Возвращает функцию, которой опрос прекращают.
   */
  watchCancel(ref, agent) {
    let stopped = false;
    const ask = async () => {
      while (!stopped && this.running) {
        await new Promise((r) => window.setTimeout(r, 2500));
        if (stopped || !this.running) return;
        try {
          const r = await this.req("/api/cancelled?code=" + encodeURIComponent(this.cfg.code)
            + "&ref=" + encodeURIComponent(ref));
          if (r && r.cancelled) {
            agent.cancelled = true;
            // Оборвать и сам запрос к модели: иначе ответ ещё пишется,
            // и деньги за него всё равно спишутся.
            try { if (agent.abort) agent.abort.abort(); } catch { /* уже закрыт */ }
            return;
          }
        } catch { /* нет связи или старый релей — молчим и пробуем снова */ }
      }
    };
    ask();
    return () => { stopped = true; };
  }

  async handle(m) {
    const from = (m && m.device) || null;
    const raw = String((m && m.body) || "");
    /* Кнопка быстрой записи. Перехватываем до всего остального: у неё нет
       ни ассистента, ни инструментов, ни доступа к переписке — только
       создание заметки. Шифра тут не бывает, «Команды» его не умеют. */
    if (await this.isQuick(from)) {
      return await this.doQuick(m, raw);
    }
    let text = (await this.openFrom(from, raw)).trim();
    if (!text) {
      if (cnSealed(raw)) {
        // Ключа для этого устройства нет — сказать об этом надо, иначе
        // человек будет смотреть на молчание.
        await this.reply(m.id, "Не удалось расшифровать сообщение. Переподключите телефон.", from)
          .catch(() => {});
      }
      return;
    }

    // Как с нами говорили — так и отвечаем: шифром на шифр, открыто на
    // открытое. Телефон, у которого ещё нет нашего ключа, шифра не прочтёт.
    const sealedIn = cnSealed(raw);

    // Не всё, что приходит с телефона, — вопрос ассистенту.
    const kind = String((m && m.kind) || "text");
    if (kind.startsWith("photo")) {
      text = await this.fromPhoto(m, kind, text, from, sealedIn);
      if (!text) return;
    }
    if (kind.startsWith("voice")) return await this.doVoice(m, kind, text, from, sealedIn);
    if (kind === "balance") return await this.doBalance(m, from, sealedIn);
    if (kind.startsWith("topup")) return await this.doTopup(m, kind, from, sealedIn);

    try {
      const agent = new Agent(this.plugin);
      // Фраза-сценарий работает здесь ровно так же, как сказанная вслух.
      const hit = matchScenario(text, this.plugin.settings.scenarios);
      let sent = hit ? scenarioPrompt(hit.scenario, hit.rest) : text;

      // Из браузера ассистент не видит ни открытой заметки, ни календаря,
      // поэтому «что у меня на сегодня» он понимал как «что вообще есть».
      // Дату сообщаем явно и в том же формате, в каком названы ежедневные.
      const now = new Date();
      const two = (n) => String(n).padStart(2, "0");
      const days = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
      const stamp = `${two(now.getDate())}-${two(now.getMonth() + 1)}-${now.getFullYear()}`;
      const months = ["января", "февраля", "марта", "апреля", "мая", "июня",
        "июля", "августа", "сентября", "октября", "ноября", "декабря"];
      const words = `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
      // Про дневник говорим только когда спрашивают про время. Иначе
      // ассистент открывал сегодняшнюю заметку на любой вопрос — даже про
      // консультации, — и тратил на это ход.
      const aboutTime = /сегодн|вчера|завтра|на день|за день|дневник|ежеднев|привычк|задач|план|недел|утро|вечер|дата|числ/i
        .test(text);
      const dayHint = aboutTime
        ? `Ежедневная заметка за сегодня — «${stamp}», формат ДЕНЬ-МЕСЯЦ-ГОД. `
          + `Открывай её по имени, а не ту, что открыта в редакторе. `
        : '';
      // Коротко, но без двусмысленности: «03-09» модель читает как 9 марта,
      // если не сказать, что формат день-месяц-год.
      /* Куда класть новую заметку — из настроек хранилища, а не из кода.
         Здесь была зашита папка автора, и всем остальным ассистент предлагал
         класть заметки туда, чего у них нет. Без настройки просим
         хотя бы не сорить в корне. */
      const inbox = String(this.plugin.settings.newNoteFolder || "").trim();
      const inboxHint = inbox
        ? `Новые заметки без указания папки клади в «${inbox}», не в корень. `
        : "Новые заметки клади в подходящую по смыслу папку, а не в корень хранилища. ";
      sent = `[Сегодня ${words} (${days[now.getDay()]}), ${two(now.getHours())}:${two(now.getMinutes())}. `
        + dayHint
        + inboxHint
        + `Человек пишет с телефона и не видит экран компьютера: не отвечай `
        + `«открыл, смотри» — читай и пересказывай, коротко. `
        /* Живой случай: на «убери повторы» после списка задач ассистент
           переписал четыре ежедневные заметки. Человек имел в виду список
           на экране. С телефона такое не отменить — там не видно, что
           изменилось, и нет отмены под рукой. */
        + `Короткое уточнение — «убери повторы», «покороче», «по-другому», `
        + `«без воды», «переделай» — относится к твоему ответу, а не к `
        + `заметкам: перепиши ответ, файлы не трогай. Заметки меняй только `
        + `когда сказано прямо: «исправь в заметке», «удали из файла», `
        + `«допиши в дневник». Можно понять и так и так — спроси одной `
        + `строкой, а не выбирай сам.]\n\n` + sent;

      const chatId = String(m.chat || "main");
      const history = this.chatHistory.get(chatId) || [];

      // Пока агент работает, цикл стоит здесь и очередь не разбирает —
      // значит про «останови» надо спрашивать отдельно.
      const stopWatch = this.watchCancel(m.id, agent);
      let reply;
      try {
        reply = await agent.run(history, sent, {
          // Пустая функция, а не null: runTool зовёт onEvent без проверки,
          // и с null падает любой поиск по заметкам.
          onEvent: () => {},
          // За клавиатурой никого нет, поэтому удаление здесь не происходит
          // никогда: агент спрашивает, получает отказ и говорит об этом.
          confirm: async () => false,
          onSegment: null,
          written: true,
          channel: "connector",
        });
      } finally { stopWatch(); }

      /* Остановлено с телефона. Ответ всё равно нужен: приложение ждёт метки
         «готово» и без неё крутило бы «думаю» до самого таймаута. В историю
         оборванный ход не кладём — продолжать с него нечего. */
      if (agent.cancelled) {
        await this.reply(m.id, t("Stopped."), from, sealedIn).catch(() => {});
        return;
      }
      history.push({ role: "user", content: sent });
      history.push({ role: "assistant", content: reply || "" });
      this.chatHistory.set(chatId, history.slice(-12));
      // Чатов может накопиться много, а память нужна только живым.
      if (this.chatHistory.size > 20) {
        this.chatHistory.delete(this.chatHistory.keys().next().value);
      }

      const list = (agent.sources || []).slice(0, 8);
      const tail = list.length
        ? "\n\n" + t("From your notes:") + "\n" + list.map((x) => "- " + (x.title || x.path)).join("\n")
        : "";
      // Одним куском: телефон перестаёт слушать на метке «готово», и всё,
      // что послано после неё, до него уже может не дойти.
      const body = (reply && reply.trim()) || t("I have nothing to say to that.");
      /* Хвостом — подсказки «а дальше». Приложение вырежет эту строку и
         нарисует её кнопками; в историю и в заметки она не попадает,
         потому что приклеивается уже после них. */
      const next = await this.nextSteps(text, body, agent.sources);
      const chips = next.length ? "\n\n<!--next:" + JSON.stringify(next) + "-->" : "";
      await this.reply(m.id, body + tail + chips, from, sealedIn);
    } catch (e) {
      await this.reply(m.id, "Не получилось ответить: " + (e.message || String(e)), from, sealedIn)
        .catch(() => {});
    }
  }
}

