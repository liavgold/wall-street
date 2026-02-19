import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import YahooFinance from "yahoo-finance2";
import logger from "./utils/logger";

const yf = new YahooFinance({ suppressNotices: ["ripHistorical", "yahooSurvey"] });

// ── Types ───────────────────────────────────────────────────────────────────

interface HistoryEntry {
  ticker: string;
  date: string;
  price: number;
  score: number;
  action: string;
}

interface BacktestResult {
  ticker: string;
  date: string;
  entryPrice: number;
  currentPrice: number;
  pctChange: number;
  score: number;
  action: string;
  win: boolean;
}

// ── Paths ───────────────────────────────────────────────────────────────────

const HISTORY_PATH = path.resolve(process.cwd(), "logs", "history.json");
const REPORT_PATH = path.resolve(process.cwd(), "logs", "performance.md");

// ── Fetch current price via Yahoo Finance ───────────────────────────────────

async function fetchCurrentPrice(symbol: string): Promise<number | null> {
  try {
    const quote = await yf.quote(symbol) as { regularMarketPrice?: number };
    return quote.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  logger.info("WallStreet Backtest Engine");

  // Read history
  if (!fs.existsSync(HISTORY_PATH)) {
    logger.error("logs/history.json not found. Run 'npm run scan' first.");
    process.exit(1);
  }

  let history: HistoryEntry[];
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8"));
  } catch {
    logger.error("Could not parse logs/history.json.");
    process.exit(1);
  }

  if (history.length === 0) {
    logger.info("No entries in history. Run 'npm run scan' first.");
    process.exit(0);
  }

  // Filter: only entries older than 5 days
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const fiveDaysAgo = new Date(now);
  fiveDaysAgo.setDate(now.getDate() - 5);

  const eligible = history.filter((e) => {
    const entryDate = new Date(e.date + "T00:00:00");
    return entryDate <= fiveDaysAgo && e.price > 0;
  });

  logger.info(`Total history entries: ${history.length}`);
  logger.info(`Eligible (>5 days old): ${eligible.length}`);

  if (eligible.length === 0) {
    logger.info("No entries older than 5 days to backtest. Wait a few days after scanning, then run again.");
    writeReport([], history.length);
    process.exit(0);
  }

  // Deduplicate: keep latest entry per ticker+date
  const uniqueMap = new Map<string, HistoryEntry>();
  for (const e of eligible) {
    uniqueMap.set(`${e.ticker}:${e.date}`, e);
  }
  const unique = [...uniqueMap.values()];

  // Fetch current prices
  const tickers = [...new Set(unique.map((e) => e.ticker))];
  logger.info(`Fetching current prices for ${tickers.length} tickers...`);

  const priceMap = new Map<string, number>();
  for (const ticker of tickers) {
    const price = await fetchCurrentPrice(ticker);
    if (price !== null) {
      priceMap.set(ticker, price);
      logger.info(`${ticker}: $${price.toFixed(2)}`);
    } else {
      logger.error(`${ticker}: price fetch FAILED`);
    }
  }

  // Calculate returns
  const results: BacktestResult[] = [];
  for (const e of unique) {
    const currentPrice = priceMap.get(e.ticker);
    if (currentPrice === undefined) continue;

    const pctChange = ((currentPrice - e.price) / e.price) * 100;
    results.push({
      ticker: e.ticker,
      date: e.date,
      entryPrice: e.price,
      currentPrice,
      pctChange: parseFloat(pctChange.toFixed(2)),
      score: e.score,
      action: e.action,
      win: e.action === "SELL" ? pctChange < 0 : pctChange > 0,
    });
  }

  // Generate report
  writeReport(results, history.length);
  printSummary(results);

  logger.info("Report saved to logs/performance.md");

  // Exit with code 2 if accuracy is below 20% threshold
  const wins = results.filter((r) => r.win);
  const winRate = results.length > 0 ? (wins.length / results.length) * 100 : 0;
  if (results.length > 0 && winRate < 20) {
    logger.error(`LOW ACCURACY: Win rate ${winRate.toFixed(1)}% is below the 20% threshold. Halting.`);
    process.exit(2);
  }
}

// ── Report Writer ───────────────────────────────────────────────────────────

function writeReport(results: BacktestResult[], totalHistory: number): void {
  const date = new Date().toISOString().split("T")[0];

  const wins = results.filter((r) => r.win);
  const winRate = results.length > 0 ? ((wins.length / results.length) * 100).toFixed(1) : "0.0";
  const avgReturn = results.length > 0
    ? (results.reduce((a, r) => a + r.pctChange, 0) / results.length).toFixed(2)
    : "0.00";

  const goldenPicks = results.filter((r) => r.action === "GOLDEN TRADE");
  const avgGoldenReturn = goldenPicks.length > 0
    ? (goldenPicks.reduce((a, r) => a + r.pctChange, 0) / goldenPicks.length).toFixed(2)
    : "N/A";

  const explosivePicks = results.filter((r) => r.action === "EXPLOSIVE BUY");
  const avgExplosiveReturn = explosivePicks.length > 0
    ? (explosivePicks.reduce((a, r) => a + r.pctChange, 0) / explosivePicks.length).toFixed(2)
    : "N/A";

  const buyPicks = results.filter((r) => r.action === "BUY" || r.action === "EXPLOSIVE BUY" || r.action === "GOLDEN TRADE");
  const avgBuyReturn = buyPicks.length > 0
    ? (buyPicks.reduce((a, r) => a + r.pctChange, 0) / buyPicks.length).toFixed(2)
    : "N/A";

  const sellPicks = results.filter((r) => r.action === "SELL");
  const sellCorrect = sellPicks.filter((r) => r.pctChange < 0);
  const sellAccuracy = sellPicks.length > 0
    ? ((sellCorrect.length / sellPicks.length) * 100).toFixed(1)
    : "N/A";

  const lines: string[] = [
    "# WallStreet Backtest Performance",
    "",
    `> **Report Date:** ${date} | **Data Points:** ${results.length}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| ------ | ----- |",
    `| Total History Entries | ${totalHistory} |`,
    `| Backtested (>5 days old) | ${results.length} |`,
    `| Win Rate | ${winRate}% (${wins.length}/${results.length}) |`,
    `| Average Return | ${avgReturn}% |`,
    `| Avg Return per Golden Trade | ${avgGoldenReturn}${avgGoldenReturn !== "N/A" ? "%" : ""} (${goldenPicks.length} picks) |`,
    `| Avg Return per Explosive Pick | ${avgExplosiveReturn}${avgExplosiveReturn !== "N/A" ? "%" : ""} |`,
    `| Avg Return per Buy Pick | ${avgBuyReturn}${avgBuyReturn !== "N/A" ? "%" : ""} |`,
    `| Sell Accuracy (price dropped) | ${sellAccuracy}${sellAccuracy !== "N/A" ? "%" : ""} (${sellCorrect.length}/${sellPicks.length}) |`,
    "",
  ];

  if (results.length > 0) {
    lines.push(
      "## Detailed Results",
      "",
      "| Ticker | Date | Action | Score | Entry Price | Current Price | Return % | Win? |",
      "| ------ | ---- | ------ | ----- | ----------- | ------------- | -------- | ---- |",
    );

    const sorted = [...results].sort((a, b) => b.pctChange - a.pctChange);
    for (const r of sorted) {
      const returnStr = `${r.pctChange > 0 ? "+" : ""}${r.pctChange}%`;
      lines.push(
        `| ${r.ticker} ` +
        `| ${r.date} ` +
        `| ${r.action} ` +
        `| ${r.score} ` +
        `| $${r.entryPrice.toFixed(2)} ` +
        `| $${r.currentPrice.toFixed(2)} ` +
        `| ${returnStr} ` +
        `| ${r.win ? "YES" : "NO"} |`
      );
    }

    lines.push("");

    // Best and worst
    if (sorted.length > 0) {
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      lines.push(
        "## Highlights",
        "",
        `- **Best performer:** ${best.ticker} (${best.action}) — ${best.pctChange > 0 ? "+" : ""}${best.pctChange}% since ${best.date}`,
        `- **Worst performer:** ${worst.ticker} (${worst.action}) — ${worst.pctChange > 0 ? "+" : ""}${worst.pctChange}% since ${worst.date}`,
        "",
      );
    }
  } else {
    lines.push("**No data points available for backtesting yet.**", "");
  }

  fs.writeFileSync(REPORT_PATH, lines.join("\n"), "utf-8");
}

// ── Console Summary ─────────────────────────────────────────────────────────

function printSummary(results: BacktestResult[]): void {
  const wins = results.filter((r) => r.win);
  const winRate = results.length > 0 ? ((wins.length / results.length) * 100).toFixed(1) : "0.0";
  const avgReturn = results.length > 0
    ? (results.reduce((a, r) => a + r.pctChange, 0) / results.length).toFixed(2)
    : "0.00";
  const explosivePicks = results.filter((r) => r.action === "EXPLOSIVE BUY");
  const avgExplosive = explosivePicks.length > 0
    ? (explosivePicks.reduce((a, r) => a + r.pctChange, 0) / explosivePicks.length).toFixed(2)
    : "N/A";

  logger.info(`${"═".repeat(65)}`);
  logger.info(`  BACKTEST RESULTS`);
  logger.info(`${"─".repeat(65)}`);
  logger.info(`  Data points:        ${results.length}`);
  logger.info(`  Win rate:           ${winRate}% (${wins.length}/${results.length})`);
  logger.info(`  Average return:     ${avgReturn}%`);
  logger.info(`  Avg Explosive pick: ${avgExplosive}${avgExplosive !== "N/A" ? "%" : ""} (${explosivePicks.length} picks)`);
  logger.info(`${"─".repeat(65)}`);

  // Top 5 and bottom 5
  const sorted = [...results].sort((a, b) => b.pctChange - a.pctChange);
  if (sorted.length > 0) {
    logger.info(`  TOP PERFORMERS:`);
    for (const r of sorted.slice(0, 5)) {
      logger.info(`    ${r.ticker.padEnd(6)} ${r.action.padEnd(15)} ${(r.pctChange > 0 ? "+" : "") + r.pctChange + "%"}`);
    }
    logger.info(`  WORST PERFORMERS:`);
    for (const r of sorted.slice(-5).reverse()) {
      logger.info(`    ${r.ticker.padEnd(6)} ${r.action.padEnd(15)} ${(r.pctChange > 0 ? "+" : "") + r.pctChange + "%"}`);
    }
  }
  logger.info(`${"═".repeat(65)}`);
}

// ── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
