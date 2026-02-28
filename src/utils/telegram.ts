import fs from "fs";
import path from "path";
import { Telegram } from "telegraf";
import logger from "./logger";
import { TodoAction } from "../analyzers/engine";
import { calculatePositionSize } from "./finance";

const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID       = process.env.TELEGRAM_CHAT_ID   ?? "";
const STREAMLIT_URL = process.env.STREAMLIT_URL      ?? "";

// Primary exchange for TradingView symbol URLs — defaults to NASDAQ.
const NYSE_TICKERS = new Set([
  "SQ", "DECK", "UBER", "DASH", "RBLX", "ONON", "ELF", "TOST",
  "NET", "SNOW", "ESTC", "IOT", "HUBS", "GDDY", "BILL", "SHOP", "FICO",
]);

let bot: Telegram | null = null;

function getBot(): Telegram | null {
  if (!BOT_TOKEN || !CHAT_ID) return null;
  if (!bot) bot = new Telegram(BOT_TOKEN);
  return bot;
}

// ── Formatting Helpers ────────────────────────────────────────────────────────

function escapeMd(text: string): string {
  return text.replace(/[_*`\[\]]/g, "\\$&");
}

/** Returns a 5-dot confidence meter based on a 0–100 certainty score. */
function confidenceMeter(certainty: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, certainty)) / 100) * 5);
  return "🟦".repeat(filled) + "⬜".repeat(5 - filled);
}

function tradingViewUrl(ticker: string): string {
  const exchange = NYSE_TICKERS.has(ticker.toUpperCase()) ? "NYSE" : "NASDAQ";
  return `https://www.tradingview.com/symbols/${exchange}-${ticker}/`;
}

function dashboardFooter(): string {
  return STREAMLIT_URL ? `📊 [Live Dashboard](${STREAMLIT_URL})` : "";
}

function resolvePrice(r: TodoAction): number {
  return r.breakdown.details.atrData?.currentPrice
    ?? r.breakdown.details.weeklyTrend?.currentPrice
    ?? 0;
}

/**
 * Builds a one-line fundamentals quality summary for Telegram messages.
 * Returns null when no fundamentals data is available.
 *
 * Examples:
 *   💎 Quality: High (EPS +40% | Rev +22%)
 *   📊 Quality: Mixed (EPS +28%)
 *   ⚠️ Quality: Risky (D/E 2.8 — high debt)
 *   📊 Quality: No data
 */
function formatQualityLine(r: TodoAction): string | null {
  const fd = r.breakdown.details.fundamentalsData;
  if (!fd) return null;

  const parts: string[] = [];
  if (fd.epsGrowthYoY !== null) {
    parts.push(`EPS ${fd.epsGrowthYoY > 0 ? "+" : ""}${fd.epsGrowthYoY.toFixed(0)}%`);
  }
  if (fd.revenueGrowthYoY !== null) {
    parts.push(`Rev ${fd.revenueGrowthYoY > 0 ? "+" : ""}${fd.revenueGrowthYoY.toFixed(0)}%`);
  }

  const epsHigh = fd.epsGrowthYoY !== null && fd.epsGrowthYoY > 20;
  const revHigh = fd.revenueGrowthYoY !== null && fd.revenueGrowthYoY > 15;
  const debtRisky = fd.debtToEquity !== null && fd.debtToEquity > 2.0;

  let icon: string;
  let label: string;

  if (debtRisky) {
    icon = "⚠️";
    label = `Risky (D/E ${fd.debtToEquity!.toFixed(1)} — high debt)`;
  } else if (epsHigh && revHigh) {
    icon = "💎";
    label = `High (${parts.join(" | ")})`;
  } else if (epsHigh || revHigh) {
    icon = "📊";
    label = `Mixed (${parts.join(" | ")})`;
  } else if (parts.length > 0) {
    icon = "📊";
    label = `Low (${parts.join(" | ")})`;
  } else {
    return null; // No data worth showing
  }

  return `${icon} *Quality:* ${label}`;
}

function actionLabel(r: TodoAction): string {
  if (r.action === "GOLDEN TRADE")  return "GOLDEN TRADE";
  if (r.action === "EXPLOSIVE BUY") return "EXPLOSIVE BUY";
  if (r.breakdown.certaintyIndex.highConviction) return "HIGH CONVICTION BUY";
  return r.action;
}

// ── Tiered Message Formatters ─────────────────────────────────────────────────

/**
 * Standard alert for score 70–89.
 * Clean layout with AI Insight and Risk Management sections.
 */
function formatStandardAlert(r: TodoAction): string {
  const ci        = r.breakdown.certaintyIndex;
  const price     = resolvePrice(r);
  const rs        = r.breakdown.details.relativeStrengthData;
  const rsStr     = rs ? `${rs.tickerChange > 0 ? "+" : ""}${rs.tickerChange}% vs SPY` : "N/A";
  const stopLoss  = r.stopLoss !== null ? `$${r.stopLoss}` : "—";
  const vol       = r.breakdown.details.volumeRatio;
  const volLabel  = r.breakdown.details.volumeStatus;
  const footer    = dashboardFooter();
  const pos       = price > 0 ? calculatePositionSize(price) : null;
  const summary   = escapeMd(r.breakdown.details.catalystSummary || r.breakdown.details.sentimentReasoning);
  const qualLine  = formatQualityLine(r);
  const sectorETF = r.breakdown.details.sectorETFData;
  const sectorStr = sectorETF
    ? `${sectorETF.etf} ${sectorETF.changePercent > 0 ? "+" : ""}${sectorETF.changePercent}%`
    : null;
  const breakEven = price > 0 ? `$${(price * 1.05).toFixed(2)}` : "—";

  const lines: (string | null)[] = [
    `⭐ *Strong Setup: ${r.ticker}*`,
    ``,
    `💰 *Price:* $${price.toFixed(2)}`,
    sectorStr ? `📊 *Sector:* ${sectorStr}` : null,
    `📊 *Score:* ${r.score}  |  *Certainty:* ${ci.total}/100`,
    `⚡ *Confidence:* ${confidenceMeter(ci.total)}`,
    ``,
    `📈 *RS (1d):* ${rsStr}`,
    `📦 *Volume:* ${volLabel}${vol > 0 ? ` (${vol.toFixed(1)}x)` : ""}`,
    qualLine,
    ``,
    `📰 *AI Insight*`,
    `_${summary}_`,
    ``,
    pos && pos.shares > 0
      ? `📏 *Entry:* Buy ${pos.shares} shares at $${price.toFixed(2)}`
      : `📏 *Entry:* $${price.toFixed(2)}`,
    `🛡️ *Stop Loss:* ${stopLoss} (1.5×ATR)`,
    `📈 *Break-even:* ${breakEven} (+5%)`,
    ``,
    `🔗 [TradingView: ${r.ticker}](${tradingViewUrl(r.ticker)})`,
    ...(footer ? [footer] : []),
  ];

  return lines.filter((l): l is string => l !== null).join("\n");
}

/**
 * Premium alert for score 90+ (EXPLOSIVE BUY / GOLDEN TRADE).
 * Bold headers, AI Insight, and Risk Management sections.
 */
function formatGoldenAlert(r: TodoAction): string {
  const ci        = r.breakdown.certaintyIndex;
  const isGolden  = r.action === "GOLDEN TRADE";
  const price     = resolvePrice(r);
  const rs        = r.breakdown.details.relativeStrengthData;
  const rsStr     = rs ? `${rs.tickerChange > 0 ? "+" : ""}${rs.tickerChange}% vs SPY` : "N/A";
  const stopLoss  = r.stopLoss !== null ? `$${r.stopLoss}` : "—";
  const vol       = r.breakdown.details.volumeRatio;
  const volLabel  = r.breakdown.details.volumeStatus;
  const es        = r.breakdown.details.earningsSurprise;
  const footer    = dashboardFooter();
  const pos       = price > 0 ? calculatePositionSize(price) : null;
  const summary   = escapeMd(r.breakdown.details.catalystSummary || r.breakdown.details.sentimentReasoning);
  const qualLine  = formatQualityLine(r);
  const sectorETF = r.breakdown.details.sectorETFData;
  const sectorStr = sectorETF
    ? `${sectorETF.etf} ${sectorETF.changePercent > 0 ? "+" : ""}${sectorETF.changePercent}%`
    : null;
  const breakEven = price > 0 ? `$${(price * 1.05).toFixed(2)}` : "—";

  const header = isGolden
    ? `🏆🏆🏆 *GOLDEN TRADE: ${r.ticker}* 🏆🏆🏆`
    : `🔥🔥 *EXPLOSIVE BUY: ${r.ticker}* 🔥🔥`;

  const lines: (string | null)[] = [
    header,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `💰 *Price:* $${price.toFixed(2)}`,
    sectorStr ? `📊 *Sector:* ${sectorStr}` : null,
    `📊 *Score:* ${r.score}  |  *Certainty:* ${ci.total}/100`,
    `⚡ *Confidence:* ${confidenceMeter(ci.total)}`,
    ``,
    `📈 *RS (1d):* ${rsStr}`,
    `📦 *Volume:* ${volLabel}${vol > 0 ? ` (${vol.toFixed(1)}x)` : ""}`,
    es ? `💥 *Earnings Beat:* ${es.surprisePercent > 0 ? "+" : ""}${es.surprisePercent}%` : null,
    qualLine,
    ``,
    `📰 *AI Insight*`,
    `_${summary}_`,
    ``,
    pos && pos.shares > 0
      ? `📏 *Entry:* Buy ${pos.shares} shares at $${price.toFixed(2)}`
      : `📏 *Entry:* $${price.toFixed(2)}`,
    `🛡️ *Stop Loss:* ${stopLoss} (1.5×ATR)`,
    `📈 *Break-even:* ${breakEven} (+5%)`,
    ``,
    `🔗 [TradingView: ${r.ticker}](${tradingViewUrl(r.ticker)})`,
    ...(footer ? [footer] : []),
  ];

  return lines.filter((l): l is string => l !== null).join("\n");
}

// ── Sender ────────────────────────────────────────────────────────────────────

async function send(message: string): Promise<void> {
  const tg = getBot();
  if (!tg) {
    logger.warn("Telegram not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)");
    return;
  }

  const chatId = /^\d+$/.test(CHAT_ID) ? Number(CHAT_ID) : CHAT_ID;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extra: Record<string, unknown> = { parse_mode: "Markdown" };
  if (STREAMLIT_URL) {
    extra.reply_markup = {
      inline_keyboard: [[{ text: "📊 View Full Dashboard", url: STREAMLIT_URL }]],
    };
  }

  logger.info(`Sending Telegram alert to chat ${CHAT_ID}...`);

  try {
    await tg.sendMessage(chatId, message, extra as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    logger.info("Telegram alert sent successfully");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Telegram send failed: ${msg}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a pre-formatted string — used for scan summary messages.
 */
export async function sendSignal(message: string): Promise<void> {
  await send(message);
}

/**
 * Format and send a tiered trade alert.
 *   Score 90+ → Golden/Explosive format with bold headers and AI reasoning.
 *   Score 70–89 → Standard format with key stats.
 *
 * @param modeTag  Optional scan-mode prefix (e.g. "⚡ *FAST SCAN*") prepended to the message.
 */
export async function sendAlert(result: TodoAction, modeTag?: string): Promise<void> {
  let message = result.score >= 90
    ? formatGoldenAlert(result)
    : formatStandardAlert(result);
  if (modeTag) {
    message = `${modeTag}\n\n${message}`;
  }
  await send(message);
}

// ── Live Signals Digest ───────────────────────────────────────────────────────

interface LiveSignalEntry {
  ticker:      string;
  score:       number;
  close:       number;
  date:        string;
  aboveSma200: boolean;
}

interface LiveSignalsFile {
  generated_at: string;
  threshold:    number;
  count:        number;
  signals:      LiveSignalEntry[];
}

/**
 * Read logs/live_signals.json (written by `npm run backtest`) and send a
 * consolidated Golden Run digest to Telegram.
 *
 * Each row: Ticker · Score · Price · Break-even (+5%) · SMA200 status
 */
export async function sendLiveSignalsDigest(): Promise<void> {
  const signalsPath = path.join(process.cwd(), "logs", "live_signals.json");

  if (!fs.existsSync(signalsPath)) {
    logger.warn("live_signals.json not found — skipping digest");
    return;
  }

  let data: LiveSignalsFile;
  try {
    data = JSON.parse(fs.readFileSync(signalsPath, "utf-8"));
  } catch {
    logger.error("Failed to parse live_signals.json — skipping digest");
    return;
  }

  if (!data.signals?.length) {
    await send(
      `🎯 *Golden Run — Live Signals (${data.generated_at})*\n\n` +
      `No high-conviction setups today (score ≥${data.threshold}).\n` +
      `_Waiting for quality._`,
    );
    return;
  }

  const rows = data.signals.map((s, i) => {
    const trend = s.aboveSma200 ? "✅ SMA200" : "⚠️ Below SMA200";
    const be    = (s.close * 1.05).toFixed(2);
    return `*${i + 1}. ${s.ticker}* — Score ${s.score} | $${s.close} | BE: $${be} | ${trend}`;
  });

  const message = [
    `🎯 *Golden Run — Live Signals (${data.generated_at})*`,
    `_Score ≥${data.threshold} · ATR Stop 1.5x · Trail 2.5xATR · Break-even +5%_`,
    ``,
    ...rows,
  ].join("\n");

  logger.info(`Sending live signals digest (${data.signals.length} signals)...`);
  await send(message);
}
