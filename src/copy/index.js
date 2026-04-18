/**
 * copy/index.js
 * Entry point for the BUY-only copy trading bot.
 *
 * Run:  node src/copy/index.js
 *
 * Startup sequence:
 *   1. Load wallet & CLOB credentials (shared with the arb bot).
 *   2. Ensure on-chain USDC approvals (one-time per wallet).
 *   3. Start ActivityFeed (polls data-api for target wallet trades).
 *   4. Wire every 'trade' event into CopyTrader.onTrade (non-blocking).
 *   5. Print stats every 60s; graceful SIGINT/SIGTERM shutdown.
 */
import 'dotenv/config';
import {
  API_KEY,
  API_SECRET,
  API_PASSPHRASE,
} from '../config.js';
import logger from '../logger.js';
import { ClobClient } from '../clob.js';
import { getSigner, ensureApprovals } from '../onchain.js';
import { ActivityFeed } from './activityFeed.js';
import { CopyTrader }   from './copyTrader.js';
import {
  COPY_TARGETS,
  COPY_POLL_MS,
  COPY_DRY_RUN,
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
} from './config.js';

async function main() {
  const wallet = getSigner();

  logger.info('copy.main: starting BUY-only copy trader', {
    wallet:     wallet.address,
    dryRun:     COPY_DRY_RUN,
    targets:    COPY_TARGETS,
    pollMs:     COPY_POLL_MS,
    sizing:     COPY_SIZE_MODE,
    fixedUsdc:  COPY_FIXED_USDC,
    ratio:      COPY_RATIO,
    caps: {
      perTrade:  COPY_MAX_USDC_PER_TRADE,
      perMarket: COPY_MAX_USDC_PER_MARKET,
      perHour:   COPY_MAX_USDC_PER_HOUR,
      total:     COPY_MAX_USDC_TOTAL,
    },
    filters: {
      priceRange: [COPY_MIN_PRICE, COPY_MAX_PRICE],
      slippage:   COPY_MAX_SLIPPAGE,
      staleMs:    COPY_STALE_MS,
    },
  });

  // ── Approvals (skip in dry-run to avoid gas) ────────────────────────────
  if (!COPY_DRY_RUN) {
    await ensureApprovals();
  } else {
    logger.info('copy.main: DRY RUN — skipping approvals and order submission');
  }

  // ── CLOB credentials ────────────────────────────────────────────────────
  await ClobClient.init(wallet, {
    apiKey:     API_KEY,
    secret:     API_SECRET,
    passphrase: API_PASSPHRASE,
  });

  // ── Wire up feed → trader ───────────────────────────────────────────────
  const trader = new CopyTrader(wallet);
  const feed   = new ActivityFeed(COPY_TARGETS, COPY_POLL_MS);

  feed.on('trade', (ev) => {
    // Fire-and-forget so the poller never blocks on an order round-trip.
    trader.onTrade(ev).catch((err) => {
      logger.error('copy.main: unexpected error in onTrade', { err: err.message, stack: err.stack });
    });
  });

  feed.start();

  // ── Periodic stats ──────────────────────────────────────────────────────
  const statsTimer = setInterval(() => {
    logger.info('copy.main: stats', trader.stats());
  }, 60_000);

  // ── Graceful shutdown ───────────────────────────────────────────────────
  const shutdown = (sig) => {
    logger.info(`copy.main: ${sig} received, shutting down…`, trader.stats());
    clearInterval(statsTimer);
    feed.stop();
    // Give any in-flight order a moment to flush.
    setTimeout(() => process.exit(0), 1_000);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('copy.main: running — Ctrl+C to stop');
}

main().catch((err) => {
  logger.error('copy.main: fatal error', { err: err.message, stack: err.stack });
  process.exit(1);
});
