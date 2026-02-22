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

export interface PositionSize {
  shares: number;        // Recommended number of whole shares to buy
  totalValue: number;    // Total investment cost ($)
  stopLossPrice: number; // Price level at which to exit (2% below entry)
}

/**
 * Calculate a risk-adjusted position size.
 *
 * @param currentPrice  Current stock price (must be > 0)
 * @param stopLossPct   Stop-loss distance as a fraction (default 2% = 0.02)
 */
export function calculatePositionSize(
  currentPrice: number,
  stopLossPct = 0.02,
): PositionSize {
  if (currentPrice <= 0) {
    return { shares: 0, totalValue: 0, stopLossPrice: 0 };
  }

  const riskAmount    = TOTAL_PORTFOLIO * RISK_PER_TRADE;           // $100
  const riskPerShare  = currentPrice * stopLossPct;                 // e.g. $2.00
  const shares        = riskPerShare > 0 ? Math.floor(riskAmount / riskPerShare) : 0;
  const totalValue    = parseFloat((shares * currentPrice).toFixed(2));
  const stopLossPrice = parseFloat((currentPrice * (1 - stopLossPct)).toFixed(2));

  return { shares, totalValue, stopLossPrice };
}
