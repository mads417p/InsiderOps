"""Fase 4-SE: in-sample-rapport og holdout, præcis som research/reports/prereg-se.md beskriver.

  python src/se_analyze.py           # in-sample (entry før 2025) → reports/backtest-se-v1.md
  python src/se_analyze.py holdout   # kun efter committet reports/holdout-plan-se.md → afsnit 8 i samme rapport

Al læsning af enheder går gennem analyze.load_units (holdout kræver committet og uændret holdout-plan-se.md).
Ingen modeller, ingen walk-forward (slank version).
"""
from __future__ import annotations

import hashlib
import subprocess
import sys

import pandas as pd

import se
from analyze import load_units, num, pct, row, shr, stat, table
from common import DATA, HOLDOUT_START, HORIZONS, REPO, REPORTS, n_required
from holdout import Z, confirm

UNITS, PLAN = 'se/units.parquet', 'holdout-plan-se.md'
REPORT = REPORTS / 'backtest-se-v1.md'
HOLD_HEADER = '## 8. Holdout 2025–2026'
B1, B2 = se.BENCH, se.BENCH2
LIQ_ORDER = ['$0–1 mio.', '$1–5 mio.', '$5–50 mio.', '≥ $50 mio.']


def test2(d: pd.DataFrame) -> pd.DataFrame:
    return d[d.small_mid & d.cluster]


def git_rev(path) -> str:
    return subprocess.run(['git', 'log', '-1', '--format=%h', '--', path.relative_to(REPO).as_posix()],
                          cwd=REPO, capture_output=True, text=True).stdout.strip()


def tests(d: pd.DataFrame) -> tuple[list[str], str, str]:
    r1, v1 = confirm('Test 1 – basisstrategien', d, se.MIN_TEST_N, bench=B1)
    r2, v2 = confirm('Test 2 – clusters (≥ 2 PDMR/10 d) i small/mid cap', test2(d), se.MIN_TEST_N, bench=B1)
    return r1 + r2, v1, v2


def horizon_table(title: str, d: pd.DataFrame) -> str:
    lines = [f'### {title}', '', f'| Horisont | N | Brutto mod {B1} | Netto mod {B1} | Netto mod {B2} |', '|---|---|---|---|---|']
    lines += [row(f'{h} d', d, [f'gross_{h}', f'net_{h}', f'net_sec_{h}']) for h in HORIZONS]
    return '\n'.join(lines) + '\n'


def lower_row(label: str, d: pd.DataFrame) -> str:
    """Beskrivende linje: N, netto 5 d [95 %] og ensidet 97,5 %-nedre grænse (uge-klynget)."""
    s = stat(d, 'net_5')
    lo = s['mean'] - Z * s['se']
    return f'| {label} | {num(s["n"])} | {pct(s["mean"])} [{pct(s["lo"])}; {pct(s["hi"])}] | {pct(lo)} |'


def robustness(d: pd.DataFrame) -> str:
    lines = ['| Udvalg | N | Netto 5 d [95 %] | Ensidet 97,5 %-nedre |', '|---|---|---|---|',
             lower_row('Test 1, signal-tjek [0,5; 2] (`strict_ok`)', d[d.strict_ok]),
             lower_row('Test 2, signal-tjek [0,5; 2] (`strict_ok`)', test2(d[d.strict_ok])),
             lower_row('Test 1 uden ISIN godkendt trods kursafvigelse (`ratio_flag`)', d[~d.ratio_flag])]
    return '\n'.join(lines) + '\n'


def spread_section(d: pd.DataFrame) -> str:
    s = stat(d, 'net_5')
    se_iid = s['sd'] / s['n'] ** 0.5
    deff = (s['se'] / se_iid) ** 2
    lines = ['| Mål | Værdi |', '|---|---|',
             f'| SD pr. enhed (netto 5 d) | {shr(s["sd"], 2)} |',
             f'| SE, uafhængige / uge-klynget | {shr(se_iid, 3)} / {shr(s["se"], 3)} |',
             f'| Designeffekt (SE²-forhold) | {s["se"] ** 2 / se_iid ** 2:.2f} |'.replace('.', ','), '',
             '| δ (netto 5 d) | Påkrævet N (80 % styrke, ensidet 97,5 %, målt SD og deff) |', '|---|---|']
    lines += [f'| {pct(dl / 100, 1)} | {num(n_required(s["sd"], dl / 100, 0.975, 0.8, deff))} |' for dl in (0.5, 1.0, 1.5)]
    return '\n'.join(lines) + '\n'


def describe(d: pd.DataFrame) -> str:
    d = d.assign(segment=d.small_mid.map({True: 'small/mid (ADV < $5 mio.)', False: 'large (ADV ≥ $5 mio.)'}),
                 cl=d.cluster.map({True: '≥ 2 PDMR/10 d', False: '1 PDMR'}))
    return '\n'.join([
        table('Pr. rolle (højeste i enheden)', d, 'role', [r for r in se.ROLE_ORDER_SE if (d.role == r).any()]),
        table('Pr. år (entry)', d, 'year'),
        table('Pr. likviditetsspand (omkostning: 1,7 / 1,1 / 0,8 / 0,6 %)', d, 'liquidity', LIQ_ORDER),
        table('Small/mid mod large', d, 'segment'),
        table('Cluster', d, 'cl'),
    ])


def coverage(years=None) -> str:
    c = pd.read_parquet(se.SE_DIR / 'candidates.parquet')
    c = c[c.status != 'kurs < 10 SEK'].assign(y=lambda x: x.pub.str[:4])
    if years:
        c = c[c.y.isin(years)]
    g = c.groupby('y')
    miss = g.status.apply(lambda s: s.isin(['intet symbol', 'ingen kursdata', 'ikke SEK-noteret']).sum())
    lines = ['| År (publicering) | Kandidater | Uden kurser | Andel |', '|---|---|---|---|']
    lines += [f'| {y} | {num(n)} | {num(m)} | {shr(m / n)} |' for y, n, m in zip(g.size().index, g.size(), miss)]
    return '\n'.join(lines) + '\n'


def verdict_text(v1: str, v2: str) -> str:
    return f'**Test 1:** {v1}. **Test 2:** {v2}.'


def main() -> None:
    u = load_units(units=UNITS)
    fi = se.load_fi()
    s = pd.read_parquet(se.SE_DIR / 'signals.parquet')
    cands = pd.read_parquet(se.SE_DIR / 'candidates.parquet')
    allu = pd.read_parquet(DATA / UNITS)
    rows, v1, v2 = tests(u)
    lines = [
        '# Backtest SE v1 – svenske insiderkøb efter FI-publicering (in-sample 7/2016–2024)', '',
        f'Genereret {pd.Timestamp.now():%d.%m.%Y} af `research/src/se_analyze.py`. Regler: `research/reports/prereg-se.md` '
        f'(commit {git_rev(REPORTS / "prereg-se.md")}), ISIN-kontroltabel `isin-map-se.csv`, omkostninger `config/costs-v4.json`.',
        f'- Entry ved første åbning (09:00 Stockholm) mindst 10 minutter efter FI-publiceringen; exit ved lukning på handelsdag h.',
        f'- AR i DKK: aktiens totalafkast (inkl. udbytte med ex-dato i (entry, exit]) minus benchmark. Primær {B1} (brutto-indeks), sekundær {B2}.',
        f'- Enhed = (symbol, entry-dag). In-sample = entry før {HOLDOUT_START}; holdout står i afsnit 8, når den er kørt.',
        '- Der er ikke brugt LLM på historiske hændelser.', '',
        '## 1. Data, filter-tragt og dækning', '',
        'Alle år (in-sample og holdout); signaler pr. publiceringsår, enheder pr. entry-år.', '',
        se.funnel(fi, s, cands, allu), '',
        '**Kursdækning (survivorship):** kandidatsignaler (≥ $50k, VWAP ≥ 10 SEK) uden symbol eller kursserie i Yahoo. Afnoterede selskaber mangler.', '',
        coverage(),
        f'Status for kandidatsignaler: ' + ', '.join(f'{k} {num(v)}' for k, v in cands.status.value_counts().items()) + '.', '',
        f'In-sample: {num(len(u))} enheder i {num(u.week.nunique())} ISO-uger ({u.entry_date.min()} – {u.entry_date.max()}); '
        f'gennemsnitlig round-trip {dk_pct(u.cost_pct.mean())}.', '',
        '## 2. Bekræftende tests (in-sample)', '',
        'To tests med Bonferroni. Hver bestås, hvis den ensidede 97,5 %-nedre grænse (gennemsnit − 1,96 × uge-klynget SE) er > 0. '
        f'Under {se.MIN_TEST_N} enheder med 5-dages udfald er en test kun beskrivende.', '',
        *rows,
        '## 3. Horisonter', '',
        'Intervaller: 95 %, uge-klyngede. Spand med under 30 enheder vises som "for få".', '',
        horizon_table('Test 1 – alle enheder', u), horizon_table('Test 2 – clusters i small/mid cap', test2(u)),
        '## 4. Beskrivende tal (ingen konklusioner)', '', describe(u),
        '## 5. Robusthed (kun beskrivende)', '', robustness(u),
        '## 6. Spredning og påkrævet N', '', spread_section(u),
        '## 7. In-sample-resultat', '', verdict_text(v1, v2), '',
        'Kendte begrænsninger står i prereg-se.md afsnit 11. Desuden: handelsdage tælles efter aktiens egne Yahoo-bars, så en manglende '
        'bar (fx SAND.ST 17.6.2019) flytter exit én handelsdag.', '']
    REPORT.write_text('\n'.join(lines), encoding='utf-8', newline='\n')
    print(f'Test 1: {v1}\nTest 2: {v2}\n→ {REPORT}')


def dk_pct(v: float) -> str:
    return f'{v:.2f} %'.replace('.', ',')


def holdout() -> None:
    u = load_units(holdout=True, units=UNITS, plan=PLAN)  # kaster, hvis planen ikke er committet og uændret
    plan = REPORTS / PLAN
    plan_sha = hashlib.sha256(plan.read_bytes().replace(b'\r\n', b'\n')).hexdigest()
    units_sha = hashlib.sha256((DATA / UNITS).read_bytes()).hexdigest()
    rows, v1, v2 = tests(u)
    lines = [HOLD_HEADER, '',
             f'Kørt {pd.Timestamp.now():%d.%m.%Y} efter `research/reports/{PLAN}` (commit {git_rev(plan)}, sha256 {plan_sha[:12]}…). '
             f'`units.parquet` sha256 {units_sha[:12]}…. Entry {u.entry_date.min()} – {u.entry_date.max()}.', '',
             'Samme to tests og kriterier som in-sample (replikation).', '',
             *rows,
             horizon_table('Holdout – Test 1', u), horizon_table('Holdout – Test 2', test2(u)),
             '### Robusthed (kun beskrivende)', '', robustness(u),
             '### Pr. likviditetsspand (beskrivende)', '', table('Holdout pr. likviditetsspand', u, 'liquidity', LIQ_ORDER),
             '### Kursdækning 2025–2026', '', coverage(['2025', '2026']),
             f'**Holdout-resultat:** {verdict_text(v1, v2)[0:]}', '']
    text = REPORT.read_text(encoding='utf-8').split(HOLD_HEADER)[0].rstrip()
    REPORT.write_text(text + '\n\n' + '\n'.join(lines), encoding='utf-8', newline='\n')
    print(f'Holdout – Test 1: {v1}\nHoldout – Test 2: {v2}')


if __name__ == '__main__':
    holdout() if sys.argv[1:] == ['holdout'] else main()
