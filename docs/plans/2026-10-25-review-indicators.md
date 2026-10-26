# Configurable review charts implementation plan

**Goal:** Let users choose additional timeframes and add/remove/configure main-chart and separate-pane indicators while reviewing the same recorded trades.

**Architecture:** Extend the existing additive static review page. Discover configured intervals from the selected session's trading/data routes and offer Jesse's fixed minute/hour/day intervals. Preserve the saved 1m chart as the sole input. Keep display indicator settings in a versioned localStorage key, independently of Jesse strategy/configuration. All selected intervals share indicator definitions but calculate values on their own candles. Auxiliary panes use separate Lightweight Charts instances linked to the candle charts.

**Tech Stack:** Existing browser ES modules, bundled Lightweight Charts, Node built-in test runner. No new packages or backend/strategy changes.

## Design

The user approved selectable periods and requested main/subchart indicators. Use one global indicator editor for all selected periods: choose type, adjust periods/deviation and color, then add; existing rows can be edited or removed. Main overlays: SMA, EMA, Bollinger Bands. Separate panes: RSI, MACD, ATR, volume. Retain SMA5 as the initial overlay. Do not interpret this as executing arbitrary user Python/Pine code.

A maximum of four selected timeframes keeps the layout usable; all configured timeframes remain selectable. Initial selection prefers the configured periods, retaining the 1m source route and the largest three when there are more than four. Offer all fixed Jesse intervals up to 1D, marking those configured by the strategy. Empty/insufficient higher-period data produces an explanation instead of breaking the entire page. Auxiliary panes share the parent period's full timestamp domain (whitespace during warmup) so their panning matches even before the first valid indicator value.

Calculate display indicators using explicit conventions confirmed against the installed Jesse: EMA starts from the first close; Wilder RSI/ATR; Bollinger SMA and population standard deviation; MACD DIF=fast EMA minus slow EMA, DEA=signal EMA, histogram=DIF−DEA (not doubled). Flat RSI follows Jesse's zero-loss convention of 100. Test deterministic Rust-generated fixtures and causal prefixes. Indicator tooltips/README disclose conventions and missing exported warmup. EMA initialization was revised from the initial SMA-seed proposal after inspecting the actual installed implementation.

Persist only validated display settings. Allow recovery from invalid/old browser settings. Rebuild charts after changing display settings without refetching data or changing the selected trade, event anchor or time window. Apply indicator settings to all selected periods. Continue displaying the fixed strategy-reference SMA5/as-of summary independently of optional overlays.

## Implementation steps

1. Add failing pure tests for configured timeframe discovery, validated preferences, period parsing and numerical indicator values/warmup/gaps/causality.
2. Implement settings/indicator modules and pass tests. Compare at least deterministic fixtures to the installed Jesse indicators, document any initialization differences.
3. Add accessible period picker and indicator editor (type/parameters/color/edit/remove), preserving selection on rebuild and localStorage.
4. Add main overlays and auxiliary panes, including value legends, thresholds and no-data states. Preserve synchronized timestamp domains, trade markers and as-of summaries.
5. Review code for formula, timing, storage, indicator-gap and synchronization regressions. Address important findings.
6. Copy only extension static files into the running container; no restart. Verify actual saved backtest, select a new period, add/edit/remove indicators on main/subcharts, verify persistence and real-data rendering, then save screenshots and update README/verification notes.

## Acceptance

- 30m/1h/4h/1D can be selected in addition to configured 1m/3m/5m/15m; no more than four are displayed.
- Users can add multiple main overlays and separate indicators, change parameters/colors, and remove them.
- Settings survive reload; invalid settings recover safely. No credentials or trading settings are written.
- Existing trade selection, entry/exit navigation, markers, completed-candle summaries and time linking continue to work.
- Source and currently installed copy are consistent; strategy and recorded result stay unchanged.
