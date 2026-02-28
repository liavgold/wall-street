/**
 * WallStreet TS Backtester
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches 2 years of daily OHLCV from Polygon.io for all 50 tickers + SPY,
 * runs a simplified technical-only scoring pass over each historical window,
 * simulates BUY→hold→EXIT trades, and writes logs/backtest_results.json with:
 *   total_return, spy_return, alpha_vs_spy, max_drawdown, win_rate,
 *   profit_factor, data_points, generated_at, rows (per-trade detail).
 *
 * Run: npm run backtest
 */

import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import axios from "axios";

import {
  DailyPrice,
  calculateRSIFromPrices,
  analyzeVolume,
  calculateRelativeStrength,
  calculate3MonthRelativeStrength,
  calculateWeeklyTrend,
  delay,
} from "./fetchers/marketData";
import { scoreTechnical, detectExplosion } from "./analyzers/engine";

// ── Config ───────────────────────────────────────────────────────────────────

const TICKERS = [
  "NVDA", "TSLA", "AMD", "PLTR", "MSTR", "SMCI", "PANW", "ELF", "CRWD", "SNOW",
  "NET",  "DDOG", "COIN", "MELI", "TTD",  "SHOP", "SQ",   "AFRM", "HOOD", "RBLX",
  "UBER", "ABNB", "DASH", "DUOL", "MNDY", "ZS",   "OKTA", "BILL", "HUBS", "GDDY",
  "TEAM", "MDB",  "ESTC", "IOT",  "CFLT", "TOST", "APP",  "CELH", "ONON", "DECK",
  "AXON", "TW",   "FICO", "LULU", "WDAY", "ADSK", "FTNT", "ARM",  "AAPL", "MSFT",
];

const HOLD_DAYS              = 21;   // standard hold window
const MAX_HOLD_DAYS          = 63;   // absolute max hold for tier2-locked winners (~3 months)
const BUY_THRESHOLD          = 65;   // quality floor — entry filters do the heavy lifting
const ATR_STOP_MULT          = 1.5;  // stop = 1.5× ATR14 below entry
const MAX_STOP_PCT           = 0.08; // ATR stop capped at 8%
const BREAKEVEN_TRIGGER      = 0.05; // tier-1: raise stop to break-even once +5% gained
const TRAIL_LOCK_TRIGGER     = 0.15; // tier-2: lock in +10% floor once +15% is reached
const TRAIL_LOCK_FLOOR       = 0.10; // the locked profit floor for tier-2
const TRAIL_UNLIMITED_TRIGGER = 0.25; // tier-3: activate unlimited trailing once +25% hit
const TRAIL_UNLIMITED_STOP   = 0.10; // tier-3: 10% trailing stop below running peak
const POSITION_SIZE          = 0.05; // standard 5% per trade
const POWER_POSITION_SIZE    = 0.075; // 7.5% for near-max-score signals
const POWER_SCORE_THRESHOLD  = 70;   // score at which pyramid sizing activates
const POWER_PLAY_RS_MIN      = 10;   // RS3M margin (pp) needed to earn a power play re-entry
const MIN_HOLD_DAYS          = 2;    // volatility buffer: stop-loss deferred for first 2 days
const CATASTROPHIC_STOP      = 0.10; // override MIN_HOLD_DAYS if price drops > 10% intraday
const VOL_CONFIRM_MULT       = 1.20; // breakout volume must be ≥ 120% of 10-day avg
const RS3M_LEAD_MIN          = 5;    // ticker must beat SPY by ≥ 5pp over 3 months
const SECTOR_MAX_OPEN        = 2;    // max concurrent sector entries within a hold window
const STARTING_CASH = 100_000;
const RATE_LIMIT_MS = 15000;   // ms between Polygon requests (free-tier safe)

const LOGS_DIR    = path.resolve(process.cwd(), "logs");
const CACHE_DIR   = path.resolve(LOGS_DIR, "price_cache");
const OUTPUT_PATH = path.resolve(LOGS_DIR, "backtest_results.json");

const TWO_YEARS_AGO = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 2);
  return d.toISOString().split("T")[0];
})();
const TODAY = new Date().toISOString().split("T")[0];

// ── Polygon API key ────────────────────────────────────────────────────────────

const POLYGON_KEY = process.env.POLYGON_API_KEY;
if (!POLYGON_KEY) {
  console.error("POLYGON_API_KEY is not set in .env");
  process.exit(1);
}

// Polygon REST base — uses plain axios to avoid the ESM-only @polygon.io/client-js
const POLYGON_BASE = "https://api.polygon.io";

// ── Types ──────────────────────────────────────────────────────────────────────

type ExitReason = "TIME" | "STOP_LOSS" | "TRAIL_STOP";

interface TradeRow {
  ticker:     string;
  date:       string;    // entry date
  action:     string;
  pct_change: number;
  win:        boolean;
  entryPrice: number;
  exitPrice:  number;
  exitDate:   string;
  exitReason: ExitReason;
}

interface BacktestResults {
  generated_at:  string;
  start_date:    string;
  end_date:      string;
  data_points:   number;
  win_rate:      number;
  profit_factor: number;
  alpha_vs_spy:  number;
  total_return:  number;
  spy_return:    number;
  max_drawdown:  number;
  rows:          TradeRow[];
}

// ── Disk cache ─────────────────────────────────────────────────────────────────

interface CacheFile { fetchedAt: number; prices: DailyPrice[] }

function cachePath(ticker: string): string {
  return path.join(CACHE_DIR, `${ticker}.json`);
}

function readCache(ticker: string): DailyPrice[] | null {
  const p = cachePath(ticker);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as CacheFile;
    if (Date.now() - raw.fetchedAt > 24 * 60 * 60 * 1000) return null; // stale after 24 h
    return raw.prices;
  } catch {
    return null;
  }
}

function writeCache(ticker: string, prices: DailyPrice[]): void {
  const data: CacheFile = { fetchedAt: Date.now(), prices };
  fs.writeFileSync(cachePath(ticker), JSON.stringify(data, null, 2));
}

// ── Polygon bar fetcher (plain axios — no ESM conflict) ────────────────────────

interface PolygonBar { o: number; h: number; l: number; c: number; v: number; t: number }
interface PolygonAggResp { results?: PolygonBar[]; status?: string; message?: string }

async function fetchBars(ticker: string): Promise<DailyPrice[]> {
  const cached = readCache(ticker);
  if (cached) {
    console.log(`  [cache]   ${ticker.padEnd(5)} ${cached.length} days`);
    return cached; // no rate-limit delay for cache hits
  }

  try {
    const url =
      `${POLYGON_BASE}/v2/aggs/ticker/${ticker}/range/1/day` +
      `/${TWO_YEARS_AGO}/${TODAY}` +
      `?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY!}`;

    const resp = await axios.get<PolygonAggResp>(url, { timeout: 20_000 });
    const bars  = resp.data.results ?? [];
    const prices: DailyPrice[] = bars
      .map(b => ({
        date:   new Date(b.t).toISOString().split("T")[0],
        open:   b.o,
        high:   b.h,
        low:    b.l,
        close:  b.c,
        volume: b.v,
      }))
      .filter(p => p.open > 0 && p.close > 0);

    writeCache(ticker, prices);
    console.log(`  [polygon] ${ticker.padEnd(5)} ${prices.length} days`);
    await delay(RATE_LIMIT_MS); // rate-limit only on real network requests
    return prices;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [error]   ${ticker} FAILED: ${msg}`);
    return [];
  }
}

// ── Simplified technical-only score (no AI / no Finnhub) ──────────────────────
// Reuses scoreTechnical + detectExplosion from engine.ts, plus helper functions
// from marketData.ts. Max achievable score ≈ 80.

function simplifiedScore(priceWindow: DailyPrice[], spyWindow: DailyPrice[]): number {
  if (priceWindow.length < 30) return 0;

  const rsi  = calculateRSIFromPrices(priceWindow);
  const tech = scoreTechnical(priceWindow, rsi);   // RSI +15, SMA200 +15
  const vol  = analyzeVolume(priceWindow);
  const rs   = calculateRelativeStrength(priceWindow, spyWindow);
  const rs3m = calculate3MonthRelativeStrength(priceWindow, spyWindow);
  const wt   = calculateWeeklyTrend(priceWindow);
  const expl = detectExplosion(priceWindow, vol);   // VCP / near-high / vol-spark

  let score = tech.score;

  if (vol?.status === "High")    score += 15;   // volume confirmation
  if (rs?.outperforming)         score += 10;   // 1-day outperform SPY
  if (rs?.relativeWeakness)      score -= 10;   // 1-day weakness vs SPY
  if (rs3m?.underperforming)     score -= 20;   // 3-month underperform penalty
  if (expl.triggered)            score += 25;   // explosion pattern

  // Safety caps (mirrors engine.ts logic)
  if (vol?.status === "Low" && score > 60) score = 60;
  if (wt && !wt.bullish && score > 50)     score = 50;  // below 20-week SMA

  return score;
}

// ── 10-day SMA (anti-falling-knife filter) ────────────────────────────────────

function calc10DaySMA(prices: DailyPrice[]): number | null {
  if (prices.length < 10) return null;
  const last10 = prices.slice(-10);
  return last10.reduce((sum, p) => sum + p.close, 0) / 10;
}

// ── 20-day SMA (power play re-entry signal) ───────────────────────────────────

function calc20DaySMA(prices: DailyPrice[]): number | null {
  if (prices.length < 20) return null;
  const last20 = prices.slice(-20);
  return last20.reduce((sum, p) => sum + p.close, 0) / 20;
}

// ── 14-day ATR for volatility-adjusted stop ───────────────────────────────────
// Returns the 14-bar simple ATR. Falls back to 2% of close if data is thin.

function calcATR14(prices: DailyPrice[]): number {
  if (prices.length < 15) return prices[prices.length - 1].close * 0.02;
  let trSum = 0;
  for (let k = prices.length - 14; k < prices.length; k++) {
    const high      = prices[k].high;
    const low       = prices[k].low;
    const prevClose = prices[k - 1].close;
    trSum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return trSum / 14;
}

// ── Sector heat-map — prevents over-clustering in the same theme ──────────────
// Tickers with no mapping get a unique solo bucket so they never block each other.

const SECTOR_GROUPS: Record<string, string> = {
  // AI / Semiconductors
  NVDA: "AI_SEMI",  AMD: "AI_SEMI",  ARM: "AI_SEMI",  SMCI: "AI_SEMI",
  // Fintech / Crypto
  COIN: "FINTECH",  MSTR: "FINTECH", HOOD: "FINTECH", AFRM: "FINTECH", SQ: "FINTECH",
  TW:   "FINTECH",  FICO: "FINTECH",
  // Cloud / Cybersecurity
  NET:  "CLOUD",  DDOG: "CLOUD",  ZS:   "CLOUD",  OKTA: "CLOUD",  PANW: "CLOUD",
  CRWD: "CLOUD",  SNOW: "CLOUD",  HUBS: "CLOUD",  WDAY: "CLOUD",  ADSK: "CLOUD",
  BILL: "CLOUD",  MNDY: "CLOUD",  MDB:  "CLOUD",  ESTC: "CLOUD",  IOT:  "CLOUD",
  CFLT: "CLOUD",  TOST: "CLOUD",  TEAM: "CLOUD",  FTNT: "CLOUD",
  // Consumer / Lifestyle
  CELH: "CONSUMER", ONON: "CONSUMER", DECK: "CONSUMER", LULU: "CONSUMER", ELF: "CONSUMER",
  // Mobility / Gig
  UBER: "MOBILITY", ABNB: "MOBILITY", DASH: "MOBILITY",
  // E-commerce
  SHOP: "ECOMM", MELI: "ECOMM",
  // Big Tech
  AAPL: "BIG_TECH", MSFT: "BIG_TECH",
  // Specialty (solo)
  TSLA: "EV",  PLTR: "DATA_GOV", APP: "ADTECH", TTD: "ADTECH",
  AXON: "GOV_TECH", RBLX: "GAMING", DUOL: "EDTECH", GDDY: "WEB_INFRA",
};

// ── Max Drawdown ─────────────────────────────────────────────────────────────

function calcMaxDrawdown(curve: number[]): number {
  let peak  = curve[0] ?? STARTING_CASH;
  let maxDD = 0;
  for (const val of curve) {
    if (val > peak) peak = val;
    const dd = (peak - val) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return parseFloat((-maxDD * 100).toFixed(2));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runBacktest(): Promise<void> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR,  { recursive: true });

  console.log(`\nWallStreet TS Backtester`);
  console.log(`Period  : ${TWO_YEARS_AGO} → ${TODAY}`);
  console.log(`Tickers : ${TICKERS.length} + SPY`);
  console.log(`Threshold : score ≥ ${BUY_THRESHOLD}  |  Hold: ${HOLD_DAYS}d (${MAX_HOLD_DAYS}d for winners)  |  Position: ${POSITION_SIZE * 100}% / ${POWER_POSITION_SIZE * 100}%`);
  console.log(`Stop-Loss : ATR14 × ${ATR_STOP_MULT} (max -${(MAX_STOP_PCT * 100).toFixed(0)}%)  |  No hard take-profit — unlimited trailing`);
  console.log(`Trailing  : +${(BREAKEVEN_TRIGGER*100).toFixed(0)}% → break-even  |  +${(TRAIL_LOCK_TRIGGER*100).toFixed(0)}% → lock +${(TRAIL_LOCK_FLOOR*100).toFixed(0)}%  |  +${(TRAIL_UNLIMITED_TRIGGER*100).toFixed(0)}% → ${(TRAIL_UNLIMITED_STOP*100).toFixed(0)}%-from-peak trail`);
  console.log(`Re-entry  : Power Play after leader stop-out (RS3M ≥ ${POWER_PLAY_RS_MIN}pp) on SMA20 reclaim + vol`);
  console.log(`Entry     : score ≥ ${BUY_THRESHOLD}  AND  close > prior-day high  AND  close > SMA10`);
  console.log(`          : volume ≥ ${((VOL_CONFIRM_MULT - 1) * 100).toFixed(0)}% above 10-day avg  AND  SPY above SMA50`);
  console.log(`          : 3M RS beats SPY by ≥ ${RS3M_LEAD_MIN}pp  AND  sector heat < ${SECTOR_MAX_OPEN} open\n`);

  // ── 1. Fetch all bars ───────────────────────────────────────────────────────
  console.log("── Fetching price data ──────────────────────────────────────");
  const priceMap = new Map<string, DailyPrice[]>();

  priceMap.set("SPY", await fetchBars("SPY"));

  for (const ticker of TICKERS) {
    priceMap.set(ticker, await fetchBars(ticker));
  }

  // ── 2. SPY buy-and-hold return (benchmark) ─────────────────────────────────
  const spyAll = priceMap.get("SPY") ?? [];
  const spyReturn =
    spyAll.length >= 2
      ? parseFloat(
          (((spyAll[spyAll.length - 1].close - spyAll[0].close) / spyAll[0].close) * 100).toFixed(2),
        )
      : 0;

  // ── 3. Simulate trades ─────────────────────────────────────────────────────
  console.log("\n── Simulating trades ────────────────────────────────────────");

  const allTrades: TradeRow[] = [];
  const equityCurve: number[] = [STARTING_CASH];
  let portfolioCash = STARTING_CASH;
  let totalGains  = 0;
  let totalLosses = 0;

  // Sector heat-map: tracks entry dates per sector across all tickers
  // so we never hold more than SECTOR_MAX_OPEN concurrent positions in the same theme.
  const sectorEntryDates = new Map<string, string[]>();

  for (const ticker of TICKERS) {
    const prices = priceMap.get(ticker) ?? [];

    if (prices.length < 220) {
      console.log(`  ${ticker.padEnd(6)} skipped (${prices.length} days, need ≥ 220)`);
      continue;
    }

    let inTrade              = false;
    let entryIdx             = 0;
    let entryPrice           = 0;
    let currentStop          = 0;     // trailing stop level
    let peakPrice            = 0;     // highest price seen during the trade
    let unlimitedTrailActive = false; // true once +25% is reached
    let tier2Locked          = false; // true once +15% is reached (extends hold, locks +10%)
    let powerPlayEligible    = false; // true after a leader (RS>10pp) is stopped out
    let entryRs3mMargin      = 0;     // RS3M advantage at entry (for power play check)
    let tradePositionSize    = STARTING_CASH * POSITION_SIZE; // per-trade capital
    let count                = 0;

    for (let i = 200; i < prices.length - 1; i++) {
      if (!inTrade) {
        // Build aligned SPY window (same relative length)
        const spyWindow = spyAll.slice(0, Math.min(i + 1, spyAll.length));
        const score     = simplifiedScore(prices.slice(0, i + 1), spyWindow);

        if (score >= BUY_THRESHOLD) {
          // ── Entry filter 1: Breakout confirmation ────────────────────────
          // Current close must exceed the prior day's high — confirms breakout,
          // avoids entering on a mid-pullback score spike.
          const breakoutConfirmed = prices[i].close > prices[i - 1].high;

          // ── Entry filter 2: 10-day SMA filter ────────────────────────────
          // Price must be above the 10-day SMA — avoids buying falling knives.
          const sma10      = calc10DaySMA(prices.slice(0, i + 1));
          const aboveSma10 = sma10 !== null && prices[i].close > sma10;

          // ── Entry filter 3: Volume confirmation ──────────────────────────
          // Breakout day volume must be ≥ 120% of the prior 10-day avg volume.
          // No "low volume" breakouts — they fail to follow through.
          const volLookback     = prices.slice(Math.max(0, i - 10), i);
          const avgVol10        = volLookback.length > 0
            ? volLookback.reduce((sum, p) => sum + p.volume, 0) / volLookback.length
            : 0;
          const volumeConfirmed = avgVol10 > 0 && prices[i].volume >= avgVol10 * VOL_CONFIRM_MULT;

          // ── Entry filter 4: Market regime filter ─────────────────────────
          // Only enter if SPY is trading above its 50-day SMA.
          // We don't buy even the best stock in a market downtrend.
          const spySMA50Confirmed = (() => {
            if (spyWindow.length < 50) return false;
            const sma50 = spyWindow.slice(-50).reduce((s, p) => s + p.close, 0) / 50;
            return spyWindow[spyWindow.length - 1].close >= sma50;
          })();

          // ── Entry filter 5: Sector leader — 3M RS must beat SPY by ≥ 5pp ─
          // Only the strongest stocks within their own theme qualify.
          const rs3mEntry    = calculate3MonthRelativeStrength(prices.slice(0, i + 1), spyWindow);
          const leadsMarket  = rs3mEntry !== null &&
            (rs3mEntry.tickerChange3M - rs3mEntry.spyChange3M) >= RS3M_LEAD_MIN;

          // ── Entry filter 6: Sector heat — no more than SECTOR_MAX_OPEN ────
          // Prevents over-clustering in the same theme in the same window.
          const sector      = SECTOR_GROUPS[ticker] ?? `SOLO_${ticker}`;
          const sectorDates = sectorEntryDates.get(sector) ?? [];
          const signalDate  = prices[i].date;
          const signalMs    = new Date(signalDate).getTime();
          const recentCount = sectorDates.filter(d => {
            const diffDays = (signalMs - new Date(d).getTime()) / 86_400_000;
            return diffDays >= 0 && diffDays <= HOLD_DAYS * 1.5; // ~30 calendar days
          }).length;
          const sectorCool  = recentCount < SECTOR_MAX_OPEN;

          if (breakoutConfirmed && aboveSma10 && volumeConfirmed &&
              spySMA50Confirmed && leadsMarket && sectorCool) {
            // Enter at next-day open to avoid look-ahead bias
            entryIdx             = i + 1;
            entryPrice           = prices[entryIdx].open;
            peakPrice            = entryPrice;
            tier2Locked          = false;
            unlimitedTrailActive = false;

            // ── Volatility-adjusted stop: 1.5× ATR14, capped at MAX_STOP_PCT ──
            const atr14       = calcATR14(prices.slice(0, i + 1));
            const atrStopDist = (atr14 * ATR_STOP_MULT) / entryPrice;
            const stopPct     = Math.min(atrStopDist, MAX_STOP_PCT);
            currentStop = entryPrice * (1 - stopPct);

            // ── Pyramid sizing: near-max score earns 7.5%, rest get 5% ───────
            tradePositionSize = score >= POWER_SCORE_THRESHOLD
              ? STARTING_CASH * POWER_POSITION_SIZE
              : STARTING_CASH * POSITION_SIZE;

            // Store RS3M margin so exit logic can decide on power play eligibility
            entryRs3mMargin = rs3mEntry !== null
              ? rs3mEntry.tickerChange3M - rs3mEntry.spyChange3M
              : 0;

            // Register this sector entry so future tickers see it
            sectorEntryDates.set(sector, [...sectorDates, signalDate]);
            inTrade = true;
          }

          // ── Power Play re-entry ─────────────────────────────────────────────
          // After a strong leader (RS3M > 10pp) is stopped out, watch for a
          // single re-entry when price reclaims the 20-day SMA on high volume.
          if (!inTrade && powerPlayEligible) {
            const sma20      = calc20DaySMA(prices.slice(0, i + 1));
            const aboveSma20 = sma20 !== null && prices[i].close > sma20;
            const ppLookback = prices.slice(Math.max(0, i - 10), i);
            const ppAvgVol   = ppLookback.length > 0
              ? ppLookback.reduce((s, p) => s + p.volume, 0) / ppLookback.length
              : 0;
            const ppVolOk    = ppAvgVol > 0 && prices[i].volume >= ppAvgVol * VOL_CONFIRM_MULT;

            if (aboveSma20 && ppVolOk) {
              entryIdx             = i + 1;
              entryPrice           = prices[entryIdx].open;
              peakPrice            = entryPrice;
              tier2Locked          = false;
              unlimitedTrailActive = false;

              const atr14       = calcATR14(prices.slice(0, i + 1));
              const atrStopDist = (atr14 * ATR_STOP_MULT) / entryPrice;
              const stopPct     = Math.min(atrStopDist, MAX_STOP_PCT);
              currentStop = entryPrice * (1 - stopPct);

              tradePositionSize = STARTING_CASH * POSITION_SIZE; // standard 5% for re-entries
              entryRs3mMargin   = 0;       // no chained power plays
              powerPlayEligible = false;   // one-time use consumed
              inTrade           = true;
            }
          }
        }
      } else {
        const bar = prices[i];

        // ── Track intra-trade peak price ──────────────────────────────────────
        if (bar.high > peakPrice) peakPrice = bar.high;

        // ── Three-tier trailing stop system ───────────────────────────────────
        // Tier 1 (+5%): raise stop to break-even — can't lose money.
        if (bar.high >= entryPrice * (1 + BREAKEVEN_TRIGGER) && currentStop < entryPrice) {
          currentStop = entryPrice;
        }
        // Tier 2 (+15%): lock in +10% floor, unlock extended hold.
        const trailLockPrice = entryPrice * (1 + TRAIL_LOCK_FLOOR);
        if (bar.high >= entryPrice * (1 + TRAIL_LOCK_TRIGGER) && currentStop < trailLockPrice) {
          currentStop = trailLockPrice;
          tier2Locked = true;
        }
        // Tier 3 (+25%): activate unlimited trailing — 10% below running peak.
        if (peakPrice >= entryPrice * (1 + TRAIL_UNLIMITED_TRIGGER)) {
          unlimitedTrailActive = true;
        }
        if (unlimitedTrailActive) {
          const dynamicStop = peakPrice * (1 - TRAIL_UNLIMITED_STOP);
          if (dynamicStop > currentStop) currentStop = dynamicStop;
        }

        // ── Exit conditions ────────────────────────────────────────────────────
        const daysHeld         = i - entryIdx;
        const catastrophicDrop = bar.low <= entryPrice * (1 - CATASTROPHIC_STOP);
        const stopHit          = bar.low <= currentStop && (daysHeld >= MIN_HOLD_DAYS || catastrophicDrop);
        // Time exit: 21-day window normally; extended to MAX_HOLD_DAYS once tier-2 fires.
        const timeExit         = daysHeld >= (tier2Locked ? MAX_HOLD_DAYS : HOLD_DAYS);

        if (!stopHit && !timeExit) continue; // still holding

        let exitPrice: number;
        let exitReason: ExitReason;

        if (stopHit) {
          exitPrice = parseFloat(currentStop.toFixed(2));
          // Profitable stop = trailing exit on a winner; unprofitable = actual loss.
          exitReason = exitPrice > entryPrice ? "TRAIL_STOP" : "STOP_LOSS";
        } else {
          exitPrice  = parseFloat(bar.close.toFixed(2));
          exitReason = "TIME";
        }

        const pct = parseFloat(
          (((exitPrice - entryPrice) / entryPrice) * 100).toFixed(2),
        );
        const win = pct > 0;
        const pnl = tradePositionSize * (pct / 100);

        allTrades.push({
          ticker,
          date:       prices[entryIdx].date,
          action:     "BUY",
          pct_change: pct,
          win,
          entryPrice: parseFloat(entryPrice.toFixed(2)),
          exitPrice,
          exitDate:   bar.date,
          exitReason,
        });

        portfolioCash += pnl;
        equityCurve.push(portfolioCash);
        if (win) totalGains  += pnl;
        else     totalLosses += Math.abs(pnl);

        // Power play eligibility: strong leader stopped out at a loss earns a re-entry.
        if (exitReason === "STOP_LOSS" && entryRs3mMargin >= POWER_PLAY_RS_MIN) {
          powerPlayEligible = true;
        }

        count++;
        inTrade          = false;
        tier2Locked      = false;
        unlimitedTrailActive = false;
        // After a power-play-eligible stop-out, skip only 5 bars (1 week) to allow
        // the re-entry signal to form; otherwise use the full hold window.
        i += powerPlayEligible ? 5 : HOLD_DAYS;
      }
    }

    // Close any still-open trade at last bar
    if (inTrade && entryIdx < prices.length - 1) {
      const last      = prices.length - 1;
      const exitPrice = parseFloat(prices[last].close.toFixed(2));
      const pct       = parseFloat(
        (((exitPrice - entryPrice) / entryPrice) * 100).toFixed(2),
      );
      const win = pct > 0;
      const pnl = tradePositionSize * (pct / 100);

      allTrades.push({
        ticker,
        date:       prices[entryIdx].date,
        action:     "BUY",
        pct_change: pct,
        win,
        entryPrice: parseFloat(entryPrice.toFixed(2)),
        exitPrice,
        exitDate:   prices[last].date,
        exitReason: "TIME",
      });

      portfolioCash += pnl;
      equityCurve.push(portfolioCash);
      if (win) totalGains  += pnl;
      else     totalLosses += Math.abs(pnl);
      count++;
    }

    console.log(`  ${ticker.padEnd(6)} ${count} trade(s)`);
  }

  // ── 4. Compute metrics ─────────────────────────────────────────────────────
  const n = allTrades.length;
  const wins         = allTrades.filter(t => t.win).length;
  const winRate      = n > 0 ? parseFloat(((wins / n) * 100).toFixed(2)) : 0;
  const profitFactor = totalLosses > 0 ? parseFloat((totalGains / totalLosses).toFixed(2)) : 0;
  const totalReturn  = parseFloat((((portfolioCash - STARTING_CASH) / STARTING_CASH) * 100).toFixed(2));
  const alphaVsSpy   = parseFloat((totalReturn - spyReturn).toFixed(2));
  const maxDrawdown  = calcMaxDrawdown(equityCurve);

  // ── 5. Write results ───────────────────────────────────────────────────────
  const results: BacktestResults = {
    generated_at:  TODAY,
    start_date:    TWO_YEARS_AGO,
    end_date:      TODAY,
    data_points:   n,
    win_rate:      winRate,
    profit_factor: profitFactor,
    alpha_vs_spy:  alphaVsSpy,
    total_return:  totalReturn,
    spy_return:    spyReturn,
    max_drawdown:  maxDrawdown,
    rows:          allTrades,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));

  // ── 6. Summary ─────────────────────────────────────────────────────────────
  const byReason    = (r: ExitReason) => allTrades.filter(t => t.exitReason === r);
  const stopHits    = byReason("STOP_LOSS");
  const trailStops  = byReason("TRAIL_STOP");
  const timeExits   = byReason("TIME");
  const avg = (arr: TradeRow[]) =>
    arr.length ? (arr.reduce((s, t) => s + t.pct_change, 0) / arr.length).toFixed(2) : "0";

  const sep = "═".repeat(55);
  console.log(`\n${sep}`);
  console.log(`  BACKTEST COMPLETE`);
  console.log(`${"─".repeat(55)}`);
  console.log(`  Trades simulated : ${n}`);
  console.log(`  Win Rate         : ${winRate}%`);
  console.log(`  Profit Factor    : ${profitFactor}`);
  console.log(`  Total Return     : ${totalReturn >= 0 ? "+" : ""}${totalReturn}%`);
  console.log(`  SPY Buy & Hold   : +${spyReturn}%`);
  console.log(`  Alpha vs SPY     : ${alphaVsSpy >= 0 ? "+" : ""}${alphaVsSpy}%`);
  console.log(`  Max Drawdown     : ${maxDrawdown}%`);
  console.log(`${"─".repeat(55)}`);
  console.log(`  Exit breakdown:`);
  console.log(`    STOP_LOSS   : ${stopHits.length}  (avg ${avg(stopHits)}%)`);
  console.log(`    TRAIL_STOP  : ${trailStops.length}  (avg ${avg(trailStops)}%)  ← profitable trailing exits`);
  console.log(`    TIME        : ${timeExits.length}  (avg ${avg(timeExits)}%)`);
  console.log(`${sep}`);
  console.log(`  Saved → ${OUTPUT_PATH}`);
}

// ── Entry point ────────────────────────────────────────────────────────────────

runBacktest().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
