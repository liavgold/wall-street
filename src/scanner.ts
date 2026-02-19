import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { fetchDailyPrices, calculateRSIFromPrices, fetchSPYPrices, fetchVIX, delay, getSectorETF, fetchSectorETF, SectorETFData } from "./fetchers/marketData";
import {
  fetchRecommendationTrends,
  fetchInsiderSentiment,
  fetchCompanyNews,
  fetchEarningsCalendar,
  fetchSocialSentiment,
  fetchInsiderTransactions,
  fetchInstitutionalOwnership,
  fetchEarningsSurprise,
} from "./fetchers/socialData";
import { getAISentiment, analyzeMarket, TodoAction, MarketContext } from "./analyzers/engine";
import logger from "./utils/logger";
import { sendSignal, sendAlert } from "./utils/telegram";

// ── CLI Arguments ────────────────────────────────────────────────────────────

const argv = yargs(hideBin(process.argv))
  .option("mode", {
    alias: "m",
    type: "string",
    choices: ["fast", "full"] as const,
    default: "full",
    describe: "Scan mode: fast (top 10 priority) or full (all 50)",
  })
  .strict()
  .parseSync();

type ScanMode = "fast" | "full";
const scanMode: ScanMode = argv.mode as ScanMode;

// ── Ticker Universe ─────────────────────────────────────────────────────────

const TICKERS_FULL = [
  "NVDA", "TSLA", "AMD", "PLTR", "MSTR", "SMCI", "PANW", "ELF", "CRWD", "SNOW",
  "NET",  "DDOG", "COIN", "MELI", "TTD",  "SHOP", "SQ",   "AFRM", "HOOD", "RBLX",
  "UBER", "ABNB", "DASH", "DUOL", "MNDY", "ZS",   "OKTA", "BILL", "HUBS", "GDDY",
  "TEAM", "MDB",  "ESTC", "IOT",  "CFLT", "TOST", "APP",  "CELH", "ONON", "DECK",
  "AXON", "TW",   "FICO", "LULU", "WDAY", "ADSK", "FTNT", "ARM",  "AAPL", "MSFT",
];

const TICKERS_FAST = [
  "NVDA", "TSLA", "PLTR", "AMD", "MSFT", "AAPL", "AMZN", "META", "GOOGL", "MSTR",
];

const TICKERS = scanMode === "fast" ? TICKERS_FAST : TICKERS_FULL;

// ── Session Timing ──────────────────────────────────────────────────────────

type SessionLabel = "Pre-market" | "Intraday" | "Post-market";

function getSessionLabel(): SessionLabel {
  const now = new Date();
  // Convert to ET (US Eastern)
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  const hour = et.getHours();
  const minute = et.getMinutes();
  const totalMinutes = hour * 60 + minute;

  const marketOpen = 9 * 60 + 30;  // 9:30 AM ET
  const marketClose = 16 * 60;      // 4:00 PM ET

  if (totalMinutes < marketOpen) return "Pre-market";
  if (totalMinutes >= marketClose) return "Post-market";
  return "Intraday";
}

// ── Shared data (fetched once) ──────────────────────────────────────────────

interface SharedData {
  spyPrices: Awaited<ReturnType<typeof fetchSPYPrices>>;
  vix: Awaited<ReturnType<typeof fetchVIX>>;
  sectorETFs: Map<string, SectorETFData | null>;
}

// ── Quiet mode: suppress yahoo-finance2 internal console noise ──────────────
// Yahoo-finance2 uses console.log/warn internally. We mute these during
// fetcher calls while keeping winston logger untouched.

function quietYahoo<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  return fn().finally(() => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  });
}

// ── Analyze a single ticker ─────────────────────────────────────────────────

async function analyzeTicker(symbol: string, shared: SharedData): Promise<TodoAction | null> {
  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(now.getFullYear() - 1);
  const fromDate = oneYearAgo.toISOString().split("T")[0];
  const toDate = now.toISOString().split("T")[0];

  const newsFrom = new Date(now);
  newsFrom.setDate(now.getDate() - 7);
  const newsFromDate = newsFrom.toISOString().split("T")[0];

  const earningsTo = new Date(now);
  earningsTo.setDate(now.getDate() + 30);
  const earningsToDate = earningsTo.toISOString().split("T")[0];

  try {
    return await quietYahoo(async () => {
      const prices = await fetchDailyPrices(symbol);
      const rsi = calculateRSIFromPrices(prices);

      const institutionalOwnership = await fetchInstitutionalOwnership(symbol);

      const [recommendations, insiderSentiment, news, earnings, insiderTransactions, socialSentiment, earningsSurprise] = await Promise.all([
        fetchRecommendationTrends(symbol),
        fetchInsiderSentiment(symbol, fromDate, toDate),
        fetchCompanyNews(symbol, newsFromDate, toDate),
        fetchEarningsCalendar(symbol, toDate, earningsToDate),
        fetchInsiderTransactions(symbol),
        fetchSocialSentiment(symbol, newsFromDate, toDate),
        fetchEarningsSurprise(symbol),
      ]);

      const sentiment = await getAISentiment(symbol, news);

      const etfSymbol = getSectorETF(symbol);
      const sectorETF = shared.sectorETFs.get(etfSymbol) ?? null;

      const snapshot = {
        symbol, prices, rsi, recommendations, insiderSentiment, news,
        earnings, spyPrices: shared.spyPrices, socialSentiment, vix: shared.vix,
        insiderTransactions, institutionalOwnership, earningsSurprise, sectorETF,
      };

      return await analyzeMarket(snapshot, sentiment);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`${symbol} analysis failed: ${msg}`);
    return null;
  }
}

// ── Analyze with retry (for fast mode) ──────────────────────────────────────

async function analyzeTickerWithRetry(symbol: string, shared: SharedData, retry: boolean): Promise<TodoAction | null> {
  const result = await analyzeTicker(symbol, shared);
  if (result !== null) return result;

  if (retry) {
    logger.warn(`${symbol} — Retrying (fast mode auto-retry)...`);
    await delay(3000);
    return await analyzeTicker(symbol, shared);
  }

  return null;
}

// ── OPPORTUNITIES.md writer ─────────────────────────────────────────────────

const OPP_PATH = path.resolve(process.cwd(), "OPPORTUNITIES.md");

const OPP_TABLE_HEADER = [
  "| Ticker | Sector ETF | Action | Score | Certainty | Earnings Surprise | RS (1d) | Explosion Factor | Reasoning | Stop-Loss |",
  "| ------ | ---------- | ------ | ----- | --------- | ----------------- | ------- | ---------------- | --------- | --------- |",
].join("\n");

function writeOpportunities(
  results: TodoAction[],
  totalScanned: number,
  mc: MarketContext,
  mode: ScanMode,
  session: SessionLabel,
  scanTime: string,
): void {
  const date = new Date().toISOString().split("T")[0];
  const lines: string[] = [
    "# WallStreet Opportunities",
    "",
    `> **Scan Date:** ${date} | **Time:** ${scanTime} | **Session:** ${session} | **Mode:** ${mode.toUpperCase()} | **Tickers Scanned:** ${totalScanned}`,
    "",
    "## Market Context",
    "",
    "| Indicator | Value |",
    "| --------- | ----- |",
    `| VIX | ${mc.vixLevel} (${mc.vixLabel})${mc.vixMultiplier < 1 ? " — **0.8x fear multiplier**" : ""} |`,
    `| Sector Health | ${mc.sectorHealth} |`,
    `| General Sentiment | ${mc.generalSentiment} |`,
    "",
    "> **Filters:** (Score > 75 OR Explosive Buy) AND Earnings Surprise > 0% AND Relative Strength > 0",
    "",
  ];

  if (results.length === 0) {
    lines.push("**No opportunities found in this scan.**", "");
  } else {
    lines.push(OPP_TABLE_HEADER);

    // Sort by score descending (highest first)
    const sorted = [...results].sort((a, b) => b.score - a.score);

    for (const r of sorted) {
      const b = r.breakdown;
      const atr = b.details.atrData;
      const stopLoss = r.stopLoss !== null
        ? `$${r.stopLoss}${atr ? ` (ATR $${atr.atr} x 2)` : ""}`
        : "—";
      const explosionFactor = b.explosionFactor.replace(/\|/g, "\\|");
      const reasoning = r.reasoning.replace(/\|/g, "\\|");

      const es = b.details.earningsSurprise;
      const surpriseStr = es
        ? `${es.surprisePercent > 0 ? "+" : ""}${es.surprisePercent}% (Q${es.quarter})`
        : "N/A";

      const rs = b.details.relativeStrengthData;
      const rsStr = rs
        ? `${rs.tickerChange > 0 ? "+" : ""}${rs.tickerChange}% vs SPY ${rs.spyChange > 0 ? "+" : ""}${rs.spyChange}%`
        : "N/A";

      const ci = r.breakdown.certaintyIndex;
      let ciStr = `${ci.total}/100`;
      if (ci.label === "EXPLOSIVE") ciStr += " 🔥";
      else if (ci.label === "POTENTIAL") ciStr += " ⚠️";
      if (ci.sectorHeadwind) ciStr += " Headwind";
      if (ci.highConviction) ciStr += " 🚀";

      const etf = b.details.sectorETFData;
      const etfStr = etf
        ? `${etf.etf} ${etf.changePercent > 0 ? "+" : ""}${etf.changePercent}%`
        : "N/A";

      lines.push(
        `| ${r.ticker} ` +
        `| ${etfStr} ` +
        `| **${r.action}** ` +
        `| ${r.score} ` +
        `| ${ciStr} ` +
        `| ${surpriseStr} ` +
        `| ${rsStr} ` +
        `| ${explosionFactor} ` +
        `| ${reasoning} ` +
        `| ${stopLoss} |`
      );
    }

    lines.push("");

    // Safety checklists
    for (const r of sorted) {
      const sc = r.breakdown.safetyChecklist;
      lines.push(
        `**Safety Checklist — ${r.ticker}:**`,
        `- [${sc.trendAlignment ? "x" : " "}] Market Trend Alignment?`,
        `- [${sc.noEarningsNear ? "x" : " "}] No Earnings within 3 days?`,
        `- [${sc.institutionalAccumulation ? "x" : " "}] Institutional Accumulation?`,
        `- [${sc.volumeConfirmation ? "x" : " "}] Volume Confirmation?`,
        "",
      );
    }
  }

  // Summary stats
  lines.push(
    "---",
    "",
    "## Scan Summary",
    "",
    `- **Total scanned:** ${totalScanned}`,
    `- **Passed filters:** ${results.length}`,
    `- **Golden Trades (top 1%):** ${results.filter((r) => r.action === "GOLDEN TRADE").length}`,
    `- **Explosive signals:** ${results.filter((r) => r.action === "EXPLOSIVE BUY").length}`,
    `- **High-confidence buys (>75):** ${results.filter((r) => r.score > 75 && r.action !== "EXPLOSIVE BUY" && r.action !== "GOLDEN TRADE").length}`,
    "",
  );

  fs.writeFileSync(OPP_PATH, lines.join("\n"), "utf-8");
}

// ── History Logger ──────────────────────────────────────────────────────────

const HISTORY_PATH = path.resolve(process.cwd(), "logs", "history.json");

interface HistoryEntry {
  ticker: string;
  date: string;
  time: string;
  session: SessionLabel;
  price: number;
  score: number;
  action: string;
}

function appendToHistory(results: TodoAction[], session: SessionLabel, scanTime: string): void {
  const date = new Date().toISOString().split("T")[0];
  const newEntries: HistoryEntry[] = results.map((r) => ({
    ticker: r.ticker,
    date,
    time: scanTime,
    session,
    price: r.breakdown.details.atrData?.currentPrice
      ?? r.breakdown.details.weeklyTrend?.currentPrice
      ?? 0,
    score: r.score,
    action: r.action,
  }));

  let existing: HistoryEntry[] = [];
  if (fs.existsSync(HISTORY_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8"));
    } catch {
      existing = [];
    }
  }

  // Deduplicate: remove existing entries with same ticker+date before appending
  const newKeys = new Set(newEntries.map((e) => `${e.ticker}:${e.date}`));
  const deduped = existing.filter((e) => !newKeys.has(`${e.ticker}:${e.date}`));
  const merged = [...deduped, ...newEntries];
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(merged, null, 2), "utf-8");
}

// ── Main Scanner ────────────────────────────────────────────────────────────

async function main() {
  const session = getSessionLabel();
  const scanTime = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const isFastMode = scanMode === "fast";

  logger.info(`WallStreet Scanner — Mode: ${scanMode.toUpperCase()} | Session: ${session} (${scanTime} ET) | Tickers: ${TICKERS.length}`);
  if (isFastMode) {
    logger.info(`Fast mode: scanning top 10 priority tickers with auto-retry on failure`);
  }

  // Fetch shared data once (quietly)
  const [spyPrices, vix] = await quietYahoo(() =>
    Promise.all([fetchSPYPrices(), fetchVIX()])
  );
  logger.info(`VIX: ${vix.level} [${vix.label}]${vix.isDropping ? " (dropping)" : " (rising)"} | SPY: ${spyPrices.length} days`);

  // Fetch unique sector ETFs
  const uniqueETFs = [...new Set(TICKERS.map((t) => getSectorETF(t)))];
  logger.info(`Fetching ${uniqueETFs.length} sector ETFs...`);
  const sectorETFs = new Map<string, SectorETFData | null>();
  await quietYahoo(async () => {
    const results = await Promise.all(uniqueETFs.map((etf) => fetchSectorETF(etf)));
    for (let i = 0; i < uniqueETFs.length; i++) {
      sectorETFs.set(uniqueETFs[i], results[i]);
    }
  });
  const etfSummary = uniqueETFs
    .filter((etf) => sectorETFs.get(etf))
    .map((etf) => {
      const d = sectorETFs.get(etf)!;
      return `${etf}: ${d.changePercent > 0 ? "+" : ""}${d.changePercent}%`;
    })
    .join("  ");
  logger.info(`Sector ETFs: ${etfSummary}`);

  const shared: SharedData = { spyPrices, vix, sectorETFs };
  const allResults: TodoAction[] = [];
  let completed = 0;
  let failed = 0;

  for (const symbol of TICKERS) {
    completed++;

    const result = await analyzeTickerWithRetry(symbol, shared, isFastMode);

    if (result) {
      allResults.push(result);
      const ci = result.breakdown.certaintyIndex;
      if (result.action === "GOLDEN TRADE") {
        logger.info(`${completed}/${TICKERS.length} ${symbol} — GOLDEN TRADE (99) Certainty ${ci.total}/100`);
        logger.info(`Sending Telegram for: ${symbol} (GOLDEN TRADE)`);
        await sendAlert(result);
      } else if (result.action === "EXPLOSIVE BUY") {
        logger.info(`${completed}/${TICKERS.length} ${symbol} — EXPLOSIVE BUY (95) Certainty ${ci.total}/100 🔥`);
        logger.info(`Sending Telegram for: ${symbol} (EXPLOSIVE BUY)`);
        await sendAlert(result);
      } else if (ci.highConviction) {
        logger.info(`${completed}/${TICKERS.length} ${symbol} — ${result.action} (${result.score}) Certainty ${ci.total}/100 🚀`);
        logger.info(`Sending Telegram for: ${symbol} (HIGH CONVICTION)`);
        await sendAlert(result);
      } else if (ci.label === "POTENTIAL") {
        logger.info(`${completed}/${TICKERS.length} ${symbol} — ${result.action} (${result.score}) Certainty ${ci.total}/100 ⚠️`);
      } else if (result.score > 75) {
        logger.info(`${completed}/${TICKERS.length} ${symbol} — BUY (${result.score})`);
      } else {
        logger.info(`${completed}/${TICKERS.length} ${symbol} — ${result.action} (${result.score})`);
      }
    } else {
      failed++;
      logger.error(`${completed}/${TICKERS.length} ${symbol} — FAILED${isFastMode ? " (after retry)" : ""}`);
    }

    // Rate limit: 3s between tickers (prevents Finnhub 429s at 50 tickers × ~8 calls each)
    if (completed < TICKERS.length) {
      await delay(3000);
    }
  }

  // Filter opportunities: (Explosive Buy OR Score > 75) AND positive earnings surprise AND RS > 0
  const opportunities = allResults.filter((r) => {
    const hasSignal = r.action === "GOLDEN TRADE" || r.action === "EXPLOSIVE BUY" || r.score > 75;
    const positiveSurprise = (r.breakdown.details.earningsSurprise?.surprisePercent ?? 0) > 0;
    const positiveRS = r.breakdown.relativeStrength > 0;
    return hasSignal && positiveSurprise && positiveRS;
  });

  // Write results
  const mc = allResults.length > 0
    ? allResults[0].marketContext
    : { vixLevel: vix.level, vixLabel: vix.label, vixMultiplier: vix.level > 25 ? 0.8 : 1.0, sectorHealth: "N/A", generalSentiment: "N/A" };

  writeOpportunities(opportunities, allResults.length, mc, scanMode, session, scanTime);
  appendToHistory(allResults, session, scanTime);

  // Final summary
  logger.info(`${"═".repeat(65)}`);
  logger.info(`  SCAN COMPLETE — ${scanMode.toUpperCase()} | ${session} (${scanTime} ET)`);
  logger.info(`${"─".repeat(65)}`);
  logger.info(`  Tickers scanned:    ${TICKERS.length}`);
  logger.info(`  Successful:         ${allResults.length}`);
  logger.info(`  Failed:             ${failed}`);
  logger.info(`  Passed all filters: ${opportunities.length}`);
  if (opportunities.length > 0) {
    logger.info(`${"─".repeat(65)}`);
    const sorted = [...opportunities].sort((a, b) => b.score - a.score);
    for (const r of sorted) {
      const es = r.breakdown.details.earningsSurprise;
      const surprise = es ? `+${es.surprisePercent}%` : "";
      logger.info(`  ${r.ticker.padEnd(6)} | ${r.action.padEnd(15)} | Score: ${String(r.score).padEnd(4)} | EPS: ${surprise}`);
    }
  }
  logger.info(`${"═".repeat(65)}`);
  logger.info(`Results saved to OPPORTUNITIES.md`);

  // Send daily summary via Telegram (full mode only)
  if (scanMode === "full") {
    await sendSignal(`✅ *Scan Complete* — ${session} (${scanTime} ET)\n\n📋 Scanned: ${allResults.length} tickers\n🎯 Opportunities Found: ${opportunities.length}\n💥 Explosive: ${opportunities.filter((r) => r.breakdown.certaintyIndex.label === "EXPLOSIVE").length}\n🏆 Golden Trades: ${opportunities.filter((r) => r.action === "GOLDEN TRADE").length}`);
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
