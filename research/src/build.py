"""Bygger datasættet til backtesten fra research/data/.

  build.py tx      Form 345 → trades/owners; kandidatsignaler (P/A, ≥ $50k pr. accession); accepttid fra submissions.zip;
                   data/symbols.txt og data/prospectus_needed.parquet til fetch.py
  build.py units   Yahoo-kurser → hard-filter punkt-i-tid, enheder (ticker, entry-dag), features og udfald (data/units.parquet)
                   + dækning/survivorship pr. år (data/coverage.parquet)

Et signal = én Form 4 (accession) med første reporting owner, som i appen ("Joint Form 4 … logger kun den første ejer").
"""
from __future__ import annotations

import gzip
import json
import math
import re
import sys
import zipfile
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from common import (DATA, HOLDOUT_START, HORIZONS, MAX_FX_STALE_DAYS, MIN_ADV, MIN_PRICE, MIN_VALUE_USD, NY,
                    OFFERING_FOOTNOTE_RE, OFFERING_PRICE_TOLERANCE, OFFERING_WINDOW_DAYS, PERSONAL_VEHICLE_RE, ROLE_ORDER,
                    CLUSTER_WINDOW_DAYS, cmp_class, entry_index, exchange_ok, is_entity_name, is_fund_issuer,
                    is_plan_footnote, iso_week, liquidity_bucket, load_costs, parse_chart, pit_snapshot, raw_close_on,
                    role, round_trip_pct, unadjust_factor)

TX_COLS = ['ACCESSION_NUMBER', 'TRANS_DATE', 'TRANS_CODE', 'TRANS_SHARES', 'TRANS_PRICEPERSHARE', 'TRANS_ACQUIRED_DISP_CD',
           'SHRS_OWND_FOLWNG_TRANS', 'DIRECT_INDIRECT_OWNERSHIP', 'NATURE_OF_OWNERSHIP']
C_SUITE_RE = re.compile(r'(?<![^\W_])(ceo|cfo|coo|chief|president)(?![^\W_])', re.I)
GUARD = (0.75, 1.33)  # Form 4-kurs ÷ ujusteret close på handelsdagen; uden for = genbrugt/forkert ticker


def _tsv(z: zipfile.ZipFile, name: str) -> pd.DataFrame:
    return pd.read_csv(z.open(name), sep='\t', dtype=str, quoting=3, keep_default_na=False, na_values=[''],
                       encoding='utf-8', encoding_errors='replace', on_bad_lines='skip', low_memory=False)


def _date(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s, format='%d-%b-%Y', errors='coerce').dt.strftime('%Y-%m-%d')


def _clean_symbol(s) -> str | None:
    if not isinstance(s, str):
        return None
    tok = re.findall(r'[A-Za-z][A-Za-z0-9.\-]{0,9}', s.upper())
    tok = [t for t in tok if t not in ('NONE', 'NA', 'N', 'NYSE', 'NASDAQ', 'AMEX', 'OTC', 'INC')]
    return tok[-1].replace('.', '-') if tok else None


# ================================================================ tx
def build_tx() -> None:
    if not (DATA / 'trades.parquet').exists():
        _parse_form345()
    t = pd.read_parquet(DATA / 'trades.parquet')
    first_owner = pd.read_parquet(DATA / 'owners.parquet')
    _signals(t, first_owner)


def _parse_form345() -> None:
    trades, owners = [], []
    for zp in sorted((DATA / 'form345').glob('*_form345.zip')):
        z = zipfile.ZipFile(zp)
        sub = _tsv(z, 'SUBMISSION.tsv')
        sub = sub[sub.DOCUMENT_TYPE == '4']  # som appens Form 4-feed; ændringer (4/A) og Form 5 udelades
        if 'AFF10B5ONE' not in sub:
            sub['AFF10B5ONE'] = None
        nd = _tsv(z, 'NONDERIV_TRANS.tsv')
        nd = nd[nd.TRANS_CODE.isin(['P', 'S']) & nd.ACCESSION_NUMBER.isin(sub.ACCESSION_NUMBER)].copy()
        fn_cols = [c for c in nd.columns if c.endswith('_FN')]
        nd['fn_ids'] = nd[fn_cols].fillna('').agg(','.join, axis=1).str.findall(r'F\d+').map(lambda x: sorted(set(x)))
        nd = nd[TX_COLS + ['fn_ids']]
        p_acc = set(nd.ACCESSION_NUMBER[nd.TRANS_CODE == 'P'])
        fn = _tsv(z, 'FOOTNOTES.tsv')
        fn = fn[fn.ACCESSION_NUMBER.isin(p_acc)].fillna({'FOOTNOTE_TXT': ''})
        plan = set(zip(fn.ACCESSION_NUMBER[fn.FOOTNOTE_TXT.map(is_plan_footnote)], fn.FOOTNOTE_ID[fn.FOOTNOTE_TXT.map(is_plan_footnote)]))
        offer_mask = fn.FOOTNOTE_TXT.map(lambda t: bool(OFFERING_FOOTNOTE_RE.search(t)))
        offer = set(zip(fn.ACCESSION_NUMBER[offer_mask], fn.FOOTNOTE_ID[offer_mask]))
        nd['plan_fn'] = [any((a, i) in plan for i in ids) for a, ids in zip(nd.ACCESSION_NUMBER, nd.fn_ids)]
        nd['offer_fn'] = [any((a, i) in offer for i in ids) for a, ids in zip(nd.ACCESSION_NUMBER, nd.fn_ids)]
        nd = nd.drop(columns='fn_ids').merge(
            sub[['ACCESSION_NUMBER', 'FILING_DATE', 'ISSUERCIK', 'ISSUERNAME', 'ISSUERTRADINGSYMBOL', 'AFF10B5ONE']], on='ACCESSION_NUMBER')
        trades.append(nd)
        own = _tsv(z, 'REPORTINGOWNER.tsv')
        owners.append(own[own.ACCESSION_NUMBER.isin(sub.ACCESSION_NUMBER)][
            ['ACCESSION_NUMBER', 'RPTOWNERCIK', 'RPTOWNERNAME', 'RPTOWNER_RELATIONSHIP', 'RPTOWNER_TITLE']])
        print(f'  {zp.name}: {len(nd)} P/S-linjer')
    t = pd.concat(trades, ignore_index=True)
    t.columns = ['accession', 'trans_date', 'code', 'shares', 'price', 'ad', 'owned_after', 'di', 'nature', 'plan_fn', 'offer_fn',
                 'filing_date', 'issuer_cik', 'issuer_name', 'symbol_f4', 'aff10b5one']
    for c in ('shares', 'price', 'owned_after'):
        t[c] = pd.to_numeric(t[c], errors='coerce')
    t['trans_date'], t['filing_date'] = _date(t.trans_date), _date(t.filing_date)
    t['issuer_cik'] = pd.to_numeric(t.issuer_cik, errors='coerce').astype('Int64')
    o = pd.concat(owners, ignore_index=True)
    o.columns = ['accession', 'owner_cik', 'owner_name', 'relationship', 'title']
    o['owner_cik'] = pd.to_numeric(o.owner_cik, errors='coerce').astype('Int64')
    first_owner = o.drop_duplicates('accession')  # første reporting owner pr. Form 4
    t = t.merge(first_owner[['accession', 'owner_cik']], on='accession', how='left')
    t.to_parquet(DATA / 'trades.parquet')
    first_owner.to_parquet(DATA / 'owners.parquet')
    print(f'trades: {len(t)} P/S-linjer i {t.accession.nunique()} Form 4')


def _signals(t: pd.DataFrame, first_owner: pd.DataFrame) -> None:
    # ---- kandidatsignaler: P med A, Σ shares × price ≥ $50k pr. accession (sec-scanner.ts:871-874)
    p = t[(t.code == 'P') & (t.ad == 'A')].copy()
    p['value'] = p.shares.fillna(0) * p.price.fillna(0)
    p['is_d'] = p.di == 'D'
    p['is_i'] = p.di == 'I'
    p['trans_date'] = p.trans_date.fillna('')  # max() på object-kolonne med None fejler
    g = p.groupby('accession')
    sig = g.agg(value=('value', 'sum'), shares=('shares', 'sum'), trade_date=('trans_date', 'max'), filing_date=('filing_date', 'first'),
                issuer_cik=('issuer_cik', 'first'), issuer_name=('issuer_name', 'first'), symbol_f4=('symbol_f4', 'first'),
                aff10b5one=('aff10b5one', 'first'), plan_fn=('plan_fn', 'any'), offer_fn=('offer_fn', 'any'),
                any_d=('is_d', 'any'), any_i=('is_i', 'any'), owner_cik=('owner_cik', 'first')).reset_index()
    via = p[p.is_i & p.nature.notna()].drop_duplicates('accession').set_index('accession').nature
    sig['trade_date'] = sig.trade_date.replace('', None)
    sig['via'] = sig.accession.map(via)
    # beholdningsstigning: linjerne med samme D/I som den sidste linje; før = beholdning efter − købt
    last = p.drop_duplicates('accession', keep='last').set_index('accession')
    same = p.merge(last[['di']].rename(columns={'di': 'last_di'}), left_on='accession', right_index=True)
    same = same[same.di == same.last_di].groupby('accession').shares.sum()
    sig['bought_same'] = sig.accession.map(same)
    sig['owned_after'] = sig.accession.map(last.owned_after)
    sig = sig[sig.value >= MIN_VALUE_USD].merge(first_owner[['accession', 'owner_name', 'relationship', 'title']], on='accession', how='left')
    sig['vwap'] = sig.value / sig.shares
    sig['tenb51'] = sig.aff10b5one.str.lower().isin(['1', 'true']) | sig.plan_fn
    print(f'kandidatsignaler (P/A, ≥ $50k): {len(sig)}')

    # ---- accepttid (UTC; verificeret mod EDGAR-index 5.11.2026) og 424B-prospekter fra submissions.zip
    acc_time, prospects = _scan_submissions(set(sig.issuer_cik.dropna().astype(int)), set(sig.accession))
    missing = sig.loc[~sig.accession.isin(acc_time), 'owner_cik'].dropna().astype(int)
    if len(missing):
        more, _ = _scan_submissions(set(missing), set(sig.accession) - set(acc_time), want_424b=False)
        acc_time.update(more)
    sig['accept_utc'] = sig.accession.map(acc_time)
    print(f'accepttid fundet: {sig.accept_utc.notna().mean():.1%}')

    # ---- prospekter ±7 dage fra et købs handelsdato (offering-check.ts) – kun dem, der skal hentes
    pr = pd.DataFrame(prospects, columns=['cik', 'accession', 'form', 'filing_date', 'primary_doc'])
    buys = p[p.accession.isin(sig.accession)][['issuer_cik', 'trans_date']].dropna().drop_duplicates()
    if len(pr):
        m = pr.merge(buys, left_on='cik', right_on='issuer_cik')
        dd = (pd.to_datetime(m.filing_date) - pd.to_datetime(m.trans_date)).dt.days.abs()
        pr = m[dd <= OFFERING_WINDOW_DAYS][pr.columns].drop_duplicates('accession')
    pr.to_parquet(DATA / 'prospectus_needed.parquet')
    print(f'424B-prospekter nær et køb: {len(pr)}')

    # ---- symboler: nuværende ticker for CIK (SEC), ellers Form 4-symbolet
    cte = json.loads((DATA / 'company_tickers_exchange.json').read_text(encoding='utf-8'))
    cur = pd.DataFrame(cte['data'], columns=cte['fields']).drop_duplicates('cik').set_index('cik').ticker
    sig['symbol_cur'] = sig.issuer_cik.map(cur).map(_clean_symbol)
    sig['symbol_f4c'] = sig.symbol_f4.map(_clean_symbol)
    sig.to_parquet(DATA / 'signals_raw.parquet')
    keep = ~sig.issuer_name.fillna('').map(is_fund_issuer)
    syms = set(sig.loc[keep, 'symbol_cur'].dropna()) | set(sig.loc[keep & sig.symbol_cur.isna(), 'symbol_f4c'].dropna())
    (DATA / 'symbols.txt').write_text('\n'.join(sorted(syms)), encoding='utf-8')
    print(f'symboler til Yahoo: {len(syms)}')


def _scan_submissions(ciks: set[int], accessions: set[str], want_424b: bool = True):
    """Læser kun de relevante CIK-filer i submissions.zip (hovedfil + -submissions-00N-sider)."""
    acc_time, prospects = {}, []
    names = {f'CIK{c:010d}' for c in ciks}
    with zipfile.ZipFile(DATA / 'submissions.zip') as z:
        for n in z.namelist():
            if n[:13] not in names:
                continue
            js = json.loads(z.read(n))
            cik = int(n[3:13])
            block = js['filings']['recent'] if 'filings' in js else js
            for a, f, fd, t, doc in zip(block.get('accessionNumber', []), block.get('form', []), block.get('filingDate', []),
                                        block.get('acceptanceDateTime', []), block.get('primaryDocument', [])):
                if a in accessions and t:
                    acc_time[a] = t.replace('Z', '+00:00')
                elif want_424b and f in ('424B1', '424B3', '424B4', '424B5'):
                    prospects.append((cik, a, f, fd, doc))
    return acc_time, prospects


# ================================================================ units
def _load_bars(sym: str, cache: dict):
    if sym not in cache:
        p = DATA / 'yahoo' / f'{sym}.json.gz'
        if not p.exists():
            cache[sym] = None
        else:
            bars, splits, meta = parse_chart(json.loads(gzip.decompress(p.read_bytes())))
            cache[sym] = (bars, unadjust_factor(bars.date, splits), meta, bars.date.tolist())
    return cache[sym]


def _bench_ret(b, entry_date: str, exit_date: str) -> float | None:
    """Open første bar ≥ entry, close sidste bar ≤ exit; ingen bars i vinduet = 0 (outcomes.ts benchmarkWindow)."""
    bars, _, _, dates = b
    i, j = bisect_left(dates, entry_date), bisect_right(dates, exit_date) - 1
    if j < i:
        return 0.0 if j >= 0 else None
    o, c = bars.open.iat[i], bars.close.iat[j]
    return float(c / o - 1) if o > 0 and c > 0 else None


def _fx_on(b, d: str) -> float | None:
    """Close på eller før datoen, højst 7 dage gammel (outcomes.ts fxOn)."""
    bars, _, _, dates = b
    i = bisect_right(dates, d) - 1
    while i >= 0 and not bars.close.iat[i] > 0:
        i -= 1
    if i < 0 or (datetime.fromisoformat(d) - datetime.fromisoformat(dates[i])).days > MAX_FX_STALE_DAYS:
        return None
    return float(bars.close.iat[i])


def _outcomes(s, ei: int, spy, iwm, usd, cost: float, div=None) -> dict:
    """div (fase 4-SE): sorteret liste af (ex-dato, beløb) i Yahoos basis; udbytte med ex-dato i (entry, exit] lægges til
    exit-kursen (totalafkast mod et brutto-indeks). None = kursafkast som fase 4."""
    bars, _, _, dates = s
    out = {}
    for h in HORIZONS:
        xi = ei + h - 1
        if xi >= len(dates):
            continue  # ikke nået
        o, c = bars.open.iat[ei], bars.close.iat[xi]
        if not (o > 0 and c > 0):
            continue  # manglende kurs = intet udfald (aldrig 0)
        e_d, x_d = dates[ei], dates[xi]
        if div:
            c = c + sum(a for d, a in div if e_d < d <= x_d)
        ue, ux = _fx_on(usd, e_d), _fx_on(usd, x_d)
        rs = _bench_ret(spy, e_d, x_d)
        if ue is None or ux is None or rs is None:
            continue
        ret_dkk = (c * ux) / (o * ue) - 1
        to_dkk = lambda r: (1 + r) * ux / ue - 1
        out[f'gross_{h}'] = ret_dkk - to_dkk(rs)
        out[f'net_{h}'] = out[f'gross_{h}'] - cost / 100
        ri = _bench_ret(iwm, e_d, x_d)
        if ri is not None:
            out[f'gross_iwm_{h}'] = ret_dkk - to_dkk(ri)
            out[f'net_iwm_{h}'] = out[f'gross_iwm_{h}'] - cost / 100
        out[f'exit_{h}'] = x_d
    return out


def _cmp_lookup(trades: pd.DataFrame):
    """ejer → år → [(måned, filing-dato)] for alle åbne P/S-handler (Cohen, Malloy & Pomorski bruger køb og salg)."""
    t = trades.dropna(subset=['owner_cik', 'trans_date', 'filing_date'])
    look: dict = defaultdict(lambda: defaultdict(list))
    for oc, td, fd in zip(t.owner_cik.astype(int), t.trans_date, t.filing_date):
        look[oc][int(td[:4])].append((int(td[5:7]), fd))
    return look


def _cmp_for(look, owner, trade_date: str, filing_date: str) -> str:
    if owner is None or pd.isna(owner) or not isinstance(trade_date, str):
        return 'ukendt'
    years = look.get(int(owner), {})
    y, m = int(trade_date[:4]), int(trade_date[5:7])
    known = {yy: {mm for mm, fd in years.get(yy, []) if fd < filing_date} for yy in (y - 1, y - 2, y - 3)}
    return cmp_class(known, y, m)


def build_units() -> None:
    costs = load_costs()
    sig = pd.read_parquet(DATA / 'signals_raw.parquet')
    trades = pd.read_parquet(DATA / 'trades.parquet', columns=['accession', 'code', 'ad', 'trans_date', 'price', 'filing_date', 'owner_cik'])
    cache: dict = {}
    spy, iwm, usd = (_load_bars(s, cache) for s in ('SPY', 'IWM', 'USDDKK=X'))
    assert spy and iwm and usd, 'SPY/IWM/USDDKK=X mangler – kør fetch.py prices'

    # prospekt-kurser (offering-check.ts: samme kurs ±$0,006 og prospekt ±7 dage fra handelsdatoen)
    pp = DATA / 'prospectus_prices.parquet'
    offer_px = defaultdict(list)
    if pp.exists():
        need = pd.read_parquet(DATA / 'prospectus_needed.parquet').merge(pd.read_parquet(pp).dropna(), on='accession')
        for cik, fd, px in zip(need.cik, need.filing_date, need.price):
            offer_px[int(cik)].append((fd, float(px)))
    plines = trades[(trades.code == 'P') & (trades.ad == 'A') & trades.accession.isin(sig.accession)]
    line_px = plines.groupby('accession')[['trans_date', 'price']].apply(lambda d: list(zip(d.trans_date, d.price)))

    def offer_match(acc: str, cik) -> bool:
        if pd.isna(cik) or int(cik) not in offer_px:
            return False
        for td, px in line_px.get(acc, []):
            if not isinstance(td, str) or not px > 0:
                continue
            for fd, op in offer_px[int(cik)]:
                if abs(op - px) < OFFERING_PRICE_TOLERANCE and abs((pd.Timestamp(fd) - pd.Timestamp(td)).days) <= OFFERING_WINDOW_DAYS:
                    return True
        return False

    look = _cmp_lookup(trades)
    frames = _shares_outstanding()
    rows = []
    for r in sig.itertuples(index=False):
        status, rec = None, {'accession': r.accession, 'filing_year': int(r.filing_date[:4]) if isinstance(r.filing_date, str) else None}
        rec['has_accept'] = isinstance(r.accept_utc, str)
        rec['candidate'] = bool(r.vwap >= MIN_PRICE and not is_fund_issuer(r.issuer_name or ''))  # survivorship-nævner
        if is_fund_issuer(r.issuer_name or ''):
            status = 'fond/trust (navn)'
        series, sym = None, None
        if status is None:
            for cand in dict.fromkeys([r.symbol_cur, r.symbol_f4c if not isinstance(r.symbol_cur, str) else None]):
                s = _load_bars(cand, cache) if isinstance(cand, str) else None
                if s is None:
                    continue
                raw = raw_close_on(s[0], s[1], r.trade_date) if isinstance(r.trade_date, str) else math.nan
                if raw > 0 and GUARD[0] <= r.vwap / raw <= GUARD[1]:
                    series, sym = s, cand
                    break
                status = 'kurs-mismatch'
            if series is None and status is None:
                status = 'ingen kursdata'
        if series is not None:
            status = None
            bars, factor, meta, dates = series
            anchor = datetime.fromisoformat(r.accept_utc) if rec['has_accept'] else None
            ei = entry_index(dates, anchor, r.filing_date)
            if ei >= len(dates):
                status = 'entry ikke nået'
            else:
                snap = pit_snapshot(bars, factor, ei)
                ok, exch = exchange_ok(meta.get('exchangeName', ''), meta.get('fullExchangeName', ''))
                rec.update(symbol=sym, entry_date=dates[ei], entry_idx=ei, exchange=exch, **snap,
                           pass_price_raw=snap['raw_close'] >= MIN_PRICE, pass_price_adj=snap['adj_close'] >= MIN_PRICE)
                if not ok:
                    status = 'børs'
                elif meta.get('instrumentType', 'EQUITY') != 'EQUITY':
                    status = 'instrument'
                elif not snap['raw_close'] >= MIN_PRICE:
                    status = 'kurs < $2'
                elif not snap['adv'] >= MIN_ADV:
                    status = 'ADV < $500k'
                elif r.tenb51:
                    status = '10b5-1'
        rec['status'] = status or 'ok'
        if rec['status'] == 'ok' or 'entry_date' in rec:
            ownership = 'D' if r.any_d else ('I' if r.any_i else None)
            name = r.owner_name or ''
            fund = ownership is not None and (is_entity_name(name) or (ownership == 'I' and not (isinstance(r.via, str) and PERSONAL_VEHICLE_RE.search(r.via))))
            rel = (r.relationship or '')
            rec.update(
                issuer_cik=r.issuer_cik, owner_cik=r.owner_cik, owner_entity=is_entity_name(name), value=r.value,
                accept_utc=r.accept_utc, filing_date=r.filing_date, trade_date=r.trade_date,
                role=role(r.title or '', 'Director' in rel, 'Officer' in rel, 'TenPercentOwner' in rel),
                c_suite=bool(C_SUITE_RE.search(r.title or '')), ownership=ownership, fund=fund,
                personal_indirect=ownership == 'I' and not fund,
                offering=bool(r.offer_fn) or offer_match(r.accession, r.issuer_cik), offering_fn=bool(r.offer_fn),
                cmp=_cmp_for(look, r.owner_cik, r.trade_date, r.filing_date),
                holding_inc=_holding_inc(r.owned_after, r.bought_same),
                tenb51=bool(r.tenb51), aff_present=r.aff10b5one is not None and not pd.isna(r.aff10b5one))
        rows.append(rec)
    s = pd.DataFrame(rows)
    s.to_parquet(DATA / 'signals.parquet')
    _coverage(s).to_parquet(DATA / 'coverage.parquet')

    # ---- enheder (ticker, entry-dag) af signaler, der består alt
    ok = s[s.status == 'ok'].copy()
    ok['anchor'] = ok.accept_utc.fillna(ok.filing_date + 'T23:59:00-05:00').map(lambda x: datetime.fromisoformat(x))
    # cluster-tælling over ALLE kandidatsignaler i udstederen (appen tæller købere blandt rækker, der består ≥ $50k)
    allc = sig[sig.issuer_cik.notna() & sig.owner_cik.notna()][['issuer_cik', 'owner_cik', 'owner_name', 'accept_utc', 'filing_date']].copy()
    allc['owner_entity'] = allc.owner_name.fillna('').map(is_entity_name)
    allc['anchor'] = allc.accept_utc.fillna(allc.filing_date + 'T23:59:00-05:00').map(lambda x: datetime.fromisoformat(x))
    by_issuer = {k: g for k, g in allc.groupby('issuer_cik')}
    units = []
    for (sym, ed), g in ok.groupby(['symbol', 'entry_date']):
        series = _load_bars(sym, cache)
        ei = int(g.entry_idx.iat[0])
        snap = g.iloc[0]
        cost = round_trip_pct(costs, snap.adv)
        u = {'symbol': sym, 'entry_date': ed, 'year': int(ed[:4]), 'week': iso_week(ed), 'issuer_cik': int(g.issuer_cik.iat[0]),
             'n_signals': len(g), 'value': g.value.sum(), 'adv': snap.adv, 'cost_pct': cost, 'liquidity': liquidity_bucket(costs, snap.adv),
             'raw_close': snap.raw_close, 'ret20': snap.ret20, 'ret60': snap.ret60, 'ret250': snap.ret250, 'dist52w': snap.dist52w,
             'role': min(g.role, key=ROLE_ORDER.index), 'c_suite': bool(g.c_suite.any()),
             'cmp': 'opportunistisk' if (g.cmp == 'opportunistisk').any() else ('rutine' if (g.cmp == 'rutine').any() else 'ukendt'),
             'offering': bool(g.offering.any()), 'holding_inc': float(g.holding_inc.max()),
             'has_accept': bool(g.has_accept.all()), 'aff_present': bool(g.aff_present.any())}
        u['ownership'] = ('ukendt' if g.ownership.isna().all() else 'fond/enhed' if g.fund.all() else 'blandet' if g.fund.any()
                          else 'indirekte privat' if (g.personal_indirect.all()) else 'direkte person')
        anchor = g.anchor.max()
        win = by_issuer[g.issuer_cik.iat[0]]
        win = win[(win.anchor <= anchor) & (win.anchor >= anchor - timedelta(days=CLUSTER_WINDOW_DAYS))]
        u['buyers_10d'] = int(win.owner_cik.nunique())
        u['personal_buyers_10d'] = int(win.loc[~win.owner_entity, 'owner_cik'].nunique())
        u['mcap'] = _mcap(frames, u['issuer_cik'], anchor, snap.raw_close)
        u.update(_outcomes(series, ei, spy, iwm, usd, cost))
        late = _outcomes(series, ei + 1, spy, iwm, usd, cost)  # følsomhed: entry én handelsdag senere
        u.update({f'late_{k}': v for k, v in late.items() if k.startswith(('net_', 'gross_')) and not k.startswith(('net_iwm', 'gross_iwm'))})
        units.append(u)
    units = pd.DataFrame(units)
    units['holdout'] = units.entry_date >= HOLDOUT_START
    units.to_parquet(DATA / 'units.parquet')
    print(f'signaler: {len(s)}; status:\n{s.status.value_counts().to_string()}')
    print(f'enheder: {len(units)} (heraf holdout {units.holdout.sum()})')


def _holding_inc(owned_after, bought) -> float:
    """Købt ÷ beholdning før (= efter − købt). inf = ny position; NaN = ukendt (manglende tal)."""
    if not (owned_after == owned_after and bought == bought) or owned_after is None or bought is None:
        return math.nan
    before = owned_after - bought
    return bought / before if before > 0 else math.inf


def _coverage(s: pd.DataFrame) -> pd.DataFrame:
    c = s[s.candidate].copy()
    c['price_ok'] = ~c.status.isin(['ingen kursdata', 'kurs-mismatch'])
    g = c.groupby('filing_year')
    return pd.DataFrame({'kandidater': g.size(), 'uden_kursdata': g.status.apply(lambda x: (x == 'ingen kursdata').sum()),
                         'kurs_mismatch': g.status.apply(lambda x: (x == 'kurs-mismatch').sum()),
                         'uden_accepttid': g.has_accept.apply(lambda x: (~x).sum())}).reset_index()


def _shares_outstanding() -> pd.DataFrame:
    rows = []
    for p in sorted((DATA / 'frames').glob('*.json')):
        for d in json.loads(p.read_text(encoding='utf-8'))['data']:
            rows.append((d['cik'], d['end'], d['val']))
    f = pd.DataFrame(rows, columns=['cik', 'end', 'val']).drop_duplicates(['cik', 'end'])
    f['known'] = (pd.to_datetime(f.end) + pd.Timedelta(days=45)).dt.strftime('%Y-%m-%d')  # konservativt: kendt 45 dage efter
    return {k: (g.sort_values('known').known.tolist(), g.sort_values('known').val.tolist()) for k, g in f.groupby('cik')}


def _mcap(frames: dict, cik: int, anchor: datetime, raw_close: float) -> float:
    if cik not in frames or not raw_close > 0:
        return math.nan
    known, vals = frames[cik]
    i = bisect_right(known, anchor.astimezone(NY).date().isoformat()) - 1
    return float(vals[i] * raw_close) if i >= 0 else math.nan


if __name__ == '__main__':
    {'tx': build_tx, 'units': build_units}[sys.argv[1] if len(sys.argv) > 1 else 'tx']()
