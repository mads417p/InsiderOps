"""In-sample-analyse (entry før 1.1.2025) → research/reports/backtest-v1.md + figurer.

Al læsning af enheder går gennem load_units(), som skærer holdout (2025–2026) fra, medmindre holdout=True – og holdout=True
kræver, at research/reports/holdout-plan.md er committet og uændret (holdout.py).
"""
from __future__ import annotations

import json
import math
import subprocess
from datetime import date

import numpy as np
import pandas as pd

from common import (BOOTSTRAP, DATA, HOLDOUT_START, HORIZONS, MIN_UNITS, PRIMARY_H, REPO, REPORTS, ROLE_ORDER, clustered_mean,
                    load_costs, n_required, week_bootstrap)

FIG = REPORTS / 'fig'


def holdout_plan_committed() -> bool:
    plan = REPORTS / 'holdout-plan.md'
    if not plan.exists():
        return False
    rel = plan.relative_to(REPO).as_posix()
    tracked = subprocess.run(['git', 'ls-files', '--error-unmatch', rel], cwd=REPO, capture_output=True).returncode == 0
    clean = subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--', rel], cwd=REPO).returncode == 0
    return tracked and clean


def load_units(holdout: bool = False) -> pd.DataFrame:
    u = pd.read_parquet(DATA / 'units.parquet')
    if not holdout:
        return u[u.entry_date < HOLDOUT_START].reset_index(drop=True)
    if not holdout_plan_committed():
        raise SystemExit('Holdout afvist: research/reports/holdout-plan.md er ikke committet og uændret.')
    return u[u.entry_date >= HOLDOUT_START].reset_index(drop=True)


# ---------------------------------------------------------------- statistik-hjælpere
def stat(d: pd.DataFrame, col: str) -> dict:
    x = d[[col, 'week']].dropna()
    n = len(x)
    if n < 2 or x.week.nunique() < 2:
        return {'n': n, 'mean': x[col].mean() if n else math.nan, 'se': math.nan, 'lo': math.nan, 'hi': math.nan, 'sd': math.nan}
    m, se = clustered_mean(x[col], x.week)
    return {'n': n, 'mean': m, 'se': se, 'lo': m - 1.96 * se, 'hi': m + 1.96 * se, 'sd': x[col].std(ddof=1)}


pct = lambda v, d=2: '–' if v is None or (isinstance(v, float) and math.isnan(v)) else f'{100 * v:+.{d}f} %'.replace('.', ',')
num = lambda v: f'{v:,.0f}'.replace(',', '.')
dk = lambda v, d=2: f'{v:.{d}f}'.replace('.', ',')  # decimaltal med komma
shr = lambda v, d=1: '–' if v != v else f'{100 * v:.{d}f} %'.replace('.', ',')  # andel/SD uden fortegn


def row(label: str, d: pd.DataFrame, cols: list[str]) -> str:
    cells = [label, num(d[cols[0]].notna().sum())]
    for c in cols:
        s = stat(d, c)
        few = s['n'] < MIN_UNITS
        cells.append('for få' if few else f'{pct(s["mean"])} [{pct(s["lo"])}; {pct(s["hi"])}]')
    return '| ' + ' | '.join(cells) + ' |'


def table(title: str, d: pd.DataFrame, by: str, order=None, cols=(f'gross_{PRIMARY_H}', f'net_{PRIMARY_H}', 'net_21')) -> str:
    heads = {f'gross_{PRIMARY_H}': 'Brutto 5 d', f'net_{PRIMARY_H}': 'Netto 5 d', 'net_21': 'Netto 21 d', 'net_1': 'Netto 1 d'}
    lines = [f'### {title}', '', '| Spand | N | ' + ' | '.join(heads.get(c, c) for c in cols) + ' |', '|' + '---|' * (2 + len(cols))]
    keys = order if order is not None else sorted(d[by].dropna().unique())
    for k in keys:
        g = d[d[by] == k]
        if len(g):
            lines.append(row(str(k), g, list(cols)))
    return '\n'.join(lines) + '\n'


# ---------------------------------------------------------------- sektioner
def primary_section(u: pd.DataFrame) -> tuple[str, dict]:
    col = f'net_{PRIMARY_H}'
    x = u[[col, 'week', 'issuer_cik', 'year']].dropna()
    n, sd = len(x), x[col].std(ddof=1)
    m, se_w = clustered_mean(x[col], x.week)
    _, se_2 = clustered_mean(x[col], x.week, x.issuer_cik)
    se_iid = sd / math.sqrt(n)
    deff = (se_w / se_iid) ** 2
    sizes = x.groupby('week').size()
    m_eff = (sizes ** 2).sum() / sizes.sum()
    rho = (deff - 1) / (m_eff - 1) if m_eff > 1 else math.nan
    boot = week_bootstrap(x[col], x.week, BOOTSTRAP)
    lo, hi = x[col].quantile([0.01, 0.99])
    sd_w = x[col].clip(lo, hi).std(ddof=1)
    recent = x[x.year >= 2018]
    k = {'n': n, 'weeks': x.week.nunique(), 'mean': m, 'sd': sd, 'se_iid': se_iid, 'se_w': se_w, 'se_2': se_2, 'deff': deff,
         'rho': rho, 'm_eff': m_eff, 'boot': boot, 'sd_w': sd_w, 'sd_recent': recent[col].std(ddof=1), 'n_recent': len(recent),
         'units_per_week': n / x.week.nunique(), 'first': u.entry_date.min(), 'last': u.entry_date.max()}
    t = [
        '## 2. Primær metrik: 5-dages netto abnormalt afkast i DKK mod SPY', '',
        f'Enheder: **{num(n)}** i {num(k["weeks"])} ISO-uger ({k["first"]} – {k["last"]}); i gennemsnit {str(round(k["units_per_week"], 1)).replace(".", ",")} enheder pr. uge.', '',
        '| Mål | Værdi |', '|---|---|',
        f'| Gennemsnit | {pct(m)} |',
        f'| **SD pr. enhed** | **{shr(sd, 2)}** |',
        f'| SD efter winsorisering 1/99 % (kun til orientering) | {shr(sd_w, 2)} |',
        f'| SD 2018–2024 ({num(k["n_recent"])} enheder) | {shr(k["sd_recent"], 2)} |',
        f'| SE, uafhængige enheder | {shr(se_iid, 3)} |',
        f'| **SE, uge-klynget** | **{shr(se_w, 3)}** |',
        f'| SE, to-vejs klynget (uge + udsteder) | {shr(se_2, 3)} |',
        f'| Designeffekt (SE²-forhold, uge) | {dk(deff)} |',
        f'| ρ inden for ugen (m_eff = {dk(m_eff, 1)}) | {dk(rho, 3)} |',
        f'| 95 %-interval (uge-klynget) | [{pct(m - 1.96 * se_w)}; {pct(m + 1.96 * se_w)}] |',
        f'| Ensidet nedre grænse 95 % / 99 % (prereg-bootstrap, {num(BOOTSTRAP)} gentagelser, seed 20261104) | {pct(boot["low95"])} / {pct(boot["low99"])} |',
        '',
    ]
    return '\n'.join(t), k


def n_section(k: dict) -> str:
    deff10 = 1 + 9 * k['rho']
    lines = ['## 3. Påkrævet N (SD fra afsnit 2)', '',
             'N er det antal enheder, der skal til for at den ensidede nedre grænse ligger over 0, når den sande effekt er δ.',
             '(a) 50 % styrke svarer til regnemåden i prereg afsnit 10: gennemsnittet skal ligge z·SD/√N over 0.',
             '(b) 80 % styrke er den sædvanlige definition på at kunne påvise en effekt.',
             f'Designeffekten afhænger af, hvor mange enheder der falder i samme uge. "Backtest" bruger backtestens egen (deff = {dk(k["deff"])}).',
             f'"10/uge" bruger ρ = {dk(k["rho"], 3)} med 10 enheder pr. uge (deff = {dk(deff10)}), hvilket er nærmere ledgerens forventede tempo.', '',
             '| δ (netto 5 d) | Styrke | 95 % · deff 1 | 95 % · 10/uge | 95 % · backtest | 99 % · deff 1 | 99 % · 10/uge | 99 % · backtest |',
             '|---|---|---|---|---|---|---|---|']
    for delta in (0.005, 0.010, 0.015):
        for power, lab in ((0.5, '50 % (prereg-logik)'), (0.8, '80 %')):
            cells = [pct(delta, 1), lab]
            for conf in (0.95, 0.99):
                for deff in (1.0, deff10, k['deff']):
                    cells.append(num(n_required(k['sd'], delta, conf, power, deff)))
            lines.append('| ' + ' | '.join(cells) + ' |')
    return '\n'.join(lines) + '\n'


def horizon_section(u: pd.DataFrame) -> str:
    lines = ['## 4. Effekt pr. horisont', '', '| Horisont | N | Brutto mod SPY | Netto mod SPY | Netto mod IWM | Netto, entry én dag senere |', '|---|---|---|---|---|---|']
    for h in HORIZONS:
        cells = [f'{h} d', num(u[f'net_{h}'].notna().sum())]
        for c in (f'gross_{h}', f'net_{h}', f'net_iwm_{h}', f'late_net_{h}'):
            s = stat(u, c)
            cells.append(f'{pct(s["mean"])} [{pct(s["lo"])}; {pct(s["hi"])}]')
        lines.append('| ' + ' | '.join(cells) + ' |')
    return '\n'.join(lines) + '\n\nIntervaller: 95 %, uge-klynget. "Entry én dag senere" er følsomheden for manuel scanning.\n'


def year_section(u: pd.DataFrame) -> str:
    import statsmodels.api as sm
    x = u[['net_5', 'gross_5', 'year', 'week']].dropna()
    fit = sm.OLS(x.net_5, sm.add_constant(x.year - 2015)).fit(cov_type='cluster', cov_kwds={'groups': pd.factorize(x.week)[0]})
    b, se = fit.params.iloc[1], fit.bse.iloc[1]
    return (table('5. Effekt pr. år', u, 'year') +
            f'\nTrend i netto 5 d: {pct(b, 3)} pr. år (uge-klynget SE {pct(se, 3)}; 95 %-interval [{pct(b - 1.96 * se, 3)}; {pct(b + 1.96 * se, 3)}]).\n')


def quintile(s: pd.Series) -> tuple[pd.Series, list[str]]:
    """Kvintiler med labels i stigende rækkefølge (Q1 = laveste) + 'ukendt'."""
    q = s.quantile([0, .2, .4, .6, .8, 1]).to_numpy()
    f = lambda v: f'{100 * v:+.0f} %'.replace('-', '−')
    lab = [f'Q{i + 1}: {f(q[i])} til {f(q[i + 1])}' for i in range(5)]
    return pd.cut(s, q, labels=lab, include_lowest=True).astype(str).replace('nan', 'ukendt'), lab + ['ukendt']


def feature_section(u: pd.DataFrame) -> str:
    d = u.copy()
    d['personlige købere (10 d)'] = d.personal_buyers_10d.clip(upper=3).map({0: '0 (kun enheder)', 1: '1', 2: '2', 3: '3+'})
    d['beholdningsstigning'] = pd.cut(d.holding_inc, [-np.inf, 0.05, 0.2, 1.0, 1e12, np.inf],
                                      labels=['< 5 %', '5–20 %', '20–100 %', '> 100 %', 'ny position']).astype(str).replace('nan', 'ukendt')
    d['markedsværdi'] = pd.cut(d.mcap, [0, 3e8, 2e9, 1e10, np.inf], labels=['< $300 mio.', '$0,3–2 mia.', '$2–10 mia.', '> $10 mia.']).astype(str).replace('nan', 'ukendt')
    d['udbudskurs'] = d.offering.map({True: 'ja', False: 'nej'})
    out = ['## 6. Effekt pr. feature (in-sample, univariat)', '',
           'Alle features beregnes punkt-i-tid (kun data kendt ved ankeret). Intervaller: 95 %, uge-klynget. Spand med under 30 enheder vises som "for få".', '',
           table('Rutine/opportunistisk (Cohen, Malloy & Pomorski; kræver 3 års historik → fra 2009)', d, 'cmp', ['opportunistisk', 'rutine', 'ukendt']),
           table('Rolle (højeste i enheden)', d, 'role', list(ROLE_ORDER)),
           table('Antal personlige købere i 10 dage', d, 'personlige købere (10 d)', ['0 (kun enheder)', '1', '2', '3+']),
           table('Fondskøb / ejerskab', d, 'ownership', ['direkte person', 'indirekte privat', 'blandet', 'fond/enhed', 'ukendt']),
           table('Køb til en udbudskurs (fodnote eller 424B-kursmatch)', d, 'udbudskurs', ['nej', 'ja']),
           table('Beholdningsstigning', d, 'beholdningsstigning', ['< 5 %', '5–20 %', '20–100 %', '> 100 %', 'ny position', 'ukendt']),
           table('Kursudvikling 20 handelsdage før (kvintiler)', d.assign(q=quintile(d.ret20)[0]), 'q', quintile(d.ret20)[1]),
           table('Kursudvikling 60 handelsdage før (kvintiler)', d.assign(q=quintile(d.ret60)[0]), 'q', quintile(d.ret60)[1]),
           table('Kursudvikling 250 handelsdage før (kvintiler)', d.assign(q=quintile(d.ret250)[0]), 'q', quintile(d.ret250)[1]),
           table('Afstand til 52-ugers-top (kvintiler)', d.assign(q=quintile(d.dist52w)[0]), 'q', quintile(d.dist52w)[1]),
           table('Markedsværdi (aktier i omløb fra XBRL × ujusteret kurs)', d, 'markedsværdi', ['< $300 mio.', '$0,3–2 mia.', '$2–10 mia.', '> $10 mia.', 'ukendt']),
           table('C-suite (titel med CEO/CFO/COO/Chief/President)', d.assign(c=d.c_suite.map({True: 'ja', False: 'nej'})), 'c', ['ja', 'nej']),
           table('Cluster (≥ 2 købere i 10 dage)', d.assign(c=(d.buyers_10d >= 2).map({True: 'ja', False: 'nej'})), 'c', ['ja', 'nej'])]
    return '\n'.join(out)


def liquidity_section(u: pd.DataFrame, costs: dict) -> str:
    order = [b for b in ['$0–1 mio.', '$1–5 mio.', '$5–50 mio.', '≥ $50 mio.'] if b in set(u.liquidity)]
    cost = u.groupby('liquidity').cost_pct.first()
    t = table('7. Effekt pr. likviditetsspand (omkostningerne varierer)', u, 'liquidity', order)
    return t + '\nRound-trip pr. spand (costs.json v3): ' + ', '.join(f'{k}: {dk(cost[k], 1)} %' for k in order) + '.\n'


def tenb51_section(s: pd.DataFrame, u: pd.DataFrame) -> str:
    s = s[s.filing_year < int(HOLDOUT_START[:4])]
    lines = ['## 8. 10b5-1 i to perioder', '',
             'Afkrydsningsfeltet for Rule 10b5-1 findes i Form 4 fra 2023. Før det fanges planer kun via fodnoter, så status er reelt ukendt.', '',
             '| Periode | Signaler, der ellers består filtrene | Udelukket som 10b5-1 | Andel | Enheder | Netto 5 d [95 %] |', '|---|---|---|---|---|---|']
    for lab, lo, hi in (('2006–2022 (kun fodnoter)', 2006, 2022), ('2023–2024 (afkrydsningsfelt)', 2023, 2024)):
        g = s[(s.filing_year >= lo) & (s.filing_year <= hi) & s.status.isin(['ok', '10b5-1'])]
        ex = (g.status == '10b5-1').sum()
        uu = u[(u.year >= lo) & (u.year <= hi)]
        st = stat(uu, 'net_5')
        lines.append(f'| {lab} | {num(len(g))} | {num(ex)} | {shr(ex / len(g) if len(g) else math.nan)} | {num(len(uu))} | '
                     f'{pct(st["mean"])} [{pct(st["lo"])}; {pct(st["hi"])}] |')
    return '\n'.join(lines) + '\n'


def calendar_section(u: pd.DataFrame) -> str:
    """Kalendertidsportefølje: hver dag ligevægt over åbne positioner (entry-åbning → 5. lukning), dagligt afkast − SPY, netto."""
    import gzip
    import json
    import statsmodels.api as sm
    from common import parse_chart
    spy, _, _ = parse_chart(json.loads(gzip.decompress((DATA / 'yahoo' / 'SPY.json.gz').read_bytes())))
    spy = spy.set_index('date')
    spy_ret = (spy.close / spy.close.shift(1) - 1)
    spy_day0 = spy.close / spy.open - 1
    recs = []
    for sym, g in u.groupby('symbol'):
        b, _, _ = parse_chart(json.loads(gzip.decompress((DATA / 'yahoo' / f'{sym}.json.gz').read_bytes())))
        idx = {d: i for i, d in enumerate(b.date)}
        for ed, cost in zip(g.entry_date, g.cost_pct):
            i = idx.get(ed)
            if i is None or i + 4 >= len(b):
                continue
            for k in range(5):
                d = b.date.iat[i + k]
                r = b.close.iat[i] / b.open.iat[i] - 1 if k == 0 else b.close.iat[i + k] / b.close.iat[i + k - 1] - 1
                bench = spy_day0.get(d) if k == 0 else spy_ret.get(d)
                if bench is not None and np.isfinite(r) and np.isfinite(bench):
                    recs.append((d, r - bench - cost / 100 / 5))
    p = pd.DataFrame(recs, columns=['date', 'ar']).groupby('date').ar.mean()
    fit = sm.OLS(p.to_numpy(), np.ones(len(p))).fit(cov_type='HAC', cov_kwds={'maxlags': 5})
    m, se = float(fit.params[0]), float(fit.bse[0])
    return ('## 9. Robusthed: kalendertidsportefølje\n\n'
            'Ligevægtet portefølje af alle åbne positioner (entry-åbning → 5. lukning), dagligt afkast minus SPY i USD, omkostningen fordelt over de 5 dage. '
            f'{num(len(p))} handelsdage. Gennemsnitligt dagligt netto abnormalt afkast: **{dk(m * 1e4, 1)} bp** (Newey-West SE {dk(se * 1e4, 1)} bp, t = {dk(m / se)}).\n')


def coverage_section(s: pd.DataFrame, cov: pd.DataFrame, u: pd.DataFrame) -> str:
    cov = cov[cov.filing_year < int(HOLDOUT_START[:4])]
    lines = ['## 1. Data og dækning (survivorship)', '',
             'Kandidatsignaler er Form 4-køb med kode P/A på mindst $50k pr. Form 4 og en Form 4-kurs på mindst $2, hvor udstederens navn ikke tyder på en fond eller trust.',
             'Kursdata kommer fra Yahoo chart v8 via udstederens nuværende ticker (SEC) og ellers Form 4-symbolet.',
             'Gratis kursdata mangler typisk afnoterede selskaber, så "uden kursdata" er et mål for survivorship bias.', '',
             '| År (filing) | Kandidater | Uden kursdata | Andel | Kurs-mismatch | Uden accepttid |', '|---|---|---|---|---|---|']
    for r in cov.itertuples():
        lines.append(f'| {r.filing_year} | {num(r.kandidater)} | {num(r.uden_kursdata)} | {shr(r.uden_kursdata / r.kandidater)} | '
                     f'{num(r.kurs_mismatch)} | {shr(r.uden_accepttid / r.kandidater)} |')
    tot = cov.sum(numeric_only=True)
    lines.append(f'| **I alt** | **{num(tot.kandidater)}** | **{num(tot.uden_kursdata)}** | **{shr(tot.uden_kursdata / tot.kandidater)}** | '
                 f'{num(tot.kurs_mismatch)} | {shr(tot.uden_accepttid / tot.kandidater)} |')
    ins = s[s.filing_year < int(HOLDOUT_START[:4])]
    funnel = ins.status.value_counts()
    lines += ['', 'Signaler efter filter (in-sample, første filter der fejler):', '', '| Status | Signaler |', '|---|---|']
    lines += [f'| {k} | {num(v)} |' for k, v in funnel.items()]
    pp = ins[ins.pass_price_raw.notna()]
    came = (pp.pass_price_raw & ~pp.pass_price_adj.astype(bool)).sum()
    fell = (~pp.pass_price_raw.astype(bool) & pp.pass_price_adj).sum()
    lines += ['', f'**Kursfilteret på ujusterede i stedet for justerede kurser** (signaler med kurs ved entry, n = {num(len(pp))}): '
              f'{num(fell)} faldt ud (ujusteret < $2, justeret ≥ $2, typisk før en senere reverse split), og {num(came)} kom med '
              '(ujusteret ≥ $2, justeret < $2, typisk før en senere split).', '']
    return '\n'.join(lines)


# ---------------------------------------------------------------- walk-forward (delmål 5)
OOS_YEARS = range(2012, int(HOLDOUT_START[:4]))
NUM = ['log_value', 'log_adv', 'log_mcap', 'ret20', 'ret60', 'ret250', 'dist52w', 'log_holding', 'buyers_10d',
       'personal_buyers_10d', 'n_signals', 'cost_pct']
CAT = ['role', 'cmp', 'ownership', 'liquidity']
BOOL = ['offering', 'c_suite', 'has_accept', 'new_position', 'mcap_missing']


def design(u: pd.DataFrame) -> pd.DataFrame:
    x = pd.DataFrame(index=u.index)
    x['log_value'] = np.log(u.value)
    x['log_adv'] = np.log(u.adv.clip(lower=1))
    x['log_mcap'] = np.log(u.mcap)
    x['mcap_missing'] = u.mcap.isna()
    x['new_position'] = u.holding_inc == np.inf
    x['log_holding'] = np.log1p(u.holding_inc.where(np.isfinite(u.holding_inc)).clip(upper=100))
    for c in ['ret20', 'ret60', 'ret250', 'dist52w', 'buyers_10d', 'personal_buyers_10d', 'n_signals', 'cost_pct', 'offering', 'c_suite', 'has_accept']:
        x[c] = u[c]
    x = pd.concat([x, pd.get_dummies(u[CAT].astype(str), prefix=CAT)], axis=1)
    return x.astype(float).replace([np.inf, -np.inf], np.nan)  # fx log(0) for markedsværdi → ukendt


def models() -> dict:
    import lightgbm as lgb
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import RidgeCV
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    return {
        'ridge': lambda: make_pipeline(SimpleImputer(strategy='median'), StandardScaler(), RidgeCV(alphas=np.logspace(-1, 4, 20))),
        'lightgbm': lambda: lgb.LGBMRegressor(n_estimators=300, learning_rate=0.03, num_leaves=15, min_child_samples=200, subsample=0.8,
                                               subsample_freq=1, colsample_bytree=0.8, random_state=20261104, verbose=-1),
    }


def walk_forward(u: pd.DataFrame) -> pd.DataFrame:
    """Træn på enheder, hvis 5-dages udfald var afsluttet før år Y (purge), test på år Y. Mål: netto 5 d, winsoriseret 1/99 % i træning.
    Tærsklen for 'øverste tredjedel' er 67 %-percentilen af TRÆNINGS-forudsigelserne (ingen lookahead i testårets fordeling)."""
    d = u[u.net_5.notna()].copy()
    X = design(d)
    preds = []
    for y in OOS_YEARS:
        tr = d.exit_5 < f'{y}-01-01'
        te = d.year == y
        if te.sum() == 0:
            continue
        yt = d.loc[tr, 'net_5'].clip(*d.loc[tr, 'net_5'].quantile([0.01, 0.99]))
        for name, make in models().items():
            m = make().fit(X[tr], yt)
            p_tr, p_te = m.predict(X[tr]), m.predict(X[te])
            out = d.loc[te, ['symbol', 'entry_date', 'year', 'week', 'net_5', 'c_suite', 'buyers_10d']].copy()
            out['model'], out['pred'], out['thr_top'] = name, p_te, np.quantile(p_tr, 2 / 3)
            preds.append(out)
    return pd.concat(preds, ignore_index=True)


def weekly_diff(a: pd.DataFrame, b: pd.DataFrame) -> tuple[float, float, int]:
    wa, wb = a.groupby('week').net_5.mean(), b.groupby('week').net_5.mean()
    diff = (wa - wb).dropna()
    return float(diff.mean()), float(diff.std(ddof=1) / math.sqrt(len(diff))), len(diff)


def model_section(u: pd.DataFrame) -> tuple[str, bool, dict]:
    from statistics import NormalDist
    p = walk_forward(u)
    oos = u[u.net_5.notna() & u.year.isin(list(OOS_YEARS))]
    baselines = {'alle enheder': oos, 'kun C-suite': oos[oos.c_suite], 'kun clusters (≥ 2 købere/10 d)': oos[oos.buyers_10d >= 2]}
    base_stats = {k: stat(v, 'net_5') for k, v in baselines.items()}
    best = max(base_stats, key=lambda k: base_stats[k]['mean'])
    variants = []
    for name in p.model.unique():
        pm = p[p.model == name]
        variants += [(f'{name}: forudsagt > 0', pm[pm.pred > 0]), (f'{name}: øverste tredjedel', pm[pm.pred >= pm.thr_top])]
    alpha = 0.05 / len(variants)
    z_b, z95 = NormalDist().inv_cdf(1 - alpha), NormalDist().inv_cdf(0.95)
    lines = [f'## 11. Modeller ude af sample (walk-forward {OOS_YEARS.start}–{OOS_YEARS.stop - 1})', '',
             'For hvert testår Y trænes modellerne på enheder, hvis 5-dages udfald lå før 1.1.Y. Ingen tilfældig opdeling.',
             'Målet er netto 5 d, winsoriseret 1/99 % i træningen. Der er to modeller (ridge og LightGBM) og to regler, i alt',
             f'**{len(variants)} varianter**. Bonferroni-α = 5 % ÷ {len(variants)} = {dk(100 * alpha)} %.', '',
             'Kriterium, fastlagt før kørslen. En model "slår baselines" kun, hvis begge betingelser holder:',
             '1. Udvalgets netto 5 d har en ensidet 95 %-nedre grænse over 0 (uge-klynget).',
             '2. Den ugentlige forskel til den bedste baseline har en ensidet nedre grænse over 0 ved Bonferroni-α.', '',
             '| Udvalg | Enheder | Netto 5 d [95 %, uge-klynget] | Ensidet 95 %-nedre |', '|---|---|---|---|']
    for k, s in base_stats.items():
        lines.append(f'| Baseline: {k}{" (bedst)" if k == best else ""} | {num(s["n"])} | {pct(s["mean"])} [{pct(s["lo"])}; {pct(s["hi"])}] | {pct(s["mean"] - z95 * s["se"])} |')
    passed, res = False, {}
    rows2 = ['', f'| Variant | Enheder | Netto 5 d [95 %] | Ensidet 95 %-nedre | Uge-forskel mod "{best}" | Nedre grænse ved Bonferroni | Består |', '|---|---|---|---|---|---|---|']
    for lab, sel in variants:
        s = stat(sel, 'net_5')
        lo1 = s['mean'] - z95 * s['se']
        dm, dse, nw = weekly_diff(sel, baselines[best])
        lo2 = dm - z_b * dse
        ok = lo1 > 0 and lo2 > 0
        passed |= ok
        res[lab] = {'n': s['n'], 'mean': s['mean'], 'lo1': lo1, 'diff': dm, 'lo2': lo2, 'ok': ok}
        lines.append(f'| {lab} | {num(s["n"])} | {pct(s["mean"])} [{pct(s["lo"])}; {pct(s["hi"])}] | {pct(lo1)} | – | – | – |')
        rows2.append(f'| {lab} | {num(s["n"])} | {pct(s["mean"])} [{pct(s["lo"])}; {pct(s["hi"])}] | {pct(lo1)} | {pct(dm)} ({nw} uger) | {pct(lo2)} | {"ja" if ok else "nej"} |')
    lines = lines[:-len(variants)] + rows2
    verdict = ('**Mindst én model slår de naive baselines ude af sample efter omkostninger.** Der laves et TypeScript-scoringsmodul (delmål 8).'
               if passed else
               '**Ingen model slår de naive baselines ude af sample efter omkostninger – intet TypeScript-scoringsmodul.**')
    lines += ['', verdict, '']
    return '\n'.join(lines), passed, {'best_baseline': best, 'variants': res, 'alpha': alpha}


def feature_flags(d: pd.DataFrame) -> dict[str, pd.Series]:
    """De binære features fra afsnit 12 (samme definitioner bruges i holdout)."""
    return {
        'opportunistisk køb (CMP)': d.cmp == 'opportunistisk', 'rutinekøb (CMP)': d.cmp == 'rutine',
        'CEO eller CFO': d.role.isin(['CEO', 'CFO']), 'director': d.role == 'director', '10 %-ejer': d.role == '10 %-ejer',
        'C-suite-titel': d.c_suite, '≥ 2 personlige købere/10 d': d.personal_buyers_10d >= 2, 'fond/enhed': d.ownership == 'fond/enhed',
        'køb til udbudskurs': d.offering, 'ny position eller > 100 % stigning': d.holding_inc > 1,
        'kursfald > 20 % de seneste 60 d': d.ret60 < -0.2, '> 30 % under 52-ugers-top': d.dist52w < -0.3,
        'markedsværdi < $300 mio.': d.mcap < 3e8, 'ADV < $5 mio.': d.adv < 5e6,
    }


def test2_rule(d: pd.DataFrame) -> pd.Series:
    """Holdout-test 2: højeste rolle i enheden er CEO eller CFO OG sidste (justerede) close før entry ligger mere end 30 % under
    toppen af de seneste 252 closes (dist52w < −0,3) – præcis flagene 'CEO eller CFO' og '> 30 % under 52-ugers-top' fra afsnit 12."""
    f = feature_flags(d)
    return (f['CEO eller CFO'] & f['> 30 % under 52-ugers-top']).fillna(False).astype(bool)


def flag_diff(d: pd.DataFrame, f: pd.Series, col: str = 'net_5') -> tuple[float, float]:
    """Forskel i gennemsnit (med − uden flag), uge-klynget SE. NaN, hvis en af grupperne har under 30 enheder."""
    import statsmodels.api as sm
    x = d[d[col].notna()]
    fx = f[x.index].fillna(False).astype(bool)
    if fx.sum() < MIN_UNITS or (~fx).sum() < MIN_UNITS:
        return math.nan, math.nan
    fit = sm.OLS(x[col], sm.add_constant(fx.astype(float))).fit(cov_type='cluster', cov_kwds={'groups': pd.factorize(x.week)[0]})
    return float(fit.params.iloc[1]), float(fit.bse.iloc[1])


def rule_table(u: pd.DataFrame, z_lo: float) -> str:
    """Pr. horisont: N, brutto og netto mod SPY, netto mod IWM [95 %, uge-klynget] og ensidet nedre grænse for netto mod SPY."""
    lines = ['| Horisont | N | Brutto mod SPY | Netto mod SPY | Netto mod IWM | Ensidet nedre grænse, netto SPY |', '|---|---|---|---|---|---|']
    for h in HORIZONS:
        cells = [f'{h} d', num(u[f'net_{h}'].notna().sum())]
        for c in (f'gross_{h}', f'net_{h}', f'net_iwm_{h}'):
            st = stat(u, c)
            cells.append(f'{pct(st["mean"])} [{pct(st["lo"])}; {pct(st["hi"])}]')
        st = stat(u, f'net_{h}')
        cells.append(pct(st['mean'] - z_lo * st['se']))
        lines.append('| ' + ' | '.join(cells) + ' |')
    return '\n'.join(lines) + '\n'


def live_features_section(u: pd.DataFrame) -> str:
    """Features med samme fortegn i begge halvdele af in-sample-perioden og et interval uden 0 i hele perioden (univariat, spand mod resten)."""
    d = u[u.net_5.notna()].copy()
    d['first_half'] = d.year < 2016
    flags = feature_flags(d)
    lines = ['## 12. Features til live-beregning i appen', '',
             'Hver feature er testet som forskellen mellem enheder med og uden den (netto 5 d, uge-klynget).',
             'En feature er "holdbar", hvis forskellen har et 95 %-interval uden 0 over hele in-sample-perioden og samme fortegn i 2006–2015 og 2016–2024.', '',
             '| Feature | Andel | Forskel netto 5 d [95 %] | 2006–2015 | 2016–2024 | Holdbar |', '|---|---|---|---|---|---|']
    keep = []
    for lab, f in flags.items():
        f = f.fillna(False).astype(bool)
        b, se = flag_diff(d, f)
        b1, _ = flag_diff(d[d.first_half], f)
        b2, _ = flag_diff(d[~d.first_half], f)
        ok = not math.isnan(b) and abs(b) > 1.96 * se and np.sign(b1) == np.sign(b2) == np.sign(b)
        if ok:
            keep.append(lab)
        lines.append(f'| {lab} | {shr(f.mean())} | {pct(b)} [{pct(b - 1.96 * se)}; {pct(b + 1.96 * se)}] | {pct(b1)} | {pct(b2)} | {"ja" if ok else "nej"} |')
    lines += ['', 'Appen bør beregne disse live: ' + (', '.join(keep) if keep else 'ingen af dem opfylder kriteriet') +
              '. ADV og likviditetsspand beregnes allerede, fordi de styrer omkostningen.', '']
    return '\n'.join(lines)


def figures(u: pd.DataFrame) -> None:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    FIG.mkdir(parents=True, exist_ok=True)
    ys = sorted(u.year.unique())
    st = [stat(u[u.year == y], 'net_5') for y in ys]
    fig, ax = plt.subplots(figsize=(9, 3.5))
    ax.bar([str(y) for y in ys], [100 * s['mean'] for s in st], color='#4C78A8',
           yerr=[[100 * (s['mean'] - s['lo']) for s in st], [100 * (s['hi'] - s['mean']) for s in st]], capsize=2)
    ax.axhline(0, color='black', lw=0.8)
    ax.set_ylabel('Netto 5 d AR (%)')
    ax.set_title('5-dages netto abnormalt afkast mod SPY pr. år (95 %, uge-klynget)')
    plt.xticks(rotation=60)
    fig.tight_layout()
    fig.savefig(FIG / 'net5_pr_aar.png', dpi=120)
    plt.close(fig)


def main() -> None:
    costs = load_costs()
    u = load_units()
    s = pd.read_parquet(DATA / 'signals.parquet')
    cov = pd.read_parquet(DATA / 'coverage.parquet')
    prim, k = primary_section(u)
    parts = [
        f'# Backtest v1 – insiderkøb efter offentliggørelse (in-sample {k["first"][:4]}–2024)', '',
        f'Genereret {date.today().isoformat()} af `research/src/analyze.py`. Regler som `docs/prereg.md` v1:',
        '- entry ved første åbning mindst 10 minutter efter EDGAR-accepttiden;',
        '- frosne omkostninger (costs.json v3);',
        '- AR i DKK mod SPY (primær) og IWM (sekundær);',
        '- enhed = (ticker, entry-dag).',
        '',
        'Holdout 2025–2026 indgår ikke her. Der er ikke brugt LLM på historiske hændelser.', '',
        coverage_section(s, cov, u), prim, n_section(k), horizon_section(u), year_section(u), '![](fig/net5_pr_aar.png)\n',
        feature_section(u), liquidity_section(u, costs), tenb51_section(s, u), calendar_section(u),
        f'## 10. Kapacitet\n\n10.000 kr. ≈ $1.500 pr. handel. Medianen af ADV er {num(u.adv.median())} $/dag, så en handel svarer til '
        f'{dk(100 * 1500 / u.adv.median(), 3)} % af en dags omsætning (≤ 0,3 % selv ved minimumskravet på $500k). Kapaciteten begrænser ikke denne strategi.\n',
    ]
    msec, passed, mres = model_section(u)
    parts += [msec, live_features_section(u)]
    REPORTS.mkdir(parents=True, exist_ok=True)
    figures(u)
    (REPORTS / 'backtest-v1.md').write_text('\n'.join(parts), encoding='utf-8')
    (DATA / 'primary.json').write_text(json.dumps(k | {'model_passed': passed, 'models': mres}, indent=1, default=float), encoding='utf-8')
    print(f'Primær: N={k["n"]} mean={k["mean"]:.4f} SD={k["sd"]:.4f} SE_w={k["se_w"]:.5f} deff={k["deff"]:.2f}')


if __name__ == '__main__':
    main()
