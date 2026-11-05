"""Den endelige test på holdout 2025–2026, præcis som research/reports/holdout-plan.md beskriver.

Afviser at køre, hvis holdout-plan.md ikke er committet og uændret (analyze.load_units). Skriver afsnittet
"## 13. Holdout 2025–2026" i reports/backtest-v1.md (erstatter et tidligere afsnit med samme overskrift).
"""
from __future__ import annotations

import hashlib
import subprocess
from statistics import NormalDist

import pandas as pd

from analyze import feature_flags, flag_diff, load_units, num, pct, rule_table, shr, stat, test2_rule
from common import BOOTSTRAP, DATA, HOLDOUT_START, REPO, REPORTS, week_bootstrap

HEADER = '## 13. Holdout 2025–2026'
Z = NormalDist().inv_cdf(0.975)  # Bonferroni over 2 tests: ensidet 97,5 %
MIN_TEST2 = 150


def confirm(label: str, d: pd.DataFrame, min_n: int | None = None) -> tuple[list[str], str]:
    s = stat(d, 'net_5')
    lo = s['mean'] - Z * s['se']
    x = d[['net_5', 'week']].dropna()
    boot = week_bootstrap(x.net_5, x.week, BOOTSTRAP) if x.week.nunique() >= 2 else {'low95': float('nan')}
    if min_n is not None and s['n'] < min_n:
        verdict = f'kun beskrivende: {num(s["n"])} enheder < {min_n}'
    else:
        verdict = 'bestået: nedre grænse > 0' if lo > 0 else 'ikke bestået: nedre grænse ≤ 0'
    rows = [f'### {label}', '', '| Mål | Værdi |', '|---|---|',
            f'| Enheder / uger | {num(s["n"])} / {num(x.week.nunique())} |',
            f'| Gennemsnit netto 5 d mod SPY | {pct(s["mean"])} |',
            f'| SD pr. enhed | {shr(s["sd"], 2)} |',
            f'| SE, uge-klynget | {shr(s["se"], 3)} |',
            f'| **Ensidet 97,5 %-nedre grænse (uge-klynget)** | **{pct(lo)}** |',
            f'| Ensidet 95 %-nedre grænse, prereg-bootstrap (kun til orientering) | {pct(boot["low95"])} |',
            f'| **Resultat** | **{verdict}** |', '']
    return rows, verdict


def main() -> None:
    u = load_units(holdout=True)  # kaster, hvis planen ikke er committet og uændret
    ins = load_units()
    plan = REPORTS / 'holdout-plan.md'
    plan_sha = hashlib.sha256(plan.read_bytes().replace(b'\r\n', b'\n')).hexdigest()
    units_sha = hashlib.sha256((DATA / 'units.parquet').read_bytes()).hexdigest()
    commit = subprocess.run(['git', 'log', '-1', '--format=%h %cI', '--', plan.relative_to(REPO).as_posix()],
                            cwd=REPO, capture_output=True, text=True).stdout.strip()
    t2 = u[test2_rule(u)]
    r1, v1 = confirm('Test 1 – basisstrategien', u)
    r2, v2 = confirm('Test 2 – CEO/CFO-køb > 30 % under 52-ugers-toppen', t2, MIN_TEST2)

    lines = [HEADER, '',
             f'Kørt {pd.Timestamp.now():%d.%m.%Y} efter `research/reports/holdout-plan.md` (commit {commit}, sha256 {plan_sha[:12]}…).',
             f'`units.parquet` har sha256 {units_sha[:12]}… (planen: 984eecbaddfe…).',
             f'Holdout-enheder har entry fra {HOLDOUT_START} til {u.entry_date.max()}.',
             'Der er to bekræftende tests med Bonferroni: hver bestås, hvis den ensidede 97,5 %-nedre grænse er over 0 (uge-klynget).', '',
             *r1, *r2,
             '### Beskrivende (ingen konklusioner)', '',
             'Intervallerne er 95 % og uge-klyngede. Sidste kolonne er den ensidede 97,5 %-nedre grænse.', '',
             '**Basisstrategien:**', '', rule_table(u, Z),
             '**Test 2-reglen:**', '', rule_table(t2, Z),
             '**Fortegn pr. feature** (forskel i netto 5 d med/uden flag, uge-klynget):', '',
             '| Feature | In-sample | Holdout [95 %] | Samme fortegn |', '|---|---|---|---|']
    di, dh = ins[ins.net_5.notna()], u[u.net_5.notna()]
    fi, fh = feature_flags(di), feature_flags(dh)
    for lab in fi:
        bi, _ = flag_diff(di, fi[lab].fillna(False).astype(bool))
        bh, seh = flag_diff(dh, fh[lab].fillna(False).astype(bool))
        same = '–' if bh != bh else ('ja' if (bi > 0) == (bh > 0) else 'nej')
        hold = 'for få' if bh != bh else f'{pct(bh)} [{pct(bh - 1.96 * seh)}; {pct(bh + 1.96 * seh)}]'
        lines.append(f'| {lab} | {pct(bi)} | {hold} | {same} |')
    cov = pd.read_parquet(DATA / 'coverage.parquet')
    cov = cov[cov.filing_year >= int(HOLDOUT_START[:4])]
    lines += ['', '**Dækning 2025–2026** (survivorship):', '', '| År (filing) | Kandidater | Uden kursdata | Andel | Kurs-mismatch |', '|---|---|---|---|---|']
    for r in cov.itertuples():
        lines.append(f'| {r.filing_year} | {num(r.kandidater)} | {num(r.uden_kursdata)} | {shr(r.uden_kursdata / r.kandidater)} | {num(r.kurs_mismatch)} |')
    lines += ['', f'**Samlet:** Test 1 {v1}; Test 2 {v2}.', '']

    rep = REPORTS / 'backtest-v1.md'
    text = rep.read_text(encoding='utf-8').split(HEADER)[0].rstrip()
    rep.write_text(text + '\n\n' + '\n'.join(lines), encoding='utf-8', newline='\n')
    print(f'Test 1: {v1}\nTest 2: {v2}')


if __name__ == '__main__':
    main()
