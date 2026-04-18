/**
 * onchain.js
 * Polygon on-chain interactions via ethers v6.
 *
 * Handles:
 *  - One-time approvals (USDC → CTFExchange, CTF tokens → NegRiskAdapter)
 *  - mergePositions: burn matched YES+NO pairs → receive USDC.e
 *  - redeemPositions: after oracle resolves, claim winning token payout
 *  - Token balance queries (USDC and ERC-1155 positions)
 */
import { ethers } from 'ethers';
import {
  POLYGON_RPC,
  USDC_ADDRESS,
  CTF_ADDRESS,
  NEG_RISK_ADAPTER_ADDRESS,
  NEG_RISK_CTF_EXCHANGE,
  CTF_EXCHANGE_ADDRESS,
  USDC_SCALE,
  PRIVATE_KEY,
} from './config.js';
import logger from './logger.js';

// ── ABIs (minimal) ────────────────────────────────────────────────────────────
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const CTF_ABI = [
  // ERC-1155 multi-token (conditional tokens)
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
];

// NegRiskAdapter wraps the CTF and provides simple merge/redeem interfaces
// for NegRisk (multi-outcome) markets.  Each binary market has exactly two
// outcomes (index 0 = Up, index 1 = Down) within a NegRisk "question".
const NEG_RISK_ADAPTER_ABI = [
  // Burn `amount` of outcome-0 token + `amount` of outcome-1 token
  // → return `amount` USDC.e to caller (requires CTF setApprovalForAll)
  'function mergePositions(bytes32 conditionId, uint256 amount)',
  // After oracle resolution: redeem any winning tokens you hold
  // indexSets: [1] = outcome-0, [2] = outcome-1
  'function redeemPositions(bytes32 conditionId, uint256[] indexSets)',
  // Returns ERC-1155 token ID for a given conditionId + outcomeIndex
  'function getPositionId(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
];

// ── Provider + Wallet (singleton) ─────────────────────────────────────────────
let _provider = null;
let _wallet   = null;

export function getProvider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(POLYGON_RPC);
  }
  return _provider;
}

export function getSigner() {
  if (!_wallet) {
    _wallet = new ethers.Wallet(PRIVATE_KEY, getProvider());
  }
  return _wallet;
}

// ── Contract factories ────────────────────────────────────────────────────────
function usdc()           { return new ethers.Contract(USDC_ADDRESS, ERC20_ABI, getSigner()); }
function ctf()            { return new ethers.Contract(CTF_ADDRESS, CTF_ABI, getSigner()); }
function negRiskAdapter() { return new ethers.Contract(NEG_RISK_ADAPTER_ADDRESS, NEG_RISK_ADAPTER_ABI, getSigner()); }

// ── One-time approvals ────────────────────────────────────────────────────────
/**
 * Ensure the NegRiskCTFExchange is approved to move our USDC (for order posting).
 * Also ensure NegRiskAdapter is approved as an operator on our CTF positions
 * (needed for mergePositions).
 * Call once at startup.
 */
export async function ensureApprovals() {
  const signer = getSigner();
  const addr   = await signer.getAddress();
  logger.info('Onchain: checking approvals…', { wallet: addr });

  // 1. USDC approval for NEG_RISK_CTF_EXCHANGE (to post buy orders on the CLOB)
  const usdcContract   = usdc();
  const allowance      = await usdcContract.allowance(addr, NEG_RISK_CTF_EXCHANGE);
  const maxUint256     = ethers.MaxUint256;
  if (allowance < maxUint256 / 2n) {
    logger.info('Onchain: approving USDC for NEG_RISK_CTF_EXCHANGE…');
    const tx = await usdcContract.approve(NEG_RISK_CTF_EXCHANGE, maxUint256);
    await tx.wait();
    logger.info('Onchain: USDC approved', { tx: tx.hash });
  }

  // 2. CTF setApprovalForAll for NEG_RISK_ADAPTER (to call mergePositions)
  const ctfContract    = ctf();
  const isApproved     = await ctfContract.isApprovedForAll(addr, NEG_RISK_ADAPTER_ADDRESS);
  if (!isApproved) {
    logger.info('Onchain: setting CTF approvalForAll for NegRiskAdapter…');
    const tx = await ctfContract.setApprovalForAll(NEG_RISK_ADAPTER_ADDRESS, true);
    await tx.wait();
    logger.info('Onchain: CTF approved for NegRiskAdapter', { tx: tx.hash });
  }

  // 3. USDC approval for CTF_EXCHANGE (for standard CTF markets, if ever needed)
  const allowance2 = await usdcContract.allowance(addr, CTF_EXCHANGE_ADDRESS);
  if (allowance2 < maxUint256 / 2n) {
    const tx = await usdcContract.approve(CTF_EXCHANGE_ADDRESS, maxUint256);
    await tx.wait();
  }

  logger.info('Onchain: all approvals OK');
}

// ── Balance queries ───────────────────────────────────────────────────────────
/**
 * Returns USDC.e balance in human units (e.g. 1000.50).
 */
export async function getUsdcBalance() {
  const signer   = getSigner();
  const addr     = await signer.getAddress();
  const raw      = await usdc().balanceOf(addr);
  return Number(raw) / USDC_SCALE;
}

/**
 * Returns the ERC-1155 (conditional token) balance of a specific tokenId.
 * Result is in human units (6 decimal precision, so divide by USDC_SCALE).
 */
export async function getTokenBalance(tokenId) {
  const signer = getSigner();
  const addr   = await signer.getAddress();
  const raw    = await ctf().balanceOf(addr, BigInt(tokenId));
  return Number(raw) / USDC_SCALE;
}

/**
 * Batch-fetch balances for multiple tokenIds.
 * Returns { [tokenId]: humanBalance }
 */
export async function getTokenBalances(tokenIds) {
  if (!tokenIds.length) return {};
  const signer  = getSigner();
  const addr    = await signer.getAddress();
  const addrs   = tokenIds.map(() => addr);
  const ids     = tokenIds.map(id => BigInt(id));
  const raws    = await ctf().balanceOfBatch(addrs, ids);
  return Object.fromEntries(tokenIds.map((id, i) => [id, Number(raws[i]) / USDC_SCALE]));
}

// ── Core operations ───────────────────────────────────────────────────────────
/**
 * RULE 4: Merge `amount` matched YES+NO pairs → receive `amount` USDC.e.
 *
 * @param {string} conditionId   - 0x-prefixed bytes32 condition ID
 * @param {number} amountHuman   - number of pairs to merge (human units, e.g. 50.5)
 * @returns {string} tx hash
 */
export async function mergePositions(conditionId, amountHuman) {
  const amount = BigInt(Math.floor(amountHuman * USDC_SCALE));
  if (amount <= 0n) throw new Error('mergePositions: amount must be > 0');

  logger.info('Onchain: mergePositions', { conditionId, amountHuman });
  try {
    const tx = await negRiskAdapter().mergePositions(conditionId, amount, {
      gasLimit: 500_000,
    });
    const receipt = await tx.wait();
    logger.info('Onchain: merge confirmed', {
      conditionId,
      amountHuman,
      tx: tx.hash,
      gasUsed: receipt.gasUsed.toString(),
    });
    return tx.hash;
  } catch (err) {
    logger.error('Onchain: mergePositions failed', { conditionId, err: err.message });
    throw err;
  }
}

/**
 * RULE 7: Redeem positions after the oracle resolves.
 * Attempts to redeem both outcome-0 (Up) and outcome-1 (Down) tokens.
 * Whichever is the winner will pay out $1/share; losers pay $0.
 *
 * @param {string} conditionId - 0x-prefixed bytes32
 * @returns {string} tx hash
 */
export async function redeemPositions(conditionId) {
  logger.info('Onchain: redeemPositions', { conditionId });
  try {
    // indexSets = [1, 2]: attempt to redeem outcome-0 AND outcome-1.
    // The contract will only pay out for whichever actually won.
    const tx = await negRiskAdapter().redeemPositions(conditionId, [1, 2], {
      gasLimit: 300_000,
    });
    const receipt = await tx.wait();
    logger.info('Onchain: redeem confirmed', {
      conditionId,
      tx: tx.hash,
      gasUsed: receipt.gasUsed.toString(),
    });
    return tx.hash;
  } catch (err) {
    logger.error('Onchain: redeemPositions failed', { conditionId, err: err.message });
    throw err;
  }
}

/**
 * Poll until the market is resolved (both outcome token positions have been
 * settled) or `timeoutMs` is exceeded. Used by Trader to know when to redeem.
 *
 * Heuristic: if our balance of the winning token changed to 0 (burned on redeem)
 * OR if a well-known "market resolved" event appeared in the receipt — we check
 * by querying the Gamma API in market.js instead. This function just waits.
 */
export async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Returns the on-chain position token IDs for a conditionId by querying
 * the NegRiskAdapter contract.
 */
export async function getPositionIds(conditionId) {
  const adapter = negRiskAdapter();
  const [id0, id1] = await Promise.all([
    adapter.getPositionId(conditionId, 0),
    adapter.getPositionId(conditionId, 1),
  ]);
  return [id0.toString(), id1.toString()];
}
