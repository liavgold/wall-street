import { Telegram } from "telegraf";
import logger from "./logger";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

let bot: Telegram | null = null;

function getBot(): Telegram | null {
  if (!BOT_TOKEN || !CHAT_ID) {
    return null;
  }
  if (!bot) {
    bot = new Telegram(BOT_TOKEN);
  }
  return bot;
}

export async function sendSignal(message: string): Promise<void> {
  const tg = getBot();
  if (!tg) {
    logger.warn("Telegram not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)");
    return;
  }

  // Telegraf accepts both string and number for chat_id;
  // numeric IDs should be passed as numbers for reliability.
  const chatId = /^\d+$/.test(CHAT_ID) ? Number(CHAT_ID) : CHAT_ID;

  logger.info(`Sending Telegram alert to chat ${CHAT_ID}...`);

  try {
    await tg.sendMessage(chatId, message, { parse_mode: "Markdown" });
    logger.info("Telegram alert sent successfully");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Telegram send failed: ${msg}`);
  }
}
