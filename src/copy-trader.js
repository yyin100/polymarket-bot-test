/**
 * copy-trader.js
 * Watches a target wallet for new buys and mirrors them in real-time.
 *
 * Strategy:
 *  On every poll we compare each position's `totalBought` (cumulative USDC
 *  spent, monotonically increasing) against the last recorded value.
 *
 *  • New asset  → copy the full totalBought amount (scaled by COPY_TRADE_BUY_PERCENT).
 *  • Existing asset, totalBought increased → copy the INCREMENT (they bought more).
 *  • Existing asset, totalBought unchanged → no action.
 *
 * This correctly handles:
 *  - Target wallet adding to an existing position (most common case).
 *  - Brand-new positions in markets never held before.
 *  - The startup snapshot: existing positions are recorded so we copy only
 *    FUTURE buys, not the entire pre-existing portfolio.
 *
 * Real-time loop:
 *  • First poll fires IMMEDIATELY on start().
 *  • If any copy was triggered → re-poll immediately (catch burst buys).
 *  • Otherwise → sleep COPY_TRADE_POLL_MS before next poll.
 */
import {
  COPY_TRADE_BUY_PERCENT,
  COPY_TRADE_POLL_MS,
  TARGET_WALLET,
} from './config.js';
import { fetchTargetWalletPositions } from './market.js';
import { ClobClient } from './clob.js';
import { getUsdcBalance } from './onchain.js';
import logger from './logger.js';

export class CopyTrader {
  /**
   * @param {ethers.Wallet} wallet  Signer used to post copy orders
   */
  constructor(wallet) {
    this.wallet = wallet;
    // Map<asset, { totalBought: number, meta: object }>
    // Records the last known totalBought for every asset we've seen.
    this._positions = new Map();
    this._stopped   = false;
  }

  /**
   * Snapshot the target wallet's current positions.
   * Records every asset's current totalBought so we only copy FUTURE buys.
   * Call once before start().
   */
  async snapshot() {
    const positions = await fetchTargetWalletPositions();
    for (const p of positions) {
      if (p.asset) {
        this._positions.set(p.asset, { totalBought: p.totalBought, meta: p });
      }
    }
    logger.info('CopyTrader: startup snapshot complete — only future buys will be copied', {
      targetWallet:  TARGET_WALLET,
      snapshotCount: this._positions.size,
    });
  }

  /** Start the real-time background poll loop (non-blocking). */
  start() {
    logger.info('CopyTrader: real-time polling started', {
      targetWallet: TARGET_WALLET,
      idlePollMs:   COPY_TRADE_POLL_MS,
    });
    this._loop().catch((err) =>
      logger.error('CopyTrader: loop crashed unexpectedly', { err: err.message }),
    );
  }

  /** Gracefully stop the polling loop. */
  stop() {
    this._stopped = true;
    logger.info('CopyTrader: polling stopped');
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  async _loop() {
    while (!this._stopped) {
      let triggered = 0;
      try {
        triggered = await this._poll();
      } catch (err) {
        logger.warn('CopyTrader: poll error, retrying after idle interval', { err: err.message });
      }

      if (this._stopped) break;

      if (triggered > 0) {
        // Burst guard: re-poll immediately in case the target opened several
        // positions in rapid succession.
        logger.debug('CopyTrader: buy(s) triggered, re-polling immediately');
      } else {
        await new Promise(r => setTimeout(r, COPY_TRADE_POLL_MS));
      }
    }
  }

  /**
   * Fetch target positions, detect any totalBought increases, and copy them.
   * @returns {number} number of copy buys triggered this poll
   */
  async _poll() {
    const positions = await fetchTargetWalletPositions();
    let triggered = 0;

    for (const position of positions) {
      if (!position.asset) continue;

      const prev = this._positions.get(position.asset);

      if (!prev) {
        // Brand-new asset — copy the full amount they've put in so far.
        this._positions.set(position.asset, { totalBought: position.totalBought, meta: position });
        logger.info('CopyTrader: new position detected on target wallet', {
          slug: position.slug, outcome: position.outcome,
          targetTotalBought: position.totalBought,
        });
        const copied = await this._copyBuy(position, position.totalBought);
        if (copied) triggered++;

      } else if (position.totalBought > prev.totalBought + 0.005) {
        // Target wallet bought MORE of this position.
        const delta = position.totalBought - prev.totalBought;
        this._positions.set(position.asset, { totalBought: position.totalBought, meta: position });
        logger.info('CopyTrader: existing position increased — target bought more', {
          slug: position.slug, outcome: position.outcome,
          prevTotalBought:    prev.totalBought,
          newTotalBought:     position.totalBought,
          delta:              delta.toFixed(4),
        });
        const copied = await this._copyBuy(position, delta);
        if (copied) triggered++;

      } else {
        // No change — update meta silently.
        this._positions.set(position.asset, { totalBought: position.totalBought, meta: position });
      }
    }

    return triggered;
  }

  /**
   * Execute a copy buy for `buyUsdc` (pre-scaling) from the target.
   * Applies COPY_TRADE_BUY_PERCENT and all validation checks.
   * @param {object} position  Full position object from the Data API
   * @param {number} buyUsdc   Raw USDC amount from the target (will be scaled)
   * @returns {boolean} true if an order was submitted
   */
  async _copyBuy(position, buyUsdc) {
    const { asset, outcome, slug, conditionId, negativeRisk } = position;

    // ── Fetch live best ask + tick size before computing amounts ─────────────
    let bestAsk;
    try {
      bestAsk = await ClobClient.getBestAsk(asset);
    } catch (err) {
      logger.warn('CopyTrader: skipping — could not fetch order book', { slug, outcome, err: err.message });
      return false;
    }

    if (!bestAsk || !bestAsk.price) {
      logger.warn('CopyTrader: skipping — no liquidity on ask side', { slug, outcome, asset });
      return false;
    }

    const { tickSize, minOrderSize } = bestAsk;

    // ── Scale our buy amount ─────────────────────────────────────────────────
    // Follow the target wallet proportionally even for very small trades.
    // The only hard stop here is when the scaled amount would round down to
    // 0.00 USDC for the market-order payload.
    let ourBuyUsdc = buyUsdc * (COPY_TRADE_BUY_PERCENT / 100);
    const roundedScaledUsdc = Math.floor(ourBuyUsdc * 100) / 100;
    const minMarketBuyUsdc = 1;
    if (roundedScaledUsdc < minMarketBuyUsdc) {
      logger.info('CopyTrader: skipping — scaled buy below market BUY minimum', {
        slug,
        outcome,
        targetBuyUsdc: buyUsdc.toFixed(4),
        scaledUsdc:    ourBuyUsdc.toFixed(4),
        roundedScaledUsdc: roundedScaledUsdc.toFixed(2),
        minOrderSize,
        minMarketBuyUsdc: minMarketBuyUsdc.toFixed(2),
        pct:           `${COPY_TRADE_BUY_PERCENT}%`,
        explanation:   `${buyUsdc.toFixed(4)} * ${COPY_TRADE_BUY_PERCENT}% = ${ourBuyUsdc.toFixed(4)} -> ${roundedScaledUsdc.toFixed(2)}`,
      });
      return false;
    }

    const availableUsdc = await getUsdcBalance();
    if (availableUsdc <= 0) {
      logger.info('CopyTrader: skipping — wallet has no available USDC', {
        slug,
        outcome,
        availableUsdc: availableUsdc.toFixed(4),
      });
      return false;
    }

    if (ourBuyUsdc > availableUsdc) {
      ourBuyUsdc = Math.floor(availableUsdc * 100) / 100;
    } else {
      ourBuyUsdc = roundedScaledUsdc;
    }
    if (ourBuyUsdc <= 0) {
      logger.info('CopyTrader: skipping — available balance rounds to zero', {
        slug,
        outcome,
        availableUsdc: availableUsdc.toFixed(4),
        requestedUsdc: ourBuyUsdc.toFixed(2),
      });
      return false;
    }

    // Snap price to market tick size (CLOB rejects INVALID_ORDER_MIN_TICK_SIZE otherwise).
    const decimals = Math.round(-Math.log10(tickSize));
    const factor   = 10 ** decimals;
    const price    = Math.round(bestAsk.price * factor) / factor;

    const shares = ourBuyUsdc / price;

    logger.info('CopyTrader: submitting copy buy NOW', {
      slug,
      outcome,
      asset,
      conditionId,
      negativeRisk,
      targetBuyUsdc: buyUsdc.toFixed(4),
      ourBuyUsdc:    ourBuyUsdc.toFixed(4),
      price:         price.toFixed(decimals),
      tickSize,
      shares:        shares.toFixed(4),
      pct:           `${COPY_TRADE_BUY_PERCENT}%`,
    });

    try {
      await ClobClient.postIOCBuy(this.wallet, asset, price, ourBuyUsdc, negativeRisk);
      logger.info('CopyTrader: copy buy submitted ✓', { slug, outcome, asset });
      return true;
    } catch (err) {
      logger.error('CopyTrader: copy buy failed', { slug, outcome, asset, err: err.message });
      return false;
    }
  }
}
