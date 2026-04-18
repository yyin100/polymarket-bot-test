/**
 * copy/config.js
 * Configuration for the BUY-only copy trading bot.
 *
 * Reads env vars with sensible, safe defaults. Nothing here does any I/O.
 */
import 'dotenv/config';

function req(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}
function opt(key, fb) { return process.env[key] ?? fb; }
function num(key, fb) {
  const v = process.env[key];
  return v !== undefined && v !== '' ? Number(v) : fb;
}
function bool(key, fb) {
  const v = process.env[key];
  if (v === undefined || v === '') return fb;
  return /^(1|true|yes|on)$/i.test(v);
}

// ── Target(s) to copy ────────────────────────────────────────────────────────
// Comma-separated list of Polymarket proxy wallet addresses (lowercased).
const rawTargets = req('COPY_TARGETS')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
export const COPY_TARGETS = rawTargets;

// ── Sizing ───────────────────────────────────────────────────────────────────
// MIRROR: copy the exact USDC the target spent (capped by COPY_MAX_USDC_PER_TRADE)
// FIXED:  always spend exactly COPY_FIXED_USDC per copied trade
// RATIO:  spend COPY_RATIO × target's USDC
export const COPY_SIZE_MODE   = opt('COPY_SIZE_MODE', 'FIXED').toUpperCase();
export const COPY_FIXED_USDC  = num('COPY_FIXED_USDC',  10);
export const COPY_RATIO       = num('COPY_RATIO',       0.1);

// ── Execution caps ───────────────────────────────────────────────────────────
export const COPY_MAX_USDC_PER_TRADE  = num('COPY_MAX_USDC_PER_TRADE',  50);
export const COPY_MAX_USDC_PER_MARKET = num('COPY_MAX_USDC_PER_MARKET', 200);
export const COPY_MAX_USDC_PER_HOUR   = num('COPY_MAX_USDC_PER_HOUR',   500);
export const COPY_MAX_USDC_TOTAL      = num('COPY_MAX_USDC_TOTAL',      2000);

// Don't copy a trade if the best ask is more than this far above the target's fill.
// e.g. 0.03 = 3 cents of slippage tolerance.
export const COPY_MAX_SLIPPAGE = num('COPY_MAX_SLIPPAGE', 0.03);

// Don't copy if price ≥ this (target buying ≥$0.97 is usually dead money).
export const COPY_MAX_PRICE = num('COPY_MAX_PRICE', 0.97);

// Don't copy if price ≤ this (dust / illiquid tails).
export const COPY_MIN_PRICE = num('COPY_MIN_PRICE', 0.02);

// Don't copy if the trade is older than this many ms at detection time.
// 8000 = 8s. Set low to ensure only fresh, relevant signal is copied.
export const COPY_STALE_MS = num('COPY_STALE_MS', 8_000);

// ── Polling ──────────────────────────────────────────────────────────────────
// How often to poll data-api for each target wallet's trades.
// 250 ms is ~4 req/s per target; fast enough to catch trades within a block.
export const COPY_POLL_MS = num('COPY_POLL_MS', 250);

// Size of the trade-id dedup cache. Keeps ~5k entries — plenty for hours of trades.
export const COPY_DEDUP_CACHE = num('COPY_DEDUP_CACHE', 5_000);

// ── Misc ─────────────────────────────────────────────────────────────────────
// If true, log everything but don't send real orders.
export const COPY_DRY_RUN = bool('COPY_DRY_RUN', false);

// Optional: restrict to specific market condition IDs (comma-separated, 0x…).
// Empty = copy any market the target trades.
const rawAllow = opt('COPY_ALLOWED_CONDITIONS', '');
export const COPY_ALLOWED_CONDITIONS = new Set(
  rawAllow.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
);

// Optional: block specific tokenIds or conditionIds (comma-separated).
const rawBlock = opt('COPY_BLOCKED_CONDITIONS', '');
export const COPY_BLOCKED_CONDITIONS = new Set(
  rawBlock.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
);
