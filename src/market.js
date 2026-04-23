/**
 * market.js
 * Market discovery via the Polymarket Gamma API.
 *
 * btc-updown-5m markets follow the naming scheme:
 *   slug = "btc-updown-5m-<unix_ts>" where unix_ts is the window open time
 *   (multiple of 300 seconds).
 *
 * Responsibilities:
 *  - Compute the next market window timestamp.
 *  - Fetch the market's conditionId and Up/Down tokenIds from Gamma API.
 *  - Poll until the market is resolved (for redeem timing).
 */
import axios from 'axios';
import { DATA_API_URL, GAMMA_API_URL, MARKET_WINDOW_SECONDS, TARGET_WALLET } from './config.js';
import logger from './logger.js';

// ── Slug & timestamp helpers ──────────────────────────────────────────────────
/**
 * Returns the unix timestamp of the CURRENT 5-min window open.
 * e.g. if now = 06:42:30, window open = 06:40:00 (ts ending in :00 on 5-min grid).
 */
export function currentWindowTs() {
  return Math.floor(Date.now() / 1000 / MARKET_WINDOW_SECONDS) * MARKET_WINDOW_SECONDS;
}

/**
 * Returns the unix timestamp of the NEXT 5-min window open.
 */
export function nextWindowTs() {
  return currentWindowTs() + MARKET_WINDOW_SECONDS;
}

/**
 * Build the slug for a given window open timestamp.
 */
export function slugFor(ts) {
  return `btc-updown-5m-${ts}`;
}

/**
 * Milliseconds remaining until a target unix timestamp.
 */
export function msUntil(unixTs) {
  return unixTs * 1000 - Date.now();
}

function normaliseWalletAddress(address) {
  return typeof address === 'string' ? address.toLowerCase() : '';
}

// ── Gamma API ─────────────────────────────────────────────────────────────────
/**
 * Fetch market metadata for a given slug.
 *
 * Returns:
 * {
 *   conditionId: '0x…',
 *   slug: 'btc-updown-5m-…',
 *   windowTs: <unix_ts>,     // window open unix timestamp
 *   upToken:   { tokenId: '123…', outcome: 'Up',   outcomeIndex: 0 },
 *   downToken: { tokenId: '456…', outcome: 'Down',  outcomeIndex: 1 },
 *   active: true|false,
 *   resolved: true|false,
 * }
 *
 * Throws if the market does not exist yet (not yet created by Polymarket).
 */
export async function fetchMarket(slug) {
  const url = `${GAMMA_API_URL}/markets?slug=${encodeURIComponent(slug)}`;
  const res = await axios.get(url, { timeout: 10_000 });
  const markets = res.data;

  if (!markets || !markets.length) {
    throw new Error(`Market not found: ${slug}`);
  }

  const m = markets[0];
  const tokens = m.tokens ?? m.clobTokenIds ?? [];

  // Normalise token structure (Gamma API returns either objects or flat token ID strings)
  const normTokens = tokens.map((t, i) => {
    if (typeof t === 'string') {
      return { tokenId: t, outcome: i === 0 ? 'Up' : 'Down', outcomeIndex: i };
    }
    return {
      tokenId:      t.token_id ?? t.tokenId,
      outcome:      t.outcome ?? (i === 0 ? 'Up' : 'Down'),
      outcomeIndex: t.outcome_index ?? i,
    };
  });

  const upToken   = normTokens.find(t => t.outcome === 'Up'   || t.outcomeIndex === 0);
  const downToken = normTokens.find(t => t.outcome === 'Down'  || t.outcomeIndex === 1);

  if (!upToken || !downToken) {
    throw new Error(`Cannot find Up/Down tokens for market: ${slug} → ${JSON.stringify(tokens)}`);
  }

  const ts = parseInt(slug.split('-').at(-1), 10);

  return {
    conditionId:  m.condition_id ?? m.conditionId,
    slug,
    windowTs:     ts,
    upToken,
    downToken,
    active:       m.active ?? !m.closed,
    resolved:     !!(m.resolved ?? m.is_resolved),
    question:     m.question ?? m.title,
  };
}

/**
 * Fetch detailed position data for a Polymarket proxy wallet from the Data API.
 *
 * Useful for copy-trade logic that needs to inspect the target wallet's live
 * positions, sizing, average prices, and market metadata.
 */
export async function fetchWalletPositions(proxyWallet, {
  sizeThreshold = 1,
  limit = 100,
  offset = 0,
  sortBy = 'TOKENS',
  sortDirection = 'DESC',
} = {}) {
  const wallet = normaliseWalletAddress(proxyWallet);
  if (!wallet) throw new Error('fetchWalletPositions: proxyWallet is required');

  const res = await axios.get(`${DATA_API_URL}/positions`, {
    timeout: 10_000,
    params: {
      user: wallet,
      sizeThreshold,
      limit,
      offset,
      sortBy,
      sortDirection,
    },
  });

  return (res.data ?? []).map((position) => ({
    proxyWallet: normaliseWalletAddress(position.proxyWallet ?? wallet),
    asset: position.asset ?? '',
    conditionId: position.conditionId ?? '',
    size: Number(position.size ?? 0),
    avgPrice: Number(position.avgPrice ?? 0),
    initialValue: Number(position.initialValue ?? 0),
    currentValue: Number(position.currentValue ?? 0),
    cashPnl: Number(position.cashPnl ?? 0),
    percentPnl: Number(position.percentPnl ?? 0),
    totalBought: Number(position.totalBought ?? 0),
    realizedPnl: Number(position.realizedPnl ?? 0),
    percentRealizedPnl: Number(position.percentRealizedPnl ?? 0),
    curPrice: Number(position.curPrice ?? 0),
    redeemable: Boolean(position.redeemable),
    mergeable: Boolean(position.mergeable),
    title: position.title ?? '',
    slug: position.slug ?? '',
    icon: position.icon ?? '',
    eventSlug: position.eventSlug ?? '',
    outcome: position.outcome ?? '',
    outcomeIndex: Number(position.outcomeIndex ?? 0),
    oppositeOutcome: position.oppositeOutcome ?? '',
    oppositeAsset: position.oppositeAsset ?? '',
    endDate: position.endDate ?? '',
    negativeRisk: Boolean(position.negativeRisk),
  }));
}

/**
 * Convenience wrapper for the configured copy-trade target wallet.
 */
export async function fetchTargetWalletPositions(options = {}) {
  if (!TARGET_WALLET) {
    throw new Error('TARGET_WALLET is not configured');
  }
  return fetchWalletPositions(TARGET_WALLET, options);
}

/**
 * Retry-wrapped fetchMarket. Retries up to `maxAttempts` times with
 * `delayMs` between attempts. Used to wait for the market to be created
 * (Polymarket creates the next market a few seconds before the window opens).
 */
export async function fetchMarketWithRetry(slug, maxAttempts = 20, delayMs = 3_000) {
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const market = await fetchMarket(slug);
      return market;
    } catch (err) {
      last = err;
      logger.debug('market.js: market not ready yet, retrying…', {
        slug, attempt, err: err.message,
      });
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Market ${slug} not found after ${maxAttempts} attempts: ${last?.message}`);
}

/**
 * Poll until the market is resolved, then return.
 * Used by Trader after the window close to know when to call redeemPositions.
 */
export async function waitForResolution(slug, timeoutMs = 400_000, pollMs = 10_000) {
  const start = Date.now();
  logger.info('market.js: waiting for resolution…', { slug });
  while (Date.now() - start < timeoutMs) {
    try {
      const m = await fetchMarket(slug);
      if (m.resolved) {
        logger.info('market.js: market resolved', { slug });
        return m;
      }
    } catch (err) {
      logger.warn('market.js: poll error', { slug, err: err.message });
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`Market ${slug} did not resolve within ${timeoutMs / 1000}s`);
}

/**
 * Fetch the current BTC implied probability from the live market mid-price.
 * Useful for an optional directional overlay (extension).
 * Returns { upMid, downMid } where upMid + downMid should ≈ 1.
 */
export async function fetchMidPrices(market, clob) {
  const [upBook, downBook] = await Promise.all([
    clob.getBook(market.upToken.tokenId),
    clob.getBook(market.downToken.tokenId),
  ]);

  const mid = (book) => {
    if (!book.bids.length || !book.asks.length) return null;
    const bestBid = Math.max(...book.bids.map(b => b.price));
    const bestAsk = Math.min(...book.asks.map(a => a.price));
    return (bestBid + bestAsk) / 2;
  };

  return { upMid: mid(upBook), downMid: mid(downBook) };
}
