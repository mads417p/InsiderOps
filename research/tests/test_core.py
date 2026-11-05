"""Låste regler for fase 4 (kør: research/run.ps1 -Step test). Fejler, hvis en regel driver fra appen/prereg v1."""
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

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


def test_parity_with_app_outcomes_fixture():
    """Samme fixture og forventninger som tests/outcomes.test.ts (appen): entry-dage og AR i DKK."""
    import json
    from build import _outcomes
    raw = json.loads((Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'yahoo-daily-2025-11.json').read_text(encoding='utf-8'))

    def series(sym):
        r = raw[sym]
        js = {'chart': {'result': [{'meta': {'exchangeTimezoneName': r['tz']}, 'timestamp': r['timestamp'],
                                    'indicators': {'quote': [{'open': r['open'], 'close': r['close']}]}}]}}
        bars, splits, meta = parse_chart(js)
        return bars, unadjust_factor(bars.date, splits), meta, bars.date.tolist()

    spy, iwm, usd = series('SPY'), series('IWM'), series('USDDKK=X')
    d = spy[3]
    for anchor, want in [('2025-11-24T09:42', '2025-11-24'), ('2025-11-24T14:25', '2025-11-25'), ('2025-11-24T14:20', '2025-11-24'),
                         ('2025-11-24T21:30', '2025-11-25'), ('2025-11-22T12:00', '2025-11-24'), ('2025-11-27T10:00', '2025-11-28')]:
        assert d[entry_index(d, UTC(anchor), anchor[:10])] == want, anchor
    ei = entry_index(d, UTC('2025-11-26T22:00'), '2025-11-26')
    o = _outcomes(spy, ei, spy, iwm, usd, cost=0.0)
    assert (d[ei], o['exit_5']) == ('2025-11-28', '2025-12-04')
    ret_dkk = (684.39 * 6.4008) / (680.86 * 6.4381) - 1
    iwm_dkk = ((251.82 / 248.01) * 6.4008) / 6.4381 - 1
    assert abs(o['gross_5']) < 1e-12  # aktien er SPY selv
    assert abs(o['gross_iwm_5'] - (ret_dkk - iwm_dkk)) < 1e-10


# ---------------------------------------------------------------- fase 4-SE (research/reports/prereg-se.md)
def test_se_costs_v4():
    import se
    c4, c3 = load_costs(*se.COSTS_V4), load_costs()  # fejler, hvis v4's sha256 er ændret
    for adv, want in [(60e6, 0.6), (10e6, 0.8), (2e6, 1.1), (0.6e6, 1.7), (None, 1.7)]:
        assert abs(round_trip_pct(c4, adv, 'SEK') - want) < 1e-9, (adv, round_trip_pct(c4, adv, 'SEK'))
    assert abs(round_trip_pct(c3, 10e6, 'SEK') - 1.3) < 1e-9  # v3 uændret (automatisk veksling)
    assert {k: v for k, v in c4.items() if k not in ('version', 'source', 'note', 'fxSpreadPctByCurrency')} == \
           {k: v for k, v in c3.items() if k not in ('version', 'source', 'note', 'fxSpreadPctByCurrency')}
    assert c4['fxSpreadPctByCurrency'] == {**c3['fxSpreadPctByCurrency'], 'SEK': 0}


def test_se_entry_rule_stockholm():
    import se
    ST = lambda s: datetime.fromisoformat(s).replace(tzinfo=se.SE_TZ).astimezone(timezone.utc)
    e = lambda days, s: days[entry_index(days, ST(s), s[:10], se.SE_TZ, se.SE_OPEN)]
    win = ['2025-01-09', '2025-01-10', '2025-01-13']  # vintertid: 09:00 = 08:00 UTC
    assert e(win, '2025-01-10T08:50:00') == '2025-01-10'  # 09:00 ≥ 08:50 + 10 min
    assert e(win, '2025-01-10T08:51:00') == '2025-01-13'  # 09:00 < 09:01 → næste handelsdag (weekend)
    assert e(win, '2025-01-09T17:40:00') == '2025-01-10'
    sumr = ['2025-03-28', '2025-03-31', '2025-04-01']  # sommertid fra 30.3.2025: 09:00 = 07:00 UTC
    assert e(sumr, '2025-03-31T08:50:00') == '2025-03-31'
    assert e(sumr, '2025-03-31T08:51:00') == '2025-04-01'
    assert sumr[entry_index(sumr, UTC('2025-03-31T06:50'), '2025-03-31', se.SE_TZ, se.SE_OPEN)] == '2025-03-31'
    assert sumr[entry_index(sumr, UTC('2025-03-31T06:51'), '2025-03-31', se.SE_TZ, se.SE_OPEN)] == '2025-04-01'


def test_se_fi_parse_and_population():
    import se
    head = ';'.join(['Publiceringsdatum', 'Emittent', 'LEI-kod', 'Anmälningsskyldig', 'Person i ledande ställning', 'Befattning',
                     'Närstående', 'Korrigering', 'Beskrivning av korrigering', 'Är förstagångsrapportering',
                     'Är kopplad till aktieprogram', 'Karaktär', 'Instrumenttyp', 'Instrumentnamn', 'ISIN', 'Transaktionsdatum',
                     'Volym', 'Volymsenhet', 'Pris', 'Valuta', 'Handelsplats', 'Status', ''])
    rows = [
        ['2017-03-06 08:31:12', 'Acme AB', '', 'Anna A', 'Anna A', 'VD', '', '', '', 'Ja', '', 'Förvärv', '', 'Acme AB ser. B',
         'SE0000000001', '2017-03-03 00:00:00', '12\xa0000,0', 'Antal', '45,5', 'SEK', 'NASDAQ STOCKHOLM AB', 'Aktuell', ''],
        ['2017-03-06 08:31:12', 'Acme AB', '', 'Anna A', 'Anna A', 'VD', '', '', '', '', '', 'Förvärv', '', 'Acme AB TO 2',
         'SE0000000002', '2017-03-03 00:00:00', '100,0', 'Antal', '1,0', 'SEK', 'NASDAQ STOCKHOLM AB', 'Aktuell', ''],
        ['2017-03-07 10:00:00', 'Acme AB', '', 'Bo B', 'Bo B', 'CFO', '', 'Ja', 'fel antal', '', '', 'Förvärv', 'Aktie', 'Acme AB',
         'SE0000000001', '2017-03-06 00:00:00', '10,0', 'Antal', '45,0', 'SEK', 'FIRST NORTH SWEDEN', 'Aktuell', ''],
        ['2017-03-07 10:00:00', 'Acme AB', '', 'Cia C', 'Cia C', 'Styrelseledamot', '', '', '', '', '', 'Förvärv', 'Aktie', 'Acme AB',
         'SE0000000001', '2017-03-06 00:00:00', '10,0', 'Antal', '45,0', 'SEK', 'Utanför handelsplats', 'Aktuell', ''],
        ['2017-03-07 11:00:00', 'Acme AB', '', 'Dan D', 'Dan D', 'Ordförande', '', '', '', '', '', 'Förvärv', 'Aktie', 'Acme AB',
         'SE0000000001', '2017-03-06 00:00:00', '10,0', 'Antal', '45,0', 'SEK', 'SPOTLIGHT STOCK MARKET', 'Makulerad', ''],
    ]
    body = '\n'.join([head] + [';'.join(r) for r in rows]).encode('utf-16-le')
    parsed = se.parse_fi_csv(body)
    df = pd.DataFrame(parsed, columns=se.COLS)
    df['volume'], df['price'] = df.volume.map(se._num), df.price.map(se._num)
    assert df.volume.iat[0] == 12000.0 and df.price.iat[0] == 45.5  # hårdt mellemrum + decimalkomma
    assert se.market_buy(df).tolist() == [True, False, False, False, False]  # TO-option, korrektion, Utanför, makuleret ud
    assert [se.role_se(p) for p in ('VD', 'Ekonomidirektör', 'Styrelseordförande', 'Styrelseledamot/suppleant', 'COO', '')] == \
           ['VD', 'CFO', 'ordförande', 'styrelseledamot', 'anden ledelse', 'ukendt']
    assert se.norm_issuer('Acme AB (publ)') == se.norm_issuer('ACME AB') == 'acme'


def test_se_cluster_window():
    import se
    t = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    c = pd.DataFrame({'issuer_key': ['x', 'x', 'x', 'x', 'y'], 'pdmr_key': ['a', 'b', 'a', 'c', 'd'],
                      'anchor_utc': [t('2025-01-01T08:00'), t('2025-01-05T08:00'), t('2025-01-10T08:00'), t('2025-01-11T08:00'),
                                     t('2025-01-10T08:00')]})
    assert se.personal_buyers(c, 'x', t('2025-01-10T08:00')) == 2  # a og b (a to gange), c er efter ankeret, y er anden emittent
    assert se.personal_buyers(c, 'x', t('2025-01-11T08:00')) == 3  # 1.1. 08:00 er præcis 10 dage før: med
    assert se.personal_buyers(c, 'x', t('2025-01-11T08:01')) == 3  # 1.1. falder ud, men a købte igen 10.1.


def test_se_dividend_window():
    from build import _outcomes
    dates = ['2025-05-05', '2025-05-06', '2025-05-07', '2025-05-08', '2025-05-09', '2025-05-12', '2025-05-13']
    bars = pd.DataFrame({'date': dates, 'open': [100.0] * 7, 'close': [100.0] * 7, 'volume': [1.0] * 7})
    flat = (bars, np.ones(7), {}, dates)  # benchmark og FX flade: AR = aktiens eget afkast
    div = [('2025-05-05', 9.0), ('2025-05-07', 2.0), ('2025-05-13', 7.0)]  # entry-dagen, inden for, efter 5 d-exit
    o = _outcomes(flat, 0, flat, flat, flat, 0.0, div=div)
    assert abs(o['gross_1']) < 1e-12  # ex-dato på entry-dagen tæller ikke
    assert abs(o['gross_5'] - 0.02) < 1e-12  # kun 7.5. i (entry, exit]
    assert abs(_outcomes(flat, 0, flat, flat, flat, 0.0)['gross_5']) < 1e-12  # uden div = kursafkast (fase 4)


if __name__ == '__main__':
    tests = [f for k, f in sorted(globals().items()) if k.startswith('test_')]
    for t in tests:
        t()
        print(f'ok  {t.__name__}')
    print(f'{len(tests)} tests ok')
