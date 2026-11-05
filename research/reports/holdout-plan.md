# Holdout-plan – den endelige test på 2025–2026

**Skrevet:** 5.11.2026, før nogen holdout-enhed er analyseret.
**Status:** låst, når filen committes.

`research/src/holdout.py` afviser at køre, hvis filen ikke er committet og uændret (`analyze.load_units(holdout=True)`). En ændring efter holdout-kørslen kræver en ny version af planen med ny dato. Resultatet efter denne version rapporteres stadig.

## 1. Grundlag

**In-sample-analyse:** `research/reports/backtest-v1.md` (commit 22c105a), entry 2006-01-04 – 2024-12-31, 34.842 enheder.
- Basisstrategien gav brutto +0,56 % og netto −0,34 % efter 5 dage og var aftagende.
- Ingen walk-forward-model slog de naive baselines ude af sample efter omkostninger.
- Derfor er der ingen frosset model at teste.

**Prereg-note:** `docs/prereg.md` under "Vurderinger" (commit 42b9d8f).

**Data:** `research/data/units.parquet` (gitignored), sha256 `984eecbaddfe798efea66e4dff26df6b88f20e011b0476deb7bb8e8567b380bc`. Filen er bygget af `build.py` med samme regler som in-sample og indeholder 38.485 enheder i alt.

**Kode:** testene udføres af `holdout.py` og funktionerne `test2_rule`, `feature_flags`, `flag_diff`, `rule_table` og `stat` i `analyze.py`, som de står i samme commit som denne fil.

## 2. Holdout-population

Alle enheder (ticker, entry-dag) i `units.parquet` med entry-dag ≥ 2025-01-01:
- Form 345-data findes til og med 2026Q1, så den sidste mulige entry er 2026-04-01.
- Kurser er hentet 5.11.2026.

Reglerne er de samme som in-sample og som `docs/prereg.md` v1:
- **Entry:** første ordinære åbning ≥ EDGAR-accepttid + 10 min.
- **Population:** kode P, ikke-derivat, ≥ $50k pr. Form 4, ujusteret kurs ≥ $2, ADV ≥ $500k punkt-i-tid, NASDAQ/NYSE/NYSE American/Cboe, ikke fonde/trusts, ikke 10b5-1.
- **Afkast:** AR i DKK.
- **Omkostninger:** costs.json v3, sha256 `fad087e9…`.

En enhed indgår i en horisont, når den har et udfald for den horisont. Manglende kurs giver intet udfald.

## 3. Bekræftende tests

Der er kun to bekræftende tests, og de korrigeres med Bonferroni. Hver test bestås, hvis den **ensidede 97,5 %-nedre grænse er > 0**. Grænsen beregnes som gennemsnit − 1,96 × uge-klynget SE, hvor SE er klynget på ISO-ugen for entry-dagen (statsmodels OLS på konstant med `cov_type='cluster'`).

### Test 1 – basisstrategien
- **Hvem:** alle holdout-enheder.
- **Metrik:** gennemsnitligt 5-dages netto abnormalt afkast i DKK mod SPY.

### Test 2 – CEO/CFO-køb langt under 52-ugers-toppen
- **Hvem:** holdout-enheder, hvor begge betingelser holder (`analyze.test2_rule`):
  1. Den højeste rolle blandt enhedens signaler er **CEO eller CFO**. Rollen afgøres af `common.role`:
     - CEO = titlen matcher `ceo|chief executive`;
     - CFO = titlen matcher `cfo|chief financial`, og titlen er ikke CEO.
  2. **dist52w < −0,30**. Det er sidste justerede close før entry-dagen divideret med maksimum af de seneste 252 closes (justerede, før entry-dagen) minus 1 (`common.pit_snapshot`).
- Begge betingelser er præcis flagene "CEO eller CFO" og "> 30 % under 52-ugers-top" fra afsnit 12 i backtest-v1.
- **Metrik:** som Test 1.
- **Mindste N:** har Test 2 færre end **150 enheder** med 5-dages udfald i holdout, er resultatet kun beskrivende og ikke bekræftende.

**Advarsel:** reglen er valgt efter in-sample-analysen. Den kombinerer de to features, der var holdbare in-sample. In-sample-tallene nedenfor er derfor optimistiske, og holdout er den eneste ærlige test af reglen.

### Fortolkning
- Test 1 bestået: basisstrategien har dokumenteret en netto-edge i 2025–2026. In-sample-forventningen er negativ.
- Test 2 bestået (og N ≥ 150): reglen har dokumenteret en netto-edge i 2025–2026. Den kan foreslås som et udvalg i en senere prereg-version for ledgeren. Den ændrer ikke prereg v1.
- Ikke bestået: ingen dokumenteret netto-edge for den pågældende strategi i holdout.

## 4. In-sample-tal (2006–2024), skrevet ind før holdout

Intervaller er 95 % og uge-klyngede. Sidste kolonne er den ensidede 97,5 %-nedre grænse for netto mod SPY.

**Basisstrategien (Test 1)**, 34.842 enheder:

| Horisont | N | Brutto mod SPY | Netto mod SPY | Netto mod IWM | Ensidet 97,5 %-nedre, netto SPY |
|---|---|---|---|---|---|
| 1 d | 34.842 | +0,35 % [+0,28 %; +0,41 %] | -0,55 % [-0,61 %; -0,49 %] | -0,51 % [-0,56 %; -0,46 %] | -0,61 % |
| 5 d | 34.842 | +0,56 % [+0,30 %; +0,82 %] | -0,34 % [-0,60 %; -0,08 %] | -0,27 % [-0,41 %; -0,13 %] | -0,60 % |
| 21 d | 34.842 | +0,61 % [+0,15 %; +1,06 %] | -0,29 % [-0,75 %; +0,17 %] | -0,09 % [-0,36 %; +0,18 %] | -0,75 % |
| 63 d | 34.842 | +1,21 % [+0,47 %; +1,94 %] | +0,31 % [-0,42 %; +1,05 %] | +0,52 % [+0,02 %; +1,02 %] | -0,42 % |

**Test 2-reglen**, 3.779 enheder (10,8 % af enhederne):

| Horisont | N | Brutto mod SPY | Netto mod SPY | Netto mod IWM | Ensidet 97,5 %-nedre, netto SPY |
|---|---|---|---|---|---|
| 1 d | 3.779 | +0,78 % [+0,60 %; +0,97 %] | -0,13 % [-0,31 %; +0,05 %] | -0,07 % [-0,24 %; +0,10 %] | -0,31 % |
| 5 d | 3.779 | +1,19 % [+0,55 %; +1,83 %] | +0,28 % [-0,36 %; +0,92 %] | +0,36 % [-0,03 %; +0,74 %] | -0,36 % |
| 21 d | 3.779 | +1,66 % [+0,72 %; +2,60 %] | +0,75 % [-0,19 %; +1,68 %] | +1,00 % [+0,29 %; +1,71 %] | -0,19 % |
| 63 d | 3.779 | +3,41 % [+1,23 %; +5,59 %] | +2,50 % [+0,32 %; +4,68 %] | +2,29 % [+0,46 %; +4,11 %] | +0,32 % |

Test 2-enheder pr. år in-sample:

| År | 2006 | 2007 | 2008 | 2009 | 2010 | 2011 | 2012 | 2013 | 2014 | 2015 |
|---|---|---|---|---|---|---|---|---|---|---|
| Enheder | 44 | 114 | 305 | 156 | 27 | 131 | 75 | 33 | 129 | 220 |

| År | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 |
|---|---|---|---|---|---|---|---|---|---|
| Enheder | 201 | 136 | 205 | 273 | 470 | 169 | 489 | 367 | 235 |

## 5. Beskrivende (ingen konklusioner)

1. Alle horisonter (1/5/21/63 d), brutto og netto mod SPY og netto mod IWM, for både basisstrategien og Test 2-reglen (`rule_table`).
2. Fortegnet for hver feature. Det er forskellen i netto 5 d mellem enheder med og uden flaget (`flag_diff`, uge-klynget), sammenlignet med in-sample-fortegnet:

| Feature | In-sample-forskel netto 5 d [95 %] | Fortegn |
|---|---|---|
| opportunistisk køb (CMP) | +0,14 % [-0,09 %; +0,37 %] | + |
| rutinekøb (CMP) | -0,14 % [-0,56 %; +0,28 %] | − |
| CEO eller CFO | +0,31 % [+0,08 %; +0,54 %] | + |
| director | -0,14 % [-0,32 %; +0,04 %] | − |
| 10 %-ejer | -0,02 % [-0,34 %; +0,30 %] | − |
| C-suite-titel | +0,20 % [-0,02 %; +0,41 %] | + |
| ≥ 2 personlige købere/10 d | +0,06 % [-0,28 %; +0,41 %] | + |
| fond/enhed | +0,23 % [-0,02 %; +0,48 %] | + |
| køb til udbudskurs | +0,43 % [-0,30 %; +1,16 %] | + |
| ny position eller > 100 % stigning | +0,09 % [-0,10 %; +0,27 %] | + |
| kursfald > 20 % de seneste 60 d | +0,81 % [+0,12 %; +1,50 %] | + |
| > 30 % under 52-ugers-top | +0,66 % [+0,23 %; +1,09 %] | + |
| markedsværdi < $300 mio. | +0,38 % [-0,04 %; +0,80 %] | + |
| ADV < $5 mio. | +0,09 % [-0,15 %; +0,34 %] | + |

3. Dækning (survivorship) pr. filing-år 2025–2026.
