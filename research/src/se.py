"""Fase 4-SE: svenske insiderkøb fra Finansinspektionens insynsregister (regler: research/reports/prereg-se.md).

  python src/se.py fetch   # FI ugevis + FX + benchmarks + Yahoo-søgning og -kurser (cache; kan genoptages)
  python src/se.py map     # ISIN-kontroltabel, signaler og enheder UDEN udfald, filter-tragt og forventet N
  python src/se.py build   # udfald (afkast) – nægter, hvis reports/prereg-se.md ikke er committet og uændret

Genbruger fase 4: entry-reglen (common.entry_index med Stockholm-tid), omkostninger (round_trip_pct, costs-v4.json),
udfald (build._outcomes med udbytte) og værnet committed_clean. Niveau-filtre bruger meddelelsens kurs, aldrig Yahoos
(Yahoo emissionsjusterer kurser uden split-event).
"""
from __future__ import annotations

import csv
import gzip
import io
import json
import re
import sys
import time
from bisect import bisect_right
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from analyze import committed_clean
from build import _fx_on, _outcomes
from common import (ADV_BARS, CLUSTER_WINDOW_DAYS, DATA, HOLDOUT_START, MIN_ADV, MIN_VALUE_USD, REPORTS, entry_index, http_get,
                    iso_week, liquidity_bucket, load_costs, parse_chart, raw_close_on, round_trip_pct, unadjust_factor)

# ---------------------------------------------------------------- låst af prereg-se.md
SE_TZ = ZoneInfo('Europe/Stockholm')
SE_OPEN = '09:00'
FI_START = date(2016, 7, 4)  # MAR; intet før
MIN_PRICE_SEK = 10.0  # meddelelsens VWAP i SEK
SMALL_MID_ADV_USD = 5_000_000  # small/mid cap = ADV(20) < $5 mio. ved entry
MIN_TEST_N = 150  # færre enheder = kun beskrivende
COSTS_V4 = ('costs-v4.json', 4, '067e6ec4e2d3a4b95b7ac8847a4fb4c9554de4819bc1c82447b56ed198b7199b')
BENCH, BENCH2, FX_DKK, FX_USD = '^OMXSBGI', 'XACT-SMABOLAG.ST', 'SEKDKK=X', 'USDSEK=X'
GUARD = (0.75, 1.33)  # meddelelsens kurs ÷ Yahoo ujusteret close på handelsdagen; uden for = til kontroltabellen

BUY, SHARE, OUTSIDE, CANCELLED = 'Förvärv', 'Aktie', 'Utanför handelsplats', 'Makulerad'
NON_SHARE_RE = re.compile(r'option|teckningsr|\bbt[au]\b|warrant|konvertib|obligation|\bto\s?\d|\bts\b|interim|certifikat|'
                          r'termin|cfd|swap|\bsdb\b.*rätt|\brätter\b', re.I)  # kun når Instrumenttyp er tom (2016–18)
ROLE_ORDER_SE = ('VD', 'CFO', 'ordförande', 'styrelseledamot', 'anden ledelse', 'ukendt')
_ROLE_RES = [('VD', re.compile(r'\bvd\b|verkställande|\bceo\b|chief executive|koncernchef|managing director', re.I)),
             ('CFO', re.compile(r'\bcfo\b|ekonomichef|finanschef|ekonomidirekt|finansdirekt|chief financial|finance director', re.I)),
             ('ordförande', re.compile(r'ordförande|chairman|chair\b', re.I)),
             ('styrelseledamot', re.compile(r'styrelse|ledamot|board|director|suppleant', re.I))]

SE_DIR = DATA / 'se'
FI_DIR, SEARCH_DIR, YH_DIR = SE_DIR / 'fi', SE_DIR / 'search', SE_DIR / 'yahoo'
MAP_CSV = REPORTS / 'isin-map-se.csv'
PRICE_START = int(datetime(2016, 1, 1, tzinfo=timezone.utc).timestamp())
FI_URL = ('https://marknadssok.fi.se/Publiceringsklient/sv-SE/Search/Search?SearchFunctionType=Insyn&Utgivare='
          '&PersonILedandeStallningNamn=&Transaktionsdatum.From=&Transaktionsdatum.To='
          '&Publiceringsdatum.From={a}&Publiceringsdatum.To={b}&button=export')
FI_CAP = 1000  # eksporten skærer tavst ved 1.000 rækker (nyeste først)
COLS = ['pub', 'issuer', 'lei', 'notifier', 'pdmr', 'position', 'closely', 'is_corr', 'corr_desc', 'is_first', 'program', 'nature',
        'itype', 'iname', 'isin', 'tdate', 'volume', 'unit', 'price', 'currency', 'venue', 'status']


# ---------------------------------------------------------------- FI
def parse_fi_csv(body: bytes) -> list[list[str]]:
    """FI-eksport: UTF-16LE uden BOM, ';'-separeret, sidste kolonne tom. Returnerer datarækker (uden header)."""
    text = body.decode('utf-16-le').lstrip('﻿')
    rows = list(csv.reader(io.StringIO(text), delimiter=';'))
    if not rows or rows[0][0] != 'Publiceringsdatum':
        raise ValueError(f'ikke en FI-eksport: {text[:120]!r}')
    return [r[:len(COLS)] for r in rows[1:] if any(c.strip() for c in r)]


def _fi_get(a: date, b: date) -> bytes:
    for i in range(6):  # FI nulstiller af og til forbindelsen midt i svaret (læsningen er uden for http_get's retry)
        time.sleep(1.0)
        try:
            body = http_get(FI_URL.format(a=a, b=b), sec=False, timeout=120)
            break
        except (ConnectionError, TimeoutError, OSError) as e:
            if i == 5:
                raise
            print(f'FI {a}–{b}: {e.__class__.__name__}, prøver igen om {5 * 2 ** i} s', flush=True)
            time.sleep(5 * 2 ** i)
    if body is None:
        raise SystemExit(f'FI svarede 404 for {a}–{b}')
    parse_fi_csv(body)  # fejl højt, hvis formatet ændrer sig
    return body


def fetch_fi() -> None:
    """Ugevis efter publiceringsdato (loftet på 1.000 rækker); en uge over loftet hentes dag for dag. Seneste 8 dage hentes altid igen."""
    FI_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now(SE_TZ).date()
    a = FI_START
    while a <= today:
        b = min(a + timedelta(days=6), today)
        p = FI_DIR / f'{a}.csv'
        fresh = b >= today - timedelta(days=8)
        if fresh or not (p.exists() or (FI_DIR / f'{a}.d0.csv').exists()):
            body = _fi_get(a, b)
            if len(parse_fi_csv(body)) >= FI_CAP:
                p.unlink(missing_ok=True)
                for k in range((b - a).days + 1):
                    d = a + timedelta(days=k)
                    db = _fi_get(d, d)
                    if len(parse_fi_csv(db)) >= FI_CAP:
                        raise SystemExit(f'FI: {d} har ≥ {FI_CAP} rækker – kan ikke hentes komplet')
                    (FI_DIR / f'{a}.d{k}.csv').write_bytes(db)
            else:
                p.write_bytes(body)
            print(f'FI {a}–{b}', flush=True)
        a += timedelta(days=7)


def _num(s: str) -> float:
    s = (s or '').replace('\xa0', '').replace(' ', '').replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return float('nan')


def load_fi() -> pd.DataFrame:
    rows = [r for p in sorted(FI_DIR.glob('*.csv')) for r in parse_fi_csv(p.read_bytes())]
    df = pd.DataFrame([r + [''] * (len(COLS) - len(r)) for r in rows], columns=COLS).drop_duplicates()
    for c in ('volume', 'price'):
        df[c] = df[c].map(_num)
    df['isin'] = df.isin.str.strip().str.upper()
    return df.reset_index(drop=True)


def market_buy(df: pd.DataFrame) -> pd.Series:
    """Original meddelelse (Korrigering ≠ Ja, Status ≠ Makulerad), Förvärv af aktie på en handelsplads (alt undtagen Utanför)."""
    share = (df.itype == SHARE) | ((df.itype.str.strip() == '') & ~df.iname.str.contains(NON_SHARE_RE, na=False))
    return (df.is_corr != 'Ja') & (df.status != CANCELLED) & (df.nature == BUY) & share & (df.venue != OUTSIDE)


def norm_person(s: str) -> str:
    return ' '.join((s or '').casefold().split())


def norm_issuer(s: str) -> str:
    s = re.sub(r'\(publ\)|[.,]', ' ', (s or '').casefold())
    return ' '.join(w for w in s.split() if w not in ('ab', 'asa', 'oyj', 'plc', 'ltd', 'inc', 'se', 'sa', 'nv'))


def role_se(position: str) -> str:
    p = position or ''
    for name, rx in _ROLE_RES:
        if rx.search(p):
            return name
    return 'anden ledelse' if p.strip() else 'ukendt'


# ---------------------------------------------------------------- Yahoo
def _chart_path(sym: str):
    return YH_DIR / f'{quote(sym, safe="")}.json.gz'


def fetch_chart(sym: str) -> None:
    p = _chart_path(sym)
    if p.exists():
        return
    p.parent.mkdir(parents=True, exist_ok=True)
    url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{quote(sym, safe="")}?period1={PRICE_START}'
           f'&period2={int(time.time())}&interval=1d&events=div%7Csplit')
    body = http_get(url, sec=False)
    p.write_bytes(gzip.compress(body if body is not None else b'{}'))


_bars_cache: dict = {}


def load_bars(sym: str):
    """(bars, split-faktor, meta, datoer) som build._load_bars + udbytte [(ex-dato, beløb i Yahoos basis)].
    Bars fra hentedagen og senere smides væk (ufærdig dagsbar). None, hvis Yahoo intet har."""
    if sym in _bars_cache:
        return _bars_cache[sym]
    p, out = _chart_path(sym), None
    if p.exists():
        js = json.loads(gzip.decompress(p.read_bytes()) or b'{}')
        res = (js.get('chart') or {}).get('result')
        if res and res[0].get('timestamp'):
            bars, splits, meta = parse_chart(js)
            fetched = datetime.fromtimestamp(p.stat().st_mtime, SE_TZ).date().isoformat()
            bars = bars[bars.date < fetched].reset_index(drop=True)
            tz = ZoneInfo(meta['exchangeTimezoneName'])
            divs = sorted((datetime.fromtimestamp(int(v['date']), tz).date().isoformat(), float(v['amount']))
                          for v in ((res[0].get('events') or {}).get('dividends') or {}).values())
            out = ((bars, unadjust_factor(bars.date, splits), meta, bars.date.tolist()), divs)
    _bars_cache[sym] = out
    return out


def series(sym: str):
    b = load_bars(sym)
    return b[0] if b else None


def search_isin(isin: str) -> list[str]:
    """mapIsinToYahooTicker (src/lib/nordic-scanner.ts), begrænset til .ST: alle EQUITY-hits på Stockholm i Yahoos rækkefølge.
    Appen tager det første; de øvrige vises i kontroltabellen."""
    p = SEARCH_DIR / f'{isin}.json'
    if not p.exists():
        SEARCH_DIR.mkdir(parents=True, exist_ok=True)
        body = http_get(f'https://query2.finance.yahoo.com/v1/finance/search?q={quote(isin)}&quotesCount=5&newsCount=0', sec=False)
        p.write_bytes(body or b'{}')
    quotes = json.loads(p.read_bytes() or b'{}').get('quotes') or []
    return list(dict.fromkeys((q.get('symbol') or '').upper() for q in quotes
                              if q.get('quoteType') == 'EQUITY' and (q.get('symbol') or '').upper().endswith('.ST')))


# ---------------------------------------------------------------- FX og signaler
def fx_sek(currency: str, d: str) -> float | None:
    """SEK pr. 1 enhed af valutaen på dagen (close højst 7 dage gammel)."""
    if currency == 'SEK':
        return 1.0
    s = series(f'{currency}SEK=X')
    return _fx_on(s, d) if s else None


def build_signals(fi: pd.DataFrame) -> pd.DataFrame:
    """Signal = (ISIN, PDMR, publiceringstidspunkt): Σ værdi og VWAP fra meddelelsen, omregnet med dagskurs på handelsdagen."""
    r = fi[market_buy(fi)].copy()
    r['tday'] = r.tdate.str[:10].where(r.tdate.str.len() >= 10, r.pub.str[:10])
    r['value_cur'] = np.where(r.unit == 'Belopp', r.volume, r.volume * r.price)
    r['shares'] = np.where(r.unit == 'Belopp', np.nan, r.volume)
    sek = {k: fx_sek(*k) for k in set(zip(r.currency, r.tday))}
    usd = {d: _fx_on(series(FX_USD), d) for d in set(r.tday)}
    r['value_sek'] = [v * sek[(c, d)] if sek[(c, d)] else np.nan for v, c, d in zip(r.value_cur, r.currency, r.tday)]
    r['value_usd'] = [v / usd[d] if usd[d] else np.nan for v, d in zip(r.value_sek, r.tday)]
    r['pdmr_key'] = r.pdmr.map(norm_person)
    r['issuer_key'] = r.issuer.map(norm_issuer)
    g = r.groupby(['isin', 'pdmr_key', 'pub'], sort=False)
    s = g.agg(issuer=('issuer', 'first'), issuer_key=('issuer_key', 'first'), pdmr=('pdmr', 'first'), position=('position', 'first'),
              tday=('tday', 'min'), value_sek=('value_sek', lambda x: x.sum(min_count=len(x))),
              value_usd=('value_usd', lambda x: x.sum(min_count=len(x))), shares=('shares', lambda x: x.sum(min_count=len(x))),
              venue=('venue', 'first'), n_rows=('pub', 'size')).reset_index()
    s['vwap_sek'] = s.value_sek / s.shares
    s['role'] = s.position.map(role_se)
    s['pub_year'] = s.pub.str[:4].astype(int)
    s['anchor_utc'] = [datetime.fromisoformat(p).replace(tzinfo=SE_TZ).astimezone(timezone.utc) for p in s.pub]
    s['candidate'] = s.value_usd >= MIN_VALUE_USD  # ≥ $50k (også nævner for clusters, som fase 4)
    return s


def personal_buyers(cands: pd.DataFrame, issuer_key: str, anchor_utc: datetime) -> int:
    """Antal forskellige PDMR'er med kandidatsignaler (≥ $50k) i emittenten, publiceret i [anker − 10 kalenderdage; anker]."""
    w = cands[(cands.issuer_key == issuer_key) & (cands.anchor_utc <= anchor_utc)
              & (cands.anchor_utc >= anchor_utc - timedelta(days=CLUSTER_WINDOW_DAYS))]
    return int(w.pdmr_key.nunique())


def raw_adv_usd(s, ei: int, vwap_sek: float) -> float:
    """ADV(20) = gns. ujusteret volumen (Yahoo ÷ split-faktor) over de 20 bars før entry × meddelelsens VWAP, i USD."""
    bars, factor, _, dates = s
    c, v, f = bars.close.to_numpy()[:ei][-ADV_BARS:], bars.volume.to_numpy()[:ei][-ADV_BARS:], factor[:ei][-ADV_BARS:]
    m = (c > 0) & (v > 0)
    if not m.any() or ei == 0:
        return 0.0
    fx = _fx_on(series(FX_USD), dates[ei - 1])
    return float((v[m] / f[m]).mean() * vwap_sek / fx) if fx else float('nan')


# ---------------------------------------------------------------- kommandoer
def fetch() -> None:
    fetch_fi()
    fi = load_fi()
    cur = sorted(set(fi.loc[market_buy(fi), 'currency']) - {'SEK', ''})
    for sym in (BENCH, BENCH2, FX_DKK, FX_USD, *[f'{c}SEK=X' for c in cur]):
        fetch_chart(sym)
    s = build_signals(fi)
    isins = sorted(set(s.loc[s.candidate, 'isin']) - {''})
    print(f'FI: {len(fi)} rækker; kandidatsignaler ≥ $50k: {int(s.candidate.sum())}; ISIN: {len(isins)}', flush=True)
    for k, isin in enumerate(isins):
        for sym in search_isin(isin):
            fetch_chart(sym)
        if k % 100 == 0:
            print(f'Yahoo {k}/{len(isins)}', flush=True)


def _ratio(s, sig: pd.DataFrame) -> float:
    """Median af (meddelelsens VWAP ÷ Yahoo ujusteret close på handelsdagen) over ISIN'ets kandidatsignaler."""
    if s is None:
        return float('nan')
    bars, factor, _, _ = s
    x = [v / rc for v, d in zip(sig.vwap_sek, sig.tday) if v > 0 and (rc := raw_close_on(bars, factor, d)) > 0]
    return float(np.median(x)) if x else float('nan')


def control_table(s: pd.DataFrame) -> pd.DataFrame:
    """Alle ISIN med kandidatsignaler: auto-symbol (appens regel) og flag. Kun flaggede skrives til kontroltabellen."""
    cands = s[s.candidate & (s.isin != '')]
    last_fi = s.groupby('issuer_key').pub.max()
    rows = []
    for isin, g in cands.groupby('isin'):
        syms = search_isin(isin)
        auto = syms[0] if syms else ''
        names = sorted(set(g.issuer))
        flags = []
        if len(syms) > 1:
            flags.append('flere .ST-aktier')
        if len(set(g.issuer_key)) > 1:
            flags.append('flere emittentnavne')
        ratios = {sym: _ratio(series(sym), g) for sym in syms}
        r = ratios.get(auto, float('nan'))
        if auto and not (GUARD[0] <= r <= GUARD[1]):
            flags.append('ingen kurs på handelsdagene' if r != r else 'kursafvigelse')
        if not syms and last_fi.get(g.issuer_key.iat[0], '') >= '2025-07-01':
            flags.append('intet .ST-hit, men indberetter stadig')
        rows.append({'isin': isin, 'emittent': ' | '.join(names), 'signaler': len(g), 'auto_symbol': auto,
                     'kandidater': ' '.join(f'{k}={v:.2f}' if v == v else f'{k}=–' for k, v in ratios.items()),
                     'kursforhold': round(r, 3) if r == r else None, 'flag': '; '.join(flags)})
    return pd.DataFrame(rows)


def symbol_map(table: pd.DataFrame) -> dict[str, str | None]:
    """ISIN → symbol: auto for uflaggede; flaggede kræver en beslutning i reports/isin-map-se.csv (symbol eller 'afvis')."""
    manual = pd.read_csv(MAP_CSV, dtype=str).fillna('') if MAP_CSV.exists() else pd.DataFrame(columns=['isin', 'beslutning'])
    dec = dict(zip(manual.isin, manual.beslutning))
    out = {}
    for r in table.itertuples():
        if not r.flag:
            out[r.isin] = r.auto_symbol or None
        else:
            d = dec.get(r.isin, '').strip()
            out[r.isin] = None if d in ('', 'afvis') else d.upper()
    return out


def write_control_csv(table: pd.DataFrame) -> pd.DataFrame:
    flagged = table[table.flag != ''].copy()
    old = pd.read_csv(MAP_CSV, dtype=str).fillna('') if MAP_CSV.exists() else pd.DataFrame(columns=['isin', 'beslutning', 'begrundelse'])
    flagged = flagged.merge(old[['isin', 'beslutning', 'begrundelse']], on='isin', how='left').fillna({'beslutning': '', 'begrundelse': ''})
    flagged.sort_values(['flag', 'signaler'], ascending=[True, False]).to_csv(MAP_CSV, index=False, encoding='utf-8', lineterminator='\n')
    return flagged


def build_units(s: pd.DataFrame, smap: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Status pr. kandidatsignal (første filter, der fejler) og enheder (ticker, entry-dag) – UDEN udfald."""
    costs = load_costs(*COSTS_V4)
    cands = s[s.candidate].copy()
    st, ei_l, sym_l, adv_l = [], [], [], []
    for r in cands.itertuples():
        status, ei, sym, adv = None, None, smap.get(r.isin), float('nan')
        if not r.vwap_sek >= MIN_PRICE_SEK:
            status = 'kurs < 10 SEK'
        elif not sym:
            status = 'intet symbol'
        elif (ser := series(sym)) is None:
            status = 'ingen kursdata'
        else:
            ei = entry_index(ser[3], r.anchor_utc, r.pub[:10], SE_TZ, SE_OPEN)
            if ei >= len(ser[3]):
                status = 'entry ikke nået'
            elif bisect_right(ser[3], r.tday) == 0:
                status = 'ingen kursdata'  # serien starter efter handelsdagen (afnoteret/ny ticker)
            else:
                adv = raw_adv_usd(ser, ei, r.vwap_sek)
                status = None if adv >= MIN_ADV else 'ADV < $500k'
        st.append(status or 'ok'), ei_l.append(ei), sym_l.append(sym), adv_l.append(adv)
    cands['status'], cands['entry_idx'], cands['symbol'], cands['adv'] = st, ei_l, sym_l, adv_l
    ok = cands[cands.status == 'ok'].copy()
    ok['entry_date'] = [series(sy)[3][int(i)] for sy, i in zip(ok.symbol, ok.entry_idx)]
    units = []
    for (sym, ed), g in ok.groupby(['symbol', 'entry_date']):
        ei = int(g.entry_idx.iat[0])
        vwap = g.value_sek.sum() / g.shares.sum()
        adv = raw_adv_usd(series(sym), ei, vwap)
        anchor = g.anchor_utc.max()
        pb = personal_buyers(cands, g.issuer_key.iat[0], anchor)
        units.append({'symbol': sym, 'isin': g.isin.iat[0], 'issuer': g.issuer.iat[0], 'entry_date': ed, 'entry_idx': ei,
                      'year': int(ed[:4]), 'week': iso_week(ed), 'anchor_utc': anchor.isoformat(), 'n_signals': len(g),
                      'value_usd': g.value_usd.sum(), 'vwap_sek': vwap, 'adv': adv, 'cost_pct': round_trip_pct(costs, adv, 'SEK'),
                      'liquidity': liquidity_bucket(costs, adv), 'small_mid': adv < SMALL_MID_ADV_USD,
                      'role': min(g.role, key=ROLE_ORDER_SE.index), 'personal_buyers_10d': pb, 'cluster': pb >= 2,
                      'holdout': ed >= HOLDOUT_START})
    return cands, pd.DataFrame(units)


def funnel(fi: pd.DataFrame, s: pd.DataFrame, cands: pd.DataFrame, u: pd.DataFrame) -> str:
    fi = fi.assign(year=fi.pub.str[:4])
    mb = market_buy(fi)
    steps = {
        'FI-rækker': fi.groupby('year').size(),
        'originale, ikke makulerede': fi[(fi.is_corr != 'Ja') & (fi.status != CANCELLED)].groupby('year').size(),
        '+ Förvärv': fi[(fi.is_corr != 'Ja') & (fi.status != CANCELLED) & (fi.nature == BUY)].groupby('year').size(),
        '+ aktie på handelsplads': fi[mb].groupby('year').size(),
        'signaler (ISIN, PDMR, tidspunkt)': s.groupby(s.pub.str[:4]).size(),
        'signaler ≥ $50k': cands.groupby(cands.pub.str[:4]).size(),
        '+ kurs ≥ 10 SEK': cands[cands.status != 'kurs < 10 SEK'].groupby(cands.pub.str[:4]).size(),
        '+ symbol': cands[~cands.status.isin(['kurs < 10 SEK', 'intet symbol'])].groupby(cands.pub.str[:4]).size(),
        '+ kursdata og entry': cands[cands.status.isin(['ok', 'ADV < $500k'])].groupby(cands.pub.str[:4]).size(),
        '+ ADV ≥ $500k (signaler)': cands[cands.status == 'ok'].groupby(cands.pub.str[:4]).size(),
        'enheder (ticker, entry-dag)': u.groupby(u.entry_date.str[:4]).size(),
        'heraf small/mid': u[u.small_mid].groupby(u.entry_date.str[:4]).size(),
        'heraf cluster ∧ small/mid (test 2)': u[u.small_mid & u.cluster].groupby(u.entry_date.str[:4]).size(),
    }
    years = sorted(set(fi.year))
    lines = ['| Trin | ' + ' | '.join(years) + ' |', '|---|' + '---|' * len(years)]
    for k, v in steps.items():
        lines.append(f'| {k} | ' + ' | '.join(f'{int(v.get(y, 0)):,}'.replace(',', '.') for y in years) + ' |')
    return '\n'.join(lines)


def map_cmd() -> None:
    fi = load_fi()
    s = build_signals(fi)
    table = control_table(s)
    flagged = write_control_csv(table)
    smap = symbol_map(table)
    cands, u = build_units(s, smap)
    s.to_parquet(SE_DIR / 'signals.parquet')
    cands.to_parquet(SE_DIR / 'candidates.parquet')
    u.to_parquet(SE_DIR / 'units_pre.parquet')  # ingen udfald
    ins, hold = u[~u.holdout], u[u.holdout]
    print(funnel(fi, s, cands, u))
    print(f'\nKontroltabel: {len(flagged)} flaggede ISIN ({(flagged.beslutning == "").sum()} uden beslutning) → {MAP_CSV}')
    print(f'Status (kandidatsignaler):\n{cands.status.value_counts().to_string()}')
    for lab, d in (('in-sample 7/2016–2024', ins), ('holdout 2025–', hold)):
        t2 = d[d.small_mid & d.cluster]
        print(f'{lab}: test 1 = {len(d)} enheder, test 2 = {len(t2)} enheder')


def build_cmd() -> None:
    if not committed_clean(REPORTS / 'prereg-se.md'):
        raise SystemExit('Afvist: research/reports/prereg-se.md er ikke committet og uændret – ingen afkast før prereg.')
    u = pd.read_parquet(SE_DIR / 'units_pre.parquet')
    b1, b2, fx = series(BENCH), series(BENCH2), series(FX_DKK)
    assert b1 and b2 and fx, 'benchmarks/FX mangler – kør se.py fetch'
    outs = []
    for r in u.itertuples():
        bars = load_bars(r.symbol)
        o = _outcomes(bars[0], int(r.entry_idx), b1, b2, fx, r.cost_pct, div=bars[1])
        outs.append({k.replace('_iwm_', '_sec_'): v for k, v in o.items()})
    u = pd.concat([u, pd.DataFrame(outs, index=u.index)], axis=1)
    u.to_parquet(SE_DIR / 'units.parquet')
    print(f'enheder: {len(u)} (heraf holdout {int(u.holdout.sum())}); med 5 d-udfald: {int(u.net_5.notna().sum())}')


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    {'fetch': fetch, 'map': map_cmd, 'build': build_cmd}.get(cmd, lambda: sys.exit(__doc__))()
