import YahooFinance from "yahoo-finance2";
import logger from "../utils/logger";

// ── Shared Yahoo Finance instance ───────────────────────────────────────────

const yf = new YahooFinance({ suppressNotices: ["ripHistorical", "yahooSurvey"] });

// ── Exported Types ───────────────────────────────────────────────────────────

export interface DailyPrice {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RSIEntry {
  date: string;
  rsi: number;
}

export interface VolumeAnalysis {
  currentVolume: number;
  avgVolume20d: number;
  ratio: number;
  status: "High" | "Normal" | "Low";
}

export function analyzeVolume(prices: DailyPrice[]): VolumeAnalysis | null {
  if (prices.length < 21) return null;

  const last21 = prices.slice(-21);
  const previous20 = last21.slice(0, 20);
  const current = last21[20];

  const avgVolume20d =
    previous20.reduce((acc, p) => acc + p.volume, 0) / 20;
  const ratio = avgVolume20d > 0 ? current.volume / avgVolume20d : 0;

  let status: "High" | "Normal" | "Low";
  if (ratio >= 1.5) status = "High";
  else if (ratio < 1.0) status = "Low";
  else status = "Normal";

  return { currentVolume: current.volume, avgVolume20d, ratio, status };
}

export interface RelativeStrength {
  tickerChange: number;
  spyChange: number;
  outperforming: boolean;
  relativeWeakness: boolean;
}

export function calculateRelativeStrength(
  tickerPrices: DailyPrice[],
  spyPrices: DailyPrice[]
): RelativeStrength | null {
  if (tickerPrices.length < 2 || spyPrices.length < 2) return null;

  const tickerToday = tickerPrices[tickerPrices.length - 1].close;
  const tickerYesterday = tickerPrices[tickerPrices.length - 2].close;
  const tickerChange = ((tickerToday - tickerYesterday) / tickerYesterday) * 100;

  const spyToday = spyPrices[spyPrices.length - 1].close;
  const spyYesterday = spyPrices[spyPrices.length - 2].close;
  const spyChange = ((spyToday - spyYesterday) / spyYesterday) * 100;

  return {
    tickerChange: parseFloat(tickerChange.toFixed(2)),
    spyChange: parseFloat(spyChange.toFixed(2)),
    outperforming: tickerChange > spyChange,
    relativeWeakness: tickerChange < 0 && spyChange > 0,
  };
}

// ── 3-Month Relative Strength vs SPY ─────────────────────────────────────────

export interface ThreeMonthRS {
  tickerChange3M: number;
  spyChange3M: number;
  underperforming: boolean;
}

export function calculate3MonthRelativeStrength(
  tickerPrices: DailyPrice[],
  spyPrices: DailyPrice[]
): ThreeMonthRS | null {
  const tradingDays3M = 63; // ~3 months of trading days
  if (tickerPrices.length < tradingDays3M || spyPrices.length < tradingDays3M) return null;

  const tickerNow = tickerPrices[tickerPrices.length - 1].close;
  const ticker3MAgo = tickerPrices[tickerPrices.length - tradingDays3M].close;
  const tickerChange3M = ((tickerNow - ticker3MAgo) / ticker3MAgo) * 100;

  const spyNow = spyPrices[spyPrices.length - 1].close;
  const spy3MAgo = spyPrices[spyPrices.length - tradingDays3M].close;
  const spyChange3M = ((spyNow - spy3MAgo) / spy3MAgo) * 100;

  return {
    tickerChange3M: parseFloat(tickerChange3M.toFixed(2)),
    spyChange3M: parseFloat(spyChange3M.toFixed(2)),
    underperforming: tickerChange3M < spyChange3M,
  };
}

// ── Weekly Trend (20-week SMA ≈ 100-day SMA) ────────────────────────────────

export interface WeeklyTrend {
  sma100: number;
  currentPrice: number;
  bullish: boolean;
}

export function calculateWeeklyTrend(prices: DailyPrice[]): WeeklyTrend | null {
  if (prices.length < 100) return null;

  const last100 = prices.slice(-100);
  const sma100 = last100.reduce((acc, p) => acc + p.close, 0) / 100;
  const currentPrice = prices[prices.length - 1].close;

  return {
    sma100: parseFloat(sma100.toFixed(2)),
    currentPrice,
    bullish: currentPrice > sma100,
  };
}

// ── ATR (Average True Range) ─────────────────────────────────────────────────

export interface ATRResult {
  atr: number;
  stopLoss: number;
  currentPrice: number;
}

export function calculateATR(prices: DailyPrice[], period = 14): ATRResult | null {
  if (prices.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const high = prices[i].high;
    const low = prices[i].low;
    const prevClose = prices[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  // Wilder's smoothing for ATR
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  const currentPrice = prices[prices.length - 1].close;
  const stopLoss = parseFloat((currentPrice - 2 * atr).toFixed(2));

  return {
    atr: parseFloat(atr.toFixed(2)),
    stopLoss,
    currentPrice,
  };
}

export async function fetchSPYPrices(): Promise<DailyPrice[]> {
  return fetchDailyPricesFromYahoo("SPY");
}

export interface VIXData {
  level: number;
  label: "LOW" | "ELEVATED" | "HIGH" | "EXTREME";
  previousClose: number;
  isDropping: boolean;
}

export async function fetchVIX(): Promise<VIXData> {
  const quote = await yf.quote("^VIX") as { regularMarketPrice?: number; regularMarketPreviousClose?: number };
  const level = quote.regularMarketPrice ?? 0;
  const previousClose = quote.regularMarketPreviousClose ?? level;

  let label: VIXData["label"];
  if (level > 35) label = "EXTREME";
  else if (level > 25) label = "HIGH";
  else if (level > 18) label = "ELEVATED";
  else label = "LOW";

  return {
    level: parseFloat(level.toFixed(2)),
    label,
    previousClose: parseFloat(previousClose.toFixed(2)),
    isDropping: level < previousClose,
  };
}

// ── Sector ETF ──────────────────────────────────────────────────────────────

export interface SectorETFData {
  etf: string;
  changePercent: number;
  isGreen: boolean;
}

const SECTOR_ETF_MAP: Record<string, string> = {
  // Semiconductors
  NVDA: "SMH", AMD: "SMH", ARM: "SMH", SMCI: "SMH",
  // Cybersecurity
  PANW: "HACK", CRWD: "HACK", ZS: "HACK", OKTA: "HACK", FTNT: "HACK",
  // Fintech / Crypto
  SQ: "ARKF", AFRM: "ARKF", HOOD: "ARKF", COIN: "BITO",
  // Consumer Discretionary
  TSLA: "XLY", LULU: "XLY", DECK: "XLY", ABNB: "XLY", UBER: "XLY",
  DASH: "XLY", RBLX: "XLY", DUOL: "XLY", ONON: "XLY", CELH: "XLY",
  ELF: "XLY", TOST: "XLY",
  // Cloud / Data
  NET: "SKYY", DDOG: "SKYY", SNOW: "SKYY", MDB: "SKYY", ESTC: "SKYY",
  CFLT: "SKYY", IOT: "SKYY",
  // Tech / Software (default tech)
  AAPL: "XLK", MSFT: "XLK", ADSK: "XLK", WDAY: "XLK", TEAM: "XLK",
  HUBS: "XLK", GDDY: "XLK", BILL: "XLK", MNDY: "XLK", SHOP: "XLK",
  TTD: "XLK", MELI: "XLK", APP: "XLK", FICO: "XLK", TW: "XLK",
  AXON: "XLK", PLTR: "XLK", MSTR: "XLK",
  // Fast-mode priority tickers
  AMZN: "XLY", META: "XLK", GOOGL: "XLK",
};

export function getSectorETF(symbol: string): string {
  return SECTOR_ETF_MAP[symbol] ?? "SPY";
}

export async function fetchSectorETF(etfSymbol: string): Promise<SectorETFData | null> {
  try {
    const quote = await yf.quote(etfSymbol) as { regularMarketChangePercent?: number };
    const changePercent = quote.regularMarketChangePercent ?? 0;
    return {
      etf: etfSymbol,
      changePercent: parseFloat(changePercent.toFixed(2)),
      isGreen: changePercent > 0,
    };
  } catch {
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Yahoo Finance Data Fetchers ─────────────────────────────────────────────

async function fetchDailyPricesFromYahoo(symbol: string): Promise<DailyPrice[]> {
  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(now.getFullYear() - 1);

  const results = await yf.historical(symbol, {
    period1: oneYearAgo,
    period2: now,
  });

  return results
    .map((row: { date: Date; open: number; high: number; low: number; close: number; volume: number }) => ({
      date: row.date.toISOString().split("T")[0],
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    }))
    .sort((a: DailyPrice, b: DailyPrice) => a.date.localeCompare(b.date));
}

export function calculateRSI(prices: DailyPrice[], period = 14): RSIEntry[] {
  if (prices.length < period + 1) return [];

  const deltas = prices.slice(1).map((p, i) => p.close - prices[i].close);
  const gains = deltas.map((d) => (d > 0 ? d : 0));
  const losses = deltas.map((d) => (d < 0 ? -d : 0));

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const rsiEntries: RSIEntry[] = [];

  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsiEntries.push({
    date: prices[period].date,
    rsi: avgLoss === 0 ? 100 : 100 - 100 / (1 + rs),
  });

  for (let i = period; i < deltas.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiEntries.push({
      date: prices[i + 1].date,
      rsi: avgLoss === 0 ? 100 : 100 - 100 / (1 + rs),
    });
  }

  return rsiEntries;
}

// ── Public Fetchers ─────────────────────────────────────────────────────────

export async function fetchDailyPrices(symbol: string): Promise<DailyPrice[]> {
  const prices = await fetchDailyPricesFromYahoo(symbol);
  logger.info(`${symbol} prices: Yahoo Finance — ${prices.length} days`);
  return prices;
}

export function calculateRSIFromPrices(
  prices: DailyPrice[],
  timePeriod = 14
): RSIEntry[] {
  return calculateRSI(prices, timePeriod);
}
