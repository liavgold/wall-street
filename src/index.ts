import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { fetchDailyPrices, calculateRSIFromPrices, fetchSPYPrices, fetchVIX, fetchYieldCurve, getSectorETF, fetchSectorETF } from "./fetchers/marketData";
import {
  fetchRecommendationTrends,
  fetchInsiderSentiment,
  fetchCompanyNews,
  fetchEarningsCalendar,
  fetchSocialSentiment,
  fetchInsiderTransactions,
  fetchInstitutionalOwnership,
  fetchEarningsSurprise,
  fetchFundamentals,
} from "./fetchers/socialData";
import { getAISentiment, analyzeMarket, TodoAction, MarketContext } from "./analyzers/engine";
import logger from "./utils/logger";

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .usage("Usage: $0 --ticker <SYMBOL>")
    .option("ticker", {
      alias: "t",
      type: "string",
      demandOption: true,
      describe: "Stock ticker symbol (e.g. AAPL, MSFT)",
    })
    .option("skip-ai", {
      type: "boolean",
      default: false,
      describe: "Skip Claude AI sentiment (default to Neutral) — useful when API credits are exhausted",
    })
    .strict()
    .help().argv;

  const symbol = argv.ticker.toUpperCase();
  logger.info(`WallStreet To-Do Service — Analyzing ${symbol}`);

  // ── Fetch all data in parallel ───────────────────────────────────────────

  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(now.getFullYear() - 1);
  const fromDate = oneYearAgo.toISOString().split("T")[0];
  const toDate = now.toISOString().split("T")[0];

  // News: last 7 days
  const newsFrom = new Date(now);
  newsFrom.setDate(now.getDate() - 7);
  const newsFromDate = newsFrom.toISOString().split("T")[0];

  logger.info("[1/12] Fetching daily prices...");
  const prices = await fetchDailyPrices(symbol);

  logger.info("[2/12] Calculating RSI from price data...");
  const rsi = calculateRSIFromPrices(prices);

  // Yahoo Finance calls (no rate limit concern)
  logger.info("[3/12] Fetching SPY benchmark prices...");
  logger.info("[4/12] Fetching VIX...");
  logger.info("[5/12] Fetching institutional ownership...");

  const sectorETFSymbol = getSectorETF(symbol);
  const [spyPrices, vix, yieldCurve, institutionalOwnership, sectorETF] = await Promise.all([
    fetchSPYPrices(),
    fetchVIX(),
    fetchYieldCurve(),
    fetchInstitutionalOwnership(symbol),
    fetchSectorETF(sectorETFSymbol),
  ]);

  logger.info(`VIX: ${vix.level} [${vix.label}]${vix.isDropping ? " (dropping)" : " (rising)"}`);
  logger.info(`Sector ETF: ${sectorETFSymbol} ${sectorETF ? `${sectorETF.changePercent > 0 ? "+" : ""}${sectorETF.changePercent}%${sectorETF.isGreen ? " (green)" : " (red)"}` : "N/A"}`);

  // Earnings calendar: next 30 days
  const earningsTo = new Date(now);
  earningsTo.setDate(now.getDate() + 30);
  const earningsToDate = earningsTo.toISOString().split("T")[0];

  // Finnhub calls can run in parallel
  logger.info("[6/13] Fetching analyst recommendations...");
  logger.info("[7/13] Fetching insider sentiment...");
  logger.info("[8/13] Fetching company news...");
  logger.info("[9/13] Fetching earnings calendar...");
  logger.info("[10/13] Fetching insider transactions...");
  logger.info("[11/13] Fetching social sentiment...");
  logger.info("[12/13] Fetching earnings surprise...");
  logger.info("[13/13] Fetching fundamentals (EPS/Revenue growth, D/E)...");

  const [recommendations, insiderSentiment, news, earnings, insiderTransactions, socialSentiment, earningsSurprise, fundamentals] = await Promise.all([
    fetchRecommendationTrends(symbol),
    fetchInsiderSentiment(symbol, fromDate, toDate),
    fetchCompanyNews(symbol, newsFromDate, toDate),
    fetchEarningsCalendar(symbol, toDate, earningsToDate),
    fetchInsiderTransactions(symbol),
    fetchSocialSentiment(symbol, newsFromDate, toDate),
    fetchEarningsSurprise(symbol),
    fetchFundamentals(symbol),
  ]);

  logger.info(
    `Prices: ${prices.length} days | RSI: ${rsi.length} entries | SPY: ${spyPrices.length} days | ` +
      `Recommendations: ${recommendations.length} periods | Insider sentiment: ${insiderSentiment.length} | ` +
      `News: ${news.length} articles | Earnings: ${earnings.length} upcoming | Social: ${socialSentiment ? "available" : "N/A"} | ` +
      `Insider trades (30d): ${insiderTransactions.length} | Inst. ownership: ${institutionalOwnership ? `${(institutionalOwnership.institutionsPercentHeld * 100).toFixed(1)}%` : "N/A"} | ` +
      `Earnings surprise: ${earningsSurprise ? `${earningsSurprise.surprisePercent > 0 ? "+" : ""}${earningsSurprise.surprisePercent}% (Q${earningsSurprise.quarter} ${earningsSurprise.year})` : "N/A"}`
  );

  // ── AI Sentiment Analysis ───────────────────────────────────────────────

  let sentiment;
  if (argv.skipAi) {
    logger.info("AI sentiment SKIPPED (--no-ai flag). Defaulting to Neutral.");
    sentiment = { sentiment: "Neutral" as const, score: 15, reasoning: "Skipped (--no-ai)", headlinesAnalyzed: 0, catalystScore: 0, catalystSummary: "AI analysis skipped." };
  } else {
    logger.info("Sending headlines to Claude for sentiment analysis...");
    sentiment = await getAISentiment(symbol, news);
  }
  logger.info(
    `Sentiment: ${sentiment.sentiment} (${sentiment.score}/30) — ` +
      `${sentiment.headlinesAnalyzed} headlines analyzed`
  );
  logger.info(`Sentiment reasoning: ${sentiment.reasoning}`);

  // ── Calculate Confidence Score ─────────────────────────────────────────

  logger.info("Calculating weighted confidence score...");
  const snapshot = {
    symbol, prices, rsi, recommendations, insiderSentiment, news,
    earnings, spyPrices, socialSentiment, vix, insiderTransactions, institutionalOwnership,
    earningsSurprise, sectorETF, fundamentals, yieldCurve,
  };
  const result = await analyzeMarket(snapshot, sentiment);

  printResult(result);

  // ── Append to TODO.md ────────────────────────────────────────────────────

  appendToTodoFile(result);
  logger.info("Result appended to TODO.md");
}

// ── Console output ───────────────────────────────────────────────────────────

function printResult(result: TodoAction): void {
  const b = result.breakdown;
  const mc = result.marketContext;
  logger.info(`${"═".repeat(65)}`);
  logger.info(`  MARKET CONTEXT`);
  logger.info(`    VIX:         ${mc.vixLevel} [${mc.vixLabel}]${b.vixApplied ? " — 0.8x multiplier active" : ""}`);
  logger.info(`    Sector:      ${mc.sectorHealth}`);
  logger.info(`    Sentiment:   ${mc.generalSentiment}`);
  logger.info(`${"═".repeat(65)}`);
  logger.info(`  TICKER:        ${result.ticker}`);
  logger.info(`  ACTION:        ${result.action}`);
  logger.info(`  SCORE:         ${b.total}${b.vixApplied ? ` (raw: ${b.rawTotal}, VIX 0.8x)` : ""}`);
  logger.info(`${"─".repeat(65)}`);
  logger.info(`  Technical:     ${b.technical}/30`);
  logger.info(`    RSI 30-45:   ${b.details.rsiRecovering ? "YES (+15)" : "NO"}`);
  logger.info(`    > 200d SMA:  ${b.details.aboveSMA200 ? "YES (+15)" : "NO"}`);
  logger.info(`  Institutional: ${b.institutional}/30`);
  logger.info(`    Strong Buy:  ${b.details.strongBuyConsensus ? "YES (+20)" : "NO"}`);
  logger.info(`    Insider Buy: ${b.details.insiderNetBuying ? "YES (+10)" : "NO"}`);
  logger.info(`  AI Sentiment:  ${b.aiSentiment}/30  [${b.details.sentimentLabel}]`);
  logger.info(`  Volume:        ${b.volume}/15  [${b.details.volumeStatus}${b.details.volumeStatus !== "N/A" ? ` — ${b.details.volumeRatio}x avg` : ""}]`);
  if (b.volumeCapped) logger.info(`    ** Score capped at 60 (low volume) **`);
  const rs = b.details.relativeStrengthData;
  logger.info(`  Rel. Strength: ${b.relativeStrength >= 0 ? "+" : ""}${b.relativeStrength}  [${rs ? `${rs.tickerChange}% vs SPY ${rs.spyChange}%` : "N/A"}]`);
  const rs3m = b.details.threeMonthRSData;
  logger.info(`  3M vs SPY:     ${b.threeMonthRS >= 0 ? "+" : ""}${b.threeMonthRS}  [${rs3m ? `${rs3m.tickerChange3M}% vs SPY ${rs3m.spyChange3M}%` : "N/A"}]`);
  const wt = b.details.weeklyTrend;
  logger.info(`  Weekly Trend:  ${wt ? (wt.bullish ? "BULLISH" : "BEARISH") : "N/A"}  [${wt ? `Price $${wt.currentPrice.toFixed(2)} vs SMA100 $${wt.sma100}` : "N/A"}]${b.trendCapped ? " ** capped@50 **" : ""}`);
  const atr = b.details.atrData;
  logger.info(`  ATR(14):       ${atr ? `$${atr.atr}` : "N/A"}  [${atr ? `Stop-loss: $${atr.stopLoss}` : "N/A"}]`);
  logger.info(`  Whale Tracker: ${b.whaleTracker > 0 ? `+${b.whaleTracker}` : "0"}  [${b.details.institutionalIncrease ? "Accumulating" : "No change"}]`);
  logger.info(`  Consensus:     ${b.consensusMomentum > 0 ? `+${b.consensusMomentum}` : "0"}  [${b.details.consensusImproving ? "Improving" : "Stable/Declining"}]`);
  logger.info(`  Smart Money:   ${b.smartMoney > 0 ? `+${b.smartMoney}` : "0"}  [${b.details.smartMoneyBuy ? b.details.smartMoneyDetails : "No large insider buys"}]`);
  logger.info(`  Social Spike:  ${b.socialSpike >= 0 ? "+" : ""}${b.socialSpike}  [${b.details.highSocialInterest ? `High Interest${b.details.socialPositive ? " (positive)" : ""}` : "Normal"}]`);
  const es = b.details.earningsSurprise;
  logger.info(`  Earnings Beat: ${es ? `${es.surprisePercent > 0 ? "+" : ""}${es.surprisePercent}% (Q${es.quarter} ${es.year})` : "N/A"}`);
  const ex = b.details.explosionSignal;
  const exFlags = [ex.vcpDetected ? "VCP" : null, ex.nearHigh ? `Near 52w High (${ex.pctFromHigh}%)` : null, ex.volumeSpark ? "Volume Spark" : null].filter(Boolean);
  logger.info(`  Explosion:     ${b.explosion > 0 ? `+${b.explosion}` : "0"}  [${ex.triggered ? `TRIGGERED: ${exFlags.join(" + ")}` : exFlags.length > 0 ? `Partial: ${exFlags.join(", ")}` : "No signals"}]`);
  if (ex.high52w !== null) logger.info(`    52w High:    $${ex.high52w}  (${ex.pctFromHigh}% away)`);
  logger.info(`  Expl. Factor:  ${b.explosionFactor}`);
  const ci = b.certaintyIndex;
  let ciLabel = ci.label ? ` [${ci.label}]` : "";
  if (ci.sectorHeadwind) ciLabel += " ⚠️ Sector Headwind (-20)";
  if (ci.highConviction) ciLabel += " 🚀 HIGH CONVICTION (+10)";
  logger.info(`  Certainty:     ${ci.total}/100${ciLabel}`);
  logger.info(`    Price Action:    ${ci.priceAction}/40  |  Volume Force:  ${ci.volumeForce}/30`);
  logger.info(`    Mkt Tailwinds:   ${ci.marketTailwinds}/20  |  Surprise:      ${ci.surpriseFactor}/10`);
  const etfData = b.details.sectorETFData;
  if (etfData) logger.info(`    Sector ETF:      ${etfData.etf} ${etfData.changePercent > 0 ? "+" : ""}${etfData.changePercent}%`);
  if (b.goldenTrade) logger.info(`  >>> GOLDEN TRADE — Top 1% opportunity — Score overridden to 99 <<<`);
  else if (b.explosiveBuy) logger.info(`  >>> EXPLOSIVE BUY TRIGGERED (Certainty ${ci.total}/100) — Score overridden to 95 <<<`);
  logger.info(`${"─".repeat(65)}`);
  logger.info(`  RISK LEVEL:    ${result.riskLevel}`);
  if (result.stopLoss !== null) {
    const atrInfo = b.details.atrData;
    logger.info(`  STOP-LOSS:     $${result.stopLoss}${atrInfo ? ` (ATR $${atrInfo.atr} × 2)` : " (-10% fallback)"}`);
  }
  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      logger.warn(`  WARNING: ${w}`);
    }
  }
  logger.info(`  REASONING:     ${result.reasoning}`);
  logger.info(`${"─".repeat(65)}`);
  const sc = b.safetyChecklist;
  logger.info(`  SAFETY CHECKLIST:`);
  logger.info(`    [${sc.trendAlignment ? "x" : " "}] Market Trend Alignment?`);
  logger.info(`    [${sc.noEarningsNear ? "x" : " "}] No Earnings within 3 days?`);
  logger.info(`    [${sc.institutionalAccumulation ? "x" : " "}] Institutional Accumulation?`);
  logger.info(`    [${sc.volumeConfirmation ? "x" : " "}] Volume Confirmation?`);
  logger.info(`${"═".repeat(65)}`);
}

// ── TODO.md writer ───────────────────────────────────────────────────────────

const TODO_PATH = path.resolve(process.cwd(), "TODO.md");

const TABLE_HEADER = [
  "| Date | Ticker | Action | Score | Risk | Explosion Factor | Reasoning | Warnings | Stop-Loss |",
  "| ---- | ------ | ------ | ----- | ---- | ---------------- | --------- | -------- | --------- |",
].join("\n");

function buildMarketContextBlock(mc: MarketContext): string {
  return [
    "## Market Context",
    "",
    `| Indicator | Value |`,
    `| --------- | ----- |`,
    `| VIX | ${mc.vixLevel} (${mc.vixLabel})${mc.vixMultiplier < 1 ? " — **0.8x fear multiplier**" : ""} |`,
    `| Sector Health | ${mc.sectorHealth} |`,
    `| General Sentiment | ${mc.generalSentiment} |`,
    "",
  ].join("\n");
}

function appendToTodoFile(result: TodoAction): void {
  const date = new Date().toISOString().split("T")[0];
  const b = result.breakdown;
  const mc = result.marketContext;
  const riskStr = result.riskLevel === "EXTREME" ? "**EXTREME**" : "NORMAL";
  // stopLoss is now handled inline with ATR details
  const safeReasoning = result.reasoning.replace(/\|/g, "\\|");
  const warningsStr = result.warnings.length > 0
    ? result.warnings.map((w) => w.replace(/\|/g, "\\|")).join("; ")
    : "—";

  const sc = result.breakdown.safetyChecklist;
  const atr = result.breakdown.details.atrData;
  const stopLossDetail = result.stopLoss !== null
    ? `$${result.stopLoss}${atr ? ` (ATR $${atr.atr} × 2)` : ""}`
    : "—";

  const explosionFactorStr = b.explosionFactor.replace(/\|/g, "\\|");

  const row =
    `| ${date} ` +
    `| ${result.ticker} ` +
    `| **${result.action}** ` +
    `| ${result.score} ` +
    `| ${riskStr} ` +
    `| ${explosionFactorStr} ` +
    `| ${safeReasoning} ` +
    `| ${warningsStr} ` +
    `| ${stopLossDetail} |`;

  const checklist = [
    "",
    `**Safety Checklist — ${result.ticker}:**`,
    `- [${sc.trendAlignment ? "x" : " "}] Market Trend Alignment?`,
    `- [${sc.noEarningsNear ? "x" : " "}] No Earnings within 3 days?`,
    `- [${sc.institutionalAccumulation ? "x" : " "}] Institutional Accumulation?`,
    `- [${sc.volumeConfirmation ? "x" : " "}] Volume Confirmation?`,
    "",
  ].join("\n");

  if (!fs.existsSync(TODO_PATH)) {
    const content = [
      "# WallStreet To-Do List",
      "",
      buildMarketContextBlock(mc),
      "> **BUY** (>70) · **WATCH** (30–70) · **SELL** (<30). VIX > 25 = 0.8x multiplier. VIX > 35 = forced WATCH.",
      "",
      TABLE_HEADER,
      row,
      checklist,
    ].join("\n");
    fs.writeFileSync(TODO_PATH, content, "utf-8");
    return;
  }

  let existing = fs.readFileSync(TODO_PATH, "utf-8");

  // Update the Market Context section if it exists
  const ctxStart = existing.indexOf("## Market Context");
  if (ctxStart !== -1) {
    const ctxEnd = existing.indexOf("\n>", ctxStart);
    if (ctxEnd !== -1) {
      existing = existing.substring(0, ctxStart) + buildMarketContextBlock(mc) + existing.substring(ctxEnd);
    }
  }

  if (!existing.includes("| Date | Ticker |")) {
    const content =
      existing.trimEnd() + "\n\n" + TABLE_HEADER + "\n" + row + checklist;
    fs.writeFileSync(TODO_PATH, content, "utf-8");
    return;
  }

  const content = existing.trimEnd() + "\n" + row + checklist;
  fs.writeFileSync(TODO_PATH, content, "utf-8");
}

// ── Run ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
