import axios from "axios";
import YahooFinance from "yahoo-finance2";
import { z } from "zod";
import logger from "../utils/logger";

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";
const API_TIMEOUT = 15_000; // 15 seconds

// ── Shared Yahoo Finance instance ───────────────────────────────────────────

const yf = new YahooFinance({ suppressNotices: ["ripHistorical", "yahooSurvey"] });

// ── Zod Schemas ──────────────────────────────────────────────────────────────

const RecommendationTrendSchema = z.object({
  buy: z.number(),
  hold: z.number(),
  period: z.string(),
  sell: z.number(),
  strongBuy: z.number(),
  strongSell: z.number(),
  symbol: z.string(),
});

const RecommendationTrendsResponseSchema = z.array(RecommendationTrendSchema);

const InsiderSentimentEntrySchema = z.object({
  month: z.number(),
  year: z.number(),
  change: z.number(),
  mspr: z.number(),
  symbol: z.string(),
});

const InsiderSentimentResponseSchema = z.object({
  data: z.array(InsiderSentimentEntrySchema),
});

const CompanyNewsItemSchema = z.object({
  category: z.string(),
  datetime: z.number(),
  headline: z.string(),
  id: z.number(),
  image: z.string(),
  related: z.string(),
  source: z.string(),
  summary: z.string(),
  url: z.string(),
});

const CompanyNewsResponseSchema = z.array(CompanyNewsItemSchema);

const EarningsEntrySchema = z.object({
  date: z.string(),
  epsActual: z.number().nullable(),
  epsEstimate: z.number().nullable(),
  hour: z.string(),
  quarter: z.number(),
  revenueActual: z.number().nullable(),
  revenueEstimate: z.number().nullable(),
  symbol: z.string(),
  year: z.number(),
});

const EarningsCalendarResponseSchema = z.object({
  earningsCalendar: z.array(EarningsEntrySchema),
});

const SocialSentimentEntrySchema = z.object({
  atTime: z.string(),
  mention: z.number(),
  positiveScore: z.number(),
  negativeScore: z.number(),
  positiveMention: z.number(),
  negativeMention: z.number(),
  score: z.number(),
});

const SocialSentimentResponseSchema = z.object({
  reddit: z.array(SocialSentimentEntrySchema),
  twitter: z.array(SocialSentimentEntrySchema),
  symbol: z.string(),
});

const InsiderTransactionEntrySchema = z.object({
  name: z.string(),
  share: z.number(),
  change: z.number(),
  filingDate: z.string(),
  transactionDate: z.string(),
  transactionCode: z.string(),
  transactionPrice: z.number(),
  isDerivative: z.boolean(),
  source: z.string().optional(),
  symbol: z.string().optional(),
  currency: z.string().optional(),
  id: z.string().optional(),
});

const InsiderTransactionsResponseSchema = z.object({
  data: z.array(InsiderTransactionEntrySchema),
  symbol: z.string(),
});

const EarningsSurpriseEntrySchema = z.object({
  actual: z.number().nullable(),
  estimate: z.number().nullable(),
  period: z.string(),
  quarter: z.number(),
  surprise: z.number().nullable(),
  surprisePercent: z.number().nullable(),
  symbol: z.string(),
  year: z.number(),
});

const EarningsSurpriseResponseSchema = z.array(EarningsSurpriseEntrySchema);

// ── Exported Types ───────────────────────────────────────────────────────────

export interface CompanyNews {
  headline: string;
  summary: string;
  source: string;
  datetime: number;
}

export interface RecommendationTrend {
  period: string;
  symbol: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

export interface InsiderSentiment {
  symbol: string;
  year: number;
  month: number;
  /** Net buying/selling from all insiders' transactions */
  change: number;
  /** Monthly Share Purchase Ratio — positive = insider buying, negative = selling */
  mspr: number;
}

export interface EarningsEvent {
  date: string;
  symbol: string;
  hour: string;
  epsEstimate: number | null;
  revenueEstimate: number | null;
}

export interface InsiderTransaction {
  name: string;
  shares: number;
  value: number;
  transactionDate: string;
  transactionCode: string;
  isBuy: boolean;
}

export interface InstitutionalOwnership {
  institutionsPercentHeld: number;
  topHoldersAvgPctChange: number;
  institutionsCount: number;
}

export interface EarningsSurprise {
  actual: number;
  estimate: number;
  surprisePercent: number;
  period: string;
  quarter: number;
  year: number;
}

export interface SocialSentimentData {
  redditScore: number;
  redditAvgWeekly: number;
  twitterScore: number;
  twitterAvgWeekly: number;
  highSocialInterest: boolean;
  positiveOverall: boolean;
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

export async function fetchRecommendationTrends(
  symbol: string
): Promise<RecommendationTrend[]> {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) {
    logger.warn("FINNHUB_API_KEY is not set — skipping recommendation trends");
    return [];
  }

  try {
    const { data } = await axios.get(
      `${FINNHUB_BASE_URL}/stock/recommendation`,
      { params: { symbol, token }, timeout: API_TIMEOUT }
    );

    const parsed = RecommendationTrendsResponseSchema.parse(data);

    return parsed.map((entry) => ({
      period: entry.period,
      symbol: entry.symbol,
      strongBuy: entry.strongBuy,
      buy: entry.buy,
      hold: entry.hold,
      sell: entry.sell,
      strongSell: entry.strongSell,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Recommendation trends unavailable for ${symbol}: ${msg}`);
    return [];
  }
}

export async function fetchInsiderSentiment(
  symbol: string,
  from: string,
  to: string
): Promise<InsiderSentiment[]> {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) {
    logger.warn("FINNHUB_API_KEY is not set — skipping insider sentiment");
    return [];
  }

  try {
    const { data } = await axios.get(
      `${FINNHUB_BASE_URL}/stock/insider-sentiment`,
      { params: { symbol, from, to, token }, timeout: API_TIMEOUT }
    );

    const parsed = InsiderSentimentResponseSchema.parse(data);

    return parsed.data.map((entry) => ({
      symbol: entry.symbol,
      year: entry.year,
      month: entry.month,
      change: entry.change,
      mspr: entry.mspr,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Insider sentiment unavailable for ${symbol}: ${msg}`);
    return [];
  }
}

export async function fetchCompanyNews(
  symbol: string,
  from: string,
  to: string
): Promise<CompanyNews[]> {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) {
    logger.warn("FINNHUB_API_KEY is not set — skipping company news");
    return [];
  }

  try {
    const { data } = await axios.get(
      `${FINNHUB_BASE_URL}/company-news`,
      { params: { symbol, from, to, token }, timeout: API_TIMEOUT }
    );

    const parsed = CompanyNewsResponseSchema.parse(data);

    return parsed.slice(0, 20).map((item) => ({
      headline: item.headline,
      summary: item.summary,
      source: item.source,
      datetime: item.datetime,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Company news unavailable for ${symbol}: ${msg}`);
    return [];
  }
}

export async function fetchEarningsCalendar(
  symbol: string,
  from: string,
  to: string
): Promise<EarningsEvent[]> {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) {
    logger.warn("FINNHUB_API_KEY is not set — skipping earnings calendar");
    return [];
  }

  try {
    const { data } = await axios.get(
      `${FINNHUB_BASE_URL}/calendar/earnings`,
      { params: { symbol, from, to, token }, timeout: API_TIMEOUT }
    );

    const parsed = EarningsCalendarResponseSchema.parse(data);

    return parsed.earningsCalendar
      .filter((e) => e.symbol === symbol)
      .map((e) => ({
        date: e.date,
        symbol: e.symbol,
        hour: e.hour,
        epsEstimate: e.epsEstimate,
        revenueEstimate: e.revenueEstimate,
      }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Earnings calendar unavailable for ${symbol}: ${msg}`);
    return [];
  }
}

export async function fetchSocialSentiment(
  symbol: string,
  from: string,
  to: string
): Promise<SocialSentimentData | null> {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) {
    logger.warn("FINNHUB_API_KEY is not set — skipping social sentiment");
    return null;
  }

  try {
    const { data } = await axios.get(
      `${FINNHUB_BASE_URL}/stock/social-sentiment`,
      { params: { symbol, from, to, token }, timeout: API_TIMEOUT }
    );

    const parsed = SocialSentimentResponseSchema.parse(data);

    const redditEntries = parsed.reddit;
    const twitterEntries = parsed.twitter;

    if (redditEntries.length === 0 && twitterEntries.length === 0) return null;

    const redditScore = redditEntries.length > 0
      ? redditEntries[redditEntries.length - 1].score
      : 0;
    const redditAvgWeekly = redditEntries.length > 0
      ? redditEntries.reduce((a, e) => a + e.score, 0) / redditEntries.length
      : 0;

    const twitterScore = twitterEntries.length > 0
      ? twitterEntries[twitterEntries.length - 1].score
      : 0;
    const twitterAvgWeekly = twitterEntries.length > 0
      ? twitterEntries.reduce((a, e) => a + e.score, 0) / twitterEntries.length
      : 0;

    const redditSpike = redditAvgWeekly > 0 && redditScore >= 2 * redditAvgWeekly;
    const twitterSpike = twitterAvgWeekly > 0 && twitterScore >= 2 * twitterAvgWeekly;
    const highSocialInterest = redditSpike || twitterSpike;

    const redditPositive = redditEntries.length > 0
      ? redditEntries[redditEntries.length - 1].positiveScore > redditEntries[redditEntries.length - 1].negativeScore
      : false;
    const twitterPositive = twitterEntries.length > 0
      ? twitterEntries[twitterEntries.length - 1].positiveScore > twitterEntries[twitterEntries.length - 1].negativeScore
      : false;
    const positiveOverall = redditPositive || twitterPositive;

    return {
      redditScore,
      redditAvgWeekly,
      twitterScore,
      twitterAvgWeekly,
      highSocialInterest,
      positiveOverall,
    };
  } catch (err) {
    // 403 = paid-only endpoint on Finnhub free tier — skip silently
    if (axios.isAxiosError(err) && err.response?.status === 403) {
      return null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Social sentiment unavailable: ${msg}`);
    return null;
  }
}

export async function fetchInsiderTransactions(
  symbol: string
): Promise<InsiderTransaction[]> {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) {
    logger.warn("FINNHUB_API_KEY is not set — skipping insider transactions");
    return [];
  }

  try {
    const { data } = await axios.get(
      `${FINNHUB_BASE_URL}/stock/insider-transactions`,
      { params: { symbol, token }, timeout: API_TIMEOUT }
    );

    const parsed = InsiderTransactionsResponseSchema.parse(data);

    // Filter: non-derivative direct purchases (code "P") in the last 30 days
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);

    return parsed.data
      .filter((t) => !t.isDerivative && t.transactionDate >= thirtyDaysAgo.toISOString().split("T")[0])
      .map((t) => ({
        name: t.name,
        shares: Math.abs(t.change),
        value: Math.abs(t.change * t.transactionPrice),
        transactionDate: t.transactionDate,
        transactionCode: t.transactionCode,
        isBuy: t.transactionCode === "P",
      }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Insider transactions unavailable for ${symbol}: ${msg}`);
    return [];
  }
}

export async function fetchInstitutionalOwnership(
  symbol: string
): Promise<InstitutionalOwnership | null> {
  try {
    const result = await yf.quoteSummary(symbol, {
      modules: ["majorHoldersBreakdown", "institutionOwnership"] as never,
    }) as {
      majorHoldersBreakdown?: {
        institutionsPercentHeld?: number;
        institutionsCount?: number;
      };
      institutionOwnership?: {
        ownershipList?: Array<{ pctChange?: number }>;
      };
    };

    const holders = result.majorHoldersBreakdown;
    if (!holders) return null;

    const ownershipList = result.institutionOwnership?.ownershipList ?? [];
    const pctChanges = ownershipList
      .map((o) => o.pctChange ?? 0)
      .filter((v) => v !== 0);
    const topHoldersAvgPctChange = pctChanges.length > 0
      ? pctChanges.reduce((a, b) => a + b, 0) / pctChanges.length
      : 0;

    return {
      institutionsPercentHeld: holders.institutionsPercentHeld ?? 0,
      topHoldersAvgPctChange: parseFloat(topHoldersAvgPctChange.toFixed(4)),
      institutionsCount: holders.institutionsCount ?? 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Institutional ownership unavailable: ${msg}`);
    return null;
  }
}

export async function fetchEarningsSurprise(
  symbol: string
): Promise<EarningsSurprise | null> {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) {
    logger.warn("FINNHUB_API_KEY is not set — skipping earnings surprise");
    return null;
  }

  try {
    const { data } = await axios.get(
      `${FINNHUB_BASE_URL}/stock/earnings`,
      { params: { symbol, token }, timeout: API_TIMEOUT }
    );

    const parsed = EarningsSurpriseResponseSchema.parse(data);

    if (parsed.length === 0) return null;

    // Most recent quarter is first in the array
    const latest = parsed[0];
    if (latest.actual === null || latest.estimate === null || latest.estimate === 0) {
      return null;
    }

    const surprisePercent = ((latest.actual - latest.estimate) / Math.abs(latest.estimate)) * 100;

    return {
      actual: latest.actual,
      estimate: latest.estimate,
      surprisePercent: parseFloat(surprisePercent.toFixed(2)),
      period: latest.period,
      quarter: latest.quarter,
      year: latest.year,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Earnings surprise unavailable: ${msg}`);
    return null;
  }
}
