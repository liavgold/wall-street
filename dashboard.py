"""
WallStreet Trading Dashboard
Run with:  streamlit run dashboard.py
Install:   pip install streamlit plotly pandas
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
import requests
import streamlit as st

# ── Paths ─────────────────────────────────────────────────────────────────────

ROOT             = Path(__file__).parent
HISTORY_PATH     = ROOT / "logs" / "history.json"
OPPORTUNITIES_PATH = ROOT / "OPPORTUNITIES.md"
PERFORMANCE_PATH = ROOT / "logs" / "performance.md"
SCANNER_LOG_PATH = ROOT / "logs" / "scanner.log"
COMBINED_LOG_PATH = ROOT / "logs" / "combined.log"

# ── Sector map (mirrors src/fetchers/marketData.ts) ───────────────────────────

SECTOR_MAP: dict[str, str] = {
    # Semiconductors
    "NVDA": "SMH",  "AMD": "SMH",  "ARM": "SMH",  "SMCI": "SMH",
    # Cybersecurity
    "PANW": "HACK", "CRWD": "HACK", "ZS": "HACK", "OKTA": "HACK", "FTNT": "HACK",
    # Fintech / Crypto
    "SQ": "ARKF",   "AFRM": "ARKF", "HOOD": "ARKF",
    "COIN": "BITO",
    # Consumer Discretionary
    "TSLA": "XLY",  "LULU": "XLY",  "DECK": "XLY",  "ABNB": "XLY",
    "UBER": "XLY",  "DASH": "XLY",  "RBLX": "XLY",  "DUOL": "XLY",
    "ONON": "XLY",  "CELH": "XLY",  "ELF": "XLY",   "TOST": "XLY",
    "AMZN": "XLY",
    # Cloud / Data
    "NET": "SKYY",  "DDOG": "SKYY", "SNOW": "SKYY", "MDB": "SKYY",
    "ESTC": "SKYY", "CFLT": "SKYY", "IOT": "SKYY",
    # Tech / Software
    "AAPL": "XLK",  "MSFT": "XLK",  "ADSK": "XLK",  "WDAY": "XLK",
    "TEAM": "XLK",  "HUBS": "XLK",  "GDDY": "XLK",  "BILL": "XLK",
    "MNDY": "XLK",  "SHOP": "XLK",  "TTD": "XLK",   "MELI": "XLK",
    "APP": "XLK",   "FICO": "XLK",  "TW": "XLK",    "AXON": "XLK",
    "PLTR": "XLK",  "MSTR": "XLK",  "META": "XLK",  "GOOGL": "XLK",
}

SECTOR_LABELS: dict[str, str] = {
    "SMH":  "Semiconductors",
    "HACK": "Cybersecurity",
    "ARKF": "Fintech",
    "BITO": "Crypto",
    "XLY":  "Consumer Disc.",
    "SKYY": "Cloud / Data",
    "XLK":  "Tech / Software",
    "SPY":  "Other",
}

# ── Color Palette (crypto / trading green) ────────────────────────────────────

DARK_BG  = "#0a0a0a"
CARD_BG  = "#111111"
BORDER   = "#1e3a1e"
PRIMARY  = "#00ff00"
DIM_GRN  = "#00cc44"
RED      = "#ff4444"
GOLD     = "#ffcc00"
WHITE    = "#e0e0e0"
MUTED    = "#555555"

# Sector slice colours (pie chart)
SECTOR_COLORS: dict[str, str] = {
    "SMH":  "#00ff00",
    "XLK":  "#00cc44",
    "XLY":  "#00aaff",
    "SKYY": "#0066cc",
    "HACK": "#cc44ff",
    "ARKF": "#ff8800",
    "BITO": "#ffcc00",
    "SPY":  "#555555",
}

_PLOTLY_BASE = dict(
    paper_bgcolor=CARD_BG,
    plot_bgcolor=CARD_BG,
    font=dict(color=WHITE, family="monospace"),
    margin=dict(l=16, r=16, t=44, b=16),
)

# ── Page Config ───────────────────────────────────────────────────────────────

st.set_page_config(
    page_title="WallStreet Dashboard",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ── Global CSS ────────────────────────────────────────────────────────────────

st.markdown(f"""
<style>
  /* App shell */
  .stApp {{ background-color: {DARK_BG}; color: {WHITE}; }}
  .block-container {{ padding-top: 1.2rem; padding-bottom: 1rem; max-width: 100%; }}
  section[data-testid="stSidebar"] {{ background: {CARD_BG}; border-right: 1px solid {BORDER}; }}
  #MainMenu, footer {{ visibility: hidden; }}

  /* Metric cards */
  div[data-testid="metric-container"] {{
    background: {CARD_BG};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 16px 20px;
  }}
  div[data-testid="metric-container"] label {{
    color: {MUTED} !important;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-family: monospace;
  }}
  div[data-testid="stMetricValue"] {{
    font-size: 2rem !important;
    font-weight: 700 !important;
    font-family: monospace !important;
    color: {PRIMARY} !important;
  }}
  div[data-testid="stMetricDelta"] > div {{
    font-family: monospace !important;
    font-size: 0.72rem !important;
  }}

  /* Section headings */
  h2, h3 {{
    color: {WHITE} !important;
    font-family: monospace !important;
    border-bottom: 1px solid {BORDER};
    padding-bottom: 6px;
    margin-top: 1.5rem !important;
  }}

  /* Sidebar status pill */
  .status-pill {{
    display: inline-block;
    padding: 4px 12px;
    border-radius: 20px;
    font-family: monospace;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.05em;
  }}
  .status-active  {{ background: rgba(0,255,0,0.12);  color: {PRIMARY}; border: 1px solid {PRIMARY}; }}
  .status-idle    {{ background: rgba(255,204,0,0.12); color: {GOLD};    border: 1px solid {GOLD}; }}
  .status-offline {{ background: rgba(255,68,68,0.12); color: {RED};     border: 1px solid {RED}; }}

  /* Sidebar info rows */
  .sb-row {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 5px 0;
    font-family: monospace;
    font-size: 0.8rem;
    border-bottom: 1px solid {BORDER};
  }}
  .sb-label {{ color: {MUTED}; }}
  .sb-value {{ color: {WHITE}; font-weight: 600; }}

  /* Action badge */
  .badge {{
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
    font-family: monospace;
    white-space: nowrap;
  }}
  .b-green {{ background: rgba(0,255,0,0.12);   color: {PRIMARY}; border: 1px solid {PRIMARY}; }}
  .b-gold  {{ background: rgba(255,204,0,0.12);  color: {GOLD};    border: 1px solid {GOLD};   }}
  .b-red   {{ background: rgba(255,68,68,0.12);  color: {RED};     border: 1px solid {RED};    }}
  .b-muted {{ background: rgba(85,85,85,0.15);   color: {MUTED};   border: 1px solid {MUTED};  }}

  /* Signals table */
  .sig-table-wrap {{
    background: {CARD_BG};
    border: 1px solid {BORDER};
    border-radius: 8px;
    overflow-x: auto;
  }}
  .sig-table-wrap table {{
    width: 100%;
    border-collapse: collapse;
    font-family: monospace;
    font-size: 13px;
  }}
  .sig-table-wrap thead tr {{
    background: {DARK_BG};
    border-bottom: 1px solid {BORDER};
  }}
  .sig-table-wrap thead th {{
    padding: 10px 14px;
    text-align: left;
    color: {MUTED};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    white-space: nowrap;
  }}
  .sig-table-wrap tbody tr {{
    border-bottom: 1px solid {BORDER};
    transition: background 0.12s;
  }}
  .sig-table-wrap tbody tr:last-child {{ border-bottom: none; }}
  .sig-table-wrap tbody tr:hover {{ background: rgba(0,255,0,0.03); }}
  .sig-table-wrap tbody td {{ padding: 9px 14px; color: {WHITE}; vertical-align: middle; }}
  .sig-table-wrap tbody td.ticker {{ color: {PRIMARY}; font-weight: 700; }}
  .sig-table-wrap tbody td.score-pos {{ color: {PRIMARY}; font-weight: 700; }}
  .sig-table-wrap tbody td.score-neg {{ color: {RED}; font-weight: 700; }}
  .sig-table-wrap tbody td.muted {{ color: {MUTED}; }}

  /* Empty state */
  .empty-card {{
    background: {CARD_BG};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 32px;
    text-align: center;
    font-family: monospace;
    color: {MUTED};
  }}

  /* Footer */
  .dash-footer {{
    text-align: center;
    color: {MUTED};
    font-family: monospace;
    font-size: 0.7rem;
    padding: 28px 0 8px;
    border-top: 1px solid {BORDER};
    margin-top: 2rem;
  }}

  /* Streamlit input elements */
  .stTextInput input {{
    background: {CARD_BG} !important;
    border: 1px solid {BORDER} !important;
    color: {WHITE} !important;
    font-family: monospace !important;
  }}
  .stTextInput input:focus {{
    border-color: {PRIMARY} !important;
    box-shadow: 0 0 0 1px {PRIMARY}44 !important;
  }}
</style>
""", unsafe_allow_html=True)

# ── Data Loaders ──────────────────────────────────────────────────────────────

@st.cache_data(ttl=300)
def load_history() -> pd.DataFrame:
    if not HISTORY_PATH.exists():
        return pd.DataFrame()
    with open(HISTORY_PATH) as f:
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

    # Metadata header
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
    for label, key in [("VIX", "vix"), ("Sector Health", "sector_health"), ("General Sentiment", "sentiment")]:
        cm = re.search(rf"\|\s*{re.escape(label)}\s*\|\s*(.+?)\s*\|", text)
        if cm:
            out[key] = cm.group(1).strip()

    # Summary numbers
    for label, key in [
        (r"Total scanned",       "total_scanned"),
        (r"Passed filters",      "passed_filters"),
        (r"Golden Trades[^:]*",  "golden_trades"),
        (r"Explosive signals",   "explosive_signals"),
        (r"High-confidence buys","high_confidence"),
    ]:
        sm = re.search(rf"\*\*{label}:\*\*\s*(\d+)", text)
        if sm:
            out[key] = int(sm.group(1))

    # Opportunity table rows
    rows: list[dict] = []
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
            "Ticker":            cells[0],
            "Action":            re.sub(r"\*+", "", cells[2]).strip(),
            "Score":             int(score_raw) if score_raw else 0,
            "Sector ETF":        cells[1],
            "Certainty":         cells[4],
            "EPS Surprise":      cells[5],
            "RS (1d)":           cells[6],
            "Stop-Loss":         cells[9],
        })
    out["rows"] = rows
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
        ("Win Rate",      "win_rate"),
        ("Average Return","avg_return"),
    ]:
        pm = re.search(rf"\|\s*{label}\s*\|\s*(.+?)\s*\|", text)
        if pm:
            out[key] = pm.group(1).strip()
    return out

# ── Helpers ───────────────────────────────────────────────────────────────────

def _pct_float(raw: str) -> float | None:
    m = re.search(r"([+-]?[\d.]+)%", str(raw))
    return float(m.group(1)) if m else None


def _bot_status(df: pd.DataFrame, opp: dict) -> tuple[str, str]:
    """Return (label, css_class) based on last scan age."""
    if df.empty and not opp:
        return "OFFLINE", "status-offline"
    last_dt: datetime | None = None
    if not df.empty:
        last_dt = df["date"].max().to_pydatetime().replace(tzinfo=timezone.utc)
    if opp.get("scan_date"):
        try:
            parsed = datetime.strptime(opp["scan_date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
            last_dt = max(last_dt, parsed) if last_dt else parsed
        except ValueError:
            pass
    if last_dt is None:
        return "OFFLINE", "status-offline"
    age_hours = (datetime.now(timezone.utc) - last_dt).total_seconds() / 3600
    if age_hours < 25:
        return "ACTIVE", "status-active"
    if age_hours < 168:
        return "IDLE", "status-idle"
    return "OFFLINE", "status-offline"


def _action_badge(action: str) -> str:
    a = action.upper()
    if "GOLDEN" in a or "EXPLOSIVE" in a:
        return f"<span class='badge b-gold'>{'🏆' if 'GOLDEN' in a else '🔥'} {action}</span>"
    if "BUY" in a:
        return f"<span class='badge b-green'>▲ {action}</span>"
    if "WATCH" in a:
        return f"<span class='badge b-muted'>👁 {action}</span>"
    if "SELL" in a:
        return f"<span class='badge b-red'>▼ {action}</span>"
    return f"<span class='badge b-muted'>{action}</span>"

# ── Charts ────────────────────────────────────────────────────────────────────

def _score_bar(df: pd.DataFrame) -> go.Figure:
    latest = df[df["date"] == df["date"].max()].copy()
    latest = latest.sort_values("score", ascending=True)

    colors = [
        GOLD if s >= 80 else DIM_GRN if s >= 50 else PRIMARY if s > 0 else RED
        for s in latest["score"]
    ]

    fig = go.Figure(go.Bar(
        x=latest["score"],
        y=latest["ticker"],
        orientation="h",
        marker=dict(color=colors, line=dict(color=DARK_BG, width=0.5)),
        text=[f"{s:+d}" for s in latest["score"]],
        textposition="outside",
        textfont=dict(color=WHITE, size=10, family="monospace"),
        hovertemplate="<b>%{y}</b><br>AI Score: %{x:+d}<br>Action: %{customdata}<extra></extra>",
        customdata=latest["action"],
    ))

    x_min = min(int(latest["score"].min()) - 15, -25)
    x_max = int(latest["score"].max()) + 25

    fig.update_layout(
        **_PLOTLY_BASE,
        title=dict(
            text=f"AI Score per Ticker — {latest['date'].iloc[0].strftime('%Y-%m-%d')}",
            font=dict(color=WHITE, size=13),
        ),
        height=max(400, len(latest) * 22),
        xaxis=dict(
            gridcolor=BORDER, linecolor=BORDER, zerolinecolor=MUTED,
            range=[x_min, x_max], title=None, tickfont=dict(family="monospace"),
        ),
        yaxis=dict(
            gridcolor=BORDER, linecolor=BORDER,
            title=None, tickfont=dict(family="monospace", size=11, color=PRIMARY),
        ),
        showlegend=False,
        bargap=0.28,
    )
    fig.add_vline(x=0,  line_color=MUTED,   line_width=1, line_dash="dot")
    fig.add_vline(x=75, line_color=DIM_GRN, line_width=1, line_dash="dash",
                  annotation_text="Buy threshold",
                  annotation_font_color=DIM_GRN,
                  annotation_position="top right")
    return fig


def _sector_pie(df: pd.DataFrame) -> go.Figure:
    if df.empty:
        return go.Figure()

    latest = df[df["date"] == df["date"].max()]
    sector_counts: dict[str, int] = {}
    for ticker in latest["ticker"]:
        etf = SECTOR_MAP.get(ticker.upper(), "SPY")
        sector_counts[etf] = sector_counts.get(etf, 0) + 1

    labels  = [SECTOR_LABELS.get(e, e) for e in sector_counts]
    values  = list(sector_counts.values())
    etf_ids = list(sector_counts.keys())
    colors  = [SECTOR_COLORS.get(e, MUTED) for e in etf_ids]

    fig = go.Figure(go.Pie(
        labels=labels,
        values=values,
        hole=0.52,
        marker=dict(colors=colors, line=dict(color=DARK_BG, width=2)),
        textfont=dict(family="monospace", color=WHITE, size=11),
        hovertemplate="<b>%{label}</b><br>%{value} tickers (%{percent})<extra></extra>",
    ))
    fig.update_layout(
        **_PLOTLY_BASE,
        title=dict(text="Sector Distribution", font=dict(color=WHITE, size=13)),
        height=420,
        legend=dict(
            bgcolor="rgba(0,0,0,0)",
            font=dict(color=WHITE, family="monospace", size=11),
            orientation="v",
            x=0.78,
        ),
        annotations=[dict(
            text=f"<b>{len(latest)}</b><br><span style='font-size:10px;color:{MUTED}'>tickers</span>",
            x=0.5, y=0.5,
            font=dict(size=18, color=PRIMARY, family="monospace"),
            showarrow=False,
        )],
    )
    return fig

# ── Signals Table ─────────────────────────────────────────────────────────────

def _signals_table(rows: list[dict], query: str) -> None:
    """Render the filtered OPPORTUNITIES.md signals as an HTML table."""
    if query:
        q = query.upper()
        rows = [r for r in rows if q in r.get("Ticker", "").upper() or q in r.get("Action", "").upper()]

    if not rows:
        st.markdown(
            f"<div class='empty-card'>"
            f"{'No results match your search.' if query else 'No filtered opportunities in the current scan.'}<br>"
            f"<span style='font-size:0.8rem;color:{MUTED};'>Run "
            f"<code>npm run scan -- --mode=full</code> to generate signals.</span>"
            f"</div>",
            unsafe_allow_html=True,
        )
        return

    cols = ["Ticker", "Action", "Score", "Sector ETF", "Certainty", "EPS Surprise", "RS (1d)", "Stop-Loss"]

    header_html = "".join(f"<th>{c}</th>" for c in cols)
    rows_html = ""
    for r in rows:
        score = int(r.get("Score", 0))
        score_cls = "score-pos" if score > 0 else "score-neg"
        rows_html += (
            f"<tr>"
            f"<td class='ticker'>{r.get('Ticker','')}</td>"
            f"<td>{_action_badge(r.get('Action',''))}</td>"
            f"<td class='{score_cls}'>{score:+d}</td>"
            f"<td class='muted'>{r.get('Sector ETF','—')}</td>"
            f"<td class='muted'>{r.get('Certainty','—')}</td>"
            f"<td class='muted'>{r.get('EPS Surprise','—')}</td>"
            f"<td class='muted'>{r.get('RS (1d)','—')}</td>"
            f"<td class='muted'>{r.get('Stop-Loss','—')}</td>"
            f"</tr>"
        )
    st.markdown(
        f"<div class='sig-table-wrap'>"
        f"<table><thead><tr>{header_html}</tr></thead>"
        f"<tbody>{rows_html}</tbody></table></div>",
        unsafe_allow_html=True,
    )

# ── Live Logs ─────────────────────────────────────────────────────────────────

def _active_log_path() -> Path | None:
    """Return the first log file that exists: scanner.log → combined.log."""
    for p in (SCANNER_LOG_PATH, COMBINED_LOG_PATH):
        if p.exists():
            return p
    return None


def _colorize_log_line(line: str) -> str:
    """Wrap a log line in a colored <span> based on its level tag."""
    line = line.rstrip()
    if "[ERROR]" in line:
        color = RED
    elif "[WARN]" in line:
        color = GOLD
    elif "[INFO]" in line:
        color = PRIMARY
    else:
        color = MUTED
    escaped = line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return f"<span style='color:{color}'>{escaped}</span>"


@st.fragment(run_every=10)
def _render_live_logs() -> None:
    st.markdown("### 🖥 Live Logs")
    path = _active_log_path()

    if path is None:
        st.markdown(
            f"<div class='empty-card'>"
            f"No log file found — logs/scanner.log will appear here when the scanner runs."
            f"</div>",
            unsafe_allow_html=True,
        )
        return

    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()[-20:]

    mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    colored = "\n".join(_colorize_log_line(ln) for ln in lines)

    st.markdown(
        f"<div style='background:{CARD_BG};border:1px solid {BORDER};border-radius:8px;"
        f"padding:14px 16px;font-family:monospace;font-size:0.72rem;line-height:1.65;"
        f"overflow-x:auto;white-space:pre;'>"
        f"{colored}"
        f"</div>",
        unsafe_allow_html=True,
    )
    st.markdown(
        f"<div style='font-family:monospace;font-size:0.68rem;color:{MUTED};margin-top:6px;'>"
        f"📄 {path.name} &nbsp;·&nbsp; "
        f"last modified {mtime.strftime('%Y-%m-%d %H:%M:%S UTC')} &nbsp;·&nbsp; "
        f"auto-refreshes every 10 s"
        f"</div>",
        unsafe_allow_html=True,
    )


# ── GitHub Actions Trigger ────────────────────────────────────────────────────

WORKFLOW_FILE = "trading_bot.yml"


def _trigger_workflow() -> tuple[bool, str]:
    """
    POST to the GitHub Actions workflow_dispatch API.
    Returns (success, message).
    Reads credentials from st.secrets['GH_TOKEN'] and st.secrets['GH_REPO'].
    """
    try:
        token = st.secrets["GH_TOKEN"]
        repo  = st.secrets["GH_REPO"]  # "owner/repo"
    except KeyError:
        return False, (
            "GitHub secrets not configured. "
            "Add GH_TOKEN and GH_REPO to .streamlit/secrets.toml."
        )

    url = f"https://api.github.com/repos/{repo}/actions/workflows/{WORKFLOW_FILE}/dispatches"
    resp = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        json={"ref": "main"},
        timeout=10,
    )

    if resp.status_code == 204:
        return True, "Scan initiated! Check Telegram in 2-3 minutes."
    if resp.status_code == 401:
        return False, "Authentication failed — check your GH_TOKEN."
    if resp.status_code == 404:
        return False, f"Workflow not found — verify GH_REPO '{repo}' and workflow '{WORKFLOW_FILE}'."
    return False, f"GitHub API error {resp.status_code}: {resp.text[:200]}"


# ── Sidebar ───────────────────────────────────────────────────────────────────

def _render_sidebar(df: pd.DataFrame, opp: dict) -> None:
    with st.sidebar:
        st.markdown(
            f"<div style='font-family:monospace;font-size:1.1rem;"
            f"font-weight:700;color:{PRIMARY};padding-bottom:12px;"
            f"border-bottom:1px solid {BORDER};margin-bottom:12px;'>"
            f"📈 WallStreet Bot</div>",
            unsafe_allow_html=True,
        )

        status_label, status_cls = _bot_status(df, opp)
        st.markdown(
            f"<div style='margin-bottom:14px;'>"
            f"<span style='color:{MUTED};font-family:monospace;font-size:0.7rem;"
            f"text-transform:uppercase;letter-spacing:0.08em;'>Bot Status</span><br>"
            f"<span class='status-pill {status_cls}'>{status_label}</span>"
            f"</div>",
            unsafe_allow_html=True,
        )

        # Info rows
        last_scan = f"{opp.get('scan_date','—')} {opp.get('scan_time','')}" if opp else "—"
        session   = opp.get("session", "—")
        mode      = opp.get("mode", "—")
        vix_raw   = opp.get("vix", "—")
        vix_col   = RED if any(w in vix_raw.upper() for w in ("HIGH", "ELEV", "FEAR")) else PRIMARY

        info_rows = [
            ("Last Scan",  last_scan.strip()),
            ("Session",    session),
            ("Mode",       mode),
        ]
        html = ""
        for label, val in info_rows:
            html += (
                f"<div class='sb-row'>"
                f"<span class='sb-label'>{label}</span>"
                f"<span class='sb-value'>{val}</span>"
                f"</div>"
            )
        html += (
            f"<div class='sb-row'>"
            f"<span class='sb-label'>VIX</span>"
            f"<span style='color:{vix_col};font-weight:600;font-family:monospace;font-size:0.8rem;'>{vix_raw}</span>"
            f"</div>"
        )
        if not df.empty:
            total_tickers = df["ticker"].nunique()
            html += (
                f"<div class='sb-row'>"
                f"<span class='sb-label'>Unique Tickers</span>"
                f"<span class='sb-value'>{total_tickers}</span>"
                f"</div>"
            )
        st.markdown(html, unsafe_allow_html=True)

        st.markdown("<br>", unsafe_allow_html=True)
        if st.button("⟳  Refresh Data", use_container_width=True):
            st.cache_data.clear()
            st.rerun()

        st.markdown("<div style='height:8px'></div>", unsafe_allow_html=True)
        if st.button("🚀 Start Live Market Scan", use_container_width=True, type="primary"):
            with st.spinner("Dispatching workflow…"):
                ok, msg = _trigger_workflow()
            if ok:
                st.success(msg)
            else:
                st.error(msg)

        # Sentiment / sector health
        if opp.get("sector_health") or opp.get("sentiment"):
            st.markdown(
                f"<div style='margin-top:16px;padding:10px;background:{DARK_BG};"
                f"border:1px solid {BORDER};border-radius:6px;"
                f"font-family:monospace;font-size:0.78rem;'>"
                f"<div style='color:{MUTED};font-size:0.68rem;text-transform:uppercase;"
                f"letter-spacing:0.08em;margin-bottom:6px;'>Market Context</div>"
                f"<div style='color:{WHITE};margin-bottom:4px;'>{opp.get('sector_health','—')}</div>"
                f"<div style='color:{MUTED};font-size:0.75rem;'>{opp.get('sentiment','—')}</div>"
                f"</div>",
                unsafe_allow_html=True,
            )

# ── Main Layout ───────────────────────────────────────────────────────────────

def main() -> None:
    df   = load_history()
    opp  = parse_opportunities()
    perf = parse_performance()

    _render_sidebar(df, opp)

    # ── Header ────────────────────────────────────────────────────────────────
    st.markdown(
        f"<h1 style='font-family:monospace;font-size:1.5rem;color:{PRIMARY};"
        f"margin:0 0 4px 0;padding:0;line-height:1.3;'>"
        f"WallStreet Trading Dashboard"
        f"<span style='color:{MUTED};font-size:0.85rem;font-weight:400;'> / Live</span>"
        f"</h1>",
        unsafe_allow_html=True,
    )
    st.markdown(
        f"<div style='font-family:monospace;font-size:0.78rem;color:{MUTED};"
        f"margin-bottom:1.2rem;'>AI-powered signal scanner · data from logs/history.json</div>",
        unsafe_allow_html=True,
    )

    # ── Metrics Row ───────────────────────────────────────────────────────────
    perf_pts     = perf.get("data_points", 0)
    win_rate_f   = _pct_float(perf.get("win_rate", "0")) or 0.0
    avg_ret_f    = _pct_float(perf.get("avg_return", "0"))
    avg_ret_sign = "+" if (avg_ret_f or 0) > 0 else ""
    avg_ret_str  = f"{avg_ret_sign}{avg_ret_f:.2f}%" if avg_ret_f is not None else "N/A"

    # Total Opportunities = cumulative non-SELL signals in history
    opp_actions = {"BUY", "EXPLOSIVE BUY", "GOLDEN TRADE", "WATCH"}
    total_opps  = int((df["action"].isin(opp_actions)).sum()) if not df.empty else 0
    latest_opps = opp.get("passed_filters", 0)

    m1, m2, m3 = st.columns(3)
    with m1:
        st.metric(
            label="Win Rate %",
            value=f"{win_rate_f:.1f}%",
            delta=f"{perf_pts} backtested trades" if perf_pts else "Run backtest to populate",
        )
    with m2:
        st.metric(
            label="Average Profit",
            value=avg_ret_str,
            delta="avg return per signal" if avg_ret_f is not None else None,
        )
    with m3:
        st.metric(
            label="Total Opportunities Found",
            value=f"{total_opps:,}",
            delta=f"{latest_opps} in latest scan",
        )

    st.markdown("<br>", unsafe_allow_html=True)

    # ── Active Signals Table ──────────────────────────────────────────────────
    st.markdown("### 📡 Active Signals")

    rows = opp.get("rows", [])

    # Build a fallback from history.json when OPPORTUNITIES.md has no table
    if not rows and not df.empty:
        ld = df["date"].max()
        for _, r in df[df["date"] == ld].sort_values("score", ascending=False).iterrows():
            rows.append({
                "Ticker":       r["ticker"],
                "Action":       r["action"],
                "Score":        int(r["score"]),
                "Sector ETF":   SECTOR_MAP.get(r["ticker"].upper(), "SPY"),
                "Certainty":    "—",
                "EPS Surprise": "—",
                "RS (1d)":      "—",
                "Stop-Loss":    f"${r['price']:.2f} (entry)",
            })

    search_col, count_col = st.columns([3, 1])
    with search_col:
        query = st.text_input(
            label="search_signals",
            placeholder="🔍  Filter by ticker or action  (e.g. NVDA, EXPLOSIVE)",
            label_visibility="collapsed",
        )
    with count_col:
        matched = len([r for r in rows if not query or
                       query.upper() in r.get("Ticker","").upper() or
                       query.upper() in r.get("Action","").upper()])
        st.markdown(
            f"<div style='text-align:right;font-family:monospace;"
            f"font-size:0.8rem;color:{MUTED};padding-top:10px;'>"
            f"{matched} row{'s' if matched != 1 else ''}</div>",
            unsafe_allow_html=True,
        )

    _signals_table(rows, query)

    st.markdown("<br>", unsafe_allow_html=True)

    # ── Charts ────────────────────────────────────────────────────────────────
    st.markdown("### 📊 Charts")

    if not df.empty:
        ch1, ch2 = st.columns([3, 2])
        with ch1:
            st.plotly_chart(_score_bar(df),   use_container_width=True)
        with ch2:
            st.plotly_chart(_sector_pie(df),  use_container_width=True)
    else:
        st.markdown(
            f"<div class='empty-card'>No history data — run "
            f"<code>npm run scan</code> first.</div>",
            unsafe_allow_html=True,
        )

    st.markdown("<br>", unsafe_allow_html=True)

    # ── Live Logs ─────────────────────────────────────────────────────────────
    _render_live_logs()

    st.markdown("<br>", unsafe_allow_html=True)

    # ── Footer ────────────────────────────────────────────────────────────────
    st.markdown(
        f"<div class='dash-footer'>"
        f"WallStreet To-Do Dashboard &nbsp;·&nbsp; cache TTL 5 min &nbsp;·&nbsp;"
        f"<code>streamlit run dashboard.py</code>"
        f"</div>",
        unsafe_allow_html=True,
    )


if __name__ == "__main__":
    main()
