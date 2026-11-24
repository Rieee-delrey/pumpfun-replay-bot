// Launch sniper with a heavy-early-flow filter.
//
// Idea: the coins that go on to run 5x or more show it in their first few slots —
// several distinct buyers piling in with heavy net SOL flow — while the rest show a
// trickle. So buy once, early, only when the early tape already looks like a runner:
// at least 4 distinct non-creator buyers, at least 3 trades, and at least 15 SOL of
// net flow over the last 5 slots, on a curve holding 0.3–30 SOL of real SOL, whose
// creator has bought at most 2.5 SOL and has not sold. One build per coin, sized
// 0.3 SOL, split into at most 6 pieces because a single reply may only spend 1% of
// the curve's real reserve. Exit the whole position on the first of: +20%, -20%,
// 10 slots held, or the creator selling while held.
//
// The 15 SOL flow line is the safer variant: on the dev window it trades 30 coins
// instead of 22 (the guardrail needs 20), for a little less net. A quieter final
// window is the risk this buys down.
//
// A build that gets a piece rejected stops at once: the size cap will not allow
// that piece, so sending more pieces for the same coin only burns transaction
// fees. Pure function of the batches: no clock, no randomness, no I/O. Every map
// is iterated in insertion order, so two runs over the same data answer alike.

import type { Batch, BotState, OrderInput } from './vendor/agentfun-bot.ts';

export interface Params {
  minFlowLamports: bigint;
  minBuyers: number;
  maxBuyers: number;
  minTrades: number;
  maxAge: number;
  flowWindow: number;
  stakeLamports: bigint;
  tpBps: number;
  slBps: number;
  buySlippageBps: number;
  sellSlippageBps: number;
  maxHold: number;
  minRealSol: bigint;
  maxRealSol: bigint;
  minDevBuy: bigint;
  maxDevBuy: bigint;
  skipDevSold: boolean;
  exitOnDevSell: boolean;
  fillTarget: number;
  windowSeconds: number;
  baseSplit: number;
  maxSplit: number;
  minPieceLamports: bigint;
}

export const DEFAULT_PARAMS: Params = {
  minFlowLamports: 15_000_000_000n,
  minBuyers: 4,
  maxBuyers: 1_000_000,
  minTrades: 3,
  maxAge: 3,
  flowWindow: 5,
  stakeLamports: 300_000_000n,
  tpBps: 2000,
  slBps: 2000,
  buySlippageBps: 10000,
  sellSlippageBps: 10000,
  maxHold: 10,
  minRealSol: 300_000_000n,
  maxRealSol: 30_000_000_000n,
  minDevBuy: 0n,
  maxDevBuy: 2_500_000_000n,
  skipDevSold: true,
  exitOnDevSell: true,
  fillTarget: 300,
  windowSeconds: 21600,
  baseSplit: 1,
  maxSplit: 6,
  minPieceLamports: 2_000_000n,
};

interface Build {
  remaining: bigint;
  pieces: number;
  decidedSlot: number;
  decidedTime: number | null;
}

interface Tape {
  mint: string;
  creator: string;
  createdSlot: number;
  createdTime: number | null;
  complete: boolean;
  trades: number;
  buyers: Set<string>;
  creatorBuys: bigint;
  creatorSold: boolean;
  /** Signed net SOL flow per slot (buys positive, sells negative). */
  flowBySlot: Map<number, bigint>;
  /** True once the coin was triggered or aged out: never evaluated again. */
  decided: boolean;
  build: Build | null;
  /** Slot the first buy of the current trip filled, for the hold clock. */
  firstFillSlot: number | null;
  /** A sell fired: send no more pieces for this coin. */
  exiting: boolean;
}

const BPS = 10_000n;

export function createStrategy(params: Params = DEFAULT_PARAMS) {
  const tapes = new Map<string, Tape>();
  /** Open builds in the order they were decided. */
  const builds: Tape[] = [];
  let fillsSeen = 0;

  function tapeFor(mint: string): Tape | undefined {
    return tapes.get(mint);
  }

  function flowOverWindow(t: Tape, slot: number): bigint {
    let total = 0n;
    for (let s = slot - params.flowWindow + 1; s <= slot; s++) {
      total += t.flowBySlot.get(s) ?? 0n;
    }
    return total;
  }

  function positionValue(state: BotState, mint: string, tokens: bigint): bigint | null {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return null;
    if (curve.virtual_token_reserves <= 0n) return null;
    return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now =
      batch.events.length > 0 ? (batch.events[0]!.block_time ?? null) : null;

    // Fold this batch's events into the per-coin tape.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!tapes.has(e.mint)) {
          tapes.set(e.mint, {
            mint: e.mint,
            creator: e.creator,
            createdSlot: e.slot,
            createdTime: e.block_time ?? null,
            complete: false,
            trades: 0,
            buyers: new Set<string>(),
            creatorBuys: 0n,
            creatorSold: false,
            flowBySlot: new Map<number, bigint>(),
            decided: false,
            build: null,
            firstFillSlot: null,
            exiting: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const t = tapes.get(e.mint);
        if (t === undefined) continue;
        t.trades += 1;
        const signed = e.is_buy ? BigInt(e.sol_amount) : -BigInt(e.sol_amount);
        t.flowBySlot.set(e.slot, (t.flowBySlot.get(e.slot) ?? 0n) + signed);
        if (e.user === t.creator) {
          if (e.is_buy) t.creatorBuys += BigInt(e.sol_amount);
          else t.creatorSold = true;
        } else if (e.is_buy) {
          t.buyers.add(e.user);
        }
      } else {
        const t = tapes.get(e.mint);
        if (t !== undefined) {
          t.complete = true;
          if (t.build !== null) t.build = null;
        }
      }
    }

    // Note our own fills: buy fills start the hold clock, and a rejected buy
    // closes its build — the size cap will not allow that piece, so retrying
    // it on later batches only burns transaction fees.
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) fillsSeen += 1;
      if (f.side === 'buy' && f.status === 'filled') {
        const t = tapes.get(f.mint);
        if (t !== undefined && t.firstFillSlot === null) t.firstFillSlot = f.slot;
      }
      if (f.side === 'buy' && f.status === 'rejected') {
        const t = tapes.get(f.mint);
        if (t !== undefined && t.build !== null) t.build = null;
      }
    }

    const orders: OrderInput[] = [];
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // 1. Exits: sell the whole position on the first trigger that fires.
    for (const [mint, pos] of state.positions) {
      const t = tapeFor(mint);
      if (pos.token_amount <= 0n) continue;
      const value = positionValue(state, mint, pos.token_amount);
      if (value === null) continue;
      const cost = pos.cost_lamports;
      const takeProfit = value * BPS >= cost * BigInt(BPS + BigInt(params.tpBps));
      const stopLoss = value * BPS <= cost * BigInt(BPS - BigInt(params.slBps));
      const heldTooLong =
        t !== undefined &&
        t.firstFillSlot !== null &&
        state.slot - t.firstFillSlot >= params.maxHold;
      const devSold = params.exitOnDevSell && t !== undefined && t.creatorSold;
      if (!takeProfit && !stopLoss && !heldTooLong && !devSold) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: params.sellSlippageBps,
      });
      if (t !== undefined) {
        t.exiting = true;
        t.build = null;
        t.firstFillSlot = null;
      }
    }

    // 2. Keep building open positions, one piece per coin per batch.
    for (const t of builds) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (t.build === null || t.exiting || t.complete) continue;
      if (t.build.pieces >= params.maxSplit) {
        t.build = null;
        continue;
      }
      if (
        t.build.decidedTime !== null &&
        now !== null &&
        now - t.build.decidedTime > params.windowSeconds
      ) {
        t.build = null;
        continue;
      }
      const curve = state.curves.get(t.mint);
      if (curve === undefined || curve.complete) continue;
      const cap = state.maxBuyLamports(t.mint);
      let size = t.build.remaining;
      if (size > cap) size = cap;
      if (size > free - tx) size = free - tx;
      if (size < params.minPieceLamports) continue;
      orders.push({
        side: 'buy',
        mint: t.mint,
        quote_lamports: size,
        max_slippage_bps: params.buySlippageBps,
      });
      free -= size + tx;
      t.build.remaining -= size;
      t.build.pieces += 1;
      if (t.build.remaining < params.minPieceLamports) t.build = null;
    }

    // 3. New triggers: coins still inside their age window that have not been decided.
    if (fillsSeen < params.fillTarget) {
      for (const e of batch.events) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (slots <= 0) break;
        const t = tapes.get(e.mint);
        if (t === undefined || t.decided || t.complete || t.build !== null) continue;
        const age = state.slot - t.createdSlot;
        if (age < 0 || age > params.maxAge) {
          if (age > params.maxAge) t.decided = true;
          continue;
        }
        const curve = state.curves.get(e.mint);
        if (curve === undefined || curve.complete) continue;
        const flow = flowOverWindow(t, state.slot);
        const realSol = curve.real_quote_reserves;
        const passes =
          t.buyers.size >= params.minBuyers &&
          t.buyers.size <= params.maxBuyers &&
          t.trades >= params.minTrades &&
          flow >= params.minFlowLamports &&
          realSol >= params.minRealSol &&
          realSol <= params.maxRealSol &&
          t.creatorBuys >= params.minDevBuy &&
          t.creatorBuys <= params.maxDevBuy &&
          (!params.skipDevSold || !t.creatorSold);
        if (!passes) continue;
        t.decided = true;
        const build: Build = {
          remaining: params.stakeLamports,
          pieces: 0,
          decidedSlot: state.slot,
          decidedTime: now,
        };
        t.build = build;
        builds.push(t);
        slots -= 1;
        // First piece goes out in this same batch when the cap allows it.
        const cap = state.maxBuyLamports(t.mint);
        let size = build.remaining;
        if (size > cap) size = cap;
        if (size > free - tx) size = free - tx;
        if (size < params.minPieceLamports) continue;
        orders.push({
          side: 'buy',
          mint: t.mint,
          quote_lamports: size,
          max_slippage_bps: params.buySlippageBps,
        });
        free -= size + tx;
        build.remaining -= size;
        build.pieces += 1;
        if (build.remaining < params.minPieceLamports) t.build = null;
      }
    }

    return orders;
  }

  return { onBatch };
}
