/**
 * index.js
 * Main entry point.
 *
 * Outer loop:
 *  1. Start up: validate config, ensure on-chain approvals, init CLOB creds.
 *  2. Every 5 minutes: discover the next btc-updown-5m market.
 *  3. Spawn a Trader instance for that market and await completion.
 *  4. Session-level circuit breaker: halt if rolling hourly loss > limit.
 *  5. Print running PnL after each market completes.
 *
 * The Trader for market N starts *before* market N's window opens, so it can
 * post the ladder right at `t=0`. Meanwhile the previous market's Trader is
 * still in its RESOLVING phase (waiting for oracle, ~t=600s after its window
 * close). Both run concurrently in separate async tasks.
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import {
  PRIVATE_KEY,
  API_KEY,
  API_SECRET,
  API_PASSPHRASE,
  MAX_LOSS_PER_HOUR_USDC,
  MARKET_WINDOW_SECONDS,
} from './config.js';
import logger from './logger.js';
import { ClobClient }                 from './clob.js';
import { getSigner, ensureApprovals } from './onchain.js';
import { fetchMarketWithRetry, nextWindowTs, slugFor, msUntil } from './market.js';
import { Trader }                     from './trader.js';
import { PnlTracker }                 from './pnl.js';

// ── Startup ───────────────────────────────────────────────────────────────────
async function startup(wallet) {
  logger.info('Bot starting up…', { wallet: wallet.address });

  // 1. Ensure on-chain approvals (USDC for exchange, CTF for adapter)
  await ensureApprovals();

  // 2. Initialise CLOB credentials
  await ClobClient.init(wallet, {
    apiKey:     API_KEY,
    secret:     API_SECRET,
    passphrase: API_PASSPHRASE,
  });

  logger.info('Bot startup complete');
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  const wallet = getSigner();
  await startup(wallet);

  const pnl = new PnlTracker();

  // Track running Trader promises so we don't block the loop waiting for
  // the resolve phase of the *previous* market.
  const runningTasks = new Set();

  // Graceful shutdown
  let stopping = false;
  process.on('SIGINT',  () => { stopping = true; logger.info('SIGINT received, stopping after current market…'); });
  process.on('SIGTERM', () => { stopping = true; logger.info('SIGTERM received, stopping…'); });

  while (!stopping) {
    // ── RULE 8: Session-level hourly loss circuit breaker ─────────────────────
    const hourlyLoss = pnl.rollingHourlyLoss();
    if (hourlyLoss > MAX_LOSS_PER_HOUR_USDC) {
      logger.error('CIRCUIT BREAKER: rolling hourly loss exceeded limit', {
        hourlyLoss: hourlyLoss.toFixed(2),
        limit:      MAX_LOSS_PER_HOUR_USDC,
      });
      break;
    }

    // ── Discover next market ──────────────────────────────────────────────────
    const wts  = nextWindowTs();
    const slug = slugFor(wts);

    logger.info('Main: discovering next market', {
      slug,
      opensIn: Math.round(msUntil(wts) / 1000) + 's',
    });

    let market;
    try {
      // Fetch market ~30s before window open (Polymarket creates it ahead of time)
      const fetchDelay = msUntil(wts) - 30_000;
      if (fetchDelay > 0) {
        logger.debug('Main: waiting before market fetch', { waitSec: Math.round(fetchDelay / 1000) });
        await new Promise(r => setTimeout(r, fetchDelay));
      }
      market = await fetchMarketWithRetry(slug, 30, 3_000);
    } catch (err) {
      logger.error('Main: failed to discover market, skipping window', { slug, err: err.message });
      // Wait out the rest of this window so we align to the next one
      const skipMs = msUntil(wts + MARKET_WINDOW_SECONDS);
      if (skipMs > 0) await new Promise(r => setTimeout(r, skipMs));
      continue;
    }

    // ── Spawn Trader (non-blocking for the resolve tail) ─────────────────────
    const trader = new Trader(market, wallet, pnl);
    const task   = trader.run()
      .then(() => {
        runningTasks.delete(task);
        pnl.printSessionSummary();
      })
      .catch((err) => {
        runningTasks.delete(task);
        logger.error('Main: Trader threw', { slug, err: err.message, stack: err.stack });
      });
    runningTasks.add(task);

    // ── Align to next 5-min window before looping ────────────────────────────
    // The Trader's run() call begins its own sleep internally before the window
    // opens, so we just wait for the next window boundary here.
    const nextLoopTs  = wts + MARKET_WINDOW_SECONDS;
    const nextLoopMs  = msUntil(nextLoopTs);
    if (nextLoopMs > 0) {
      logger.debug('Main: waiting for next window boundary', { waitSec: Math.round(nextLoopMs / 1000) });
      await new Promise(r => setTimeout(r, nextLoopMs));
    }
  }

  // ── Graceful teardown ─────────────────────────────────────────────────────
  logger.info('Main: waiting for in-flight tasks to complete…', { count: runningTasks.size });
  await Promise.allSettled([...runningTasks]);
  pnl.printSessionSummary();
  logger.info('Bot stopped.');
  process.exit(0);
}

main().catch((err) => {
  logger.error('Fatal error in main()', { err: err.message, stack: err.stack });
  process.exit(1);
});
