/**
 * copy/activityFeed.js
 * Ultra-fast poller of Polymarket's public data-api for a target wallet's trades.
 *
 * Why polling and not a WS feed?
 *   Polymarket's user WebSocket is scoped to your own API credentials, so we
 *   can't receive another wallet's fill events there. The market WS publishes
 *   public `trade` events but omits the maker wallet, so filtering by target
 *   wallet isn't possible. The lowest-latency public source of a specific
 *   wallet's fills is `GET /trades?user=<addr>`.
 *
 * Design:
 *   - Keep-alive HTTP agents for minimal handshake overhead.
 *   - One in-flight request per target at a time (skip tick if the previous
 *     request hasn't returned yet — avoids pileups if data-api is slow).
 *   - Dedup by transactionHash + asset — guaranteed unique per fill.
 *   - Emits 'trade' for every new BUY the target made since last poll.
 *
 * Event shape emitted:
 *   {
 *     target,               // the wallet we're copying (lowercase)
 *     tokenId,              // ERC-1155 position token id (string)
 *     conditionId,          // 0x-prefixed bytes32 (lowercase)
 *     side,                 // 'BUY'  (always — we filter out SELL)
 *     price,                // float 0..1
 *     size,                 // target's share size (number)
 *     usdc,                 // target's USDC spend (price*size)
 *     timestamp,            // unix seconds
 *     ageMs,                // ms since the trade at emit time
 *     txHash,               // polygon tx hash
 *     slug,                 // market slug (if present)
 *     question,             // market question (if present)
 *     raw,                  // the raw trade object for debugging
 *   }
 */
import { EventEmitter } from 'events';
import http  from 'http';
import https from 'https';
import axios from 'axios';
import { DATA_API_URL } from '../config.js';
import logger from '../logger.js';
import { COPY_DEDUP_CACHE } from './config.js';

// Keep-alive sockets drastically reduce per-request latency (avoid TLS handshake).
const httpAgent  = new http.Agent({  keepAlive: true, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

const client = axios.create({
  baseURL:     DATA_API_URL,
  httpAgent,
  httpsAgent,
  timeout:     4_000,
  // Compression saves bytes, data-api supports gzip.
  headers:     { 'Accept-Encoding': 'gzip, deflate' },
});

// ── LRU-ish FIFO dedup set ───────────────────────────────────────────────────
class FifoSet {
  constructor(cap) { this.cap = cap; this.set = new Set(); this.queue = []; }
  has(k) { return this.set.has(k); }
  add(k) {
    if (this.set.has(k)) return;
    this.set.add(k);
    this.queue.push(k);
    if (this.queue.length > this.cap) {
      const drop = this.queue.shift();
      this.set.delete(drop);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────
export class ActivityFeed extends EventEmitter {
  /**
   * @param {string[]} targets    - lowercase proxy-wallet addresses to watch
   * @param {number}   pollMs     - interval per target
   */
  constructor(targets, pollMs) {
    super();
    this.targets   = targets;
    this.pollMs    = pollMs;
    this._timers   = new Map();
    this._inFlight = new Map();  // target → bool
    this._seen     = new FifoSet(COPY_DEDUP_CACHE);
    this._bootTs   = Math.floor(Date.now() / 1000);
    // We ignore trades older than _bootTs on the very first poll of each
    // target so we don't fire dozens of stale copies at startup.
    this._warmedUp = new Set();
    this._stopped  = false;
  }

  start() {
    logger.info('copy.ActivityFeed: starting', {
      targets: this.targets,
      pollMs:  this.pollMs,
    });
    for (const t of this.targets) this._schedule(t, 0);
  }

  stop() {
    this._stopped = true;
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
  }

  _schedule(target, delayMs) {
    if (this._stopped) return;
    const t = setTimeout(() => this._tick(target), delayMs);
    // Unref so it doesn't keep the process alive after shutdown signal.
    t.unref?.();
    this._timers.set(target, t);
  }

  async _tick(target) {
    if (this._stopped) return;
    if (this._inFlight.get(target)) {
      // Previous request still outstanding — try again next tick.
      this._schedule(target, this.pollMs);
      return;
    }
    this._inFlight.set(target, true);
    const startedAt = Date.now();

    try {
      // limit=25 is plenty: at 250ms poll, a target would need to do >100 trades/s
      // to overflow. Default sort is most-recent-first.
      const res = await client.get('/trades', {
        params: { user: target, limit: 25, takerOnly: false },
      });
      const trades = Array.isArray(res.data) ? res.data : [];
      this._process(target, trades);
    } catch (err) {
      // Network hiccups are common — log at debug, not error.
      logger.debug('copy.ActivityFeed: poll error', {
        target,
        err: err.message,
        status: err.response?.status,
      });
    } finally {
      this._inFlight.set(target, false);
      const elapsed = Date.now() - startedAt;
      // Schedule next tick with a floor of ~50ms to avoid runaway loops.
      const next = Math.max(50, this.pollMs - elapsed);
      this._schedule(target, next);
    }
  }

  _process(target, trades) {
    // data-api returns newest first. We process oldest → newest so downstream
    // sees events in chronological order. On first poll for a target we only
    // mark ids as seen (don't emit) to skip the backlog.
    const firstPoll = !this._warmedUp.has(target);
    const ordered = [...trades].reverse();

    for (const t of ordered) {
      const id = this._tradeKey(t);
      if (!id) continue;
      if (this._seen.has(id)) continue;
      this._seen.add(id);

      if (firstPoll) continue; // don't emit startup backlog

      const norm = this._normalize(target, t);
      if (!norm) continue;
      if (norm.side !== 'BUY') continue; // buy-only

      this.emit('trade', norm);
    }

    if (firstPoll) this._warmedUp.add(target);
  }

  _tradeKey(t) {
    // Prefer transactionHash + asset (guaranteed unique per fill leg).
    const tx    = (t.transactionHash ?? t.transaction_hash ?? '').toLowerCase();
    const asset = (t.asset ?? t.asset_id ?? t.tokenId ?? '').toString();
    if (tx && asset) return `${tx}:${asset}`;
    // Fallback: timestamp+asset+size+price (collision-resistant enough).
    const ts = t.timestamp ?? t.match_time ?? t.created_at ?? '';
    return `${ts}:${asset}:${t.size}:${t.price}`;
  }

  _normalize(target, t) {
    const side    = (t.side ?? '').toString().toUpperCase();
    const tokenId = (t.asset ?? t.asset_id ?? t.tokenId ?? '').toString();
    const price   = Number(t.price);
    const size    = Number(t.size);
    if (!tokenId || !side || !Number.isFinite(price) || !Number.isFinite(size)) return null;

    // data-api typically returns `timestamp` in unix SECONDS.
    const tsRaw = Number(t.timestamp ?? t.match_time ?? t.created_at ?? 0);
    const timestamp = tsRaw > 1e12 ? Math.floor(tsRaw / 1000) : tsRaw; // ms → s if needed
    const ageMs = Date.now() - timestamp * 1000;

    return {
      target,
      tokenId,
      conditionId: (t.conditionId ?? t.condition_id ?? '').toString().toLowerCase(),
      side,
      price,
      size,
      usdc: price * size,
      timestamp,
      ageMs,
      txHash: (t.transactionHash ?? t.transaction_hash ?? '').toLowerCase(),
      slug:     t.slug     ?? t.eventSlug ?? null,
      question: t.question ?? t.title     ?? null,
      outcome:  t.outcome  ?? null,
      raw:      t,
    };
  }
}
