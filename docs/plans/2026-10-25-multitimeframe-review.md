# Multi-timeframe backtest review implementation plan

**Goal:** Inspect one recorded Jesse trade against synchronized 1m, 3m, 5m and 15m candles without changing trading behavior.

**Architecture:** A same-origin static extension page reads the existing authenticated backtest/session chart endpoints. It aggregates saved 1m candles into complete UTC-aligned higher-timeframe candles and reuses Jesse's bundled Lightweight Charts library. Four charts share a time window and crosshair, and selecting a trade centers every chart at the entry or exit. No strategy, database or backend changes are required.

**Tech Stack:** Browser ES modules, existing Lightweight Charts asset, Node's built-in test runner.

## Design and scope

The user approved attempting the previously proposed four-chart review. Editing the compiled dashboard bundle would be fragile and the dashboard source is absent, so use an additive static page rather than reverse-engineering its Vue components. A future dashboard integration can reuse the data module. A same-origin link opens the recorded backtest again.

Use the existing saved session and its 1m route only. Reject unsupported base intervals instead of inventing candles. Drop incomplete or gapped higher-timeframe buckets, preserve source prices/volume, and disclose omitted buckets. Chart history is retrospective; the information panel must calculate the last *completed* candle as of the selected trade separately. SMA5 before the saved chart's start is unavailable because warmup candles were not exported. The selected context recorded at candle-open timestamps is interpreted as known at that candle's close; do not claim it proves the original signal that created a pending order.

Auth stays in the existing Jesse localStorage `main.authToken` and is sent only to same-origin authenticated POST endpoints. No credentials in URLs, exported files, console output or external requests. Missing auth presents a link back to Jesse login.

## Steps

1. Write Node tests for UTC OHLCV aggregation, gaps/partial buckets, input validation, SMA warmup, closed-candle selection, context timing, synchronized time windows and actual execution markers.
2. Run the tests and observe the missing implementation failure.
3. Implement the pure data helpers and get the tests passing.
4. Build the static page, four chart panels, trade picker, entry/exit navigation, synchronized zoom/pan/crosshair and context/last-closed summaries. Keep HTML updates text-only for session data.
5. Validate the existing bundled chart API and authenticated responses using the actual saved backtest. Install only additive static files into the running container; no process restart, package installation, strategy edits or rerun.
6. Use the browser to verify real candles, four intervals, trade navigation, context timing, zoom synchronization and narrow-layout behavior. Save a screenshot and a verification note.

## Acceptance

- The user's existing recorded backtest opens with all four candle charts and its actual trades.
- Selecting one trade centers all four at one timestamp; each chart shows its own SMA5 and actual entry/exit markers snapped to the containing candle.
- Last-closed values exclude the candle still forming at entry. Chart context is labelled separately from an original order-creation signal.
- The same strategy/backtest results remain unchanged.
- Tests cover missing data and incomplete edges. No restart or new dependency is necessary.

## Delivery / rollback

Serve `/review/index.html?session=<uuid>` under the existing Jesse origin and provide a direct link. The prototype requires an existing 1m chart export and is separate from the compiled dashboard's Trade Chart. New files can be removed to roll back; the original dashboard is untouched. Rebuilding the Docker image replaces the copied extension, so retain source in this repository and document a reproducible copy command.
