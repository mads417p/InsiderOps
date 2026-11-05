"""Låste regler for fase 4 (kør: research/run.ps1 -Step test). Fejler, hvis en regel driver fra appen/prereg v1."""
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from common import (NY, clustered_mean, cmp_class, entry_index, exchange_ok, is_entity_name, is_plan_footnote,  # noqa: E402
                    iso_week, load_costs, n_required, parse_chart, pit_snapshot, raw_close_on, role, round_trip_pct,
                    unadjust_factor, week_bootstrap, MIN_PRICE)

ET = lambda s: datetime.fromisoformat(s).replace(tzinfo=NY).astimezone(timezone.utc)
UTC = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def test_costs_match_prereg_table():
    c = load_costs()  # fejler også, hvis version/sha256 er ændret
    for adv, want in [(60e6, 0.6), (10e6, 0.8), (2e6, 1.1), (0.6e6, 1.7), (None, 1.7), (math.nan, 1.7)]:
        assert abs(round_trip_pct(c, adv) - want) < 1e-9, (adv, round_trip_pct(c, adv))
    assert abs(round_trip_pct(c, 10e6, 'SEK') - 1.3) < 1e-9  # +0,5 pp for nordisk veksling


def test_entry_rule():
    week = ['2025-11-06', '2025-11-07', '2025-11-10', '2025-11-11']
    assert week[entry_index(week, ET('2025-11-07T15:55'), '2025-11-07')] == '2025-11-10'  # inden lukning, efter åbning
    assert week[entry_index(week, ET('2025-11-07T16:05'), '2025-11-07')] == '2025-11-10'  # efter lukning (weekend)
    assert week[entry_index(week, ET('2025-11-07T09:15'), '2025-11-07')] == '2025-11-07'  # 09:30 ≥ 09:25
    assert week[entry_index(week, ET('2025-11-07T09:25'), '2025-11-07')] == '2025-11-10'  # 09:30 < 09:35
    assert week[entry_index(week, ET('2025-11-08T11:00'), '2025-11-07')] == '2025-11-10'  # lørdag
    thanksgiving = ['2025-11-25', '2025-11-26', '2025-11-28', '2025-12-01']
    assert thanksgiving[entry_index(thanksgiving, ET('2025-11-26T17:00'), '2025-11-26')] == '2025-11-28'
    assert thanksgiving[entry_index(thanksgiving, None, '2025-11-26')] == '2025-11-28'  # ingen accepttid → dagen efter
    assert entry_index(week, ET('2025-11-11T12:00'), '2025-11-11') == len(week)  # ikke nået
    # DST: 9.3.2025 skiftede NY til sommertid → åbning 13:30 UTC (før 14:30 UTC)
    dst = ['2025-03-07', '2025-03-10', '2025-03-11']
    assert dst[entry_index(dst, UTC('2025-03-10T13:15'), '2025-03-10')] == '2025-03-10'
    assert dst[entry_index(dst, UTC('2025-03-10T13:25'), '2025-03-10')] == '2025-03-11'
    assert dst[entry_index(dst, UTC('2025-03-07T14:15'), '2025-03-07')] == '2025-03-07'
    assert dst[entry_index(dst, UTC('2025-03-07T14:25'), '2025-03-07')] == '2025-03-10'


def _yahoo_fixture():
    """Aktie, der EFTER handelsdagen laver split 2:1 (5.11) og senere reverse split 1:10 (7.11). Yahoo viser justerede kurser."""
    dates = ['2025-11-03', '2025-11-04', '2025-11-05', '2025-11-06', '2025-11-07', '2025-11-10']
    raw = [1.5, 1.6, 0.8, 0.9, 8.5, 9.0]  # faktiske kurser på dagen
    factor = [0.2, 0.2, 0.1, 0.1, 1.0, 1.0]  # (2/1)·(1/10) før 5.11; 1/10 før 7.11; 1 fra ex-datoen
    adj = [r / f for r, f in zip(raw, factor)]  # 7.5, 8, 8, 9, 8.5, 9
    ts = lambda d: int(datetime.fromisoformat(f'{d}T09:30').replace(tzinfo=NY).timestamp())
    js = {'chart': {'result': [{
        'meta': {'exchangeTimezoneName': 'America/New_York', 'exchangeName': 'NMS', 'instrumentType': 'EQUITY'},
        'timestamp': [ts(d) for d in dates],
        'events': {'splits': {str(ts('2025-11-05')): {'date': ts('2025-11-05'), 'numerator': 2, 'denominator': 1},
                              str(ts('2025-11-07')): {'date': ts('2025-11-07'), 'numerator': 1, 'denominator': 10}}},
        # justeret volumen = rå volumen (1 mio./dag) × faktor, så justeret close × volumen = rå close × rå volumen
        'indicators': {'quote': [{'open': adj, 'close': adj, 'high': adj, 'low': adj, 'volume': [1e6 * f for f in factor]}]},
    }]}}
    return js, raw, adj


def test_unadjusted_levels_split_then_reverse_split():
    js, raw, adj = _yahoo_fixture()
    bars, splits, _ = parse_chart(js)
    assert splits == [('2025-11-05', 2.0, 1.0), ('2025-11-07', 1.0, 10.0)]
    f = unadjust_factor(bars.date, splits)
    assert np.allclose(bars.close * f, raw)  # rå niveauer: før begge events, mellem dem og på ex-datoerne
    # Entry 4.11: sidste close før entry er 3.11 → rå 1,5 < $2 (falder ud), selv om den justerede 7,5 ville bestå
    snap = pit_snapshot(bars, f, 1)
    assert abs(snap['raw_close'] - 1.5) < 1e-9 and snap['raw_close'] < MIN_PRICE <= snap['adj_close']
    assert abs(10e6 * snap['raw_close'] - 15e6) < 1e-3  # markedsværdi på rå kurs (justeret ville give 75 mio.)
    # ADV = close×volume er ens justeret og ujusteret: 7,5 × 0,2 mio. = 1,5 × 1 mio. = $1,5 mio.
    assert abs(snap['adv'] - 1.5e6) < 1e-6
    # Form 4-kursen 1,52 den 3.11 matcher den rå kurs, ikke den justerede
    assert abs(raw_close_on(bars, f, '2025-11-03') / 1.52 - 1) < 0.02
    # Forholdstal på justerede kurser: entry 10.11 → afstand til top = 8,5 / 9 − 1 (rå kurser ville give 0)
    snap6 = pit_snapshot(bars, f, 5)
    assert abs(snap6['dist52w'] - (8.5 / 9 - 1)) < 1e-9 and snap6['raw_close'] == 8.5
    # Afkast over begge splits på justerede kurser = det økonomiske afkast: 1 aktie à 1,5 → 0,2 aktier à 9 = +20 %
    assert abs(bars.close.iat[5] / bars.close.iat[0] - 1 - 0.20) < 1e-9


def test_iso_week_matches_app():
    assert iso_week('2025-01-01') == '2025-U01'
    assert iso_week('2024-12-30') == '2025-U01'
    assert iso_week('2021-01-03') == '2020-U53'


def test_cmp_classification():
    assert cmp_class({2021: {3}, 2022: {3, 7}, 2023: {3}}, 2024, 3) == 'rutine'
    assert cmp_class({2021: {3}, 2022: {6}, 2023: {3}}, 2024, 3) == 'opportunistisk'
    assert cmp_class({2021: {3}, 2023: {3}}, 2024, 3) == 'ukendt'


def test_n_required_and_stats():
    assert n_required(7, 1.5, 0.95) == 59  # prereg afsnit 10: 1,5 % ved ca. 60 enheder
    assert n_required(7, 1.5, 0.95, power=0.8) == 135
    assert n_required(7, 1.5, 0.95, deff=2.0) == 118
    v = np.random.default_rng(1).normal(size=400)
    m, se = clustered_mean(v, np.arange(400))  # én observation pr. klynge = iid-standardfejl
    assert abs(se - v.std(ddof=1) / 20) < 1e-12 and abs(m - v.mean()) < 1e-12
    b = week_bootstrap(np.full(50, 0.01), np.repeat(np.arange(10), 5), reps=200)
    assert all(abs(x - 0.01) < 1e-12 for x in b.values())


def test_app_filters_mirrored():
    assert exchange_ok('NMS', 'NasdaqGS')[0] and exchange_ok('NYQ', 'NYSE')[0] and exchange_ok('ASE', 'NYSE American')[0]
    assert exchange_ok('BTS', 'Cboe US')[0] and not exchange_ok('PNK', 'Other OTC')[0] and not exchange_ok('LSE', 'London')[0]
    assert role('Chief Executive Officer', False, True, False) == 'CEO'
    assert role('EVP & CFO', False, True, False) == 'CFO'
    assert role('President', False, False, False) == 'anden officer'
    assert role('', True, False, False) == 'director' and role('', False, False, True) == '10 %-ejer'
    assert is_plan_footnote('Purchased pursuant to a Rule 10b5-1 trading plan adopted on May 1.')
    assert not is_plan_footnote('These purchases were not made pursuant to a Rule 10b5-1 plan.')
    assert is_entity_name('Third Rock Ventures V, L.P.') and not is_entity_name('Jane Doe')


if __name__ == '__main__':
    tests = [f for k, f in sorted(globals().items()) if k.startswith('test_')]
    for t in tests:
        t()
        print(f'ok  {t.__name__}')
    print(f'{len(tests)} tests ok')
