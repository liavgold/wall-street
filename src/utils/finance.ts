import fs from "fs";

/**
 * Portfolio-level risk management and position sizing.
 *
 * Model: Fixed-fractional — risk exactly RISK_PER_TRADE of the portfolio
 * on each trade, using a 2% stop-loss to determine share quantity.
 *
 *   Risk amount  = TOTAL_PORTFOLIO × RISK_PER_TRADE  →  $100
 *   Risk/share   = currentPrice × stopLossPct        →  e.g. $2 on a $100 stock
 *   Shares       = Risk amount / Risk per share       →  50 shares
 */

export const TOTAL_PORTFOLIO = 10_000;  // $10,000 total portfolio value
export const RISK_PER_TRADE  = 0.01;   // 1% risk per trade
export const SECTOR_CAP      = 0.25;   // max 25% of active positions in any one sector

export interface PositionSize {
  shares: number;        // Recommended number of whole shares to buy
  totalValue: number;    // Total investment cost ($)
  stopLossPrice: number; // Price level at which to exit (2% below entry)
}

/**
 * Returns a position-size multiplier based on the VIX level.
 * VIX > 28 (Macro Extreme Regime) → 0.5x (half position size).
 * All other regimes → 1.0x (full size).
 */
export function getVixPositionMultiplier(vixLevel: number): number {
  return vixLevel > 28 ? 0.5 : 1.0;
}

/**
 * Calculate a risk-adjusted position size.
 *
 * @param currentPrice  Current stock price (must be > 0)
 * @param stopLossPct   Stop-loss distance as a fraction (default 2% = 0.02)
 * @param vixMultiplier Position-size multiplier from getVixPositionMultiplier() (default 1.0)
 */
export function calculatePositionSize(
  currentPrice: number,
  stopLossPct = 0.02,
  vixMultiplier = 1.0,
): PositionSize {
  if (currentPrice <= 0) {
    return { shares: 0, totalValue: 0, stopLossPrice: 0 };
  }

  const riskAmount    = TOTAL_PORTFOLIO * RISK_PER_TRADE * vixMultiplier;  // $100 × multiplier
  const riskPerShare  = currentPrice * stopLossPct;                        // e.g. $2.00
  const shares        = riskPerShare > 0 ? Math.floor(riskAmount / riskPerShare) : 0;
  const totalValue    = parseFloat((shares * currentPrice).toFixed(2));
  const stopLossPrice = parseFloat((currentPrice * (1 - stopLossPct)).toFixed(2));

  return { shares, totalValue, stopLossPrice };
}

// ── Sector Concentration Cap ──────────────────────────────────────────────────

export interface SectorCapResult {
  capped: boolean;
  sector: string;          // ETF symbol of the new ticker (e.g. "XLY")
  sectorPositions: number; // existing buy positions in that sector
  totalPositions: number;  // total existing buy positions
  projectedPct: number;    // sector share if new ticker is added (0–1)
}

/**
 * Check whether adding a new BUY ticker would push any sector over SECTOR_CAP (25%).
 *
 * Reads current buy positions from OPPORTUNITIES.md and counts per sector ETF.
 * Returns capped=true when  sectorPositions / (totalPositions + 1) >= SECTOR_CAP.
 *
 * @param newTickerSector  ETF of the incoming signal (e.g. "XLY")
 * @param opportunitiesPath  Absolute path to OPPORTUNITIES.md
 */
export function checkSectorCap(
  newTickerSector: string,
  opportunitiesPath: string,
): SectorCapResult {
  let sectorPositions = 0;
  let totalPositions  = 0;

  try {
    if (!fs.existsSync(opportunitiesPath)) {
      return { capped: false, sector: newTickerSector, sectorPositions: 0, totalPositions: 0, projectedPct: 0 };
    }

    const BUY_ACTIONS = new Set(["BUY", "EXPLOSIVE BUY", "GOLDEN TRADE"]);
    const content = fs.readFileSync(opportunitiesPath, "utf-8");

    for (const line of content.split("\n")) {
      if (!line.startsWith("|")) continue;
      const cells = line.split("|").map(c => c.trim()).filter(c => c.length > 0);
      if (cells.length < 3) continue;

      const ticker    = cells[0];
      const sectorRaw = cells[1]; // e.g. "XLY +1.04%"
      const actionRaw = cells[2].replace(/\*+/g, "").trim();

      // Skip header, separator, and non-buy rows
      if (!ticker || ticker === "Ticker" || /^[-–]+$/.test(ticker)) continue;
      if (!BUY_ACTIONS.has(actionRaw.toUpperCase())) continue;

      totalPositions++;

      // Extract ETF symbol: "XLY +1.04%" → "XLY"
      const etfMatch = sectorRaw.match(/^([A-Z]+)/);
      if (etfMatch && etfMatch[1] === newTickerSector) {
        sectorPositions++;
      }
    }
  } catch {
    return { capped: false, sector: newTickerSector, sectorPositions: 0, totalPositions: 0, projectedPct: 0 };
  }

  const projectedPct = totalPositions === 0
    ? 0
    : sectorPositions / (totalPositions + 1);

  return {
    capped: projectedPct >= SECTOR_CAP,
    sector: newTickerSector,
    sectorPositions,
    totalPositions,
    projectedPct: parseFloat(projectedPct.toFixed(4)),
  };
}
