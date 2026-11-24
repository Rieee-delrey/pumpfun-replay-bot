# pumpfun-replay-bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Rieee-delrey/pumpfun-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Rieee-delrey/pumpfun-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) competition on [make.fun](https://make.fun). The bot trades 10 SOL of paper money on a 24h replay of recorded pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

A launch sniper with a heavy-early-flow filter. The bot watches every coin from its CreateEvent and tracks a per-coin tape: trades, distinct non-creator buyers, net SOL flow over the last 5 slots, creator buys/sells, and the real SOL reserve.

It buys once per coin, only within 3 slots of creation, when all of these hold:

- at least 4 distinct non-creator buyers
- at least 3 trades
- net flow of at least 15 SOL over the last 5 slots
- real SOL reserve between 0.3 and 30 SOL
- creator buys of at most 2.5 SOL, and the creator has not sold

It buys 0.3 SOL per coin (capped by 1% of the real reserve and by free cash minus the transaction fee), with 10000 bps slippage. It sells the whole position on the first of: value at least 1.20x cost, value at most 0.80x cost, 10 slots held, or the creator selling while the position is held. At most 5 open positions.

Fills are paced by the harness fill splitter (fill target 300, 21600s window, base split 1, max split 6, minimum piece 0.002 SOL). The strategy is a pure function of the event batches: no clock, no randomness, no I/O, insertion-ordered iteration only.

## Local results (dev window, 24h)

Graded locally with the kit (`grade-local --driver process`, Docker was unavailable on this machine):

- net PnL: **+0.530 SOL** (return 0.053, 90% interval -0.151 .. 1.165 SOL)
- 30 coins, 30 round trips, 90 fills, win rate 53%, max drawdown 0.020
- at 2x fees: +0.287 SOL
- guardrails met (30 coins with a round trip of at least 0.01 SOL, drawdown ok)

Stress test (20 rebuilt copies of the dev window): median +0.03 SOL, p10 -1.06, p90 +0.44; 9 of 20 lost money; the dev score sits above 18 of 20 copies. The dev number is window-dependent — the final window is fresh, unseen data, so treat it as an upper-ish estimate, not a promise.

## Files

- `main.ts` — entrypoint, runs the bot through the SDK's `runBot`
- `strategy.ts` — the strategy, written fresh from the competition spec
- `vendor/agentfun-bot.ts` — the house SDK, vendored byte-for-byte

## License

MIT
