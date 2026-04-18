/**
 * trader.js
 * Per-market state machine implementing the 9 trading rules
 * reverse-engineered from wallet 0xcfb103c37c0234f524c632d964ed31f117b5f694.
 *
 * Rules recap:
 *  RULE 0 – universe filter (checked before constructing Trader)
 *  RULE 1 – enter within 10s of window open; stop 15s before close
 *  RULE 2 – post dual-sided limit ladder on both Up and Down at window open
 *  RULE 3 – take aggressively when combined ask < (1 - TARGET_EDGE)
 *  RULE 4 – merge matched pairs within ~10s of holding them
 *  RULE 5 – NEVER post a sell order
 *  RULE 6 – cancel all orders at t=300 (window close)
 *  RULE 7 – redeem winning tokens at t≈600 (oracle resolution)
 *  RULE 8 – three circuit breakers
 *  RULE 9 – per-market capital cap
 */
import {
  LADDER_LEVELS,
  LADDER_SIZE_PER_LEVEL,
  TARGET_EDGE,
  MERGE_THRESHOLD_USDC,
  MAX_TAKER_FILL_USDC,
  MAX_SPEND_PER_MARKET,
  MAX_INVENTORY_IMBALANCE,
  COMBINED_ASK_STOP,
  MARKET_WINDOW_SECONDS,
  STOP_BUYING_BEFORE_CLOSE,
  REDEEM_DELAY_AFTER_CLOSE,
  BOOK_POLL_MS,
} from './config.js';
import { ClobClient, BookFeed } from './clob.js';
import { mergePositions, redeemPositions, getTokenBalances, sleep } from './onchain.js';
import { waitForResolution, msUntil } from './market.js';
import { marketLogger } from './logger.js';

// ── State machine phases ──────────────────────────────────────────────────────
const PHASE = {
  INIT:       'INIT',       // pre-open
  LIVE:       'LIVE',       // window open, actively trading
  CLOSING:    'CLOSING',    // last 15s, no more buys
  CANCELLED:  'CANCELLED',  // orders cancelled, waiting for resolution
  RESOLVING:  'RESOLVING',  // waiting for oracle
  DONE:       'DONE',       // redeemed, market complete
  HALTED:     'HALTED',     // circuit breaker fired
};

export class Trader {
  /**
   * @param {object} market      - from market.fetchMarket()
   * @param {ethers.Wallet} wallet
   * @param {PnlTracker} pnl
   */
  constructor(market, wallet, pnl) {
    this.market   = market;
    this.wallet   = wallet;
    this.pnl      = pnl;
    this.log      = marketLogger(market.slug);

    // Inventory tracking (in shares, human units)
    this.balanceUp   = 0;
    this.balanceDown = 0;

    // Spend tracking (USDC)
    this.totalSpent  = 0;
    this.mergedUsdc  = 0;
    this.redeemedUsdc = 0;

    // Open order tracking { orderId → { tokenId, price, shares } }
    this.openOrders  = new Map();

    // Phase
    this.phase = PHASE.INIT;

    // Circuit breaker flag
    this.halted = false;

    // WebSocket book feed for real-time prices
    this._feed = null;

    // Current best asks (updated by WS feed)
    this._bestAskUp   = null;
    this._bestAskDown = null;

    // Pending merge flag to avoid concurrent merge calls
    this._merging = false;
  }

  // ── Main entry point ────────────────────────────────────────────────────────
  /**
   * Run the full lifecycle of this market:
   *   INIT → LIVE (post ladder, arb loop) → CLOSING → CANCELLED → RESOLVING → DONE
   *
   * Resolves when the market is fully settled (redeem called or timed out).
   */
  async run() {
    const { windowTs, conditionId, upToken, downToken } = this.market;
    const windowClose = windowTs + MARKET_WINDOW_SECONDS;

    this.log.info('Trader: starting', {
      conditionId,
      upTokenId:   upToken.tokenId,
      downTokenId: downToken.tokenId,
      windowOpen:  new Date(windowTs * 1000).toISOString(),
      windowClose: new Date(windowClose * 1000).toISOString(),
    });

    // ── RULE 1: Wait until window open (+ small entry delay) ──────────────────
    const waitMs = msUntil(windowTs) + 1000; // +1s buffer for market creation lag
    if (waitMs > 0) {
      this.log.debug('Trader: waiting for window open', { waitMs: Math.round(waitMs) });
      await sleep(waitMs);
    }

    this.phase = PHASE.LIVE;

    // ── Start WebSocket book feed ──────────────────────────────────────────────
    this._startFeed([upToken.tokenId, downToken.tokenId]);

    // ── RULE 2: Post dual-sided limit ladder ───────────────────────────────────
    await this._postLadder(upToken.tokenId, downToken.tokenId);

    // ── RULE 1 / 3 / 4 / 8: Main arb + merge loop (runs until window close) ──
    await this._arbLoop(windowClose, conditionId, upToken.tokenId, downToken.tokenId);

    // ── RULE 6: Cancel all remaining open orders at window close ──────────────
    this.phase = PHASE.CANCELLED;
    await this._cancelAllOrders(conditionId);
    this._feed?.stop();

    // ── Final merge of any remaining matched pairs ────────────────────────────
    await this._tryMerge(conditionId, { force: true });

    // ── RULE 7: Wait for oracle resolution and redeem ─────────────────────────
    this.phase = PHASE.RESOLVING;
    await this._redeemPhase(conditionId, windowClose);

    this.phase = PHASE.DONE;
    this.log.info('Trader: market complete', {
      totalSpent:    this.totalSpent.toFixed(4),
      mergedUsdc:    this.mergedUsdc.toFixed(4),
      redeemedUsdc:  this.redeemedUsdc.toFixed(4),
      netPnl:        (this.mergedUsdc + this.redeemedUsdc - this.totalSpent).toFixed(4),
    });
  }

  // ── RULE 2: Post ladder ─────────────────────────────────────────────────────
  async _postLadder(upTokenId, downTokenId) {
    this.log.info('Trader: posting ladder', { levels: LADDER_LEVELS.length });
    const posts = [];
    for (const price of LADDER_LEVELS) {
      const shares = LADDER_SIZE_PER_LEVEL / price;
      posts.push(this._safeLimitBuy(upTokenId,   price, shares));
      posts.push(this._safeLimitBuy(downTokenId, price, shares));
    }
    // Fire all limit orders concurrently (REST calls are independent)
    await Promise.allSettled(posts);
    this.log.info('Trader: ladder posted');
  }

  // ── RULE 1/3/4/8: Arb + merge main loop ────────────────────────────────────
  async _arbLoop(windowClose, conditionId, upTokenId, downTokenId) {
    while (true) {
      const now = Math.floor(Date.now() / 1000);

      // RULE 1: Stop buying in the last STOP_BUYING_BEFORE_CLOSE seconds
      if (now >= windowClose - STOP_BUYING_BEFORE_CLOSE) {
        this.log.info('Trader: approaching window close, stopping buys');
        break;
      }

      // RULE 8: check circuit breakers
      if (this._checkCircuitBreakers()) break;

      // RULE 3: Check for arb opportunity
      await this._tryArb(upTokenId, downTokenId);

      // RULE 4: Merge if we have enough matched pairs
      await this._tryMerge(conditionId);

      // Sync on-chain balances periodically (every ~30s)
      if (now % 30 === 0) {
        await this._syncBalances(upTokenId, downTokenId);
      }

      await sleep(BOOK_POLL_MS);
    }
  }

  // ── RULE 3: Taker arb ───────────────────────────────────────────────────────
  async _tryArb(upTokenId, downTokenId) {
    const upAsk   = this._bestAskUp;
    const downAsk = this._bestAskDown;

    if (!upAsk || !downAsk) return; // no book data yet

    const combined = upAsk.price + downAsk.price;

    // RULE 8: combined-ask circuit breaker
    if (combined > COMBINED_ASK_STOP) {
      this.log.warn('Trader: RULE-8 combined ask stop triggered', { combined });
      this.halted = true;
      return;
    }

    // RULE 3: fire if combined ask < (1 - TARGET_EDGE)
    if (combined >= 1 - TARGET_EDGE) return;

    // How many shares can we afford?
    const remainingBudget = MAX_SPEND_PER_MARKET - this.totalSpent;
    if (remainingBudget < 1) return; // RULE 9: cap exceeded

    const maxShares = Math.min(
      upAsk.size,
      downAsk.size,
      MAX_TAKER_FILL_USDC / combined,
      remainingBudget    / combined,
    );

    if (maxShares < 1) return; // too small to be worth gas

    this.log.info('Trader: RULE-3 arb triggered', {
      upPrice:  upAsk.price,
      downPrice: downAsk.price,
      combined:  combined.toFixed(4),
      edge:      (1 - combined).toFixed(4),
      shares:    maxShares.toFixed(2),
    });

    // Fire both IOC legs as close to simultaneously as possible
    const [upRes, downRes] = await Promise.allSettled([
      ClobClient.postIOCBuy(this.wallet, upTokenId,   upAsk.price,   maxShares),
      ClobClient.postIOCBuy(this.wallet, downTokenId, downAsk.price, maxShares),
    ]);

    // Estimate fills (actual fills come through FillFeed; this is a conservative estimate)
    if (upRes.status === 'fulfilled' && downRes.status === 'fulfilled') {
      const spentUp   = maxShares * upAsk.price;
      const spentDown = maxShares * downAsk.price;
      this.totalSpent  += spentUp + spentDown;
      this.balanceUp   += maxShares;
      this.balanceDown += maxShares;
      this.pnl.recordBuy(this.market.slug, 'Up',   upAsk.price,   maxShares);
      this.pnl.recordBuy(this.market.slug, 'Down', downAsk.price, maxShares);
    } else {
      // Leg-2 failed: directional risk created. Log and sync balances.
      this.log.warn('Trader: arb leg partially failed', {
        upStatus:   upRes.status,
        downStatus: downRes.status,
      });
      await this._syncBalances(upTokenId, downTokenId);
    }
  }

  // ── RULE 4: Merge matched pairs ─────────────────────────────────────────────
  async _tryMerge(conditionId, { force = false } = {}) {
    if (this._merging) return;
    const pairs = Math.min(this.balanceUp, this.balanceDown);
    if (pairs < MERGE_THRESHOLD_USDC && !force) return;
    if (pairs < 0.001) return;

    this._merging = true;
    try {
      this.log.info('Trader: RULE-4 merging pairs', { pairs: pairs.toFixed(4) });
      const txHash = await mergePositions(conditionId, pairs);

      // After merge, both balances decrease by `pairs`
      this.balanceUp   -= pairs;
      this.balanceDown -= pairs;
      this.mergedUsdc  += pairs;
      this.pnl.recordMerge(this.market.slug, pairs);

      this.log.info('Trader: merge done', {
        pairs:      pairs.toFixed(4),
        mergedTotal: this.mergedUsdc.toFixed(4),
        tx:         txHash,
      });
    } catch (err) {
      this.log.error('Trader: merge failed', { err: err.message });
    } finally {
      this._merging = false;
    }
  }

  // ── RULE 7: Redeem after resolution ─────────────────────────────────────────
  async _redeemPhase(conditionId, windowClose) {
    // Wait until at least REDEEM_DELAY_AFTER_CLOSE seconds after window close
    const redeemNotBefore = (windowClose + REDEEM_DELAY_AFTER_CLOSE) * 1000;
    const waitForRedeemMs = redeemNotBefore - Date.now();
    if (waitForRedeemMs > 0) {
      this.log.debug('Trader: waiting for oracle resolution…', { waitSec: Math.round(waitForRedeemMs / 1000) });
      await sleep(waitForRedeemMs);
    }

    // Poll Gamma API until market is resolved
    try {
      await waitForResolution(this.market.slug, 400_000, 10_000);
    } catch (err) {
      this.log.warn('Trader: resolution poll timed out, attempting redeem anyway', { err: err.message });
    }

    // Only redeem if we actually hold tokens
    const totalHeld = this.balanceUp + this.balanceDown;
    if (totalHeld < 0.001) {
      this.log.info('Trader: no tokens to redeem');
      return;
    }

    try {
      this.log.info('Trader: RULE-7 redeeming positions', {
        upHeld:   this.balanceUp.toFixed(4),
        downHeld: this.balanceDown.toFixed(4),
      });
      const txHash = await redeemPositions(conditionId);

      // We don't know which side won until we check on-chain state,
      // but PnL will be reconciled from the wallet balance diff.
      // Estimate: if resolution was recorded, winning shares × $1.
      const estimatedPayout = Math.max(this.balanceUp, this.balanceDown);
      this.redeemedUsdc += estimatedPayout;
      this.pnl.recordRedeem(this.market.slug, estimatedPayout, txHash);
    } catch (err) {
      this.log.error('Trader: redeem failed', { err: err.message });
    }
  }

  // ── RULE 6: Cancel all market orders ────────────────────────────────────────
  async _cancelAllOrders(conditionId) {
    this.log.info('Trader: RULE-6 cancelling all open orders');
    try {
      await ClobClient.cancelMarket(conditionId);
      this.openOrders.clear();
    } catch (err) {
      this.log.warn('Trader: cancelMarket failed, trying global cancel', { err: err.message });
      try {
        await ClobClient.cancelAll();
        this.openOrders.clear();
      } catch (err2) {
        this.log.error('Trader: cancelAll also failed', { err: err2.message });
      }
    }
  }

  // ── RULE 8: Circuit breakers ─────────────────────────────────────────────────
  _checkCircuitBreakers() {
    if (this.halted) return true;

    // Rule 8a: Inventory imbalance cap
    const imbalanceUsdc = Math.abs(this.balanceUp - this.balanceDown);
    if (imbalanceUsdc > MAX_INVENTORY_IMBALANCE) {
      this.log.warn('Trader: RULE-8 inventory imbalance circuit breaker', {
        imbalanceUsdc: imbalanceUsdc.toFixed(2),
        balanceUp:     this.balanceUp.toFixed(4),
        balanceDown:   this.balanceDown.toFixed(4),
      });
      // Don't halt entirely — just skew future buys toward the under-held side.
      // We signal this via `halted` only if imbalance is extreme (>= 2×).
      if (imbalanceUsdc > MAX_INVENTORY_IMBALANCE * 2) {
        this.halted = true;
        return true;
      }
    }

    // Rule 9: Per-market spend cap
    if (this.totalSpent >= MAX_SPEND_PER_MARKET) {
      this.log.info('Trader: RULE-9 spend cap reached', { totalSpent: this.totalSpent.toFixed(2) });
      this.halted = true;
      return true;
    }

    return false;
  }

  // ── WS book feed ─────────────────────────────────────────────────────────────
  _startFeed(tokenIds) {
    this._feed = new BookFeed(tokenIds);
    this._feed.on('update', ({ tokenId, bestAsk }) => {
      if (tokenId === this.market.upToken.tokenId) {
        this._bestAskUp = bestAsk;
      } else if (tokenId === this.market.downToken.tokenId) {
        this._bestAskDown = bestAsk;
      }
    });
    this._feed.on('error', (err) => {
      this.log.warn('Trader: BookFeed error', { err: err.message });
    });
    this._feed.start();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Post a single limit buy, tracking orderId and spend. RULE 5: no sells. */
  async _safeLimitBuy(tokenId, price, shares) {
    // RULE 9: don't exceed per-market budget
    const cost = price * shares;
    if (this.totalSpent + cost > MAX_SPEND_PER_MARKET) return;

    try {
      const orderId = await ClobClient.postLimitBuy(this.wallet, tokenId, price, shares);
      this.openOrders.set(orderId, { tokenId, price, shares });
      // Note: budget is NOT consumed here because the order may not fill.
      // Fills are accounted for in _tryArb or via FillFeed.
    } catch (err) {
      this.log.warn('Trader: limit buy failed', { tokenId, price, shares, err: err.message });
    }
  }

  /** Sync on-chain token balances (fallback for missed fills via WS). */
  async _syncBalances(upTokenId, downTokenId) {
    try {
      const bals = await getTokenBalances([upTokenId, downTokenId]);
      this.balanceUp   = bals[upTokenId]   ?? this.balanceUp;
      this.balanceDown = bals[downTokenId] ?? this.balanceDown;
      this.log.debug('Trader: balances synced', {
        up:   this.balanceUp.toFixed(4),
        down: this.balanceDown.toFixed(4),
      });
    } catch (err) {
      this.log.warn('Trader: balance sync failed', { err: err.message });
    }
  }
}
