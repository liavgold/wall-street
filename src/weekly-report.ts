import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import YahooFinance from "yahoo-finance2";
import logger from "./utils/logger";
import { sendSignal } from "./utils/telegram";

const yf = new YahooFinance({ suppressNotices: ["ripHistorical", "yahooSurvey"] });

// ── Types ────────────────────────────────────────────────────────────────────

interface HistoryEntry {
  ticker: string;
  date: string;
  price: number;
  score: number;
  action: string;
}

interface WeekResult {
  ticker: string;
  action: string;
  entryPrice: number;
  currentPrice: number;
  pctChange: number;
}

// ── Paths ────────────────────────────────────────────────────────────────────

const HISTORY_PATH     = path.resolve(process.cwd(), "logs", "history.json");
const PERFORMANCE_PATH = path.resolve(process.cwd(), "logs", "performance.md");
const STREAMLIT_URL    = process.env.STREAMLIT_URL ?? "";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchCurrentPrice(symbol: string): Promise<number | null> {
  try {
    const quote = await yf.quote(symbol) as { regularMarketPrice?: number };
    return quote.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

function dateLabel(d: Date): string {
  return d.toISOString().split("T")[0];
}

function sign(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

// ── Performance.md Reader ─────────────────────────────────────────────────────

interface PerfSummary {
  dataPoints: number;
  winRate: string;
  avgReturn: string;
  reportDate: string;
}

function parsePerformanceMd(): PerfSummary | null {
  if (!fs.existsSync(PERFORMANCE_PATH)) return null;
  const text = fs.readFileSync(PERFORMANCE_PATH, "utf-8");

  const headerMatch = text.match(/\*\*Report Date:\*\*\s*(\S+).*?\*\*Data Points:\*\*\s*(\d+)/);
  if (!headerMatch) return null;

  const dataPoints = parseInt(headerMatch[2], 10);
  if (dataPoints === 0) return null; // nothing meaningful yet

  const winRateMatch  = text.match(/\|\s*Win Rate\s*\|\s*(.+?)\s*\|/);
  const avgRetMatch   = text.match(/\|\s*Average Return\s*\|\s*(.+?)\s*\|/);

  return {
    dataPoints,
    reportDate: headerMatch[1],
    winRate:    winRateMatch  ? winRateMatch[1].trim()  : "N/A",
    avgReturn:  avgRetMatch   ? avgRetMatch[1].trim()   : "N/A",
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  logger.info("WallStreet Weekly Report");

  if (!fs.existsSync(HISTORY_PATH)) {
    logger.info("No history data available yet.");
    process.exit(0);
  }

  let history: HistoryEntry[];
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8"));
  } catch {
    logger.error("Could not parse logs/history.json.");
    process.exit(1);
  }

  // Filter: entries from the last 7 days with a valid entry price
  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 7);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const weekEntries = history.filter((e) => {
    const entryDate = new Date(e.date + "T00:00:00");
    return entryDate >= sevenDaysAgo && e.price > 0;
  });

  const weekStart = dateLabel(sevenDaysAgo);
  const weekEnd = dateLabel(now);

  logger.info(`History entries: ${history.length} total, ${weekEntries.length} in last 7 days (${weekStart} → ${weekEnd})`);

  if (weekEntries.length === 0) {
    await sendSignal(
      `📊 *Weekly Performance Report*\n_${weekStart} → ${weekEnd}_\n\nNo signals were generated this week.`,
    );
    logger.info("No entries this week — empty report sent.");
    return;
  }

  // Deduplicate: keep latest entry per ticker+date
  const uniqueMap = new Map<string, HistoryEntry>();
  for (const e of weekEntries) {
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
      logger.error(`${ticker}: price fetch failed`);
    }
  }

  // Calculate returns
  const results: WeekResult[] = [];
  for (const e of unique) {
    const currentPrice = priceMap.get(e.ticker);
    if (currentPrice === undefined) continue;
    const pctChange = parseFloat((((currentPrice - e.price) / e.price) * 100).toFixed(2));
    results.push({ ticker: e.ticker, action: e.action, entryPrice: e.price, currentPrice, pctChange });
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  const totalSignals = unique.length;

  const avgReturn = results.length > 0
    ? results.reduce((sum, r) => sum + r.pctChange, 0) / results.length
    : 0;

  const sorted = [...results].sort((a, b) => b.pctChange - a.pctChange);
  const best = sorted[0] ?? null;
  const worst = sorted[sorted.length - 1] ?? null;

  const wins = results.filter((r) => r.pctChange > 0).length;
  const winRate = results.length > 0
    ? ((wins / results.length) * 100).toFixed(1)
    : "0.0";

  // ── Telegram Message ──────────────────────────────────────────────────────

  const lines: string[] = [
    `📊 *Weekly Performance Report*`,
    `_${weekStart} → ${weekEnd}_`,
    ``,
    `📦 Total signals sent: *${totalSignals}*`,
    `🏆 Best performer: *${best ? `${best.ticker} (${sign(best.pctChange)})` : "N/A"}*`,
    `📈 Average weekly return: *${sign(avgReturn)}*`,
    `🎯 Win rate: *${winRate}% (${wins}/${results.length})*`,
    `📉 Worst performer: *${worst && worst !== best ? `${worst.ticker} (${sign(worst.pctChange)})` : "N/A"}*`,
  ];

  // Per-action-type breakdown
  const actionGroups = new Map<string, WeekResult[]>();
  for (const r of results) {
    if (!actionGroups.has(r.action)) actionGroups.set(r.action, []);
    actionGroups.get(r.action)!.push(r);
  }

  if (actionGroups.size > 0) {
    lines.push(``, `*Breakdown by signal type:*`);
    for (const [action, group] of [...actionGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const groupAvg = group.reduce((sum, r) => sum + r.pctChange, 0) / group.length;
      lines.push(`  • ${action}: ${group.length} signal${group.length > 1 ? "s" : ""}, avg ${sign(groupAvg)}`);
    }
  }

  // ── Backtest context (from logs/performance.md) ───────────────────────────

  const perf = parsePerformanceMd();
  if (perf) {
    lines.push(
      ``,
      `*Backtest Accuracy (${perf.dataPoints} verified trades · ${perf.reportDate}):*`,
      `  Win rate: ${perf.winRate} | Avg return: ${perf.avgReturn}`,
    );
  }

  // ── Dashboard link ────────────────────────────────────────────────────────
  // A text link is included here so the URL is visible inside the message body.
  // telegram.ts also appends an inline keyboard button automatically.

  if (STREAMLIT_URL) {
    lines.push(``, `📊 [View Full Dashboard & Performance](${STREAMLIT_URL})`);
  }

  const message = lines.join("\n");

  logger.info(`${"═".repeat(60)}`);
  logger.info(`  WEEKLY REPORT SUMMARY`);
  logger.info(`${"─".repeat(60)}`);
  logger.info(`  Signals this week:  ${totalSignals}`);
  logger.info(`  Avg return:         ${sign(avgReturn)}`);
  logger.info(`  Win rate:           ${winRate}% (${wins}/${results.length})`);
  if (best) logger.info(`  Best:               ${best.ticker} ${sign(best.pctChange)}`);
  logger.info(`${"═".repeat(60)}`);

  logger.info("Sending weekly report to Telegram...");
  await sendSignal(message);
  logger.info("Weekly report sent.");
}

// ── Run ───────────────────────────────────────────────────────────────────────

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
