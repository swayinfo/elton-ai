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
/* Почтовый ящик между экземплярами коннектора в одном окне: живёт на window,
   потому что старый и новый экземпляр плагина — разные модули. */
function cnInbox() {
  const w = window;
  if (!w.__eltonAiInbox) w.__eltonAiInbox = { list: [], wake: null };
  return w.__eltonAiInbox;
}
function cnHandOver(msgs) {
  if (!msgs || !msgs.length) return;
  const box = cnInbox();
  box.list.push(...msgs);
  if (box.wake) { try { box.wake(); } catch { /* новый ещё не готов — заберёт при старте */ } }
}

class ConnectorBridge {
  constructor(plugin) {
    this.plugin = plugin;
    this.running = false;
    this.lastError = "";
    // Своя история на каждый чат: в браузере их может быть несколько,
    // и мешать их в одну кучу — значит путать ассистента.
    this.chatHistory = new Map();   // осталось ради старых путей; память — в plugin.memory
    this.browser = new VaultBrowser(plugin);
    this.chain = Promise.resolve();
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

  /** Сообщения, которые забрал, но не успел разобрать прошлый экземпляр. */
  adoptOrphans() {
    const box = cnInbox();
    box.wake = () => this.adoptOrphans();
    box.owner = this;
    const list = box.list.splice(0);
    for (const m of list) this.dispatch(m);
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
    this.adoptOrphans();
    this.loop();
  }

  stop() {
    this.running = false;
    const box = cnInbox();
    if (box.wake && box.owner === this) box.wake = null;
  }

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
    throw last || new Error(t("No connection"));
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
        const msgs = (r && r.msgs) || [];
        /* Выключили, пока запрос висел у сервера, — обычно это перезагрузка
           плагина или его обновление. Сервер уже отметил эти сообщения
           забранными, и выброшенное здесь не доходило никуда: человек на
           телефоне так и смотрел на «думаю…». Отдаём их новому экземпляру. */
        if (!this.running) { cnHandOver(msgs); return; }
        for (const m of msgs) this.dispatch(m);
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
      /* Что этот плагин умеет. Приложение одно на всех, а плагины обновляются
         кто когда: по этому списку оно решает, показывать ли ленту и папки
         и слать ли вопрос вместе с перепиской. Старый плагин списка не шлёт —
         и приложение ведёт себя с ним по-старому. */
      version: this.plugin.manifest.version,
      caps: ["ask", "browse", "photo-modes", "undo"],
      user: String(this.plugin.settings.userName || "").slice(0, 40),
      assistant: String(this.plugin.settings.assistantName || "").slice(0, 40),
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
        title: String(title || t("Vault")).slice(0, 90),
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
    // Every 10 s, not every minute: a phone that has just been connected waits
    // for this key before it may ask for a single note.
    if (!force && Date.now() - this.keysChecked < 10e3) return;
    this.keysChecked = Date.now();
    const mine = await this.ownKeys();
    const list = await this.listDevices();
    this.reviewDevices(list);
    for (const d of list) {
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

  /*
   * A phone is let in only once it has been allowed here, on the computer.
   *
   * The code alone was the whole key: anyone who saw it — on a screenshot,
   * over a shoulder — could add a phone and read the vault from the feed and
   * the folders. Guessing it is hopeless (twelve characters, and the server
   * allows ten tries in ten minutes per address); leaking it is not. So a new
   * device now waits until its owner presses «Allow» in Obsidian, and until
   * then gets nothing — not a note, not an answer, not a transcription.
   */
  isApproved(id) {
    if (!id) return false;
    if (this.cfg.quick && id === this.cfg.quick) return true;   // made by this plugin itself
    return Array.isArray(this.cfg.approved) && this.cfg.approved.includes(id);
  }

  reviewDevices(list) {
    const cfg = this.cfg;
    this.knownDevices = list;
    if (!Array.isArray(cfg.approved)) cfg.approved = [];
    if (!cfg.approvalSeeded) {
      // Phones connected before this check existed were connected by their
      // owner; asking about each one now would only cut them off.
      cfg.approved = list.map((d) => d && d.id).filter(Boolean);
      cfg.approvalSeeded = true;
      this.plugin.saveSettings();
      return;
    }
    for (const d of list) if (d && d.id && !this.isApproved(d.id)) this.askApproval(d);
  }

  async approveDevice(id) {
    if (!Array.isArray(this.cfg.approved)) this.cfg.approved = [];
    if (!this.cfg.approved.includes(id)) this.cfg.approved.push(id);
    await this.plugin.saveSettings();
  }

  askApproval(d) {
    this.asked = this.asked || new Set();
    if (this.asked.has(d.id) || typeof DeviceApprovalModal === "undefined") return;
    this.asked.add(d.id);
    const name = d.name || t("Device");
    new DeviceApprovalModal(this.plugin.app, d, async (ok) => {
      if (ok) {
        await this.approveDevice(d.id);
        new Notice(t("«{0}» is connected.", name));
      } else {
        await this.dropDevice(d.id);
        new Notice(t("«{0}» was refused and disconnected.", name));
      }
    }).open();
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
        ? "Already read for this question: " + used.slice(0, 6).join("; ")
        : "",
      near.length
        ? "Close in meaning, with the start of each:\n"
          + near.map((n) => "— " + n.name + ": " + n.body).join("\n")
        : "",
    ].filter(Boolean).join("\n\n");

    /* In English like every other instruction; the questions themselves
       come out in the language of the question (rule below). */
    const ask = "A person asked their own notes vault something and got an answer. "
      + "Suggest three follow-up questions — ones they would tap with a finger "
      + "so the conversation carries on through THEIR notes.\n\n"
      + "The assistant can search and read notes, compare them, sum them up, "
      + "add to a note and create new ones. Suggest only what it really can do.\n\n"
      + "Rules:\n"
      + "— Build on something concrete from the material below: a name, a number, "
      + "a date, a note title. Generic ones like \"tell me more\" or "
      + "\"what else is there\" will not do.\n"
      + "— Plain spoken words, the way the person would ask it.\n"
      + "— In the person's own voice, because they tap it to send it: \"what did I write about…\", "
      + "\"add this to my…\" — never the assistant asking them (\"what did you…\").\n"
      + "— Short, up to 45 characters: a suggestion is a one-line button on a phone. "
      + "Short and concrete at once — that is the whole job.\n"
      + "— In the language of the question.\n"
      + "— Do not repeat the question or retell the answer.\n"
      + "— Three different moves, not one question three ways.\n\n"
      + "Reply with a JSON array of three strings and nothing else.\n\n"
      + "Question: " + String(question).slice(0, 300) + "\n"
      + "Answer: " + String(answer).replace(/\s+/g, " ").slice(0, 700)
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

  async reply(ref, text, forDevice, sealedIn, opts = {}) {
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
    /* Ответ листания — данные, а не текст: печатать его по буквам незачем,
       а куски по 64 знака превратили бы одну заметку в тысячу запросов. */
    if (opts.whole) {
      await this.req("/api/reply", { code: this.cfg.code, ref, chunk: body, done: true });
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
  /**
   * Фотография с телефона. Что с ней делать, выбирает человек:
   *
   *   text   — прочитать текст с бумаги и сохранить заметкой (как раньше);
   *   attach — положить сам снимок в хранилище и вставить в заметку;
   *   ask    — показать ассистенту и спросить, что на нём.
   *
   * Старое приложение режима не присылает — для него всё как было: текст.
   *
   * Возвращает { text, line } для обычного хода ассистента или null, если
   * всё уже сделано здесь или человеку уже объяснено, почему нет.
   */
  async fromPhoto(m, kind, payload, from, sealedIn, chatId) {
    let caption = "";
    let image = "";
    let mode = "text";
    let ctx = null;
    let rich = false;
    try {
      const j = JSON.parse(payload);
      caption = String(j.caption || "").trim();
      image = String(j.image || "");
      if (j.mode) { mode = String(j.mode); rich = true; }
      if (Array.isArray(j.ctx)) ctx = j.ctx;
    } catch { image = payload; }

    if (!image) {
      await this.reply(m.id, t("The photo did not arrive in full. Please send it again."), from, sealedIn)
        .catch(() => {});
      return null;
    }
    const mime = kind.includes("png") ? "image/png" : "image/jpeg";

    if (mode === "attach") return await this.attachPhoto(m, image, mime, caption, from, sealedIn, chatId, ctx);

    if (mode === "ask") {
      let seen = "";
      try {
        seen = await this.plugin.ai.describePhoto(image, mime, caption);
      } catch (e) {
        const why = String((e && e.message) || e);
        await this.reply(m.id, why === "no-cloud"
          ? t("A local model cannot see photos — a cloud key is needed.")
          : t("Could not look at the photo: {0}", why), from, sealedIn).catch(() => {});
        return null;
      }
      return {
        rich, ctx,
        line: "📷 " + (caption || t("What is in the photo?")),
        text: "[The user sent a photo from the phone. A vision model looked at it; here is what it shows:\n"
          + seen + "\n— Answer the user's request about the photo from this. "
          + "If they ask to save or file something, do it in their notes as usual. "
          + "The photo itself is not saved in the vault unless they ask for that.]\n\n"
          + (caption || "What is in this photo?"),
      };
    }

    let seen = "";
    try {
      seen = await this.plugin.ai.readPhoto(image, mime);
    } catch (e) {
      const why = String((e && e.message) || e);
      await this.reply(m.id, why === "no-cloud"
        ? t("A local model cannot read photos — a cloud key is needed.")
        : t("Could not read the photo: {0}", why), from, sealedIn).catch(() => {});
      return null;
    }

    if (!seen || seen === "NOTEXT") {
      await this.reply(m.id, t("There is no text to be seen in the photo. Take it closer and in even light — or choose «Into a note» to keep the picture itself."), from, sealedIn).catch(() => {});
      return null;
    }

    /* Пометка человека идёт первой строкой, потому что именно она говорит,
       что с этим делать: «по экономике», «в дневник», «это рецепт». */
    return {
      rich, ctx,
      line: "📷 " + (caption || t("Text from a photo")),
      text: "[Below is text read from a photo: the person photographed something written "
        + "on paper and wants it kept in their notes. Save it as a note: tidy the markup, but "
        + "add nothing of your own — it is not on the photo. Leave unreadable-word marks as "
        + "they are. Reply in one line: where the note went and what it is called; do not "
        + "retell the note itself. "
        + (caption ? "Reply in the language of the person's request." : "Reply in " + (LANG === "ru" ? "Russian" : "English") + ".")
        + "]\n\n"
        + (caption ? "The person's request: " + caption + "\n\n" : "")
        + "Text from the photo:\n" + seen,
    };
  }

  /** Сохранить снимок как вложение — туда, куда Obsidian кладёт вложения. */
  async savePhoto(base64, mime, near) {
    const app = this.plugin.app;
    const now = new Date();
    const two = (n) => String(n).padStart(2, "0");
    const ext = mime.includes("png") ? "png" : "jpg";
    const name = `Photo ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} `
      + `${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}.${ext}`;
    let path = name;
    try { path = await app.fileManager.getAvailablePathForAttachment(name, near ? near.path : ""); }
    catch { /* старый Obsidian — в корень, как он сам сделал бы */ }
    if (!this.plugin.vault.inScope(path)) throw new Error(t("The attachments folder is private or outside the allowed folders."));
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (dir) await this.plugin.vault.ensureFolder(dir);
    const raw = atob(base64);
    const bin = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bin[i] = raw.charCodeAt(i);
    const f = await app.vault.createBinary(path, bin.buffer);
    this.lastPhotoEntry = null;
    if (this.plugin.journal) {
      try { this.lastPhotoEntry = await this.plugin.journal.record("create", { path: f.path }); } catch { /* convenience */ }
    }
    return f;
  }

  /**
   * «В заметку»: сам снимок, без распознавания.
   *
   * Без подписи — в сегодняшний день, пунктом со временем: это самый частый
   * случай («сфоткал чек, доску, ребёнка») и он не стоит ни запроса к модели,
   * ни копейки. С подписью — ассистент решает, в какую заметку: «в ремонт
   * кухни», «новой заметкой про стол».
   */
  async attachPhoto(m, image, mime, caption, from, sealedIn, chatId, ctx) {
    const s = this.plugin.settings;
    if (!s.canCreate) {
      await this.reply(m.id, t("Creating notes is switched off in settings."), from, sealedIn).catch(() => {});
      return null;
    }
    const V = this.plugin.vault;
    /* "In the diary: breakfast" — the address goes, the words stay. Whole
       words only: "today's breakfast" lost its "today" and arrived as
       "'s breakfast", and "день рождения" went into the diary as "рождения". */
    const DAY_RE = /^(?:в\s+)?(?:сегодня\S*|дневник\S*|ежедневн\S*|today|daily|день(?=\s*[:—-]|\s*$))(?=$|[\s:,.!—-])\s*[:,.!—-]?\s*/i;
    // "завтрак сегодня", "lunch today": a short caption ending in the day is about the day too.
    const wantsDay = !caption || DAY_RE.test(caption) || /^today['’]s\s/i.test(caption)
      || (caption.split(/\s+/).length <= 4 && /(^|\s)(сегодня|today)[.!]?$/i.test(caption));
    try {
      if (wantsDay) {
        if (!s.canEdit) throw new Error(t("Editing notes is switched off in settings."));
        const day = await V.ensureDailyNote("today");
        if (!day) throw new Error(t("There is no daily note and Obsidian could not make one."));
        const f = await this.savePhoto(image, mime, day);
        const shot = this.lastPhotoEntry;
        const now = new Date();
        const two = (n) => String(n).padStart(2, "0");
        const rest = caption ? caption.replace(DAY_RE, "").trim() : "";
        const note = rest ? " " + rest : "";
        // The edit as the journal saw it — its id is what "Undo" on the phone needs.
        const J = this.plugin.journal;
        let edit = null;
        const sink = (e) => { if (e.kind === "edit" && e.path === day.path) edit = e; };
        if (J) J.sinks.add(sink);
        try {
          await V.appendToNote(day, `- ${two(now.getHours())}:${two(now.getMinutes())}${note}\n\n![[${f.name}]]`);
        } finally { if (J) J.sinks.delete(sink); }
        // Undo on that line takes the picture with it.
        if (edit && shot) { edit.with = [shot.id]; J.saveSoon(); }
        const marks = "\n\n<!--changes:" + JSON.stringify([
          { id: edit ? edit.id : "", kind: "edit", path: day.path, title: day.basename, label: t("Note changed: {0}", day.basename) },
        ]) + "-->";
        const said = t("Photo added to {0}.", day.basename);
        if (!/^sys/.test(chatId)) {
          await this.plugin.memory.add("connector", chatId, {
            user: "📷 " + (caption || t("Photo into today")), reply: said,
            did: [`saved the photo «${f.name}» (${f.path}) and embedded it in «${day.basename}» (${day.path})`],
            status: "ok", ref: m.id,
          });
        }
        await this.reply(m.id, said + marks, from, sealedIn);
        return null;
      }
      const f = await this.savePhoto(image, mime, null);
      return {
        rich: true, ctx, photoEntry: this.lastPhotoEntry,
        line: "📷 " + caption,
        text: `[The user sent a photo from the phone. It is ALREADY saved in the vault as "${f.path}". `
          + `Put it where the request below says by embedding it with exactly ![[${f.name}]] — `
          + "into an existing note (append_note) or a new one (create_note), whichever the request means. "
          + "Do not describe the photo unless asked; you have not seen it. Say in one line which note it went into, "
          + "by the note's name — no file name, no path, no ![[…]] code: the person reads this on a phone.]\n\n"
          + caption,
      };
    } catch (e) {
      await this.reply(m.id, t("Could not save the photo: {0}", (e && e.message) || String(e)), from, sealedIn).catch(() => {});
      return null;
    }
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
      await this.reply(m.id, said || "!" + t("Could not make out any words."), from, sealedIn);
    } catch (e) {
      const why = String((e && e.message) || e);
      // Восклицательный знак в начале — знак приложению, что это не текст
      // сказанного, а причина неудачи: его покажут, а не вставят в поле.
      await this.reply(m.id, why === "no-cloud"
        ? "!" + t("A local model cannot recognise speech — a cloud key is needed.")
        : "!" + t("Could not transcribe it: {0}", why), from, sealedIn).catch(() => {});
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

  /* Виды сообщений, на которые отвечает не ассистент, а сам плагин. Их не
     ставим в очередь за думающим ассистентом: листать хранилище, пока он
     пишет длинный ответ, — обычное дело, и ждать тут нечего. */
  isService(kind) {
    const k = String(kind || "text");
    return BROWSE_KINDS.has(k) || k.startsWith("voice") || k === "balance" || k.startsWith("topup");
  }

  /** Разобрать одно сообщение: служебное — сразу, ход ассистента — в очередь. */
  dispatch(m) {
    const kind = String((m && m.kind) || "text");
    if (this.isService(kind)) {
      this.handle(m).catch((e) => console.error("[Elton AI] connector", e));
      return;
    }
    // Ходы по-прежнему по одному: два ответа сразу перепутали бы и деньги,
    // и заметки, которые оба правят.
    this.chain = (this.chain || Promise.resolve())
      .then(() => (this.running ? this.handle(m) : cnHandOver([m])))
      .catch((e) => console.error("[Elton AI] connector", e));
  }

  async handle(m) {
    const from = (m && m.device) || null;
    const raw = String((m && m.body) || "");
    // Not allowed on this computer yet — nothing goes out, and the person is
    // told where to allow it (see isApproved).
    if (from && !this.cfg.approvalSeeded) this.reviewDevices(await this.listDevices());
    if (from && !this.isApproved(from)) {
      const known = (this.knownDevices || []).find((d) => d && d.id === from);
      if (known) this.askApproval(known);
      const kind = String((m && m.kind) || "text");
      const msg = t("This phone is waiting for approval: open Obsidian on your computer and press «Allow».");
      const out = BROWSE_KINDS.has(kind) ? JSON.stringify({ error: "pending" }) : (kind.startsWith("voice") ? "!" + msg : msg);
      await this.reply(m.id, out, from, !!this.secrets.get(from), { whole: true }).catch(() => {});
      return;
    }
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
        await this.reply(m.id, t("Could not decrypt the message. Connect the phone again."), from)
          .catch(() => {});
      }
      return;
    }

    // Как с нами говорили — так и отвечаем: шифром на шифр, открыто на
    // открытое. Телефон, у которого ещё нет нашего ключа, шифра не прочтёт.
    const sealedIn = cnSealed(raw);

    const kind = String((m && m.kind) || "text");
    if (BROWSE_KINDS.has(kind)) return await this.doBrowse(m, kind, text, from, sealedIn);
    if (kind.startsWith("voice")) return await this.doVoice(m, kind, text, from, sealedIn);
    if (kind === "balance") return await this.doBalance(m, from, sealedIn);
    if (kind.startsWith("topup")) return await this.doTopup(m, kind, from, sealedIn);
    return await this.doTurn(m, kind, text, from, sealedIn);
  }

  /** Лента, папки, заметка, картинка, журнал правок — без модели. */
  async doBrowse(m, kind, text, from, sealedIn) {
    /* Содержимое хранилища — только под сквозным шифром. Приложение 4.0
       иначе и не спрашивает; открытый запрос значит, что что-то не так. */
    if (!sealedIn || !this.secrets.get(from)) {
      await this.reply(m.id, JSON.stringify({ error: "sealed-only" }), from, false, { whole: true }).catch(() => {});
      return;
    }
    let out;
    try { out = await this.browser.handle(kind, text); }
    catch (e) { out = { error: String((e && e.message) || e) }; }
    await this.reply(m.id, JSON.stringify(out), from, sealedIn, { whole: true }).catch(() => {});
  }

  /**
   * Что было в этом чате, словами для модели.
   *
   * Своя память — первой: в ней есть строки «что сделано», без которых
   * «добавь ещё» некуда добавлять. Переписка с телефона — для двух случаев,
   * где своей памяти нет или она неполная: чат начат до обновления, и
   * сообщения, до компьютера так и не дошедшие. Последние человек видит у
   * себя на экране и вправе считать сказанными.
   */
  async contextFor(chatId, ctx, ref) {
    const mem = this.plugin.memory;
    const turns = await mem.turns("connector", chatId);
    let history = await mem.messages("connector", chatId);
    const phone = (Array.isArray(ctx) ? ctx : [])
      .filter((x) => x && typeof x.text === "string" && x.text.trim() && x.id !== ref)
      .slice(-16);
    let missed = [];
    if (!turns.length && phone.length) {
      history = [];
      for (const x of phone) {
        const said = String(x.text).slice(0, 3000);
        if (x.who === "me") {
          if (["error", "offline", "stuck"].includes(x.state)) missed.push(said);
          else history.push({ role: "user", content: said });
        } else if (history.length && history[history.length - 1].role === "user") {
          history.push({ role: "assistant", content: said });
        }
      }
      // Вопрос без ответа в конце истории модели ни к чему — он ушёл в «не дошли».
      if (history.length && history[history.length - 1].role === "user") {
        missed.unshift(history.pop().content);
      }
    } else if (phone.length) {
      const known = new Set(turns.map((x) => x.ref).filter(Boolean));
      const since = turns.length ? turns[turns.length - 1].at : 0;
      missed = phone
        .filter((x) => x.who === "me" && !(x.id && known.has(x.id)) && (!x.at || x.at > since - 5000))
        .filter((x) => ["error", "offline", "stuck", "queued", "sending"].includes(x.state) || !x.id)
        .map((x) => String(x.text).slice(0, 3000));
    }
    return { history, missed: missed.slice(-5) };
  }

  /** Ход ассистента: текст, фотография, вопрос с перепиской. */
  async doTurn(m, kind, text, from, sealedIn) {
    const chatId = String(m.chat || "main");
    // Служебные чаты — название диалога и подобное — в память не идут.
    const keep = !/^sys/.test(chatId);
    let ctx = [];
    let rich = false;              // новое приложение: понимает метки под ответом
    if (kind === "ask") {
      rich = true;
      try {
        const j = JSON.parse(text);
        text = String(j.text || "").trim();
        ctx = Array.isArray(j.ctx) ? j.ctx : [];
      } catch { /* не конверт — значит просто текст */ }
      if (!text) return;
    }
    let userLine = text;
    let photoEntry = null;
    if (kind.startsWith("photo")) {
      const p = await this.fromPhoto(m, kind, text, from, sealedIn, chatId);
      if (!p) return;
      photoEntry = p.photoEntry || null;
      if (p.ctx) ctx = p.ctx;
      if (p.rich) rich = true;
      text = p.text;
      userLine = p.line || "📷";
    }

    const mem = this.plugin.memory;
    const agent = new Agent(this.plugin);
    try {
      // Фраза-сценарий работает здесь ровно так же, как сказанная вслух.
      const hit = matchScenario(text, this.plugin.settings.scenarios);
      let sent = hit ? scenarioPrompt(hit.scenario, hit.rest) : text;

      const { history, missed } = keep ? await this.contextFor(chatId, ctx, m.id) : { history: [], missed: [] };

      const recall = keep ? await mem.recallNote("connector", chatId) : "";
      sent = this.framing(text) + recall + (missed.length
        ? "[Earlier in this chat the user sent these messages, and they never reached you — "
          + "the computer was off or the connection dropped. They are part of the conversation; "
          + "if the new message refers to them (\"so?\", \"do it\", \"write it\"), carry them out now:\n"
          + missed.map((x) => "«" + x + "»").join("\n") + "]\n\n"
        : "") + sent;

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
         «готово» и без неё крутило бы «думаю» до самого таймаута. В память
         ход идёт с пометкой: то, что успело сделаться, сделано. */
      if (agent.cancelled) {
        if (keep) await mem.add("connector", chatId, { user: userLine, reply: "", did: agent.didList(), status: "cancelled", ref: m.id });
        await this.reply(m.id, t("Stopped."), from, sealedIn).catch(() => {});
        return;
      }
      if (keep) await mem.add("connector", chatId, { user: userLine, reply: reply || "", did: agent.didList(), status: "ok", ref: m.id });
      /* The photo was saved before the assistant chose where it goes. Undoing
         the note it went into takes the picture with it, as it does for the
         diary — otherwise the picture stays behind with nothing showing it. */
      if (photoEntry && this.plugin.journal) {
        for (const e of agent.changes || []) {
          if ((e.kind === "edit" || e.kind === "create") && e.id !== photoEntry.id) e.with = [photoEntry.id];
        }
        this.plugin.journal.saveSoon();
      }

      const all = agent.shownSources();
      const list = all.slice(0, 8);
      /* Новому приложению — ссылками: по ним открывается сама заметка. Старое
         показало бы скобки, ему по-прежнему просто названия. */
      const tail = list.length
        ? "\n\n" + t("From your notes:") + "\n" + list.map((x) => (rich
          ? "- [[" + String(x.path || x.title).replace(/\.md$/i, "") + "|" + (x.title || x.path) + "]]"
          : "- " + (x.title || x.path))).join("\n")
          // Месяц ежедневных заметок — это 30 источников; восемь без пометки
          // читались как «остальные дни он не смотрел».
          + (all.length > list.length ? "\n- " + t("…and {0} more", all.length - list.length) : "")
        : "";
      // Одним куском: телефон перестаёт слушать на метке «готово», и всё,
      // что послано после неё, до него уже может не дойти.
      const body = (reply && reply.trim()) || t("I have nothing to say to that.");
      /* Хвостом — подсказки «а дальше». Приложение вырежет эту строку и
         нарисует её кнопками; в историю и в заметки она не попадает,
         потому что приклеивается уже после них. */
      const next = await this.nextSteps(text, body, agent.sources);
      const chips = next.length ? "\n\n<!--next:" + JSON.stringify(next) + "-->" : "";
      /* Что поменялось — кнопками «открыть» и «отменить» под ответом. Только
         новому приложению: старое показало бы эту строку как текст. */
      const changed = rich ? this.changeMarks(agent) : "";
      await this.reply(m.id, body + tail + chips + changed, from, sealedIn);
    } catch (e) {
      const why = (e && e.message) || String(e);
      if (keep) await mem.add("connector", chatId, { user: userLine, reply: why, did: agent.didList(), status: "error", ref: m.id }).catch(() => {});
      await this.reply(m.id, t("Could not answer: {0}", why), from, sealedIn)
        .catch(() => {});
    }
  }

  /** Метка с правками этого хода для приложения. */
  changeMarks(agent) {
    const seen = new Set();
    const items = [];
    // A note made this turn is shown once, as made — not again as edited.
    const made = new Set((agent.changes || []).filter((e) => e.kind === "create").map((e) => e.path));
    for (const e of (agent.changes || []).slice().reverse()) {
      const k = e.kind + "|" + e.path;
      if (e.kind === "edit" && made.has(e.path)) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ id: e.id, kind: e.kind, path: e.path, title: e.title, label: changeLabel(e) });
    }
    return items.length ? "\n\n<!--changes:" + JSON.stringify(items.slice(0, 6)) + "-->" : "";
  }

  /**
   * Что ассистенту надо знать о положении человека: дата, куда класть, что
   * экрана компьютера он не видит. В историю это не попадает — каждый ход
   * получает свежее.
   */
  framing(text) {
    /* From the phone the assistant sees neither the open note nor a calendar,
       so "what's on today" used to be read as "what is there at all". The
       date goes in explicitly.
       Written in English like the rest of the instructions: a Russian frame
       around an English message made it answer an English speaker in
       Russian. The language rule in the system prompt does the rest. */
    const now = new Date();
    const two = (n) => String(n).padStart(2, "0");
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const months = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    const words = `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
    // The daily note is mentioned only when the question is about time.
    // Otherwise it opened today's note for any question at all and spent a
    // turn on it.
    const aboutTime = /сегодн|вчера|завтра|на день|за день|дневник|ежеднев|привычк|задач|план|недел|утро|вечер|дата|числ|today|yesterday|tomorrow|daily|diary|journal|habit|task|todo|plan|week|morning|evening|date/i
      .test(text);
    let dayHint = "";
    if (aboutTime) {
      // By its real name when it exists: naming differs from vault to vault
      // (DD-MM-YYYY, YYYY-MM-DD, …), and a guessed name sent it searching.
      const V = this.plugin.vault;
      const today = V && V.dailyNote ? V.dailyNote("today") : null;
      dayHint = today
        ? `Today's daily note is "${today.path}" — open it by that path, not the note that happens to be open in the editor. `
        : "For today's daily note use the daily_note tool with when: today, not the note that happens to be open in the editor. ";
    }
    // Where a new note goes comes from the vault's settings, not from code.
    // With nothing set, at least not into the root.
    const inbox = String(this.plugin.settings.newNoteFolder || "").trim();
    const inboxHint = inbox
      ? `New notes with no folder named go into "${inbox}", not the vault root. `
      : "New notes go into the folder that fits them, not the vault root. ";
    return `[Now: ${words}, ${two(now.getHours())}:${two(now.getMinutes())}. `
      + dayHint
      + inboxHint
      + "The person is writing from a phone and cannot see the computer screen: never answer "
      + "\"I opened it, have a look\" — read it and retell it, briefly. "
      /* A real case: after a list of tasks, "remove the duplicates" made it
         rewrite four daily notes. The person meant the list on screen. */
      + "A short follow-up like \"remove the duplicates\", \"shorter\", \"say it differently\", "
      + "\"redo it\" is about your previous reply, not about the notes: rewrite the reply and leave "
      + "the files alone. Change notes only when told to directly, or when this continues a note "
      + "being written (see the conversation above). If it could mean either, do the useful one "
      + "and name the other in one line. Reply in the language of the message below.]\n\n";
  }
}
