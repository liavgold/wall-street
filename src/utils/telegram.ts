import { Telegram } from "telegraf";
import logger from "./logger";
import { TodoAction } from "../analyzers/engine";

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

function actionLabel(r: TodoAction): string {
  if (r.action === "GOLDEN TRADE")  return "GOLDEN TRADE";
  if (r.action === "EXPLOSIVE BUY") return "EXPLOSIVE BUY";
  if (r.breakdown.certaintyIndex.highConviction) return "HIGH CONVICTION BUY";
  return r.action;
}

// ── Tiered Message Formatters ─────────────────────────────────────────────────

/**
 * Standard alert for score 70–89.
 * Clean single-section layout with the key stats.
 */
function formatStandardAlert(r: TodoAction): string {
  const ci       = r.breakdown.certaintyIndex;
  const price    = resolvePrice(r);
  const rs       = r.breakdown.details.relativeStrengthData;
  const rsStr    = rs ? `${rs.tickerChange > 0 ? "+" : ""}${rs.tickerChange}% vs SPY` : "N/A";
  const stopLoss = r.stopLoss !== null ? `$${r.stopLoss}` : "—";
  const vol      = r.breakdown.details.volumeRatio;
  const volLabel = r.breakdown.details.volumeStatus;
  const footer   = dashboardFooter();

  const lines = [
    `⭐ *Strong Setup: ${r.ticker}*`,
    ``,
    `💰 Price: $${price.toFixed(2)}`,
    `📊 Score: ${r.score}  |  Certainty: ${ci.total}/100`,
    `⚡ Confidence: ${confidenceMeter(ci.total)}`,
    ``,
    `📈 RS (1d): ${rsStr}`,
    `🛑 Stop-Loss: ${stopLoss}`,
    `📦 Volume: ${volLabel}${vol > 0 ? ` (${vol.toFixed(1)}x)` : ""}`,
    ``,
    `❓ *Why this?*`,
    `_${escapeMd(r.breakdown.details.sentimentReasoning)}_`,
    ``,
    `🔗 [TradingView: ${r.ticker}](${tradingViewUrl(r.ticker)})`,
    ...(footer ? [footer] : []),
  ];

  return lines.join("\n");
}

/**
 * Premium alert for score 90+ (EXPLOSIVE BUY / GOLDEN TRADE).
 * Bold headers, AI reasoning summary, and full signal breakdown.
 */
function formatGoldenAlert(r: TodoAction): string {
  const ci       = r.breakdown.certaintyIndex;
  const isGolden = r.action === "GOLDEN TRADE";
  const price    = resolvePrice(r);
  const rs       = r.breakdown.details.relativeStrengthData;
  const rsStr    = rs ? `${rs.tickerChange > 0 ? "+" : ""}${rs.tickerChange}% vs SPY` : "N/A";
  const stopLoss = r.stopLoss !== null ? `$${r.stopLoss}` : "—";
  const vol      = r.breakdown.details.volumeRatio;
  const volLabel = r.breakdown.details.volumeStatus;
  const es       = r.breakdown.details.earningsSurprise;
  const footer   = dashboardFooter();

  const header = isGolden
    ? `🏆🏆🏆 *GOLDEN TRADE: ${r.ticker}* 🏆🏆🏆`
    : `🔥🔥 *EXPLOSIVE BUY: ${r.ticker}* 🔥🔥`;

  const lines: (string | null)[] = [
    header,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `💰 *Price:* $${price.toFixed(2)}`,
    `📊 *Score:* ${r.score}  |  *Certainty:* ${ci.total}/100`,
    `⚡ *Confidence:* ${confidenceMeter(ci.total)}`,
    ``,
    `📈 *RS (1d):* ${rsStr}`,
    `🛑 *Stop-Loss:* ${stopLoss}`,
    `📦 *Volume:* ${volLabel}${vol > 0 ? ` (${vol.toFixed(1)}x)` : ""}`,
    es ? `💥 *Earnings Beat:* ${es.surprisePercent > 0 ? "+" : ""}${es.surprisePercent}%` : null,
    ``,
    `❓ *Why this?*`,
    `_${escapeMd(r.breakdown.details.sentimentReasoning)}_`,
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
 */
export async function sendAlert(result: TodoAction): Promise<void> {
  const message = result.score >= 90
    ? formatGoldenAlert(result)
    : formatStandardAlert(result);
  await send(message);
}
