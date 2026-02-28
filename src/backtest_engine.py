"""
WallStreet Backtest Engine — Phase 1
=====================================
Reads  : logs/history.json        (scanner signals)
Writes : logs/backtest_results.json

Metrics computed
----------------
  win_rate      : % of BUY signals where price was higher after HOLD_DAYS trading days
  profit_factor : gross gains / gross losses (>1 = profitable system)
  alpha_vs_spy  : avg signal return minus avg SPY return over the same windows

Usage
-----
  python src/backtest_engine.py

Requirements
------------
  pip install requests python-dotenv
  POLYGON_API_KEY in .env (or environment)
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

# ── Config ────────────────────────────────────────────────────────────────────

load_dotenv()

ROOT              = Path(__file__).parent.parent
HISTORY_PATH      = ROOT / "logs" / "history.json"
RESULTS_PATH      = ROOT / "logs" / "backtest_results.json"
POLYGON_BASE      = "https://api.polygon.io"
POLYGON_KEY       = os.getenv("POLYGON_API_KEY", "")
HOLD_DAYS         = 21          # ~1 calendar month of trading days
MIN_AGE_DAYS      = 5           # signals must be at least this old to have outcome data
BUY_ACTIONS       = {"BUY", "EXPLOSIVE BUY", "GOLDEN TRADE"}
RATE_LIMIT_SLEEP  = 0.25        # seconds between Polygon requests (free tier = 5 req/min)


# ── Polygon helpers ───────────────────────────────────────────────────────────

def _polygon_get(path: str, params: dict) -> dict | None:
    """GET a Polygon endpoint; return parsed JSON or None on error."""
    if not POLYGON_KEY:
        print("[WARN] POLYGON_API_KEY not set — skipping price fetch", flush=True)
        return None
    params["apiKey"] = POLYGON_KEY
    url = f"{POLYGON_BASE}{path}"
    try:
        resp = requests.get(url, params=params, timeout=15)
        if resp.status_code == 200:
            return resp.json()
        print(f"[WARN] Polygon {resp.status_code} for {url}", flush=True)
        return None
    except requests.RequestException as exc:
        print(f"[WARN] Polygon request error: {exc}", flush=True)
        return None


def fetch_close(ticker: str, target_date: date) -> float | None:
    """
    Return the closing price of `ticker` on or just after `target_date`.
    Searches a 10-calendar-day window forward to handle weekends/holidays.
    """
    window_end = target_date + timedelta(days=10)
    data = _polygon_get(
        f"/v2/aggs/ticker/{ticker}/range/1/day/{target_date}/{window_end}",
        {"adjusted": "true", "sort": "asc", "limit": 5},
    )
    time.sleep(RATE_LIMIT_SLEEP)
    if not data or not data.get("results"):
        return None
    return data["results"][0]["c"]   # first available close ≥ target_date


# ── Core backtest logic ───────────────────────────────────────────────────────

def trading_days_after(signal_date: date, n: int) -> date:
    """Approximate target exit date (n trading days ≈ n * 7/5 calendar days)."""
    return signal_date + timedelta(days=round(n * 7 / 5))


def run_backtest() -> dict:
    if not HISTORY_PATH.exists():
        print(f"[ERROR] {HISTORY_PATH} not found — run the scanner first.", flush=True)
        sys.exit(1)

    with open(HISTORY_PATH) as f:
        history: list[dict] = json.load(f)

    today = date.today()
    trades: list[dict] = []
    spy_returns: list[float] = []

    eligible = [
        e for e in history
        if e.get("action", "").upper() in BUY_ACTIONS
        and (today - datetime.strptime(e["date"], "%Y-%m-%d").date()).days >= MIN_AGE_DAYS
        and e.get("price", 0) > 0
    ]

    print(f"[INFO] {len(eligible)} eligible BUY signals from {len(history)} history entries", flush=True)

    for entry in eligible:
        ticker      = entry["ticker"]
        signal_date = datetime.strptime(entry["date"], "%Y-%m-%d").date()
        entry_price = float(entry["price"])
        exit_date   = trading_days_after(signal_date, HOLD_DAYS)

        if exit_date >= today:
            continue  # outcome not yet known

        print(f"[INFO] Fetching exit price for {ticker} on {exit_date} …", flush=True)
        exit_price = fetch_close(ticker, exit_date)
        if exit_price is None:
            print(f"[WARN] No exit price for {ticker} — skipping", flush=True)
            continue

        pct_return  = ((exit_price - entry_price) / entry_price) * 100
        won         = pct_return > 0

        # SPY benchmark over same window
        spy_entry = fetch_close("SPY", signal_date)
        spy_exit  = fetch_close("SPY", exit_date)
        spy_return = ((spy_exit - spy_entry) / spy_entry) * 100 if (spy_entry and spy_exit) else None
        if spy_return is not None:
            spy_returns.append(spy_return)

        trades.append({
            "ticker":       ticker,
            "date":         entry["date"],
            "action":       entry["action"],
            "entry_price":  round(entry_price, 2),
            "exit_price":   round(exit_price, 2),
            "exit_date":    str(exit_date),
            "pct_return":   round(pct_return, 2),
            "spy_return":   round(spy_return, 2) if spy_return is not None else None,
            "won":          won,
        })

    if not trades:
        print("[WARN] No completed trades to evaluate — results will be empty.", flush=True)
        result = {
            "generated_at":   str(today),
            "data_points":    0,
            "win_rate":       None,
            "profit_factor":  None,
            "alpha_vs_spy":   None,
            "avg_return":     None,
            "trades":         [],
        }
        _write(result)
        return result

    # ── Metrics ───────────────────────────────────────────────────────────────

    wins        = [t for t in trades if t["won"]]
    losses      = [t for t in trades if not t["won"]]
    win_rate    = round(len(wins) / len(trades) * 100, 1)
    avg_return  = round(sum(t["pct_return"] for t in trades) / len(trades), 2)

    gross_gain  = sum(t["pct_return"] for t in wins)
    gross_loss  = abs(sum(t["pct_return"] for t in losses))
    profit_factor = round(gross_gain / gross_loss, 2) if gross_loss > 0 else None

    avg_spy     = round(sum(spy_returns) / len(spy_returns), 2) if spy_returns else None
    alpha       = round(avg_return - avg_spy, 2) if avg_spy is not None else None

    result: dict[str, Any] = {
        "generated_at":  str(today),
        "data_points":   len(trades),
        "win_rate":      win_rate,
        "profit_factor": profit_factor,
        "alpha_vs_spy":  alpha,
        "avg_return":    avg_return,
        "trades":        trades,
    }

    _write(result)
    print(
        f"[INFO] Backtest complete — {len(trades)} trades | "
        f"Win Rate: {win_rate}% | "
        f"Profit Factor: {profit_factor} | "
        f"Alpha vs SPY: {alpha}%",
        flush=True,
    )
    return result


def _write(result: dict) -> None:
    RESULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(RESULTS_PATH, "w") as f:
        json.dump(result, f, indent=2)
    print(f"[INFO] Results written to {RESULTS_PATH}", flush=True)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    run_backtest()
