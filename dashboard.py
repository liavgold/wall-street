"""
WallStreet To-Do Dashboard
Run with:  streamlit run dashboard.py
Install:   pip install streamlit plotly pandas
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

# ── Paths ─────────────────────────────────────────────────────────────────────

ROOT = Path(__file__).parent
HISTORY_PATH = ROOT / "logs" / "history.json"
OPPORTUNITIES_PATH = ROOT / "OPPORTUNITIES.md"
PERFORMANCE_PATH = ROOT / "logs" / "performance.md"

# ── Design Tokens ─────────────────────────────────────────────────────────────

BG       = "#0d1117"
CARD     = "#161b22"
BORDER   = "#30363d"
GREEN    = "#3fb950"
RED      = "#f85149"
GOLD     = "#e3b341"
BLUE     = "#58a6ff"
WHITE    = "#c9d1d9"
MUTED    = "#8b949e"

_PLOTLY_BASE = dict(
    paper_bgcolor=CARD,
    plot_bgcolor=CARD,
    font=dict(color=WHITE, family="monospace"),
    margin=dict(l=20, r=20, t=44, b=20),
)

# ── Page Config ───────────────────────────────────────────────────────────────

st.set_page_config(
    page_title="WallStreet Dashboard",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# ── Global CSS ────────────────────────────────────────────────────────────────

st.markdown(f"""
<style>
  /* ── App background ── */
  .stApp {{ background-color: {BG}; color: {WHITE}; }}
  .block-container {{ padding-top: 1.4rem; padding-bottom: 1rem; max-width: 100%; }}

  /* ── Hide Streamlit chrome ── */
  #MainMenu, footer {{ visibility: hidden; }}

  /* ── Metric cards ── */
  div[data-testid="metric-container"] {{
    background: {CARD};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 14px 18px;
  }}
  div[data-testid="metric-container"] label {{
    color: {MUTED} !important;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-family: monospace;
  }}
  div[data-testid="stMetricValue"] {{
    font-size: 1.65rem !important;
    font-weight: 700 !important;
    font-family: monospace !important;
    color: {WHITE} !important;
  }}
  div[data-testid="stMetricDelta"] > div {{
    font-family: monospace !important;
    font-size: 0.75rem !important;
    color: {MUTED} !important;
  }}

  /* ── Section headings ── */
  h2, h3 {{
    color: {WHITE} !important;
    font-family: monospace !important;
    border-bottom: 1px solid {BORDER};
    padding-bottom: 6px;
    margin-top: 1.2rem !important;
  }}

  /* ── Info bar ── */
  .info-bar {{
    background: {CARD};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 10px 16px;
    font-family: monospace;
    font-size: 0.82rem;
    color: {MUTED};
    line-height: 1.8;
  }}
  .info-bar .val {{ color: {WHITE}; font-weight: 600; }}

  /* ── Watchlist table ── */
  .watchlist-wrap {{
    background: {CARD};
    border: 1px solid {BORDER};
    border-radius: 8px;
    overflow: hidden;
  }}
  .watchlist-wrap table {{
    width: 100%;
    border-collapse: collapse;
    font-family: monospace;
    font-size: 13px;
  }}
  .watchlist-wrap thead tr {{
    background: {BG};
    border-bottom: 1px solid {BORDER};
  }}
  .watchlist-wrap thead th {{
    padding: 10px 14px;
    text-align: left;
    color: {MUTED};
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }}
  .watchlist-wrap tbody tr {{
    border-bottom: 1px solid {BORDER};
    transition: background 0.15s;
  }}
  .watchlist-wrap tbody tr:last-child {{ border-bottom: none; }}
  .watchlist-wrap tbody tr:hover {{ background: rgba(88,166,255,0.05); }}
  .watchlist-wrap tbody td {{ padding: 9px 14px; color: {WHITE}; vertical-align: middle; }}
  .badge {{
    display: inline-block;
    padding: 2px 9px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
    font-family: monospace;
    letter-spacing: 0.03em;
  }}
  .b-gold  {{ background:rgba(227,179,65,0.15); color:{GOLD};  border:1px solid {GOLD};  }}
  .b-green {{ background:rgba(63,185,80,0.15);  color:{GREEN}; border:1px solid {GREEN}; }}
  .b-blue  {{ background:rgba(88,166,255,0.15); color:{BLUE};  border:1px solid {BLUE};  }}
  .b-red   {{ background:rgba(248,81,73,0.15);  color:{RED};   border:1px solid {RED};   }}
  .b-muted {{ background:rgba(139,148,158,0.15);color:{MUTED}; border:1px solid {BORDER};}}

  /* ── No-data card ── */
  .empty-card {{
    background: {CARD};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 24px;
    text-align: center;
    font-family: monospace;
    color: {MUTED};
    font-size: 0.9rem;
  }}

  /* ── Footer ── */
  .dash-footer {{
    text-align: center;
    color: {MUTED};
    font-family: monospace;
    font-size: 0.72rem;
    padding: 28px 0 8px;
    border-top: 1px solid {BORDER};
    margin-top: 2rem;
  }}
</style>
""", unsafe_allow_html=True)

# ── Data Loaders (cached 5 min) ───────────────────────────────────────────────

@st.cache_data(ttl=300)
def load_history() -> pd.DataFrame:
    if not HISTORY_PATH.exists():
        return pd.DataFrame()
    with open(HISTORY_PATH, "r") as f:
        data = json.load(f)
    if not data:
        return pd.DataFrame()
    df = pd.DataFrame(data)
    df["date"]  = pd.to_datetime(df["date"])
    df["score"] = pd.to_numeric(df["score"], errors="coerce").fillna(0).astype(int)
    df["price"] = pd.to_numeric(df["price"], errors="coerce").fillna(0.0)
    return df


@st.cache_data(ttl=300)
def parse_opportunities() -> dict:
    if not OPPORTUNITIES_PATH.exists():
        return {}
    text = OPPORTUNITIES_PATH.read_text(encoding="utf-8")
    out: dict = {}

    # Scan metadata line
    m = re.search(
        r"\*\*Scan Date:\*\*\s*(\S+)"
        r".*?\*\*Time:\*\*\s*(.+?)\s*\|"
        r".*?\*\*Session:\*\*\s*(.+?)\s*\|"
        r".*?\*\*Mode:\*\*\s*(\S+)"
        r".*?\*\*Tickers Scanned:\*\*\s*(\d+)",
        text,
    )
    if m:
        out["scan_date"]       = m.group(1)
        out["scan_time"]       = m.group(2).strip()
        out["session"]         = m.group(3).strip()
        out["mode"]            = m.group(4)
        out["tickers_scanned"] = int(m.group(5))

    # Market context
    for label, key in [
        ("VIX", "vix"),
        ("Sector Health", "sector_health"),
        ("General Sentiment", "sentiment"),
    ]:
        cm = re.search(rf"\|\s*{re.escape(label)}\s*\|\s*(.+?)\s*\|", text)
        if cm:
            out[key] = cm.group(1).strip()

    # Scan summary numbers
    for label, key in [
        (r"Total scanned",        "total_scanned"),
        (r"Passed filters",       "passed_filters"),
        (r"Golden Trades[^:]*",   "golden_trades"),
        (r"Explosive signals",    "explosive_signals"),
        (r"High-confidence buys", "high_confidence"),
    ]:
        sm = re.search(rf"\*\*{label}:\*\*\s*(\d+)", text)
        if sm:
            out[key] = int(sm.group(1))

    # Opportunity table rows
    rows = []
    in_table = False
    for line in text.splitlines():
        line = line.strip()
        if "| Ticker |" in line and "Sector ETF" in line:
            in_table = True
            continue
        if not in_table:
            continue
        if re.match(r"^\|\s*-+", line):
            continue
        if not line.startswith("|"):
            in_table = False
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 10:
            continue
        score_raw = re.sub(r"[^\d\-]", "", cells[3])
        rows.append({
            "ticker":            cells[0],
            "sector_etf":        cells[1],
            "action":            re.sub(r"\*+", "", cells[2]).strip(),
            "score":             int(score_raw) if score_raw else 0,
            "certainty":         cells[4],
            "earnings_surprise": cells[5],
            "rs_1d":             cells[6],
            "stop_loss":         cells[9],
        })
    out["opportunities"] = rows
    return out


@st.cache_data(ttl=300)
def parse_performance() -> dict:
    if not PERFORMANCE_PATH.exists():
        return {}
    text = PERFORMANCE_PATH.read_text(encoding="utf-8")
    out: dict = {}

    m = re.search(r"\*\*Report Date:\*\*\s*(\S+).*?\*\*Data Points:\*\*\s*(\d+)", text)
    if m:
        out["report_date"] = m.group(1)
        out["data_points"] = int(m.group(2))

    for label, key in [
        ("Win Rate",                     "win_rate"),
        ("Average Return",               "avg_return"),
        ("Avg Return per Explosive Pick", "explosive_avg"),
        ("Avg Return per Buy Pick",       "buy_avg"),
        ("Sell Accuracy.*?",              "sell_accuracy"),
    ]:
        pm = re.search(rf"\|\s*{label}\s*\|\s*(.+?)\s*\|", text)
        if pm:
            out[key] = pm.group(1).strip()
    return out

# ── Helpers ───────────────────────────────────────────────────────────────────

def _pct_float(raw: str) -> float | None:
    m = re.search(r"([+-]?[\d.]+)%", str(raw))
    return float(m.group(1)) if m else None


def _action_badge(action: str) -> str:
    a = action.upper()
    if "GOLDEN" in a:
        return f"<span class='badge b-gold'>🏆 {action}</span>"
    if "EXPLOSIVE" in a:
        return f"<span class='badge b-gold'>🔥 {action}</span>"
    if "BUY" in a:
        return f"<span class='badge b-green'>▲ {action}</span>"
    if "WATCH" in a:
        return f"<span class='badge b-blue'>👁 {action}</span>"
    if "SELL" in a:
        return f"<span class='badge b-red'>▼ {action}</span>"
    return f"<span class='badge b-muted'>{action}</span>"


def _score_cell(score: int) -> str:
    if score >= 80:
        color = GOLD
    elif score >= 60:
        color = GREEN
    elif score >= 30:
        color = BLUE
    elif score > 0:
        color = MUTED
    else:
        color = RED
    return f"<span style='color:{color};font-weight:700;'>{score}</span>"

# ── Charts ────────────────────────────────────────────────────────────────────

def _score_bar(df: pd.DataFrame) -> go.Figure:
    latest = df[df["date"] == df["date"].max()].copy()
    latest = latest.sort_values("score", ascending=True)

    bar_colors = []
    for s in latest["score"]:
        if s >= 80:   bar_colors.append(GOLD)
        elif s >= 60: bar_colors.append(GREEN)
        elif s >= 30: bar_colors.append(BLUE)
        elif s > 0:   bar_colors.append(MUTED)
        else:         bar_colors.append(RED)

    fig = go.Figure(go.Bar(
        x=latest["score"],
        y=latest["ticker"],
        orientation="h",
        marker=dict(color=bar_colors, line=dict(color=BORDER, width=0.5)),
        text=[f"{s:+d}" for s in latest["score"]],
        textposition="outside",
        textfont=dict(color=WHITE, size=10, family="monospace"),
        hovertemplate="<b>%{y}</b><br>Score: %{x:+d}<br>Action: %{customdata}<extra></extra>",
        customdata=latest["action"],
    ))

    x_min = min(int(latest["score"].min()) - 15, -25)
    x_max = int(latest["score"].max()) + 20

    fig.update_layout(
        **_PLOTLY_BASE,
        title=dict(
            text=f"Signal Scores — {latest['date'].iloc[0].strftime('%Y-%m-%d')}",
            font=dict(color=WHITE, size=13),
        ),
        height=max(380, len(latest) * 23),
        xaxis=dict(
            gridcolor=BORDER, linecolor=BORDER, zerolinecolor=BORDER,
            range=[x_min, x_max], title=None,
        ),
        yaxis=dict(
            gridcolor=BORDER, linecolor=BORDER, zerolinecolor=BORDER,
            title=None, tickfont=dict(family="monospace", size=11),
        ),
        showlegend=False,
        bargap=0.28,
    )
    fig.add_vline(x=0,  line_color=MUTED,  line_width=1, line_dash="dot")
    fig.add_vline(x=75, line_color=GREEN,  line_width=1, line_dash="dash",
                  annotation_text="Buy threshold (75)",
                  annotation_font_color=GREEN,
                  annotation_position="top right")
    return fig


def _accuracy_line(df: pd.DataFrame) -> go.Figure:
    buy_set = {"BUY", "EXPLOSIVE BUY", "GOLDEN TRADE", "WATCH"}
    grp = (
        df.groupby("date")
        .agg(
            avg_score=("score", "mean"),
            total=("score", "count"),
            bullish=("action", lambda x: sum(a in buy_set for a in x)),
        )
        .reset_index()
        .sort_values("date")
    )
    grp["bullish_pct"] = (grp["bullish"] / grp["total"] * 100).round(1)

    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=grp["date"], y=grp["avg_score"],
        name="Avg Score",
        mode="lines+markers",
        line=dict(color=BLUE, width=2),
        marker=dict(size=7, color=BLUE, line=dict(color=BG, width=1.5)),
        yaxis="y1",
        hovertemplate="<b>%{x|%Y-%m-%d}</b><br>Avg Score: %{y:.1f}<extra></extra>",
    ))
    fig.add_trace(go.Scatter(
        x=grp["date"], y=grp["bullish_pct"],
        name="Bullish %",
        mode="lines+markers",
        line=dict(color=GREEN, width=2, dash="dot"),
        marker=dict(size=7, color=GREEN, line=dict(color=BG, width=1.5)),
        yaxis="y2",
        hovertemplate="<b>%{x|%Y-%m-%d}</b><br>Bullish signals: %{y:.1f}%<extra></extra>",
    ))

    fig.update_layout(
        **_PLOTLY_BASE,
        title=dict(text="Historical Signal Accuracy", font=dict(color=WHITE, size=13)),
        height=300,
        xaxis=dict(gridcolor=BORDER, linecolor=BORDER, title=None),
        yaxis=dict(
            gridcolor=BORDER, linecolor=BORDER, zerolinecolor=BORDER,
            title="Avg Score", title_font=dict(color=BLUE, family="monospace"),
        ),
        yaxis2=dict(
            overlaying="y", side="right",
            title="Bullish %", title_font=dict(color=GREEN, family="monospace"),
            ticksuffix="%", range=[0, 100],
            showgrid=False, gridcolor=BORDER, linecolor=BORDER,
        ),
        legend=dict(
            bgcolor="rgba(0,0,0,0)", bordercolor=BORDER, borderwidth=1,
            font=dict(color=WHITE, family="monospace"), x=0.01, y=0.99,
        ),
        hovermode="x unified",
    )
    return fig


def _distribution_donut(df: pd.DataFrame) -> go.Figure:
    latest = df[df["date"] == df["date"].max()]
    counts = latest["action"].value_counts()

    color_map = {
        "EXPLOSIVE BUY": GOLD,
        "GOLDEN TRADE":  "#ff9f00",
        "BUY":           GREEN,
        "WATCH":         BLUE,
        "SELL":          RED,
        "HOLD":          MUTED,
    }
    colors = [color_map.get(a, MUTED) for a in counts.index]

    fig = go.Figure(go.Pie(
        labels=counts.index,
        values=counts.values,
        hole=0.58,
        marker=dict(colors=colors, line=dict(color=BG, width=2)),
        textfont=dict(family="monospace", color=WHITE, size=11),
        hovertemplate="<b>%{label}</b><br>%{value} signals (%{percent})<extra></extra>",
    ))
    fig.update_layout(
        **_PLOTLY_BASE,
        title=dict(text="Signal Distribution", font=dict(color=WHITE, size=13)),
        height=300,
        legend=dict(
            bgcolor="rgba(0,0,0,0)",
            font=dict(color=WHITE, family="monospace", size=11),
            orientation="v", x=0.8,
        ),
        annotations=[dict(
            text=f"<b>{len(latest)}</b><br><span style='font-size:10px'>signals</span>",
            x=0.5, y=0.5,
            font=dict(size=18, color=WHITE, family="monospace"),
            showarrow=False,
        )],
    )
    return fig


def _gauge(value: float, title: str, suffix: str,
           rng: tuple[float, float], threshold: float,
           good_high: bool = True) -> go.Figure:
    lo, hi = rng
    bar_color = GREEN if (value >= threshold) == good_high else RED

    fig = go.Figure(go.Indicator(
        mode="gauge+number+delta",
        value=value,
        title=dict(text=title, font=dict(color=WHITE, family="monospace", size=13)),
        number=dict(
            suffix=suffix, valueformat="+.2f" if suffix == "%" and lo < 0 else ".1f",
            font=dict(color=WHITE, family="monospace", size=34),
        ),
        delta=dict(
            reference=threshold, relative=False, valueformat=".2f",
            increasing=dict(color=GREEN if good_high else RED),
            decreasing=dict(color=RED if good_high else GREEN),
        ),
        gauge=dict(
            axis=dict(
                range=[lo, hi],
                tickcolor=MUTED,
                tickfont=dict(color=MUTED, family="monospace"),
            ),
            bar=dict(color=bar_color, thickness=0.22),
            bgcolor=BG,
            borderwidth=1,
            bordercolor=BORDER,
            steps=[
                dict(range=[lo, threshold], color="rgba(248,81,73,0.08)" if good_high else "rgba(63,185,80,0.08)"),
                dict(range=[threshold, hi], color="rgba(63,185,80,0.08)" if good_high else "rgba(248,81,73,0.08)"),
            ],
            threshold=dict(line=dict(color=GOLD, width=3), thickness=0.75, value=threshold),
        ),
    ))
    fig.update_layout(
        paper_bgcolor=CARD,
        font=dict(color=WHITE),
        height=240,
        margin=dict(l=28, r=28, t=52, b=10),
    )
    return fig

# ── Main Layout ───────────────────────────────────────────────────────────────

def main() -> None:
    df   = load_history()
    opp  = parse_opportunities()
    perf = parse_performance()

    # ── Header ────────────────────────────────────────────────────────────────
    hcol, rcol = st.columns([5, 1])
    with hcol:
        st.markdown(
            f"<h1 style='font-family:monospace;font-size:1.55rem;"
            f"color:{WHITE};margin:0;padding:0;line-height:1.3;'>"
            f"📈 WallStreet To-Do "
            f"<span style='color:{MUTED};font-size:0.95rem;font-weight:400;'>"
            f"/ Performance Dashboard</span></h1>",
            unsafe_allow_html=True,
        )
    with rcol:
        if st.button("⟳  Refresh", use_container_width=True):
            st.cache_data.clear()
            st.rerun()

    # Info bar
    if opp:
        vix_raw = opp.get("vix", "—")
        vix_color = RED if "HIGH" in vix_raw.upper() or "ELEVATED" in vix_raw.upper() else GREEN
        st.markdown(
            f"<div class='info-bar'>"
            f"🕐 Last scan: <span class='val'>{opp.get('scan_date','—')} "
            f"{opp.get('scan_time','—')}</span>"
            f"&nbsp;·&nbsp; Session: <span class='val'>{opp.get('session','—')}</span>"
            f"&nbsp;·&nbsp; Mode: <span class='val'>{opp.get('mode','—')}</span>"
            f"&nbsp;·&nbsp; VIX: <span style='color:{vix_color};font-weight:600;'>{vix_raw}</span>"
            f"&nbsp;·&nbsp; Sector: <span class='val'>{opp.get('sector_health','—')}</span>"
            f"&nbsp;·&nbsp; Sentiment: <span class='val'>{opp.get('sentiment','—')}</span>"
            f"</div>",
            unsafe_allow_html=True,
        )

    st.markdown("<br>", unsafe_allow_html=True)

    # ── KPI Metrics ───────────────────────────────────────────────────────────
    win_rate_raw  = perf.get("win_rate", "0.0%")
    avg_ret_raw   = perf.get("avg_return", "N/A")
    win_rate_f    = _pct_float(win_rate_raw) or 0.0
    avg_ret_f     = _pct_float(avg_ret_raw)

    total_signals = len(df) if not df.empty else 0
    latest_date   = df["date"].max().strftime("%Y-%m-%d") if not df.empty else "—"
    explosive_n   = opp.get("explosive_signals", 0)
    golden_n      = opp.get("golden_trades", 0)
    data_pts      = perf.get("data_points", 0)

    k1, k2, k3, k4, k5 = st.columns(5)
    with k1:
        st.metric("Win Rate",          f"{win_rate_f:.1f}%",   "backtest accuracy")
    with k2:
        prefix = "+" if (avg_ret_f or 0) > 0 else ""
        val    = f"{prefix}{avg_ret_f:.2f}%" if avg_ret_f is not None else "N/A"
        st.metric("Avg Backtest Return", val,                   f"{data_pts} data pts")
    with k3:
        st.metric("Total Signals",     f"{total_signals:,}",   "all scans")
    with k4:
        st.metric("Explosive / Golden", f"{explosive_n} / {golden_n}", "latest scan")
    with k5:
        st.metric("Last Scan Date",    latest_date,            opp.get("session", ""))

    st.markdown("<br>", unsafe_allow_html=True)

    # ── Gauges ────────────────────────────────────────────────────────────────
    g1, g2 = st.columns(2)
    with g1:
        st.plotly_chart(
            _gauge(win_rate_f, "Win Rate %", "%", (0.0, 100.0), 50.0, good_high=True),
            use_container_width=True,
        )
    with g2:
        pl = avg_ret_f or 0.0
        span = max(abs(pl) * 2.5, 20.0)
        st.plotly_chart(
            _gauge(pl, "Avg Return %", "%", (-span, span), 0.0, good_high=True),
            use_container_width=True,
        )

    # ── Active Watchlist ──────────────────────────────────────────────────────
    st.markdown("### 🔥 Active Watchlist")

    watchlist_rows = opp.get("opportunities", [])

    # Fall back to top-scored WATCH/BUY entries from history when no opp table
    if not watchlist_rows and not df.empty:
        buy_actions = {"EXPLOSIVE BUY", "GOLDEN TRADE", "BUY", "WATCH"}
        ld = df["date"].max()
        fallback = (
            df[(df["date"] == ld) & (df["action"].isin(buy_actions))]
            .sort_values("score", ascending=False)
            .head(10)
        )
        for _, r in fallback.iterrows():
            watchlist_rows.append({
                "ticker":            r["ticker"],
                "action":            r["action"],
                "score":             int(r["score"]),
                "certainty":         "—",
                "earnings_surprise": "—",
                "rs_1d":             "—",
                "stop_loss":         f"${r['price']:.2f} (entry)",
            })

    if watchlist_rows:
        header_cols = ["Ticker", "Action", "Score", "Certainty", "Earnings Surprise", "RS (1d)", "Stop-Loss"]
        rows_html = ""
        for row in watchlist_rows:
            rows_html += (
                f"<tr>"
                f"<td><b>{row['ticker']}</b></td>"
                f"<td>{_action_badge(row['action'])}</td>"
                f"<td>{_score_cell(int(row['score']))}</td>"
                f"<td style='color:{MUTED}'>{row.get('certainty','—')}</td>"
                f"<td style='color:{MUTED}'>{row.get('earnings_surprise','—')}</td>"
                f"<td style='color:{MUTED}'>{row.get('rs_1d','—')}</td>"
                f"<td style='color:{MUTED}'>{row.get('stop_loss','—')}</td>"
                f"</tr>"
            )
        headers_html = "".join(f"<th>{h}</th>" for h in header_cols)
        st.markdown(
            f"<div class='watchlist-wrap'>"
            f"<table><thead><tr>{headers_html}</tr></thead>"
            f"<tbody>{rows_html}</tbody></table></div>",
            unsafe_allow_html=True,
        )
    else:
        st.markdown(
            f"<div class='empty-card'>"
            f"No active explosive or golden opportunities in the current scan.<br>"
            f"<span style='color:{MUTED};font-size:0.8rem;'>"
            f"Run <code>npm run scan -- --mode=full</code> to refresh signals.</span>"
            f"</div>",
            unsafe_allow_html=True,
        )

    st.markdown("<br>", unsafe_allow_html=True)

    # ── Charts ────────────────────────────────────────────────────────────────
    st.markdown("### 📊 Charts")

    if not df.empty:
        c1, c2 = st.columns([3, 2])
        with c1:
            st.plotly_chart(_score_bar(df),          use_container_width=True)
        with c2:
            st.plotly_chart(_distribution_donut(df), use_container_width=True)
        st.plotly_chart(_accuracy_line(df),          use_container_width=True)
    else:
        st.markdown(
            f"<div class='empty-card'>"
            f"No history data found.<br>"
            f"<span style='color:{MUTED};font-size:0.8rem;'>Run <code>npm run scan</code> first.</span>"
            f"</div>",
            unsafe_allow_html=True,
        )

    # ── Footer ────────────────────────────────────────────────────────────────
    st.markdown(
        f"<div class='dash-footer'>"
        f"WallStreet To-Do Dashboard &nbsp;·&nbsp; "
        f"Data auto-refreshes every 5 min &nbsp;·&nbsp; "
        f"<code>streamlit run dashboard.py</code>"
        f"</div>",
        unsafe_allow_html=True,
    )


if __name__ == "__main__":
    main()
