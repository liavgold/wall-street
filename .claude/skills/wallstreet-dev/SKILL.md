---
name: wallstreet-dev
description: Use this skill when working on the wallstreet-todo project — modifying scanner logic, scoring engine, signals, backtesting, entry filters, financial rules, Telegram alerts, or dashboard. Triggers when user mentions scores, thresholds, signals, BUY_THRESHOLD, RSI, SMA, VIX, backtest, scan, OPPORTUNITIES, sector cap, entry filters, Golden Cross, sentiment divergence, or any trading strategy logic.
version: 1.0.0
user-invocable: false
---

# WallStreet To-Do Dev Skill

Background knowledge applied automatically when working on this project.

## Key Commands

```bash
npm run dev -- --mode=full    # full scan
npm run dev -- --mode=fast    # fast scan
npm run backtest              # TS backtester → logs/backtest_results.json
python src/backtest.py        # institutional backtrader sim
python src/backtest_engine.py # signal-replay backtest
streamlit run dashboard.py    # dashboard (3 tabs)
```

## Scoring System (engine.ts)

| Signal | Points |
|--------|--------|
| RSI 30-45 | +15 |
| Above SMA200 | +15 |
| Strong Buy consensus | +20 |
| Insider buying | +10 |
| AI Bullish | +30 |
| AI Neutral | +15 |
| AI Bearish | +0 |
| Catalyst (major news) | -20 to +20 |
| Volume spike | +15 |
| Rel Strength | +10 / -10 |
| 3M RS underperform | -20 |
| Social spike | +5 |
| Whale tracker | +15 |
| Smart Money | +20 |
| Explosion | +25 |
| EPS growth | +15 |
| Rev growth | +15 |
| PEG < 1.2 | +10 |
| High debt | -20 |

Certainty Index 0-100: EXPLOSIVE > 85

## Backtest Scorer Cap (backtest.ts)

The simplified technical-only scorer in backtest.ts caps at ~80 (no AI/fundamentals):
- BUY_THRESHOLD must be ≤ 67 to generate any trades
- score ≥ 70 = top quintile, rarely hit
- score ≥ 75 = almost never hit
- score ≥ 78 = 0 signals

Current constants: `BUY_THRESHOLD=65`, `TRAIL_ATR_MULT=2.5`, `BREAKEVEN_TRIGGER=0.05`

## Entry Filters (9 gates, backtest.ts)

1. score ≥ BUY_THRESHOLD
2. Breakout confirmed
3. Above SMA10
4. Above SMA200
5. Volume ≥ 120% avg
6. SPY SMA10 > SMA50 (macro filter)
7. RS 3M beats SPY ≥ 5pp
8. Sector heat < 2 (active positions per sector)
9. Capacity < 10 (total open positions)

## Macro Regime Rules

| VIX | Multiplier | BUY Threshold | Label |
|-----|-----------|---------------|-------|
| > 35 | force WATCH | — | EXTREME FEAR |
| > 28 | 0.5x | 85 | MACRO EXTREME REGIME |
| > 25 OR yield inverted | 0.7x | 70 | RECESSION SHIELD |
| ≤ 25 | 1.0x | 70 | Normal |

## Financial Logic Rules (CLAUDE.md)

- **Golden Cross**: 50-day SMA crossing above 200-day SMA → High Priority Buy
- **Sentiment Divergence**: Price UP + Social Sentiment < -0.5 → "Potential Reversal/Take Profit"
- **News Velocity**: news volume > 3x daily average → "High Volatility Alert"

## Sector Cap

- 25% max per sector ETF in OPPORTUNITIES.md
- `checkSectorCap()` in `src/utils/finance.ts`
- Sectors: CYBER(6), SAAS(6), DATA_INFRA(7)

## Key Files

| File | Purpose |
|------|---------|
| `src/analyzers/engine.ts` | Main scoring + AI sentiment |
| `src/fetchers/marketData.ts` | Polygon / Yahoo price + VIX |
| `src/fetchers/socialData.ts` | Finnhub insider / news / fundamentals |
| `src/utils/finance.ts` | Position sizing, sector cap |
| `src/utils/telegram.ts` | Telegram alerts |
| `src/scanner.ts` | Main orchestration loop |
| `src/backtest.ts` | TS backtester (most developed) |
| `dashboard.py` | Streamlit dashboard |

## Signal Output Requirements

Every To-Do action must include:
- `Ticker`
- `Action` (Buy / Sell / Hold)
- `Confidence` (0–1)
- `Reasoning`

## Telegram Triggers

Alerts fire for: `GOLDEN TRADE`, `EXPLOSIVE BUY`, `HIGH CONVICTION` signals.
Uses `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` env vars.
