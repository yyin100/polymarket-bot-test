/**
 * clob.js
 * Polymarket CLOB client: REST + WebSocket.
 *
 * Responsibilities:
 *  - L1 auth: derive API credentials (apiKey, secret, passphrase) by signing
 *    an EIP-712 message with the EOA private key.
 *  - HMAC auth: sign each REST request.
 *  - EIP-712 order signing for BUY limit and market orders.
 *  - REST helpers: postOrder, cancelOrder, cancelAll, getOpenOrders, getBook.
 *  - WebSocket: subscribe to book snapshots + price-change diffs for a pair of
 *    tokenIds; exposes an EventEmitter interface for the Trader to consume.
 */
import crypto from 'crypto';
import { EventEmitter } from 'events';
import axios from 'axios';
import WebSocket from 'ws';
import { ethers } from 'ethers';
import {
  CLOB_API_URL,
  CLOB_WS_URL,
  PROXY_WALLET,
  ORDER_DOMAIN,
  ORDER_TYPES,
  AUTH_DOMAIN,
  AUTH_TYPES,
  USDC_SCALE,
  TOKEN_DECIMALS,
} from './config.js';
import logger from './logger.js';

// ── Side / SignatureType constants ────────────────────────────────────────────
const SIDE_BUY  = 0;
const SIDE_SELL = 1;
const SIG_TYPE_EOA   = 0; // standard EOA (personal_sign / typed data)
const SIG_TYPE_PROXY = 2; // Polymarket proxy wallet

// ── HMAC auth headers (for all trading endpoints) ────────────────────────────
function buildHeaders(method, path, body = '') {
  if (!ClobClient._creds) throw new Error('CLOB credentials not initialised — call ClobClient.init() first');
  const { apiKey, secret, passphrase } = ClobClient._creds;
  const ts  = Math.floor(Date.now() / 1000).toString();
  const msg = ts + method.toUpperCase() + path + body;
  const sig = crypto.createHmac('sha256', secret).update(msg).digest('base64');
  return {
    'POLY_ADDRESS':    PROXY_WALLET,
    'POLY_SIGNATURE':  sig,
    'POLY_TIMESTAMP':  ts,
    'POLY_NONCE':      '',
    'POLY_API_KEY':    apiKey,
    'POLY_PASSPHRASE': passphrase,
    'Content-Type':    'application/json',
  };
}

// ── REST base call ────────────────────────────────────────────────────────────
async function restCall(method, path, data = null, auth = true) {
  const url    = CLOB_API_URL + path;
  const body   = data ? JSON.stringify(data) : '';
  const config = {
    method,
    url,
    headers: auth ? buildHeaders(method, path, body) : { 'Content-Type': 'application/json' },
  };
  if (data) config.data = data;
  try {
    const res = await axios(config);
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data;
    logger.error('CLOB REST error', { method, path, status, detail });
    throw err;
  }
}

// ── EIP-712 order signing ─────────────────────────────────────────────────────
/**
 * Build and sign a BUY limit order struct.
 *
 * @param {ethers.Wallet} wallet   - Signer wallet
 * @param {string}        tokenId  - ERC-1155 token ID (as a decimal string)
 * @param {number}        price    - e.g. 0.50  (human units, 0–1)
 * @param {number}        shares   - e.g. 100   (human units)
 * @param {number}        expiry   - unix ts (0 = GTC, i.e. good-till-cancel within market)
 * @returns {{ orderData, signature }}
 */
async function buildBuyOrder(wallet, tokenId, price, shares, expiry = 0) {
  // Convert to on-chain units (6 decimals) as BigInt strings.
  const makerAmt = BigInt(Math.round(price * shares * USDC_SCALE)).toString();
  const takerAmt = BigInt(Math.round(shares * USDC_SCALE)).toString();
  const salt     = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)).toString();

  const orderData = {
    salt:          salt,
    maker:         PROXY_WALLET,
    signer:        wallet.address,
    taker:         ethers.ZeroAddress,
    tokenId:       tokenId,
    makerAmount:   makerAmt,
    takerAmount:   takerAmt,
    expiration:    expiry.toString(),
    nonce:         '0',
    feeRateBps:    '0',
    side:          SIDE_BUY,
    signatureType: SIG_TYPE_EOA,
  };

  const signature = await wallet.signTypedData(ORDER_DOMAIN, ORDER_TYPES, orderData);
  return { orderData, signature };
}

// ── Public API ────────────────────────────────────────────────────────────────
export class ClobClient {
  static _creds = null;

  /**
   * Initialise the client.
   * If apiKey/secret/passphrase are provided (from .env) they are used directly.
   * Otherwise a fresh L1 auth round-trip derives them from the wallet.
   */
  static async init(wallet, { apiKey, secret, passphrase } = {}) {
    if (apiKey && secret && passphrase) {
      ClobClient._creds = { apiKey, secret, passphrase };
      logger.info('CLOB: using cached API credentials');
      return;
    }
    logger.info('CLOB: deriving API credentials via L1 auth…');
    ClobClient._creds = await ClobClient._deriveCredentials(wallet);
    logger.info('CLOB: credentials derived', { apiKey: ClobClient._creds.apiKey });
  }

  /** L1 auth: sign an EIP-712 auth message and POST to /auth/api-key */
  static async _deriveCredentials(wallet) {
    const ts    = Math.floor(Date.now() / 1000).toString();
    const nonce = 0;
    const authMsg = {
      address:   wallet.address,
      timestamp: ts,
      nonce,
      message:   'This message attests that I control the given wallet',
    };
    const sig = await wallet.signTypedData(AUTH_DOMAIN, AUTH_TYPES, authMsg);

    const headers = {
      'POLY_ADDRESS':   PROXY_WALLET,
      'POLY_SIGNATURE': sig,
      'POLY_TIMESTAMP': ts,
      'POLY_NONCE':     nonce.toString(),
      'Content-Type':   'application/json',
    };
    const res = await axios.post(`${CLOB_API_URL}/auth/api-key`, {}, { headers });
    const { apiKey, secret, passphrase } = res.data;
    return { apiKey, secret, passphrase };
  }

  /** Returns current API credentials (for WS auth). */
  static get creds() {
    return ClobClient._creds;
  }

  // ── Order book ──────────────────────────────────────────────────────────────

  /**
   * Fetch full order book for a token.
   * Returns { bids: [{price,size}], asks: [{price,size}] } (human-readable floats).
   */
  static async getBook(tokenId) {
    const raw = await restCall('GET', `/book?token_id=${tokenId}`, null, false);
    return {
      bids: (raw.bids ?? []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
      asks: (raw.asks ?? []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
    };
  }

  /** Returns the best ask { price, size } for a token, or null if no liquidity. */
  static async getBestAsk(tokenId) {
    const book = await ClobClient.getBook(tokenId);
    if (!book.asks.length) return null;
    return book.asks.reduce((a, b) => (a.price <= b.price ? a : b));
  }

  // ── Order management ────────────────────────────────────────────────────────

  /**
   * Post a GTC limit BUY order to the CLOB.
   * Returns the orderId string, or throws on rejection.
   */
  static async postLimitBuy(wallet, tokenId, price, shares) {
    const { orderData, signature } = await buildBuyOrder(wallet, tokenId, price, shares);
    const body = {
      order: { ...orderData, signature },
      owner:     PROXY_WALLET,
      orderType: 'GTC',
    };
    const path = '/order';
    const res  = await restCall('POST', path, body);
    if (!res.success) throw new Error(`Order rejected: ${JSON.stringify(res)}`);
    logger.debug('CLOB: limit buy posted', { tokenId, price, shares, orderId: res.orderId });
    return res.orderId;
  }

  /**
   * Post an IOC (immediate-or-cancel) BUY order — used for the taker arb leg.
   * The order will fill up to `shares` at the given maxPrice, and any remainder
   * is cancelled immediately by the matching engine.
   */
  static async postIOCBuy(wallet, tokenId, maxPrice, shares) {
    const { orderData, signature } = await buildBuyOrder(wallet, tokenId, maxPrice, shares);
    const body = {
      order: { ...orderData, signature },
      owner:     PROXY_WALLET,
      orderType: 'FOK', // Fill-or-Kill; use FOK/IOC depending on CLOB version
    };
    const path = '/order';
    const res  = await restCall('POST', path, body);
    logger.debug('CLOB: IOC buy posted', { tokenId, maxPrice, shares, res });
    return res;
  }

  /**
   * Cancel a single order by orderId.
   */
  static async cancelOrder(orderId) {
    const path = `/order/${orderId}`;
    const res  = await restCall('DELETE', path);
    logger.debug('CLOB: order cancelled', { orderId });
    return res;
  }

  /**
   * Cancel all open orders for this wallet.
   */
  static async cancelAll() {
    const path = '/orders';
    const res  = await restCall('DELETE', path);
    logger.info('CLOB: all orders cancelled');
    return res;
  }

  /**
   * Cancel all open orders for a specific market (conditionId).
   */
  static async cancelMarket(conditionId) {
    const path = `/orders/cancel/market`;
    const res  = await restCall('DELETE', path, { market: conditionId });
    logger.debug('CLOB: market orders cancelled', { conditionId });
    return res;
  }

  /**
   * Get all open orders for this wallet on a market.
   * Returns array of order objects with { id, tokenId, price, size, side }.
   */
  static async getOpenOrders(conditionId) {
    const path = `/orders?market=${conditionId}&maker_address=${PROXY_WALLET}`;
    const res  = await restCall('GET', path);
    return res ?? [];
  }
}

// ── WebSocket book feed ───────────────────────────────────────────────────────
/**
 * BookFeed subscribes to real-time order book updates for a pair of tokenIds.
 * Maintains an in-memory best-ask for each token.
 * Emits:
 *   'snapshot'   ({tokenId, bids, asks})  – initial full book
 *   'update'     ({tokenId, bestAsk})     – whenever best ask changes
 *   'fill'       ({tokenId, price, size}) – when one of our orders fills
 *   'error'      (err)
 *   'close'      ()
 */
export class BookFeed extends EventEmitter {
  constructor(tokenIds) {
    super();
    this.tokenIds = tokenIds;
    this.bestAsks = {};   // tokenId → { price, size }
    this._ws = null;
    this._reconnectDelay = 1000;
    this._closed = false;
  }

  start() {
    this._connect();
  }

  stop() {
    this._closed = true;
    this._ws?.close();
  }

  getBestAsk(tokenId) {
    return this.bestAsks[tokenId] ?? null;
  }

  _connect() {
    if (this._closed) return;
    const ws = new WebSocket(CLOB_WS_URL + 'market');
    this._ws = ws;

    ws.on('open', () => {
      logger.debug('BookFeed: WS connected, subscribing', { tokenIds: this.tokenIds });
      ws.send(JSON.stringify({
        type:      'market',
        assets_ids: this.tokenIds,
      }));
      this._reconnectDelay = 1000; // reset backoff on successful connect
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleMessage(msg);
      } catch (e) {
        logger.warn('BookFeed: parse error', { err: e.message });
      }
    });

    ws.on('error', (err) => {
      logger.error('BookFeed: WS error', { err: err.message });
      this.emit('error', err);
    });

    ws.on('close', () => {
      if (!this._closed) {
        logger.warn(`BookFeed: WS closed, reconnecting in ${this._reconnectDelay}ms`);
        setTimeout(() => {
          this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30_000);
          this._connect();
        }, this._reconnectDelay);
      } else {
        this.emit('close');
      }
    });
  }

  _handleMessage(msg) {
    const { event_type, asset_id } = msg;

    if (event_type === 'book') {
      // Full snapshot
      const asks = (msg.asks ?? []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }));
      const bids = (msg.bids ?? []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }));
      this.emit('snapshot', { tokenId: asset_id, bids, asks });
      const best = this._bestAsk(asks);
      if (best) {
        this.bestAsks[asset_id] = best;
        this.emit('update', { tokenId: asset_id, bestAsk: best });
      }
      return;
    }

    if (event_type === 'price_change') {
      // Incremental diff
      const changes = msg.changes ?? [];
      for (const c of changes) {
        if (c.side !== 'SELL') continue; // asks only
        const price = parseFloat(c.price);
        const size  = parseFloat(c.size);
        const cur   = this.bestAsks[asset_id];

        if (size === 0 && cur && Math.abs(cur.price - price) < 1e-9) {
          // Best level removed — need REST fallback to find new best ask
          this._refreshBestAsk(asset_id);
        } else if (!cur || price < cur.price || (Math.abs(price - cur.price) < 1e-9 && size !== cur.size)) {
          this.bestAsks[asset_id] = { price, size };
          this.emit('update', { tokenId: asset_id, bestAsk: { price, size } });
        }
      }
      return;
    }

    if (event_type === 'trade') {
      // A trade happened (someone matched on the book)
      this.emit('trade', { tokenId: asset_id, price: parseFloat(msg.price), size: parseFloat(msg.size) });
      return;
    }
  }

  _bestAsk(asks) {
    if (!asks.length) return null;
    return asks.reduce((a, b) => (a.price <= b.price ? a : b));
  }

  async _refreshBestAsk(tokenId) {
    try {
      const best = await ClobClient.getBestAsk(tokenId);
      if (best) {
        this.bestAsks[tokenId] = best;
        this.emit('update', { tokenId, bestAsk: best });
      }
    } catch (e) {
      logger.warn('BookFeed: refresh best ask failed', { tokenId, err: e.message });
    }
  }
}

// ── User fill WebSocket ───────────────────────────────────────────────────────
/**
 * FillFeed subscribes to user-level fill events.
 * Emits 'fill' events: { tokenId, price, size, side, orderId, matchedAt }
 */
export class FillFeed extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._closed = false;
  }

  start() {
    this._connect();
  }

  stop() {
    this._closed = true;
    this._ws?.close();
  }

  _connect() {
    if (this._closed) return;
    const creds = ClobClient.creds;
    if (!creds) throw new Error('FillFeed: CLOB not initialised');

    const ws = new WebSocket(CLOB_WS_URL + 'user');
    this._ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        auth: {
          apiKey:    creds.apiKey,
          secret:    creds.secret,
          passphrase: creds.passphrase,
        },
        assets_ids: [],
      }));
      logger.debug('FillFeed: user WS connected');
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.event_type === 'trade' || msg.type === 'TRADE') {
          this.emit('fill', {
            tokenId:   msg.asset_id,
            price:     parseFloat(msg.price),
            size:      parseFloat(msg.size),
            side:      msg.side,
            orderId:   msg.id ?? msg.orderId,
            matchedAt: msg.timestamp,
          });
        }
      } catch { /* ignore */ }
    });

    ws.on('error', (err) => logger.error('FillFeed: error', { err: err.message }));
    ws.on('close', () => {
      if (!this._closed) {
        setTimeout(() => this._connect(), 2000);
      }
    });
  }
}
