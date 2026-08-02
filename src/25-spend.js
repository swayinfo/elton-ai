/* ============================================================
 *  What an answer cost
 *
 *  Every request to a model is money, and until now the only way
 *  to find out how much was to go and look at a balance page. So
 *  the assistant says it: tokens always, money where the provider
 *  makes it knowable.
 *
 *  Two ways of knowing, and the difference matters.
 *
 *  With your own key — OpenRouter or OpenAI — the response carries
 *  usage.cost and it is your money, so it is shown as it comes.
 *
 *  Through Elton AI the number that matters is not what the model
 *  charged upstream but what actually left your balance. So that
 *  is what is measured: the balance before against the balance
 *  after. It is the honest number for the person paying, and the
 *  pricing behind it stays where it belongs — on the server.
 * ========================================================== */

/** A turn's worth of tokens and, where known, money. */
class SpendTracker {
  constructor(plugin) {
    this.plugin = plugin;
    this.reset();
    // Balance in the account's own currency, as of the last look.
    this.balance = null;
    this.balanceAt = 0;
    // Totals for the session, so the panel can answer "how much today".
    this.session = { tokensIn: 0, tokensOut: 0, cost: 0, charged: 0, turns: 0 };
  }

  reset() {
    this.turn = { tokensIn: 0, tokensOut: 0, cost: 0, calls: 0, charged: null };
  }

  /** One call's usage block, folded into the turn. */
  add(usage) {
    if (!usage) return;
    const t = this.turn;
    t.calls++;
    t.tokensIn += Number(usage.prompt_tokens) || 0;
    t.tokensOut += Number(usage.completion_tokens) || 0;
    t.cost += Number(usage.cost) || 0;
  }

  /** Does this provider let us see money at all? */
  get knowsMoney() {
    const id = this.plugin.settings.provider;
    return id === "obsimind" || id === "openrouter";
  }

  /** Elton AI reports in the balance's own currency, not in dollars. */
  get viaBalance() {
    return this.plugin.settings.provider === "obsimind";
  }

  /** Read the balance, or null when this provider has none to read. */
  async readBalance() {
    if (!this.viaBalance) return null;
    try {
      const res = await this.plugin.ai.get("/v1/balance");
      const v = res && res.json && Number(res.json.balance);
      if (!Number.isFinite(v)) return null;
      this.balance = v;
      this.balanceAt = Date.now();
      return v;
    } catch {
      return null;
    }
  }

  /** Before a turn: note where the balance stood, so the drop can be measured. */
  async openTurn() {
    this.reset();
    this._before = this.viaBalance ? await this.readBalance() : null;
  }

  /**
   * After a turn: work out what it cost.
   *
   * A balance that went UP means a top-up landed mid-answer, and the
   * difference is then meaningless — better to show nothing than a number
   * that is wrong in the flattering direction.
   */
  async closeTurn() {
    const t = this.turn;
    if (this.viaBalance) {
      const after = await this.readBalance();
      if (this._before != null && after != null && after <= this._before) {
        t.charged = this._before - after;
      }
    }
    const s = this.session;
    s.turns++;
    s.tokensIn += t.tokensIn;
    s.tokensOut += t.tokensOut;
    s.cost += t.cost;
    if (t.charged) s.charged += t.charged;
    return t;
  }

  /**
   * The line under an answer. Short on purpose — this is a footnote, not a
   * report, and an invoice under every reply is its own kind of noise.
   */
  line(turn = this.turn) {
    if (!turn || !turn.calls) return "";
    const parts = [];
    if (this.viaBalance) {
      if (turn.charged != null) parts.push("−" + formatMoney(turn.charged, "₽"));
      if (this.balance != null) parts.push(t("{0} left", formatMoney(this.balance, "₽")));
    } else if (this.knowsMoney && turn.cost > 0) {
      parts.push("$" + formatMoney(turn.cost, ""));
    }
    parts.push(t("{0} tokens", turn.tokensIn + turn.tokensOut));
    if (turn.calls > 1) parts.push(t("{0} steps", turn.calls));
    return parts.join(" · ");
  }

  sessionLine() {
    const s = this.session;
    if (!s.turns) return t("Nothing spent yet this session.");
    const parts = [t("{0} answers", s.turns), t("{0} tokens", s.tokensIn + s.tokensOut)];
    if (this.viaBalance && s.charged) parts.push(formatMoney(s.charged, "₽"));
    else if (this.knowsMoney && s.cost) parts.push("$" + formatMoney(s.cost, ""));
    return parts.join(" · ");
  }
}

/**
 * Money, at a length a person can read.
 *
 * Sums here span five orders of magnitude — a one-word reply costs less than a
 * hundredth of a rouble, a long research turn costs several — and a fixed
 * number of decimals is wrong at one end or the other. So the precision
 * follows the size: never "0.00" for something that did cost, never
 * "12.340000" for something that plainly cost twelve.
 */
function formatMoney(value, suffix) {
  const n = Math.abs(Number(value) || 0);
  let s;
  if (n === 0) s = "0";
  else if (n < 0.01) s = n.toFixed(4);
  else if (n < 1) s = n.toFixed(3);
  else if (n < 100) s = n.toFixed(2);
  else s = n.toFixed(0);
  // Trailing zeros past the decimal point carry no information.
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return suffix ? s + " " + suffix : s;
}
