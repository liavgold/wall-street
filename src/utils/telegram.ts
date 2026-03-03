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
  const entryPrice = r.sma10EntryPrice ?? price;
  const pos       = entryPrice > 0 ? calculatePositionSize(entryPrice) : null;
  const summary   = escapeMd(r.breakdown.details.catalystSummary || r.breakdown.details.sentimentReasoning);
  const qualLine  = formatQualityLine(r);
  const sectorETF = r.breakdown.details.sectorETFData;
  const sectorStr = sectorETF
    ? `${sectorETF.etf} ${sectorETF.changePercent > 0 ? "+" : ""}${sectorETF.changePercent}%`
    : null;
  const breakEven = entryPrice > 0 ? `$${(entryPrice * 1.05).toFixed(2)}` : "—";

  // Score breakdown: Tech (RSI/SMA/Vol/RS) vs Fund (fundamentals/consensus/AI)
  const techScore = r.breakdown.technical + r.breakdown.volume
    + r.breakdown.relativeStrength + r.breakdown.threeMonthRS;
  const fundScore = r.breakdown.fundamentals + r.breakdown.institutional
    + r.breakdown.aiSentiment;

  // Adaptive ATR stop label
  const atrData = r.breakdown.details.atrData;
  const atrMultLabel = (() => {
    if (!atrData || price <= 0) return "ATR";
    const atrPct = (atrData.atr / price) * 100;
    if (atrPct < 2)  return "2.5×ATR";
    if (atrPct <= 5) return "2.0×ATR";
    return "1.5×ATR";
  })();

  const lines: (string | null)[] = [
    `⭐ *Strong Setup: ${r.ticker}*`,
    ``,
    `💰 *Price:* $${price.toFixed(2)}`,
    sectorStr ? `📊 *Sector:* ${sectorStr}` : null,
    `📊 *Score:* ${r.score}  ·  Tech: ${techScore} | Fund: ${fundScore}`,
    `🎯 *Certainty:* ${ci.total}/100  ${confidenceMeter(ci.total)}`,
    ``,
    `📈 *RS (1d):* ${rsStr}`,
    `📦 *Volume:* ${volLabel}${vol > 0 ? ` (${vol.toFixed(1)}x)` : ""}`,
    qualLine,
    ``,
    `📰 *AI Insight*`,
    `_${summary}_`,
    ``,
    pos && pos.shares > 0
      ? `📏 *Entry (SMA10 limit):* Buy ${pos.shares} shares @ $${entryPrice.toFixed(2)}`
      : `📏 *Entry (SMA10 limit):* $${entryPrice.toFixed(2)}`,
    `🛡️ *Initial Stop:* ${stopLoss} (${atrMultLabel})`,
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
  const entryPrice = r.sma10EntryPrice ?? price;
  const pos       = entryPrice > 0 ? calculatePositionSize(entryPrice) : null;
  const summary   = escapeMd(r.breakdown.details.catalystSummary || r.breakdown.details.sentimentReasoning);
  const qualLine  = formatQualityLine(r);
  const sectorETF = r.breakdown.details.sectorETFData;
  const sectorStr = sectorETF
    ? `${sectorETF.etf} ${sectorETF.changePercent > 0 ? "+" : ""}${sectorETF.changePercent}%`
    : null;
  const breakEven = entryPrice > 0 ? `$${(entryPrice * 1.05).toFixed(2)}` : "—";

  // Score breakdown: Tech (RSI/SMA/Vol/RS) vs Fund (fundamentals/consensus/AI)
  const techScore = r.breakdown.technical + r.breakdown.volume
    + r.breakdown.relativeStrength + r.breakdown.threeMonthRS;
  const fundScore = r.breakdown.fundamentals + r.breakdown.institutional
    + r.breakdown.aiSentiment;

  // Adaptive ATR stop label
  const atrData = r.breakdown.details.atrData;
  const atrMultLabel = (() => {
    if (!atrData || price <= 0) return "ATR";
    const atrPct = (atrData.atr / price) * 100;
    if (atrPct < 2)  return "2.5×ATR";
    if (atrPct <= 5) return "2.0×ATR";
    return "1.5×ATR";
  })();

  const header = isGolden
    ? `🏆🏆🏆 *GOLDEN TRADE: ${r.ticker}* 🏆🏆🏆`
    : `🔥🔥 *EXPLOSIVE BUY: ${r.ticker}* 🔥🔥`;

  const lines: (string | null)[] = [
    header,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `💰 *Price:* $${price.toFixed(2)}`,
    sectorStr ? `📊 *Sector:* ${sectorStr}` : null,
    `📊 *Score:* ${r.score}  ·  Tech: ${techScore} | Fund: ${fundScore}`,
    `🎯 *Certainty:* ${ci.total}/100  ${confidenceMeter(ci.total)}`,
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
      ? `📏 *Entry (SMA10 limit):* Buy ${pos.shares} shares @ $${entryPrice.toFixed(2)}`
      : `📏 *Entry (SMA10 limit):* $${entryPrice.toFixed(2)}`,
    `🛡️ *Initial Stop:* ${stopLoss} (${atrMultLabel})`,
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
  atr14?:      number;   // 14-day ATR (added in enriched run)
  stopPrice?:  number;   // 1.5×ATR stop
  stopPct?:    number;   // stop distance as % of entry
  sector?:     string;   // sub-sector label
}

interface LiveSignalsFile {
  generated_at: string;
  threshold:    number;
  count:        number;
  signals:      LiveSignalEntry[];
}

/**
 * Read logs/live_signals.json (written by `npm run backtest`) and fire one
 * Telegram alert per signal using the Golden Run template.
 *
 * No-signal case: sends a single summary message.
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

  // ── No signals ─────────────────────────────────────────────────────────────
  if (!data.signals?.length) {
    await send(
      `📋 *Daily scan complete. No high-conviction setups today.*\n\n` +
      `_Portfolio remains in cash/existing positions._\n` +
      `Score threshold: ${data.threshold}/80  ·  Date: ${data.generated_at}`,
    );
    return;
  }

  // ── One alert per signal ───────────────────────────────────────────────────
  logger.info(`Sending ${data.signals.length} live signal alert(s)...`);

  for (const s of data.signals) {
    const stopPrice = s.stopPrice ?? parseFloat((s.close * 0.92).toFixed(2));
    const stopPct   = s.stopPct   ?? parseFloat(((s.close - stopPrice) / s.close * 100).toFixed(1));
    const bePrice   = (s.close * 1.05).toFixed(2);
    const sector    = s.sector ?? "—";

    const message = [
      `🚀 *NEW SIGNAL: ${s.ticker}*`,
      ``,
      `⭐ *Score:* ${s.score}/80 (High Conviction)`,
      `💰 *Entry Price:* $${s.close}`,
      `🛡️ *Initial Stop (1.5x ATR):* $${stopPrice} (${stopPct}%)`,
      `📈 *Break-even Trigger (+5%):* $${bePrice}`,
      `📊 *Sector:* ${sector}`,
      ``,
      `_Action: Set a Trailing Stop of 2.5x ATR in your broker._`,
      ``,
      `🔗 [TradingView: ${s.ticker}](${tradingViewUrl(s.ticker)})`,
      ...(dashboardFooter() ? [dashboardFooter()] : []),
    ].join("\n");

    await send(message);
  }
}

/**
 * Send a break-even alert when an open position hits the +5% trigger.
 * Called from backtest.ts after price comparison against open_positions.json.
 */
export async function sendBreakevenAlert(
  ticker:       string,
  entryPrice:   number,
  currentPrice: number,
): Promise<void> {
  const gainPct = ((currentPrice - entryPrice) / entryPrice * 100).toFixed(1);
  const message = [
    `📈 *BREAK-EVEN HIT: ${ticker}*`,
    ``,
    `✅ *+${gainPct}% gain reached — protect your profit now*`,
    ``,
    `💰 *Current Price:* $${currentPrice.toFixed(2)}`,
    `🔒 *Action:* Move your stop loss to entry price $${entryPrice.toFixed(2)}`,
    `📊 *Your risk is now:* ZERO`,
    ``,
    `_Trailing stop (2.5x ATR) continues to run above break-even._`,
  ].join("\n");

  logger.info(`Sending break-even alert for ${ticker} (entry $${entryPrice} → current $${currentPrice.toFixed(2)})`);
  await send(message);
}
