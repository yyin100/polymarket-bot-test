/**
 * pnl.js
 * Session-level PnL tracker.
 *
 * Records every BUY, MERGE, and REDEEM event across all markets and
 * provides running P&L stats including rolling 1-hour loss check
 * (used by the circuit breaker in index.js).
 */
import logger from './logger.js';

export class PnlTracker {
  constructor() {
    // Per-market accumulators: { slug → { spent, merged, redeemed, buys } }
    this._markets = new Map();

    // Session-level totals
    this.sessionSpent    = 0;
    this.sessionMerged   = 0;
    this.sessionRedeemed = 0;

    // Rolling hourly loss tracking: array of { ts, amount } realized losses
    this._hourlyEvents = [];

    // Totals per-hour for circuit breaker
    this._lastHourlyReport = Date.now();
  }

  // ── Record events ───────────────────────────────────────────────────────────
  recordBuy(slug, outcome, price, shares) {
    const m = this._get(slug);
    const usdc = price * shares;
    m.spent += usdc;
    m.buys.push({ ts: Date.now(), outcome, price, shares, usdc });
    this.sessionSpent += usdc;
  }

  recordMerge(slug, usdc) {
    const m = this._get(slug);
    m.merged += usdc;
    this.sessionMerged += usdc;
  }

  recordRedeem(slug, usdc, txHash) {
    const m = this._get(slug);
    m.redeemed += usdc;
    m.redeemTx = txHash;
    this.sessionRedeemed += usdc;
    this._logMarketSummary(slug);
  }

  // ── Queries ─────────────────────────────────────────────────────────────────
  marketPnl(slug) {
    const m = this._markets.get(slug);
    if (!m) return 0;
    return (m.merged + m.redeemed) - m.spent;
  }

  /** Session-level realized PnL (excludes unrealized open positions). */
  get sessionPnl() {
    return (this.sessionMerged + this.sessionRedeemed) - this.sessionSpent;
  }

  /**
   * Returns the total realized loss over the last 60 minutes.
   * Losses are recorded as negative PnL events when a market is fully settled.
   */
  rollingHourlyLoss() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    this._hourlyEvents = this._hourlyEvents.filter(e => e.ts >= cutoff);
    return this._hourlyEvents.filter(e => e.pnl < 0).reduce((s, e) => s - e.pnl, 0);
  }

  printSessionSummary() {
    const n = this._markets.size;
    logger.info('═══ PnL SESSION SUMMARY ═══', {
      markets:        n,
      sessionSpent:   this.sessionSpent.toFixed(2),
      sessionMerged:  this.sessionMerged.toFixed(2),
      sessionRedeemed: this.sessionRedeemed.toFixed(2),
      sessionPnl:     this.sessionPnl.toFixed(2),
    });
    for (const [slug, m] of this._markets) {
      const pnl = (m.merged + m.redeemed) - m.spent;
      logger.info(`  ${slug}`, {
        spent:    m.spent.toFixed(2),
        merged:   m.merged.toFixed(2),
        redeemed: m.redeemed.toFixed(2),
        pnl:      pnl.toFixed(2),
      });
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────────
  _get(slug) {
    if (!this._markets.has(slug)) {
      this._markets.set(slug, { spent: 0, merged: 0, redeemed: 0, buys: [], redeemTx: null });
    }
    return this._markets.get(slug);
  }

  _logMarketSummary(slug) {
    const m   = this._markets.get(slug);
    const pnl = (m.merged + m.redeemed) - m.spent;
    this._hourlyEvents.push({ ts: Date.now(), pnl });
    logger.info('Market settled', {
      slug,
      spent:    m.spent.toFixed(2),
      merged:   m.merged.toFixed(2),
      redeemed: m.redeemed.toFixed(2),
      pnl:      pnl.toFixed(2),
      sessionPnl: this.sessionPnl.toFixed(2),
    });
  }
}
