/**
 * copy/copyTrader.js
 * Execution engine for the BUY-only copy trader.
 *
 * On every ActivityFeed 'trade' event:
 *   1. Filter (price band, slippage, staleness, spend caps, allow/block lists).
 *   2. Compute our size (MIRROR / FIXED / RATIO), capped by every configured limit.
 *   3. Fire a FOK BUY via ClobClient.postIOCBuy at maxPrice = target.price + slippage.
 *   4. Record spend and emit a 'copy' event for observability.
 *
 * No REST/WS calls happen in the hot path beyond the single order POST.
 */
import { EventEmitter } from 'events';
import { ClobClient } from '../clob.js';
import logger from '../logger.js';
import {
  COPY_SIZE_MODE,
  COPY_FIXED_USDC,
  COPY_RATIO,
  COPY_MAX_USDC_PER_TRADE,
  COPY_MAX_USDC_PER_MARKET,
  COPY_MAX_USDC_PER_HOUR,
  COPY_MAX_USDC_TOTAL,
  COPY_MAX_SLIPPAGE,
  COPY_MAX_PRICE,
  COPY_MIN_PRICE,
  COPY_STALE_MS,
  COPY_DRY_RUN,
  COPY_ALLOWED_CONDITIONS,
  COPY_BLOCKED_CONDITIONS,
} from './config.js';

const HOUR_MS = 60 * 60 * 1000;

export class CopyTrader extends EventEmitter {
  /**
   * @param {ethers.Wallet} wallet
   */
  constructor(wallet) {
    super();
    this.wallet       = wallet;

    // Spend tracking (USDC, human units).
    this.totalSpent   = 0;
    this.spentByMarket = new Map();  // conditionId → usdc
    this.hourlySpends  = [];         // [{ ts, usdc }, …] pruned on query

    // Stats
    this.copyCount    = 0;
    this.skipCount    = 0;
    this.failCount    = 0;
  }

  /** Handle a normalized trade event from ActivityFeed. */
  async onTrade(ev) {
    // ── Pre-flight filters (O(1), no I/O) ──────────────────────────────────
    const reason = this._rejectReason(ev);
    if (reason) {
      this.skipCount++;
      logger.debug('copy.CopyTrader: skipping trade', { reason, ev: this._evSummary(ev) });
      return;
    }

    // ── Compute our size ──────────────────────────────────────────────────
    const ourUsdc = this._ourUsdc(ev);
    if (!ourUsdc || ourUsdc < 1) {
      this.skipCount++;
      logger.debug('copy.CopyTrader: computed size too small', { ourUsdc, ev: this._evSummary(ev) });
      return;
    }

    // ── Max price we'll pay (target's fill + slippage, capped at COPY_MAX_PRICE) ──
    const maxPrice = Math.min(
      COPY_MAX_PRICE,
      Number((ev.price + COPY_MAX_SLIPPAGE).toFixed(4)),
    );
    // Size in shares at maxPrice (guarantees we never exceed ourUsdc in USDC).
    const shares = Math.max(1, Math.floor(ourUsdc / maxPrice));

    const fireAt = Date.now();
    const latencyMs = fireAt - ev.timestamp * 1000;

    logger.info('copy.CopyTrader: copying BUY', {
      target:     ev.target,
      tokenId:    ev.tokenId,
      conditionId: ev.conditionId,
      slug:       ev.slug,
      targetPx:   ev.price,
      targetSize: ev.size,
      ourUsdc:    ourUsdc.toFixed(2),
      maxPrice,
      shares,
      latencyMs,
      txHash:     ev.txHash,
    });

    if (COPY_DRY_RUN) {
      this.copyCount++;
      this.emit('copy', { ev, ourUsdc, shares, maxPrice, dryRun: true });
      return;
    }

    // ── Fire the order ─────────────────────────────────────────────────────
    try {
      const res = await ClobClient.postIOCBuy(this.wallet, ev.tokenId, maxPrice, shares);
      const elapsedMs = Date.now() - fireAt;

      // Assume we filled the full shares at maxPrice for accounting (conservative).
      // If Polymarket returns a `makingAmount` / `takingAmount` we can refine,
      // but for spend-caps overshooting never hurts.
      const assumedSpent = shares * maxPrice;
      this._recordSpend(ev.conditionId, assumedSpent);
      this.copyCount++;

      logger.info('copy.CopyTrader: order sent', {
        slug:       ev.slug,
        tokenId:    ev.tokenId,
        shares,
        maxPrice,
        assumedSpent: assumedSpent.toFixed(2),
        orderLatencyMs: elapsedMs,
        signalLatencyMs: fireAt - ev.timestamp * 1000,
        res,
      });
      this.emit('copy', { ev, ourUsdc, shares, maxPrice, res });
    } catch (err) {
      this.failCount++;
      logger.warn('copy.CopyTrader: order failed', {
        tokenId: ev.tokenId,
        maxPrice,
        shares,
        err: err.message,
      });
      this.emit('copy-failed', { ev, err });
    }
  }

  // ── Filters ─────────────────────────────────────────────────────────────

  _rejectReason(ev) {
    if (ev.side !== 'BUY')                          return 'not-a-buy';
    if (ev.ageMs > COPY_STALE_MS)                   return `stale(${ev.ageMs}ms)`;
    if (ev.price < COPY_MIN_PRICE)                  return `price-too-low(${ev.price})`;
    if (ev.price > COPY_MAX_PRICE)                  return `price-too-high(${ev.price})`;

    const cid = (ev.conditionId || '').toLowerCase();
    if (COPY_BLOCKED_CONDITIONS.has(cid))           return 'blocked-condition';
    if (COPY_ALLOWED_CONDITIONS.size > 0 && !COPY_ALLOWED_CONDITIONS.has(cid)) {
      return 'not-in-allow-list';
    }

    if (this.totalSpent >= COPY_MAX_USDC_TOTAL)     return 'total-cap';
    if ((this.spentByMarket.get(cid) ?? 0) >= COPY_MAX_USDC_PER_MARKET) {
      return 'per-market-cap';
    }
    if (this._rollingHourSpent() >= COPY_MAX_USDC_PER_HOUR) return 'hourly-cap';

    return null;
  }

  _ourUsdc(ev) {
    let raw;
    switch (COPY_SIZE_MODE) {
      case 'MIRROR': raw = ev.usdc;                 break;
      case 'RATIO':  raw = ev.usdc * COPY_RATIO;    break;
      case 'FIXED':
      default:       raw = COPY_FIXED_USDC;         break;
    }

    // Apply every cap.
    const perTradeCap = COPY_MAX_USDC_PER_TRADE;
    const remainingPerMarket =
      COPY_MAX_USDC_PER_MARKET - (this.spentByMarket.get(ev.conditionId) ?? 0);
    const remainingHourly   = COPY_MAX_USDC_PER_HOUR - this._rollingHourSpent();
    const remainingTotal    = COPY_MAX_USDC_TOTAL    - this.totalSpent;

    return Math.max(0, Math.min(
      raw,
      perTradeCap,
      remainingPerMarket,
      remainingHourly,
      remainingTotal,
    ));
  }

  // ── Spend tracking ──────────────────────────────────────────────────────

  _recordSpend(conditionId, usdc) {
    const cid = (conditionId || '').toLowerCase();
    this.totalSpent += usdc;
    this.spentByMarket.set(cid, (this.spentByMarket.get(cid) ?? 0) + usdc);
    this.hourlySpends.push({ ts: Date.now(), usdc });
  }

  _rollingHourSpent() {
    const cutoff = Date.now() - HOUR_MS;
    // Prune while-we-look-up (keeps array bounded).
    while (this.hourlySpends.length && this.hourlySpends[0].ts < cutoff) {
      this.hourlySpends.shift();
    }
    return this.hourlySpends.reduce((a, b) => a + b.usdc, 0);
  }

  // ── Stats / helpers ─────────────────────────────────────────────────────

  stats() {
    return {
      copies:   this.copyCount,
      skips:    this.skipCount,
      failures: this.failCount,
      totalSpent:      this.totalSpent.toFixed(2),
      rollingHourUsdc: this._rollingHourSpent().toFixed(2),
      markets:         this.spentByMarket.size,
    };
  }

  _evSummary(ev) {
    return {
      target:     ev.target,
      tokenId:    ev.tokenId,
      slug:       ev.slug,
      price:      ev.price,
      size:       ev.size,
      usdc:       ev.usdc?.toFixed?.(2),
      ageMs:      ev.ageMs,
    };
  }
}
