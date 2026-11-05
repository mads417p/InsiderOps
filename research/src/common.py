"""Fælles regler for fase 4-backtesten.

Spejler appen (src/lib/outcomes.ts, costs.ts, ledger-stats.ts, sec-scanner.ts, market-enricher.ts) og
docs/prereg.md v1, så backtest og ledger kan sammenlignes direkte. Ændres en regel i appen, skal den også
ændres her (og testene i tests/test_core.py fanger de låste værdier).
"""
from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import re
import time
import urllib.error
import urllib.request
from bisect import bisect_left, bisect_right
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from statistics import NormalDist
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

RESEARCH = Path(__file__).resolve().parents[1]
REPO = RESEARCH.parent
DATA = RESEARCH / 'data'
REPORTS = RESEARCH / 'reports'

# ---------------------------------------------------------------- prereg v1 (docs/prereg.md)
HORIZONS = (1, 5, 21, 63)
PRIMARY_H = 5
HOLDOUT_START = '2025-01-01'  # 2025–2026 er holdout (research/reports/holdout-plan.md)
SEED = 20261104
BOOTSTRAP = 10_000
MIN_UNITS = 30  # færre enheder i et spand = "for få"
COSTS_VERSION = 3
COSTS_SHA256 = 'fad087e981ecdcf8c9e6dcea4d9037a2362abbc1e2d9c9683d45f380433cc7f0'

NY = ZoneInfo('America/New_York')
MIN_ENTRY_LEAD = timedelta(minutes=10)  # outcomes.ts MIN_ENTRY_LEAD_MS
US_OPEN = '09:30'  # outcomes.ts regularOpen for US
MAX_FX_STALE_DAYS = 7

# ---------------------------------------------------------------- hard-filter (sec-scanner.ts, market-enricher.ts)
MIN_VALUE_USD = 50_000  # pr. (accession, reporting owner), Σ P-linjer
MIN_PRICE = 2.0  # sidste UJUSTEREDE close før entry-dagen
MIN_ADV = 500_000  # gns. close×volume over de seneste 20 bars før entry-dagen
ADV_BARS = 20
CLUSTER_WINDOW_DAYS = 10

# Python har ikke \p{L}; (?<![^\W_]) = ikke efter et bogstav/ciffer (underscore tæller som grænse som i JS-udgaven).
EXECUTIVE_TITLE_RE = re.compile(
    r'(?<![^\W_])(ceo|cfo|coo|cto|cmo|cso|cio|clo|cao|cco|chief|president|pres|evp|svp|vp|vice[ -]president|'
    r'executive chair(?:man|woman)?|general counsel|counsel|treasurer|controller|secretary|officer|vd|koncernchef|'
    r'direkt[øö]r|finansdirekt[øö]r|ekonomidirekt[öø]r|finanschef)(?![^\W_])', re.I)
CEO_RE = re.compile(r'(?<![^\W_])(ceo|chief executive)(?![^\W_])', re.I)
CFO_RE = re.compile(r'(?<![^\W_])(cfo|chief financial)(?![^\W_])', re.I)
PLAN_FOOTNOTE_RE = re.compile(r'10b5-?1|rule\s*10b5|pre-?arranged|automatic\s*(?:purchase|trading)|trading\s+plan', re.I)
PLAN_NEGATION_RE = re.compile(
    r'\bnot\s+(?:been\s+)?(?:made\s+|effected\s+|executed\s+|entered\s+into\s+|done\s+)?(?:pursuant\s+to|under|in\s+accordance\s+with)\b', re.I)
OFFERING_FOOTNOTE_RE = re.compile(
    r'\b(?:initial public offering|IPO|public offering|underwrit(?:ten|ing|ers?)|private placement|registered direct|'
    r'concurrent (?:equity )?offering)\b', re.I)
PERSONAL_VEHICLE_RE = re.compile(
    r'revocable|living trust|family trust|declaration of trust|\bu/a\b|\bspouse|\bwife|\bhusband|\bchildren|\bson\b|'
    r'\bdaughter|\bira\b|401\s*\(?k|\bself\b|\bgrat\b', re.I)
ENTITY_WORDS = (' llc', ' lp', ' l.p.', ' fund', ' trust', ' capital', ' partners', ' holdings', ' investments', ' group',
                ' management', ' corp', ' inc', ' bank', ' ventures', ' spc')
FUND_NAME_WORDS = ('fund', 'trust', 'income shares', 'closed-end')
OFFERING_PRICE_TOLERANCE = 0.006
OFFERING_WINDOW_DAYS = 7


def is_plan_footnote(text: str) -> bool:
    return bool(PLAN_FOOTNOTE_RE.search(text)) and not PLAN_NEGATION_RE.search(text)


def is_entity_name(name: str) -> bool:
    n = f' {name.lower()}'
    return any(w in n for w in ENTITY_WORDS)


def is_fund_issuer(issuer_name: str) -> bool:
    """market-enricher.ts: udstederens navn indeholder fund/trust/income shares/closed-end (fanger også fx Northern Trust)."""
    n = (issuer_name or '').lower()
    return any(w in n for w in FUND_NAME_WORDS)


def exchange_ok(exchange_raw: str, full_name: str) -> tuple[bool, str]:
    """market-enricher.ts: OTC afvises, allow-list NASDAQ/NYSE American/NYSE/Cboe, alt andet afvises (tom = uverificeret, passerer)."""
    raw, full = (exchange_raw or '').upper(), (full_name or '').upper()
    if raw in ('PNK', 'OTC', 'OBB', 'GREY', 'PINX', 'OQB', 'OQX') or 'OTC' in full or 'PINK' in full:
        return False, 'OTC'
    if raw in ('NMS', 'NGM', 'NCM', 'NAS') or 'NASDAQ' in full:
        return True, 'NASDAQ'
    if raw == 'ASE' or 'NYSE AMERICAN' in full or 'NYSE MKT' in full:
        return True, 'NYSE American'
    if raw == 'NYQ' or full == 'NYSE':
        return True, 'NYSE'
    if raw in ('BTS', 'BATS', 'CBOE') or 'CBOE' in full or 'BATS' in full:
        return True, 'Cboe'
    return (False, full_name or exchange_raw) if (raw or full) else (True, '')


ROLE_ORDER = ('CEO', 'CFO', 'anden officer', 'director', '10 %-ejer', 'anden')


def role(officer_title: str, is_director: bool, is_officer: bool, is_ten_pct: bool) -> str:
    t = officer_title or ''
    if CEO_RE.search(t):
        return 'CEO'
    if CFO_RE.search(t):
        return 'CFO'
    if is_officer or EXECUTIVE_TITLE_RE.search(t):
        return 'anden officer'
    if is_director:
        return 'director'
    if is_ten_pct:
        return '10 %-ejer'
    return 'anden'


def cmp_class(months_by_year: dict[int, set[int]], year: int, month: int) -> str:
    """Cohen, Malloy & Pomorski (2012): rutine = handlet i samme kalendermåned i hvert af de 3 foregående år;
    opportunistisk = handlet i hvert af de 3 år, men ikke rutine; ellers ukendt."""
    prior = [months_by_year.get(year - k) for k in (1, 2, 3)]
    if not all(prior):
        return 'ukendt'
    return 'rutine' if all(month in m for m in prior) else 'opportunistisk'


# ---------------------------------------------------------------- HTTP (SEC ≤ 8 req/s med SEC_USER_AGENT; Yahoo som appen)
YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'
SEC_HOSTS = ('www.sec.gov', 'data.sec.gov')
_last_call: dict[str, float] = {}


def sec_user_agent() -> str:
    ua = os.environ.get('SEC_USER_AGENT')
    for f in ('.env.local', '.env'):
        p = REPO / f
        if ua or not p.exists():
            continue
        for line in p.read_text(encoding='utf-8').splitlines():
            if line.startswith('SEC_USER_AGENT='):
                ua = line.split('=', 1)[1].strip().strip('"\'')
    if not ua:
        raise SystemExit('SEC_USER_AGENT mangler (sæt den i .env.local som appen).')
    return ua


def _throttle(host: str, min_interval: float) -> None:
    wait = _last_call.get(host, 0.0) + min_interval - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _last_call[host] = time.monotonic()


def _open(url: str, headers: dict, min_interval: float, attempts: int, timeout: float):
    host = url.split('/')[2]
    for i in range(attempts):
        _throttle(host, min_interval)
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code not in (429, 500, 502, 503, 504) or i == attempts - 1:
                raise
            time.sleep(min(60.0, float(e.headers.get('Retry-After') or 2 ** i)))
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if i == attempts - 1:
                raise
            time.sleep(2 ** i)
    return None


def http_get(url: str, *, sec: bool, attempts: int = 5, timeout: float = 60) -> bytes | None:
    """GET med throttling og retry. None ved 404."""
    if sec:
        assert url.split('/')[2] in SEC_HOSTS, url
        headers, interval = {'User-Agent': sec_user_agent(), 'Accept-Encoding': 'gzip'}, 0.125
    else:
        headers, interval = {'User-Agent': YAHOO_UA, 'Accept': 'application/json', 'Accept-Encoding': 'gzip'}, 0.4
    r = _open(url, headers, interval, attempts, timeout)
    if r is None:
        return None
    with r:
        body = r.read()
        return gzip.decompress(body) if r.headers.get('Content-Encoding') == 'gzip' else body


def download(url: str, dest: Path, *, sec: bool = True) -> Path | None:
    """Streamer en stor fil til disk (tmp + rename). Springes over, hvis filen findes. None ved 404."""
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    headers = {'User-Agent': sec_user_agent() if sec else YAHOO_UA}
    r = _open(url, headers, 0.125 if sec else 0.4, 5, 300)
    if r is None:
        return None
    tmp = dest.with_suffix(dest.suffix + '.part')
    with r, open(tmp, 'wb') as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.replace(dest)
    return dest


# ---------------------------------------------------------------- omkostninger (costs.ts, frosset af prereg)
def load_costs() -> dict:
    raw = (REPO / 'config' / 'costs.json').read_text(encoding='utf-8').replace('\r\n', '\n')
    sha = hashlib.sha256(raw.encode('utf-8')).hexdigest()
    c = json.loads(raw)
    if c.get('version') != COSTS_VERSION or sha != COSTS_SHA256:
        raise SystemExit(f'config/costs.json er ændret (version {c.get("version")}, sha256 {sha[:12]}…); '
                         f'prereg v1 kræver version {COSTS_VERSION} og sha256 {COSTS_SHA256[:12]}…')
    return c


def round_trip_pct(c: dict, adv_usd: float | None, currency: str = 'USD') -> float:
    """2 × max(min-gebyr ÷ handelsstørrelse, kurtage-%) + 2 × FX-spread + spread/slippage efter likviditet (ukendt = dyreste)."""
    market = {'USD': 'US', 'DKK': 'CPH', 'SEK': 'STO', 'EUR': 'HEL', 'NOK': 'OSL'}[currency]
    fee, fx = c['brokerage'][market], c['fxSpreadPctByCurrency'][currency]
    brokerage = max(fee['minDkk'] / c['assumedTradeSizeDkk'] * 100, fee['pct'])
    buckets = sorted(c['roundTripSpreadSlippagePctByLiquidity'], key=lambda b: -b['minAvgDailyUsd'])
    known = adv_usd is not None and adv_usd == adv_usd
    slip = next((b for b in buckets if known and adv_usd >= b['minAvgDailyUsd']), buckets[-1])
    return 2 * brokerage + 2 * fx + slip['pct']


def liquidity_bucket(c: dict, adv_usd: float | None) -> str:
    edges = sorted(b['minAvgDailyUsd'] for b in c['roundTripSpreadSlippagePctByLiquidity'])  # 0, 1e6, 5e6, 50e6
    if adv_usd is None or adv_usd != adv_usd:
        return 'ukendt'
    i = bisect_right(edges, adv_usd) - 1
    lo, hi = edges[i] / 1e6, (edges[i + 1] / 1e6 if i + 1 < len(edges) else None)
    return f'≥ ${lo:g} mio.' if hi is None else f'${lo:g}–{hi:g} mio.'


# ---------------------------------------------------------------- kurser (Yahoo chart v8) og entry-regel
def parse_chart(js: dict) -> tuple[pd.DataFrame, list[tuple[str, float, float]], dict]:
    """Yahoo chart v8 → bars (split-justerede OHLCV, lokal dato), split-events og meta.
    Rækker uden både open og close er ikke handelsdage (outcomes.ts toSeries)."""
    r = js['chart']['result'][0]
    meta = r.get('meta') or {}
    tz = ZoneInfo(meta['exchangeTimezoneName'])
    ts = r.get('timestamp') or []
    q = (r.get('indicators') or {}).get('quote', [{}])[0]
    col = lambda k: pd.to_numeric(pd.Series(q.get(k) or [None] * len(ts), dtype='object'), errors='coerce').to_numpy(float)
    df = pd.DataFrame({'date': [datetime.fromtimestamp(t, tz).date().isoformat() for t in ts],
                       'open': col('open'), 'high': col('high'), 'low': col('low'), 'close': col('close'), 'volume': col('volume')})
    for k in ('open', 'close'):
        df.loc[~(df[k] > 0), k] = np.nan
    df = df[df.open.notna() | df.close.notna()].drop_duplicates('date', keep='last').reset_index(drop=True)
    splits = [(datetime.fromtimestamp(int(s['date']), tz).date().isoformat(), float(s['numerator']), float(s['denominator']))
              for s in ((r.get('events') or {}).get('splits') or {}).values()]
    return df, sorted(splits), meta


def unadjust_factor(dates, splits) -> np.ndarray:
    """Yahoo justerer kurser for splits bagud. Ujusteret kurs = justeret × Π(tæller/nævner) for split-events EFTER bar-datoen.
    En bar på selve ex-datoen er allerede efter splittet. Dækker både split (2:1) og reverse split (1:10)."""
    d = np.asarray(dates, dtype=object)
    f = np.ones(len(d))
    for sd, num, den in splits:
        f[d < sd] *= num / den
    return f


def raw_close_on(bars: pd.DataFrame, factor: np.ndarray, d: str) -> float:
    """Ujusteret close på datoen eller seneste handelsdag før (til sammenligning med Form 4-kursen)."""
    i = bisect_right(bars.date.tolist(), d) - 1
    while i >= 0 and not bars.close.iat[i] > 0:
        i -= 1
    return float(bars.close.iat[i] * factor[i]) if i >= 0 else math.nan


def pit_snapshot(bars: pd.DataFrame, factor: np.ndarray, i: int) -> dict:
    """Punkt-i-tid-tal fra bars FØR entry-baren i (entry-dagens bar kendes ikke ved åbningen).
    Niveau-tal (kursfilter, markedsværdi) bruger UJUSTEREDE kurser; afkast og forholdstal bruger justerede.
    ADV = gns. close×volume over de seneste 20 bars med c>0 og v>0 (market-enricher.ts; justeringen går ud med sig selv)."""
    close, vol = bars.close.to_numpy()[:i], bars.volume.to_numpy()[:i]
    valid = np.flatnonzero(close > 0)
    if len(valid) == 0:
        return {'raw_close': math.nan, 'adj_close': math.nan, 'adv': 0.0, 'ret20': math.nan, 'ret60': math.nan,
                'ret250': math.nan, 'dist52w': math.nan}
    last = valid[-1]
    c20, v20 = close[-ADV_BARS:], vol[-ADV_BARS:]
    m = (c20 > 0) & (v20 > 0)
    adj = close[valid]
    ret = lambda k: float(adj[-1] / adj[-1 - k] - 1) if len(adj) > k else math.nan
    return {
        'raw_close': float(close[last] * factor[last]),
        'adj_close': float(close[last]),
        'adv': float((c20[m] * v20[m]).mean()) if m.any() else 0.0,  # appen: 0, når ingen bars tæller → afvises
        'ret20': ret(20), 'ret60': ret(60), 'ret250': ret(250),
        'dist52w': float(adj[-1] / adj[-252:].max() - 1),
    }


@lru_cache(maxsize=None)
def us_open_utc(d: str) -> datetime:
    """Ordinær US-åbning 09:30 America/New_York på datoen, i UTC (DST håndteres af zoneinfo)."""
    h, m = map(int, US_OPEN.split(':'))
    return datetime.fromisoformat(d).replace(hour=h, minute=m, tzinfo=NY).astimezone(timezone.utc)


def entry_index(dates: list[str], anchor_utc: datetime | None, filing_date: str) -> int:
    """Indeks for entry-baren (len(dates) = ikke nået).
    Med ankeret: første bar, hvis åbning ligger ≥ anker + 10 min (prereg afsnit 5).
    Uden accepttid: første handelsdag efter filing-datoen (konservativt)."""
    if anchor_utc is None:
        return bisect_right(dates, filing_date)
    earliest = anchor_utc + MIN_ENTRY_LEAD
    i = bisect_left(dates, anchor_utc.astimezone(NY).date().isoformat())
    while i < len(dates) and us_open_utc(dates[i]) < earliest:
        i += 1
    return i


def iso_week(d: str) -> str:
    """Samme som ledger-stats.ts isoWeek (torsdagsreglen): 'YYYY-Uww'."""
    y, w, _ = date.fromisoformat(d[:10]).isocalendar()
    return f'{y}-U{w:02d}'


# ---------------------------------------------------------------- statistik
_Z = NormalDist().inv_cdf


def clustered_mean(values, groups, groups2=None) -> tuple[float, float]:
    """Gennemsnit og klynget standardfejl (OLS på konstant; statsmodels' småprøvekorrektion). To-vejs, hvis groups2 gives."""
    import statsmodels.api as sm
    y = np.asarray(values, float)
    g = pd.factorize(pd.Series(groups))[0]
    if groups2 is not None:
        g = np.column_stack([g, pd.factorize(pd.Series(groups2))[0]])
    fit = sm.OLS(y, np.ones((len(y), 1))).fit(cov_type='cluster', cov_kwds={'groups': g})
    return float(fit.params[0]), float(fit.bse[0])


def week_bootstrap(values, weeks, reps: int = BOOTSTRAP, seed: int = SEED) -> dict[str, float]:
    """Prereg-metoden: hele ISO-uger trækkes med tilbagelægning; statistikken er det puljede gennemsnit (Σ værdi ÷ Σ antal)."""
    codes = pd.factorize(pd.Series(weeks))[0]
    s, n = np.bincount(codes, np.asarray(values, float)), np.bincount(codes).astype(float)
    rng, g, means = np.random.default_rng(seed), len(n), []
    for start in range(0, reps, 1000):
        idx = rng.integers(0, g, size=(min(1000, reps - start), g))
        means.append(s[idx].sum(1) / n[idx].sum(1))
    m = np.sort(np.concatenate(means))
    q = lambda p: float(m[min(len(m) - 1, int(p * len(m)))])
    return {'low99': q(0.01), 'low95': q(0.05), 'ci_low': q(0.025), 'ci_high': q(0.975)}


def n_required(sd: float, delta: float, conf: float, power: float = 0.5, deff: float = 1.0) -> int:
    """N, så den ensidede nedre grænse (konfidens conf) ligger over 0 med sandsynlighed `power`, når den sande effekt er delta.
    power = 0,5 er prereg-logikken (afsnit 10): gennemsnittet skal ligge z·SD/√N over 0. deff = klyngernes designeffekt."""
    z = _Z(conf) + _Z(power)
    return math.ceil(deff * (z * sd / delta) ** 2)
