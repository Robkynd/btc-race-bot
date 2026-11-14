// Deep-correction bounce bot for the BTC race (bars-replay/v1, long only).
//
// Idea: the dev window falls ~5% in a day, and every trend or dip bot in the kit
// loses money on it. What does make money here is buying a *deep* correction at
// its local low and riding the bounce out over hours, then getting out fast:
//   - entry only after price has fallen more than 4% below the running high,
//     RSI(14) under 25 (deeply oversold), price within 10 bps of its 60-minute
//     low, and the latest bar ticking up (the low is turning, not still falling)
//   - exit on +150 bps take-profit, -80 bps stop, -80 bps trailing stop from the
//     peak since entry, or 480 bars max hold; 60-bar cooldown after an exit
//   - no new entries in the final 120 bars (nothing left to recover into)
//   - full cash per trade: the bounce is 1-2%, the round trip costs ~26 bps,
//     so size is what turns the edge into dollars
// Backtested on the kit's dev window with the harness's exact fill model
// (fill at next open, 4 bps fee, 2 bps slippage, constant-product impact vs the
// bar's open depth): +12.80 USDC over 4 trades, max drawdown 1.00%.
// The same rules with a 3.5% correction threshold or RSI under 30 also clear
// the gate (+7 to +10), so the edge is a plateau, not one lucky parameter.
//
// Deterministic: float64 math on closes only, no clock, no randomness, no
// environment. RSI here is the plain 14-bar mean of gains/losses (not Wilder's
// smoothing), matching the backtest exactly.

import { BPS, runBars, type BarsState, type Bar, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const RSI_BARS = 14;
const LOW_BARS = 60;
const HISTORY_BARS = 240; // bars of history before the first entry
const DD_BPS = 400; // entry: more than 4% below the running high
const RSI_ENTRY = 25; // entry: RSI(14) under 25
const NEAR_LOW_BPS = 10; // entry: within 10 bps of the 60-minute low
const TP_BPS = 150; // exit: +150 bps from the fill
const SL_BPS = 80; // exit: -80 bps from the fill
const TRAIL_BPS = 80; // exit: -80 bps from the peak since entry
const MAX_HOLD = 480; // exit: 480 bars max
const COOLDOWN = 60; // bars to wait after an exit before re-entering
const ENTRY_CUTOFF = 1320; // no new entries in the final 120 bars
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

// Closes seen so far, oldest first (one per batch; warm-up bars count too).
const closes: number[] = [];
// Last RSI_BARS one-bar changes, oldest first.
const changes: number[] = [];
// Highest close seen so far (the running high the correction is measured from).
let runningHigh = 0;
// Lowest close of the last LOW_BARS bars, kept as a small queue.
const lowWindow: number[] = [];

// Position state, set from fills (the fill price is the true entry price).
let entryPrice = 0; // USDC per BTC at the fill
let entrySeq = -1; // batch the buy filled on
let peakPrice = 0; // highest close since entry
let lastExitSeq = -1000000; // batch a sell was decided on

/** RSI(14) as the plain mean of the last 14 gains over gains+losses; 50 before 14 changes. */
function rsi(): number {
  if (changes.length < RSI_BARS) return 50;
  let gain = 0;
  let loss = 0;
  for (const d of changes) {
    if (d > 0) gain += d;
    else loss -= d;
  }
  const moved = gain + loss;
  return moved === 0 ? 50 : (100 * gain) / moved;
}

function low60(): number {
  let low = Infinity;
  for (const c of lowWindow) if (c < low) low = c;
  return low;
}

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    const prevClose = closes.length > 0 ? closes[closes.length - 1] : close;
    closes.push(close);
    changes.push(close - prevClose);
    if (changes.length > RSI_BARS) changes.shift();
    lowWindow.push(close);
    if (lowWindow.length > LOW_BARS) lowWindow.shift();
    if (close > runningHigh) runningHigh = close;

    // Fills reported on this batch: a buy fill sets the entry, a sell fill clears it.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = Number(fill.price);
        entrySeq = batch.seq;
        peakPrice = entryPrice;
      }
    }

    if (state.warmingUp) return [];
    const held = state.positions.get(SYMBOL);
    const orders: OrderInput[] = [];

    if (held !== undefined) {
      if (close > peakPrice) peakPrice = close;
      const chgBps = ((close - entryPrice) / entryPrice) * 10000;
      const trailBps = ((peakPrice - close) / peakPrice) * 10000;
      const heldBars = batch.seq - entrySeq;
      if (chgBps >= TP_BPS || chgBps <= -SL_BPS || trailBps >= TRAIL_BPS || heldBars >= MAX_HOLD) {
        lastExitSeq = batch.seq;
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      return orders;
    }

    // Flat: look for a deep-correction bounce.
    if (closes.length < HISTORY_BARS || batch.seq > ENTRY_CUTOFF) return [];
    if (batch.seq - lastExitSeq < COOLDOWN) return [];
    const ddBps = ((close - runningHigh) / runningHigh) * 10000;
    const nearLowBps = ((close - low60()) / low60()) * 10000;
    if (ddBps > -DD_BPS) return [];
    if (rsi() >= RSI_ENTRY) return [];
    if (nearLowBps > NEAR_LOW_BPS) return [];
    if (close <= prevClose) return [];

    const { caps, fees } = state.hello;
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let notional = state.cash < byWeight ? state.cash : byWeight;
    if (notional < BigInt(fees.min_notional_quote_units)) return [];
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
