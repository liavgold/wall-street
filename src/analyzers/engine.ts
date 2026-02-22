import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import logger from "../utils/logger";
import {
  DailyPrice, RSIEntry, VolumeAnalysis, analyzeVolume, RelativeStrength, calculateRelativeStrength,
  VIXData, ThreeMonthRS, calculate3MonthRelativeStrength, WeeklyTrend, calculateWeeklyTrend,
  ATRResult, calculateATR, SectorETFData,
} from "../fetchers/marketData";
import {
  RecommendationTrend,
  InsiderSentiment,
  CompanyNews,
  EarningsEvent,
  SocialSentimentData,
  InsiderTransaction,
  InstitutionalOwnership,
  EarningsSurprise,
} from "../fetchers/socialData";

// ── Zod Schemas ──────────────────────────────────────────────────────────────

const SentimentResponseSchema = z.object({
  sentiment: z.enum(["Bullish", "Neutral", "Bearish"]),
  reasoning: z.string(),
  catalystScore: z.number().int().min(-20).max(20),
  catalystSummary: z.string(),
});

// ── Types ────────────────────────────────────────────────────────────────────

export interface MarketSnapshot {
  symbol: string;
  prices: DailyPrice[];
  rsi: RSIEntry[];
  recommendations: RecommendationTrend[];
  insiderSentiment: InsiderSentiment[];
  news: CompanyNews[];
  earnings: EarningsEvent[];
  spyPrices: DailyPrice[];
  socialSentiment: SocialSentimentData | null;
  vix: VIXData;
  insiderTransactions: InsiderTransaction[];
  institutionalOwnership: InstitutionalOwnership | null;
  earningsSurprise: EarningsSurprise | null;
  sectorETF: SectorETFData | null;
}

export interface MarketContext {
  vixLevel: number;
  vixLabel: VIXData["label"];
  vixMultiplier: number;
  sectorHealth: string;
  generalSentiment: string;
}

export interface SafetyChecklist {
  trendAlignment: boolean;
  noEarningsNear: boolean;
  institutionalAccumulation: boolean;
  volumeConfirmation: boolean;
}

export interface CertaintyIndex {
  priceAction: number;
  volumeForce: number;
  marketTailwinds: number;
  surpriseFactor: number;
  total: number;
  label: "EXPLOSIVE" | "POTENTIAL" | null;
  sectorHeadwind: boolean;
  highConviction: boolean;
}

export interface ScoreBreakdown {
  technical: number;
  institutional: number;
  aiSentiment: number;
  volume: number;
  relativeStrength: number;
  threeMonthRS: number;
  socialSpike: number;
  whaleTracker: number;
  consensusMomentum: number;
  smartMoney: number;
  explosion: number;
  explosiveBuy: boolean;
  goldenTrade: boolean;
  explosionFactor: string;
  certaintyIndex: CertaintyIndex;
  rawTotal: number;
  total: number;
  volumeCapped: boolean;
  trendCapped: boolean;
  vixApplied: boolean;
  riskLevel: "NORMAL" | "EXTREME";
  warnings: string[];
  marketContext: MarketContext;
  safetyChecklist: SafetyChecklist;
  details: {
    rsiRecovering: boolean;
    aboveSMA200: boolean;
    strongBuyConsensus: boolean;
    insiderNetBuying: boolean;
    sentimentLabel: "Bullish" | "Neutral" | "Bearish";
    sentimentReasoning: string;
    catalystScore: number;
    catalystSummary: string;
    volumeStatus: "High" | "Normal" | "Low" | "N/A";
    volumeRatio: number;
    earningsSoon: boolean;
    earningsDate: string | null;
    relativeStrengthData: RelativeStrength | null;
    threeMonthRSData: ThreeMonthRS | null;
    weeklyTrend: WeeklyTrend | null;
    atrData: ATRResult | null;
    explosionSignal: ExplosionSignal;
    earningsSurprise: EarningsSurprise | null;
    sectorETFData: SectorETFData | null;
    highSocialInterest: boolean;
    socialPositive: boolean;
    institutionalIncrease: boolean;
    consensusImproving: boolean;
    smartMoneyBuy: boolean;
    smartMoneyDetails: string | null;
  };
}

export interface TodoAction {
  ticker: string;
  action: "BUY" | "SELL" | "WATCH" | "EXPLOSIVE BUY" | "GOLDEN TRADE";
  score: number;
  breakdown: ScoreBreakdown;
  reasoning: string;
  stopLoss: number | null;
  volumeStatus: "High" | "Normal" | "Low" | "N/A";
  riskLevel: "NORMAL" | "EXTREME";
  warnings: string[];
  marketContext: MarketContext;
}

// ── Technical Score (30 pts) ─────────────────────────────────────────────────

function calculate200DaySMA(prices: DailyPrice[]): number | null {
  if (prices.length < 200) return null;
  const last200 = prices.slice(-200);
  const sum = last200.reduce((acc, p) => acc + p.close, 0);
  return sum / 200;
}

function scoreTechnical(
  prices: DailyPrice[],
  rsi: RSIEntry[]
): { score: number; rsiRecovering: boolean; aboveSMA200: boolean } {
  let score = 0;

  // +15 if RSI is between 30 and 45 (recovering from oversold)
  const latestRSI = rsi.length > 0 ? rsi[rsi.length - 1] : null;
  const rsiRecovering =
    latestRSI !== null && latestRSI.rsi >= 30 && latestRSI.rsi <= 45;
  if (rsiRecovering) score += 15;

  // +15 if current price > 200-day SMA (long-term uptrend)
  const sma200 = calculate200DaySMA(prices);
  const currentPrice = prices.length > 0 ? prices[prices.length - 1].close : 0;
  const aboveSMA200 = sma200 !== null && currentPrice > sma200;
  if (aboveSMA200) score += 15;

  return { score, rsiRecovering, aboveSMA200 };
}

// ── Institutional Score (30 pts) ─────────────────────────────────────────────

function scoreInstitutional(
  recommendations: RecommendationTrend[],
  insiderSentiment: InsiderSentiment[]
): { score: number; strongBuyConsensus: boolean; insiderNetBuying: boolean } {
  let score = 0;

  // +20 if latest analyst consensus is "Strong Buy" (strongBuy is the largest category)
  const latestRec = recommendations.length > 0 ? recommendations[0] : null;
  let strongBuyConsensus = false;
  if (latestRec) {
    const categories = [
      latestRec.strongBuy,
      latestRec.buy,
      latestRec.hold,
      latestRec.sell,
      latestRec.strongSell,
    ];
    const max = Math.max(...categories);
    strongBuyConsensus = max > 0 && latestRec.strongBuy === max;
    if (strongBuyConsensus) score += 20;
  }

  // +10 if significant insider buying in the last 3 months (MSPR > 0)
  const last3 = insiderSentiment.slice(-3);
  const netMSPR = last3.reduce((acc, entry) => acc + entry.mspr, 0);
  const insiderNetBuying = last3.length > 0 && netMSPR > 0;
  if (insiderNetBuying) score += 10;

  return { score, strongBuyConsensus, insiderNetBuying };
}

// ── AI Sentiment Score (30 pts) ──────────────────────────────────────────────

export interface AISentimentResult {
  sentiment: "Bullish" | "Neutral" | "Bearish";
  score: number;
  reasoning: string;
  headlinesAnalyzed: number;
  /** -20 to +20: positive = bullish catalyst, negative = bearish. */
  catalystScore: number;
  /** One-sentence summary of the key news catalyst. */
  catalystSummary: string;
}

const SENTIMENT_SCORES = { Bullish: 30, Neutral: 15, Bearish: 0 } as const;

export async function getAISentiment(
  symbol: string,
  news: CompanyNews[]
): Promise<AISentimentResult> {
  if (news.length === 0) {
    return {
      sentiment: "Neutral",
      score: SENTIMENT_SCORES.Neutral,
      reasoning: "No recent news headlines available; defaulting to Neutral.",
      headlinesAnalyzed: 0,
      catalystScore: 0,
      catalystSummary: "No recent news available.",
    };
  }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

    const client = new Anthropic({ apiKey });

    const headlineBlock = news
      .map((n) => `- [${n.source}] ${n.headline}`)
      .join("\n");

    const message = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 512,
      system:
        "You are a senior Wall Street sentiment analyst. " +
        "Analyze news headlines and return a JSON object with: " +
        "sentiment (Bullish/Neutral/Bearish), reasoning (1 sentence), " +
        "catalystScore (integer -20 to +20: +15..+20 = major positive catalyst like earnings beat or major contract; " +
        "-15..-20 = major negative like fraud, CEO resignation, or major lawsuit; 0 = neutral/mixed), " +
        "catalystSummary (1 sentence describing the single most important catalyst). " +
        "Respond ONLY with a JSON object — no markdown, no code fences.",
      messages: [
        {
          role: "user",
          content:
            `Analyze the sentiment of these recent headlines for ${symbol}:\n\n` +
            `${headlineBlock}\n\n` +
            `Respond with this exact JSON format:\n` +
            `{"sentiment": "Bullish" | "Neutral" | "Bearish", "reasoning": "<one sentence>", ` +
            `"catalystScore": <integer -20 to +20>, "catalystSummary": "<one sentence catalyst summary>"}`,
        },
      ],
    });

    const textBlock = message.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return {
        sentiment: "Neutral",
        score: SENTIMENT_SCORES.Neutral,
        reasoning: "Failed to get sentiment response from Claude; defaulting to Neutral.",
        headlinesAnalyzed: news.length,
        catalystScore: 0,
        catalystSummary: "AI analysis unavailable.",
      };
    }

    // Strip markdown code fences that Claude sometimes wraps around JSON
    const cleanedText = textBlock.text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();

    const raw = JSON.parse(cleanedText);
    const parsed = SentimentResponseSchema.parse(raw);

    return {
      sentiment: parsed.sentiment,
      score: SENTIMENT_SCORES[parsed.sentiment],
      reasoning: parsed.reasoning,
      headlinesAnalyzed: news.length,
      catalystScore: parsed.catalystScore,
      catalystSummary: parsed.catalystSummary,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // 402 = billing/credits exhausted — hard stop, do not fall back to Neutral
    if (msg.includes("402") || msg.includes("credit balance is too low")) {
      throw new Error("CRITICAL: No Claude Credits. Analysis halted to prevent inaccurate scoring.");
    }

    logger.error(`Claude sentiment failed: ${msg}`);
    logger.info("Defaulting to Neutral sentiment");
    return {
      sentiment: "Neutral",
      score: SENTIMENT_SCORES.Neutral,
      reasoning: `AI sentiment unavailable (${msg}); defaulting to Neutral.`,
      headlinesAnalyzed: news.length,
      catalystScore: 0,
      catalystSummary: "AI analysis unavailable.",
    };
  }
}

// ── Earnings Safeguard ──────────────────────────────────────────────────────

function isEarningsSoon(earnings: EarningsEvent[]): { soon: boolean; date: string | null } {
  if (earnings.length === 0) return { soon: false, date: null };

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  for (const e of earnings) {
    const earningsDate = new Date(e.date + "T00:00:00");
    const diffMs = earningsDate.getTime() - now.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    // 3 market days ≈ roughly 5 calendar days (accounting for weekends)
    if (diffDays >= 0 && diffDays <= 5) {
      return { soon: true, date: e.date };
    }
  }
  return { soon: false, date: null };
}

// ── Analyst Consensus Momentum ──────────────────────────────────────────────

function isConsensusImproving(recommendations: RecommendationTrend[]): boolean {
  if (recommendations.length < 2) return false;
  const latest = recommendations[0];
  const previous = recommendations[1];
  const strongBuyUp = latest.strongBuy > previous.strongBuy;
  const bearishDown = (latest.hold + latest.sell + latest.strongSell)
    < (previous.hold + previous.sell + previous.strongSell);
  return strongBuyUp && bearishDown;
}

// ── Smart Money (Insider Trades) ────────────────────────────────────────────

function findSmartMoneyBuy(transactions: InsiderTransaction[]): { found: boolean; details: string | null } {
  // Look for Director/Officer purchases > $100k in the last 30 days
  const bigBuys = transactions.filter((t) => t.isBuy && t.value > 100_000);
  if (bigBuys.length === 0) return { found: false, details: null };

  const top = bigBuys.sort((a, b) => b.value - a.value)[0];
  return {
    found: true,
    details: `${top.name} bought $${(top.value / 1000).toFixed(0)}k on ${top.transactionDate}`,
  };
}

// ── Explosion Detection Logic ───────────────────────────────────────────────

export interface ExplosionSignal {
  vcpDetected: boolean;
  nearHigh: boolean;
  volumeSpark: boolean;
  triggered: boolean;
  high52w: number | null;
  pctFromHigh: number | null;
  rangesShrinking: number[];
}

function detectExplosion(prices: DailyPrice[], vol: VolumeAnalysis | null): ExplosionSignal {
  const result: ExplosionSignal = {
    vcpDetected: false,
    nearHigh: false,
    volumeSpark: false,
    triggered: false,
    high52w: null,
    pctFromHigh: null,
    rangesShrinking: [],
  };

  if (prices.length < 11) return result;

  // 1. VCP (Volatility Contraction Pattern): check if daily ranges are shrinking over last 10 days
  const last10 = prices.slice(-10);
  const ranges = last10.map((p) => p.high - p.low);
  result.rangesShrinking = ranges.map((r) => parseFloat(r.toFixed(2)));

  let shrinkCount = 0;
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i] < ranges[i - 1]) shrinkCount++;
  }
  // At least 6 of 9 transitions shrinking = VCP pattern
  result.vcpDetected = shrinkCount >= 6;

  // 2. Proximity to 52-week high: current price within 3% of high
  const lookback = Math.min(prices.length, 252); // 252 trading days ≈ 1 year
  const yearSlice = prices.slice(-lookback);
  const high52w = Math.max(...yearSlice.map((p) => p.high));
  const currentPrice = prices[prices.length - 1].close;
  const pctFromHigh = ((high52w - currentPrice) / high52w) * 100;

  result.high52w = parseFloat(high52w.toFixed(2));
  result.pctFromHigh = parseFloat(pctFromHigh.toFixed(2));
  result.nearHigh = pctFromHigh <= 3;

  // 3. Volume Spark: current volume > 1.5x 20-day average
  result.volumeSpark = vol !== null && vol.ratio >= 1.5;

  // Triggered if at least 2 of 3 signals fire
  const signals = [result.vcpDetected, result.nearHigh, result.volumeSpark];
  result.triggered = signals.filter(Boolean).length >= 2;

  return result;
}

// ── Certainty Index (0-100) ─────────────────────────────────────────────────

function calculateCertaintyIndex(
  prices: DailyPrice[],
  explosionSignal: ExplosionSignal,
  vix: VIXData,
  sectorETF: SectorETFData | null,
  earningsSurprise: EarningsSurprise | null,
): CertaintyIndex {
  let priceAction = 0;
  let volumeForce = 0;
  let marketTailwinds = 0;
  let surpriseFactor = 0;

  if (prices.length >= 2) {
    const current = prices[prices.length - 1];
    const previous = prices[prices.length - 2];

    // Price Action (40 pts): current close > previous day's high (+20), near 52w high (+20)
    if (current.close > previous.high) priceAction += 20;
    if (explosionSignal.nearHigh) priceAction += 20;

    // Volume Force (30 pts): current volume >= 80% of previous full day's volume
    if (previous.volume > 0 && current.volume / previous.volume >= 0.8) {
      volumeForce = 30;
    }
  }

  // Market Tailwinds (20 pts): VIX dropping (+10), sector ETF green (+10)
  if (vix.isDropping) marketTailwinds += 10;
  if (sectorETF?.isGreen) marketTailwinds += 10;

  // Surprise Factor (10 pts): last earnings surprise > 10%
  if (earningsSurprise && earningsSurprise.surprisePercent > 10) {
    surpriseFactor = 10;
  }

  let total = priceAction + volumeForce + marketTailwinds + surpriseFactor;

  // Sector Headwind: explosive signal but sector ETF is negative → -20
  const isExplosiveCandidate = total > 65; // would be near explosive/potential range
  const sectorHeadwind = isExplosiveCandidate && sectorETF !== null && sectorETF.changePercent < 0;
  if (sectorHeadwind) total -= 20;

  // High Conviction: stock breaking out AND sector breaking out together → +10
  const stockBreakingOut = priceAction >= 20; // at least one price action signal
  const sectorBreakingOut = sectorETF !== null && sectorETF.changePercent > 0.5;
  const highConviction = stockBreakingOut && sectorBreakingOut;
  if (highConviction) total += 10;

  // Clamp to 0-100
  total = Math.max(0, Math.min(100, total));

  let label: CertaintyIndex["label"] = null;
  if (total > 85) label = "EXPLOSIVE";
  else if (total >= 70) label = "POTENTIAL";

  return { priceAction, volumeForce, marketTailwinds, surpriseFactor, total, label, sectorHeadwind, highConviction };
}

// ── Market Context Builder ──────────────────────────────────────────────────

function buildMarketContext(
  vix: VIXData,
  rs: RelativeStrength | null,
  sentimentLabel: string
): MarketContext {
  let sectorHealth: string;
  if (rs) {
    if (rs.spyChange > 0.5) sectorHealth = "Market Rising (SPY +" + rs.spyChange + "%)";
    else if (rs.spyChange < -0.5) sectorHealth = "Market Declining (SPY " + rs.spyChange + "%)";
    else sectorHealth = "Market Flat (SPY " + rs.spyChange + "%)";
  } else {
    sectorHealth = "N/A";
  }

  let generalSentiment: string;
  if (vix.level > 35) generalSentiment = "Extreme Fear — defensive positioning advised";
  else if (vix.level > 25) generalSentiment = "Elevated Fear — reduce exposure";
  else if (vix.level > 18) generalSentiment = "Cautious — normal volatility";
  else generalSentiment = "Calm — risk-on environment";

  const vixMultiplier = vix.level > 25 ? 0.8 : 1.0;

  return { vixLevel: vix.level, vixLabel: vix.label, vixMultiplier, sectorHealth, generalSentiment };
}

// ── Confidence Score Aggregator ──────────────────────────────────────────────

export async function calculateConfidenceScore(
  snapshot: MarketSnapshot,
  sentimentResult: AISentimentResult
): Promise<ScoreBreakdown> {
  const {
    prices, rsi, recommendations, insiderSentiment, earnings,
    spyPrices, socialSentiment, vix, insiderTransactions, institutionalOwnership,
    earningsSurprise,
  } = snapshot;

  const technical = scoreTechnical(prices, rsi);
  const institutional = scoreInstitutional(recommendations, insiderSentiment);
  const vol = analyzeVolume(prices);
  const rs = calculateRelativeStrength(prices, spyPrices);
  const rs3m = calculate3MonthRelativeStrength(prices, spyPrices);
  const weeklyTrend = calculateWeeklyTrend(prices);
  const atrData = calculateATR(prices);
  const warnings: string[] = [];

  // Volume: +15 if volume >= 1.5x the 20-day average
  let volumeScore = 0;
  if (vol && vol.status === "High") volumeScore = 15;

  // Relative Strength vs SPY (1-day): +10 outperforming, -10 if relative weakness
  let relativeStrengthScore = 0;
  if (rs) {
    if (rs.outperforming) relativeStrengthScore = 10;
    if (rs.relativeWeakness) relativeStrengthScore = -10;
  }

  // 3-Month Relative Strength vs SPY: -20 if underperforming
  let threeMonthRSScore = 0;
  if (rs3m && rs3m.underperforming) {
    threeMonthRSScore = -20;
  }

  // Social Sentiment Spike: +5 if high interest and positive
  // When social data is unavailable (Finnhub 403 / paid-only), redistribute
  // the +5 weight to AI sentiment so tickers aren't penalized.
  let socialSpikeScore = 0;
  const socialUnavailable = socialSentiment === null;
  const highSocialInterest = socialSentiment?.highSocialInterest ?? false;
  const socialPositive = socialSentiment?.positiveOverall ?? false;
  if (socialUnavailable) {
    // Redistribute: +5 to AI sentiment if Bullish, +3 if Neutral
    if (sentimentResult.sentiment === "Bullish") socialSpikeScore = 5;
    else if (sentimentResult.sentiment === "Neutral") socialSpikeScore = 3;
  } else if (highSocialInterest) {
    if (socialPositive) socialSpikeScore = 5;
    warnings.push("Potential Meme-Stock Volatility");
  }

  // Whale Tracker: +15 if institutional holdings increased > 2%
  let whaleScore = 0;
  const institutionalIncrease = institutionalOwnership !== null
    && institutionalOwnership.topHoldersAvgPctChange > 0.02;
  if (institutionalIncrease) whaleScore = 15;

  // Analyst Consensus Momentum: +10 if strongBuy increasing AND hold/sell decreasing
  let consensusMomentumScore = 0;
  const consensusImproving = isConsensusImproving(recommendations);
  if (consensusImproving) consensusMomentumScore = 10;

  // Smart Money: +20 if Director/Officer bought > $100k in last 30 days
  let smartMoneyScore = 0;
  const smartMoney = findSmartMoneyBuy(insiderTransactions);
  if (smartMoney.found) smartMoneyScore = 20;

  // Explosion Detection: +25 if triggered (2 of 3: VCP, near 52w high, volume spark)
  const explosionSignal = detectExplosion(prices, vol);
  let explosionScore = 0;
  if (explosionSignal.triggered) {
    explosionScore = 25;
    warnings.push(
      `EXPLOSION DETECTED: ${[
        explosionSignal.vcpDetected ? "VCP" : null,
        explosionSignal.nearHigh ? `Near 52w High (${explosionSignal.pctFromHigh}% away)` : null,
        explosionSignal.volumeSpark ? "Volume Spark" : null,
      ].filter(Boolean).join(" + ")}`
    );
  }

  // Certainty Index (0-100): replaces binary explosiveBuy detection
  const certaintyIndex = calculateCertaintyIndex(prices, explosionSignal, vix, snapshot.sectorETF, earningsSurprise);
  const explosiveBuy = certaintyIndex.label === "EXPLOSIVE";

  if (certaintyIndex.label === "POTENTIAL") {
    warnings.push(`POTENTIAL BREAKOUT (Certainty ${certaintyIndex.total}/100) — watch closely`);
  }
  if (certaintyIndex.sectorHeadwind) {
    warnings.push(`⚠️ Sector Headwind: ${snapshot.sectorETF!.etf} ${snapshot.sectorETF!.changePercent}% — Certainty reduced by 20`);
  }
  if (certaintyIndex.highConviction) {
    warnings.push(`🚀 HIGH CONVICTION: Stock + Sector (${snapshot.sectorETF!.etf} +${snapshot.sectorETF!.changePercent}%) breaking out together`);
  }

  // Build Explosion Factor string
  const surprisePct = earningsSurprise?.surprisePercent ?? 0;
  const explosionFactorParts: string[] = [];
  if (earningsSurprise) {
    explosionFactorParts.push(`Surprise ${surprisePct > 0 ? "+" : ""}${surprisePct}%`);
  }
  if (explosionSignal.pctFromHigh !== null) {
    explosionFactorParts.push(`${explosionSignal.pctFromHigh}% from 52w High`);
  }
  if (explosionSignal.vcpDetected) {
    explosionFactorParts.push("VCP pattern");
  }
  if (explosionSignal.volumeSpark) {
    explosionFactorParts.push(`Vol ${vol ? vol.ratio.toFixed(1) : "?"}x spark`);
  }
  const explosionFactor = explosionFactorParts.length > 0
    ? explosionFactorParts.join(" | ")
    : "—";

  // GOLDEN TRADE: Explosive alert + RS > 15% (3-month) + Institutional buying up
  const rs3mPct = rs3m?.tickerChange3M ?? 0;
  const goldenTrade = explosiveBuy && rs3mPct > 15 && institutionalIncrease;

  // Catalyst Score (-20 to +20): major positive or negative news event
  if (sentimentResult.catalystScore >= 15) {
    warnings.push(`🚀 MAJOR POSITIVE CATALYST (+${sentimentResult.catalystScore}): ${sentimentResult.catalystSummary}`);
  } else if (sentimentResult.catalystScore <= -10) {
    warnings.push(`⚠️ NEGATIVE CATALYST (${sentimentResult.catalystScore}): ${sentimentResult.catalystSummary}`);
  }

  let rawTotal = technical.score + institutional.score + sentimentResult.score
    + sentimentResult.catalystScore
    + volumeScore + relativeStrengthScore + threeMonthRSScore + socialSpikeScore
    + whaleScore + consensusMomentumScore + smartMoneyScore + explosionScore;

  // Cap at 60 if volume is below average (low-conviction filter)
  const volumeCapped = vol !== null && vol.status === "Low" && rawTotal > 60;
  if (volumeCapped) rawTotal = 60;

  // Trend Alignment: cap at 50 unless weekly trend is bullish (price > 20-week SMA)
  const trendCapped = weeklyTrend !== null && !weeklyTrend.bullish && rawTotal > 50;
  if (trendCapped) {
    rawTotal = 50;
    warnings.push(`Below 20-week SMA ($${weeklyTrend!.sma100}) — score capped at 50`);
  }

  // VIX Fear Filter: 0.8x multiplier if VIX > 25
  const marketCtx = buildMarketContext(vix, rs, sentimentResult.sentiment);
  const vixApplied = vix.level > 25;
  let total = vixApplied ? Math.round(rawTotal * 0.8) : rawTotal;

  // VIX > 35: force WATCH regardless
  if (vix.level > 35) {
    warnings.push(`VIX EXTREME (${vix.level}) — all actions forced to WATCH`);
  }

  if (vixApplied) {
    warnings.push(`VIX elevated (${vix.level}) — 0.8x fear multiplier applied`);
  }

  // Earnings Safeguard
  const earningsCheck = isEarningsSoon(earnings);
  let riskLevel: "NORMAL" | "EXTREME" = "NORMAL";
  if (earningsCheck.soon) {
    riskLevel = "EXTREME";
    warnings.push(`EARNINGS SOON (${earningsCheck.date}) - EXPECT HIGH VOLATILITY`);
  }

  // 3-Month RS warning
  if (rs3m && rs3m.underperforming) {
    warnings.push(`3M underperform: ${rs3m.tickerChange3M}% vs SPY ${rs3m.spyChange3M}% (-20)`);
  }

  // Safety Checklist
  const safetyChecklist: SafetyChecklist = {
    trendAlignment: weeklyTrend !== null && weeklyTrend.bullish,
    noEarningsNear: !earningsCheck.soon,
    institutionalAccumulation: institutionalIncrease,
    volumeConfirmation: vol !== null && (vol.status === "High" || vol.status === "Normal"),
  };

  return {
    technical: technical.score,
    institutional: institutional.score,
    aiSentiment: sentimentResult.score,
    volume: volumeScore,
    relativeStrength: relativeStrengthScore,
    threeMonthRS: threeMonthRSScore,
    socialSpike: socialSpikeScore,
    whaleTracker: whaleScore,
    consensusMomentum: consensusMomentumScore,
    smartMoney: smartMoneyScore,
    explosion: explosionScore,
    explosiveBuy,
    goldenTrade,
    explosionFactor,
    certaintyIndex,
    rawTotal,
    total,
    volumeCapped,
    trendCapped,
    vixApplied,
    riskLevel,
    warnings,
    marketContext: marketCtx,
    safetyChecklist,
    details: {
      rsiRecovering: technical.rsiRecovering,
      aboveSMA200: technical.aboveSMA200,
      strongBuyConsensus: institutional.strongBuyConsensus,
      insiderNetBuying: institutional.insiderNetBuying,
      sentimentLabel: sentimentResult.sentiment,
      sentimentReasoning: sentimentResult.reasoning,
      catalystScore: sentimentResult.catalystScore,
      catalystSummary: sentimentResult.catalystSummary,
      volumeStatus: vol ? vol.status : "N/A",
      volumeRatio: vol ? parseFloat(vol.ratio.toFixed(2)) : 0,
      earningsSoon: earningsCheck.soon,
      earningsDate: earningsCheck.date,
      relativeStrengthData: rs,
      threeMonthRSData: rs3m,
      weeklyTrend,
      atrData,
      explosionSignal,
      earningsSurprise,
      sectorETFData: snapshot.sectorETF,
      highSocialInterest,
      socialPositive,
      institutionalIncrease,
      consensusImproving,
      smartMoneyBuy: smartMoney.found,
      smartMoneyDetails: smartMoney.details,
    },
  };
}

// ── Action + Stop-Loss ───────────────────────────────────────────────────────

function deriveAction(score: number): "BUY" | "SELL" | "WATCH" {
  if (score > 70) return "BUY";
  if (score < 30) return "SELL";
  return "WATCH";
}

function calculateStopLoss(
  action: "BUY" | "SELL" | "WATCH",
  atrData: ATRResult | null,
  currentPrice: number
): number | null {
  if (action !== "BUY") return null;
  // ATR-based stop-loss: Current Price - (2 * ATR)
  if (atrData) return atrData.stopLoss;
  // Fallback to 10% if no ATR data
  return parseFloat((currentPrice * 0.9).toFixed(2));
}

// ── Build Reasoning String ───────────────────────────────────────────────────

function buildReasoning(breakdown: ScoreBreakdown): string {
  const d = breakdown.details;
  const parts: string[] = [];

  // Technical
  parts.push(d.rsiRecovering ? "RSI recovering (+15)" : "RSI neutral");
  parts.push(d.aboveSMA200 ? "above SMA200 (+15)" : "below/no SMA200");

  // Institutional
  parts.push(d.strongBuyConsensus ? "Strong Buy consensus (+20)" : "no Strong Buy");
  parts.push(d.insiderNetBuying ? "insider buying (+10)" : "no insider activity");

  // AI Sentiment
  const aiFailed = d.sentimentReasoning.includes("unavailable");
  if (aiFailed) {
    parts.push("AI fallback (+15)");
  } else {
    parts.push(`AI ${d.sentimentLabel.toLowerCase()} (+${breakdown.aiSentiment})`);
  }

  // Volume
  if (d.volumeStatus === "High") {
    parts.push(`high vol ${d.volumeRatio}x (+15)`);
  } else if (d.volumeStatus === "Low") {
    parts.push(`low vol ${d.volumeRatio}x${breakdown.volumeCapped ? " [capped@60]" : ""}`);
  } else if (d.volumeStatus === "Normal") {
    parts.push(`vol ${d.volumeRatio}x`);
  }

  // Relative Strength (1-day)
  const rs = d.relativeStrengthData;
  if (rs) {
    if (rs.relativeWeakness) parts.push(`weak vs SPY (-10)`);
    else if (rs.outperforming) parts.push(`outperform SPY (+10)`);
  }

  // 3-Month Relative Strength
  const rs3m = d.threeMonthRSData;
  if (rs3m && rs3m.underperforming) {
    parts.push(`3M underperform (-20)`);
  }

  // Weekly Trend
  const wt = d.weeklyTrend;
  if (wt) {
    if (!wt.bullish) parts.push(`below 20wk SMA${breakdown.trendCapped ? " [capped@50]" : ""}`);
    else parts.push("above 20wk SMA");
  }

  // Earnings Surprise
  const es = d.earningsSurprise;
  if (es) {
    const sign = es.surprisePercent > 0 ? "+" : "";
    if (Math.abs(es.surprisePercent) > 15) {
      parts.push(`${sign}${es.surprisePercent}% Earnings BEAT`);
    } else {
      parts.push(`EPS surprise ${sign}${es.surprisePercent}%`);
    }
  }

  // Explosion Detection
  const ex = d.explosionSignal;
  if (ex.triggered) {
    const sigs = [ex.vcpDetected ? "VCP breakout" : null, ex.nearHigh ? "near 52w High" : null, ex.volumeSpark ? "volume spike" : null].filter(Boolean);
    parts.push(`EXPLOSION (+25): ${sigs.join(" + ")}`);
  } else {
    const flags = [ex.vcpDetected ? "VCP" : null, ex.nearHigh ? "near-high" : null, ex.volumeSpark ? "vol-spark" : null].filter(Boolean);
    if (flags.length > 0) parts.push(`explosion partial: ${flags.join("+")}`);
  }

  // Whale Tracker
  if (d.institutionalIncrease) parts.push("inst. accumulation (+15)");

  // Consensus Momentum
  if (d.consensusImproving) parts.push("analyst momentum (+10)");

  // Smart Money
  if (d.smartMoneyBuy) parts.push(`SMART MONEY (+20): ${d.smartMoneyDetails}`);

  // Social Spike
  if (d.highSocialInterest) {
    parts.push(`social spike${d.socialPositive ? " (+5)" : ""}`);
  }

  // Certainty Index
  const ci = breakdown.certaintyIndex;
  if (ci.total > 0) {
    let ciLabel = ci.label ? ` [${ci.label}]` : "";
    if (ci.sectorHeadwind) ciLabel += " ⚠️ Sector Headwind";
    if (ci.highConviction) ciLabel += " 🚀 HIGH CONVICTION";
    parts.push(`Certainty ${ci.total}/100${ciLabel}`);
  }

  // VIX
  if (breakdown.vixApplied) {
    parts.push(`VIX ${breakdown.marketContext.vixLevel} [0.8x applied]`);
  }

  // Earnings
  if (d.earningsSoon) parts.push(`EARNINGS ${d.earningsDate} [EXTREME]`);

  return `Score ${breakdown.total}: ${parts.join(", ")}`;
}

// ── Main Analyzer ────────────────────────────────────────────────────────────

export async function analyzeMarket(
  snapshot: MarketSnapshot,
  sentimentResult: AISentimentResult
): Promise<TodoAction> {
  const breakdown = await calculateConfidenceScore(snapshot, sentimentResult);

  const currentPrice =
    snapshot.prices.length > 0
      ? snapshot.prices[snapshot.prices.length - 1].close
      : 0;

  // Major negative catalyst: regardless of other signals, cap score and force SELL
  if (breakdown.details.catalystScore <= -15) {
    const penalizedTotal = Math.min(breakdown.total, 35);
    const warning = `⚠️ MAJOR NEGATIVE CATALYST: ${breakdown.details.catalystSummary}`;
    return {
      ticker: snapshot.symbol,
      action: "SELL",
      score: penalizedTotal,
      breakdown: { ...breakdown, total: penalizedTotal },
      reasoning: `${warning} (pre-catalyst score: ${breakdown.total})`,
      stopLoss: null,
      volumeStatus: breakdown.details.volumeStatus,
      riskLevel: "EXTREME",
      warnings: [...breakdown.warnings, warning],
      marketContext: breakdown.marketContext,
    };
  }

  // GOLDEN TRADE: Explosive + RS > 15% (3M) + Institutional accumulation — top 1%
  if (breakdown.goldenTrade) {
    const es = breakdown.details.earningsSurprise;
    const ex = breakdown.details.explosionSignal;
    const vol = breakdown.details.volumeRatio;
    const rs3m = breakdown.details.threeMonthRSData;
    const ci = breakdown.certaintyIndex;
    const surpriseStr = es ? `+${es.surprisePercent}% Earnings beat + ` : "";
    const rsStr = rs3m ? `${rs3m.tickerChange3M}% RS (3M) + ` : "";
    const reasoning = `GOLDEN TRADE (Certainty ${ci.total}/100): ${surpriseStr}${rsStr}Institutional accumulation + Volume ${vol}x breakout${ex.vcpDetected ? " from VCP" : ""} near 52w High`;

    return {
      ticker: snapshot.symbol,
      action: "GOLDEN TRADE",
      score: 99,
      breakdown: { ...breakdown, total: 99 },
      reasoning,
      stopLoss: calculateStopLoss("BUY", breakdown.details.atrData, currentPrice),
      volumeStatus: breakdown.details.volumeStatus,
      riskLevel: breakdown.riskLevel,
      warnings: [...breakdown.warnings, reasoning],
      marketContext: breakdown.marketContext,
    };
  }

  // EXPLOSIVE BUY override: Certainty Index > 85
  if (breakdown.explosiveBuy) {
    const ex = breakdown.details.explosionSignal;
    const vol = breakdown.details.volumeRatio;
    const ci = breakdown.certaintyIndex;
    const es = breakdown.details.earningsSurprise;
    const surpriseStr = es ? `${es.surprisePercent > 0 ? "+" : ""}${es.surprisePercent}% Earnings beat + ` : "";
    const reasoning = `Certainty ${ci.total}/100 — ${surpriseStr}High Volume ${vol}x breakout${ex.vcpDetected ? " from VCP" : ""} near 52w High ($${ex.high52w}, ${ex.pctFromHigh}% away)`;

    return {
      ticker: snapshot.symbol,
      action: "EXPLOSIVE BUY",
      score: 95,
      breakdown: { ...breakdown, total: 95 },
      reasoning,
      stopLoss: calculateStopLoss("BUY", breakdown.details.atrData, currentPrice),
      volumeStatus: breakdown.details.volumeStatus,
      riskLevel: breakdown.riskLevel,
      warnings: [...breakdown.warnings, `EXPLOSIVE BUY: ${reasoning}`],
      marketContext: breakdown.marketContext,
    };
  }

  // VIX > 35: force all actions to WATCH
  const action = snapshot.vix.level > 35 ? "WATCH" : deriveAction(breakdown.total);

  return {
    ticker: snapshot.symbol,
    action,
    score: breakdown.total,
    breakdown,
    reasoning: buildReasoning(breakdown),
    stopLoss: calculateStopLoss(action, breakdown.details.atrData, currentPrice),
    volumeStatus: breakdown.details.volumeStatus,
    riskLevel: breakdown.riskLevel,
    warnings: breakdown.warnings,
    marketContext: breakdown.marketContext,
  };
}
