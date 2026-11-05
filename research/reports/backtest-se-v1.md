# Backtest SE v1 – svenske insiderkøb efter FI-publicering (in-sample 7/2016–2024)

Genereret 05.11.2026 af `research/src/se_analyze.py`. Regler: `research/reports/prereg-se.md` (commit b599007), ISIN-kontroltabel `isin-map-se.csv`, omkostninger `config/costs-v4.json`.
- Entry ved første åbning (09:00 Stockholm) mindst 10 minutter efter FI-publiceringen; exit ved lukning på handelsdag h.
- AR i DKK: aktiens totalafkast (inkl. udbytte med ex-dato i (entry, exit]) minus benchmark. Primær ^OMXSBGI (brutto-indeks), sekundær XACT-SMABOLAG.ST.
- Enhed = (symbol, entry-dag). In-sample = entry før 2025-01-01; holdout står i afsnit 8, når den er kørt.
- Der er ikke brugt LLM på historiske hændelser.

## 1. Data, filter-tragt og dækning

Alle år (in-sample og holdout); signaler pr. publiceringsår, enheder pr. entry-år.

| Trin | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| FI-rækker | 5.304 | 12.401 | 13.809 | 14.102 | 16.913 | 19.674 | 19.504 | 19.172 | 17.962 | 16.447 | 13.118 |
| originale, ikke makulerede | 4.553 | 10.673 | 12.355 | 12.849 | 15.248 | 17.725 | 17.780 | 17.798 | 16.199 | 15.346 | 12.324 |
| + Förvärv | 2.361 | 6.011 | 7.196 | 7.225 | 8.154 | 9.846 | 11.115 | 10.818 | 8.883 | 8.678 | 7.369 |
| + aktie på handelsplads | 1.592 | 4.083 | 5.061 | 4.897 | 5.955 | 7.400 | 8.639 | 8.656 | 6.893 | 6.919 | 5.833 |
| signaler (ISIN, PDMR, tidspunkt) | 1.237 | 3.224 | 3.691 | 3.478 | 4.308 | 4.651 | 5.602 | 5.187 | 4.717 | 4.609 | 4.015 |
| signaler ≥ $50k | 304 | 841 | 915 | 704 | 829 | 1.213 | 1.227 | 924 | 989 | 1.151 | 1.110 |
| + kurs ≥ 10 SEK | 267 | 741 | 816 | 634 | 732 | 1.078 | 1.108 | 804 | 838 | 1.023 | 981 |
| + symbol | 164 | 502 | 607 | 493 | 519 | 767 | 866 | 627 | 718 | 931 | 900 |
| + SEK-serie, kursdata, entry og signal-tjek | 148 | 478 | 589 | 482 | 510 | 761 | 854 | 623 | 704 | 923 | 888 |
| + ADV ≥ $500k (signaler) | 110 | 369 | 403 | 305 | 400 | 594 | 656 | 439 | 500 | 678 | 667 |
| enheder (ticker, entry-dag) | 86 | 272 | 311 | 235 | 331 | 469 | 544 | 355 | 414 | 571 | 559 |
| heraf small/mid | 65 | 139 | 141 | 133 | 170 | 223 | 261 | 173 | 222 | 303 | 327 |
| heraf cluster ∧ small/mid (test 2) | 7 | 25 | 32 | 20 | 33 | 40 | 59 | 26 | 39 | 60 | 60 |

**Kursdækning (survivorship):** kandidatsignaler (≥ $50k, VWAP ≥ 10 SEK) uden symbol eller kursserie i Yahoo. Afnoterede selskaber mangler.

| År (publicering) | Kandidater | Uden kurser | Andel |
|---|---|---|---|
| 2016 | 267 | 103 | 38,6 % |
| 2017 | 741 | 243 | 32,8 % |
| 2018 | 816 | 215 | 26,3 % |
| 2019 | 634 | 142 | 22,4 % |
| 2020 | 732 | 218 | 29,8 % |
| 2021 | 1.078 | 314 | 29,1 % |
| 2022 | 1.108 | 248 | 22,4 % |
| 2023 | 804 | 178 | 22,1 % |
| 2024 | 838 | 121 | 14,4 % |
| 2025 | 1.023 | 92 | 9,0 % |
| 2026 | 981 | 82 | 8,4 % |

Status for kandidatsignaler: ok 5.121, intet symbol 1.928, ADV < $500k 1.839, kurs < 10 SEK 1.185, kurs-mismatch 99, ingen kursdata 28, entry ikke nået 7.

In-sample: 3.017 enheder i 419 ISO-uger (2016-07-21 – 2024-12-30); gennemsnitlig round-trip 1,01 %.

## 2. Bekræftende tests (in-sample)

To tests med Bonferroni. Hver bestås, hvis den ensidede 97,5 %-nedre grænse (gennemsnit − 1,96 × uge-klynget SE) er > 0. Under 150 enheder med 5-dages udfald er en test kun beskrivende.

### Test 1 – basisstrategien

| Mål | Værdi |
|---|---|
| Enheder / uger | 3.017 / 419 |
| Gennemsnit netto 5 d mod ^OMXSBGI | -0,79 % |
| SD pr. enhed | 5,29 % |
| SE, uge-klynget | 0,150 % |
| **Ensidet 97,5 %-nedre grænse (uge-klynget)** | **-1,08 %** |
| Ensidet 95 %-nedre grænse, prereg-bootstrap (kun til orientering) | -1,04 % |
| **Resultat** | **ikke bestået: nedre grænse ≤ 0** |

### Test 2 – clusters (≥ 2 PDMR/10 d) i small/mid cap

| Mål | Værdi |
|---|---|
| Enheder / uger | 281 / 155 |
| Gennemsnit netto 5 d mod ^OMXSBGI | -1,31 % |
| SD pr. enhed | 5,06 % |
| SE, uge-klynget | 0,401 % |
| **Ensidet 97,5 %-nedre grænse (uge-klynget)** | **-2,09 %** |
| Ensidet 95 %-nedre grænse, prereg-bootstrap (kun til orientering) | -1,94 % |
| **Resultat** | **ikke bestået: nedre grænse ≤ 0** |

## 3. Horisonter

Intervaller: 95 %, uge-klyngede. Spand med under 30 enheder vises som "for få".

### Test 1 – alle enheder

| Horisont | N | Brutto mod ^OMXSBGI | Netto mod ^OMXSBGI | Netto mod XACT-SMABOLAG.ST |
|---|---|---|---|---|
| 1 d | 3.017 | +0,07 % [-0,04 %; +0,19 %] | -0,94 % [-1,05 %; -0,82 %] | -0,84 % [-0,93 %; -0,74 %] |
| 5 d | 3.017 | +0,22 % [-0,07 %; +0,52 %] | -0,79 % [-1,08 %; -0,49 %] | -0,67 % [-0,90 %; -0,45 %] |
| 21 d | 3.017 | +0,11 % [-0,36 %; +0,58 %] | -0,90 % [-1,37 %; -0,43 %] | -0,61 % [-1,03 %; -0,19 %] |
| 63 d | 3.017 | +1,05 % [+0,16 %; +1,94 %] | +0,04 % [-0,85 %; +0,92 %] | +0,35 % [-0,50 %; +1,21 %] |

### Test 2 – clusters i small/mid cap

| Horisont | N | Brutto mod ^OMXSBGI | Netto mod ^OMXSBGI | Netto mod XACT-SMABOLAG.ST |
|---|---|---|---|---|
| 1 d | 281 | -0,24 % [-0,71 %; +0,24 %] | -1,47 % [-1,95 %; -0,99 %] | -1,31 % [-1,74 %; -0,88 %] |
| 5 d | 281 | -0,07 % [-0,86 %; +0,71 %] | -1,31 % [-2,09 %; -0,52 %] | -1,18 % [-1,95 %; -0,42 %] |
| 21 d | 281 | -0,52 % [-2,14 %; +1,10 %] | -1,75 % [-3,37 %; -0,14 %] | -1,66 % [-3,45 %; +0,12 %] |
| 63 d | 281 | +0,33 % [-2,31 %; +2,96 %] | -0,91 % [-3,54 %; +1,72 %] | -0,98 % [-3,82 %; +1,86 %] |

## 4. Beskrivende tal (ingen konklusioner)

### Pr. rolle (højeste i enheden)

| Spand | N | Brutto 5 d | Netto 5 d | Netto 21 d |
|---|---|---|---|---|
| VD | 919 | +0,03 % [-0,34 %; +0,39 %] | -0,97 % [-1,34 %; -0,60 %] | -1,24 % [-1,91 %; -0,56 %] |
| CFO | 133 | +0,72 % [+0,03 %; +1,41 %] | -0,23 % [-0,93 %; +0,47 %] | +0,01 % [-1,59 %; +1,60 %] |
| ordförande | 470 | +0,25 % [-0,33 %; +0,83 %] | -0,81 % [-1,39 %; -0,23 %] | -0,38 % [-1,37 %; +0,60 %] |
| styrelseledamot | 1.086 | +0,23 % [-0,20 %; +0,67 %] | -0,79 % [-1,22 %; -0,36 %] | -1,04 % [-1,69 %; -0,39 %] |
| anden ledelse | 409 | +0,46 % [+0,04 %; +0,88 %] | -0,50 % [-0,93 %; -0,08 %] | -0,65 % [-1,63 %; +0,33 %] |

### Pr. år (entry)

| Spand | N | Brutto 5 d | Netto 5 d | Netto 21 d |
|---|---|---|---|---|
| 2016 | 86 | -0,37 % [-1,59 %; +0,85 %] | -1,53 % [-2,77 %; -0,29 %] | -1,04 % [-2,79 %; +0,70 %] |
| 2017 | 272 | +0,48 % [-0,01 %; +0,97 %] | -0,51 % [-1,01 %; -0,02 %] | -0,20 % [-1,03 %; +0,63 %] |
| 2018 | 311 | +0,14 % [-0,38 %; +0,65 %] | -0,80 % [-1,32 %; -0,29 %] | -1,24 % [-2,07 %; -0,41 %] |
| 2019 | 235 | +0,33 % [-0,42 %; +1,07 %] | -0,68 % [-1,42 %; +0,05 %] | -0,49 % [-1,61 %; +0,62 %] |
| 2020 | 331 | -0,49 % [-2,11 %; +1,12 %] | -1,50 % [-3,11 %; +0,12 %] | -2,07 % [-4,32 %; +0,18 %] |
| 2021 | 469 | +0,02 % [-0,64 %; +0,68 %] | -0,99 % [-1,64 %; -0,34 %] | -1,56 % [-2,64 %; -0,48 %] |
| 2022 | 544 | +0,51 % [-0,36 %; +1,39 %] | -0,48 % [-1,35 %; +0,40 %] | -0,47 % [-1,90 %; +0,96 %] |
| 2023 | 355 | +0,39 % [-0,12 %; +0,90 %] | -0,64 % [-1,14 %; -0,14 %] | -0,65 % [-1,83 %; +0,53 %] |
| 2024 | 414 | +0,47 % [+0,14 %; +0,81 %] | -0,58 % [-0,91 %; -0,25 %] | -0,38 % [-1,16 %; +0,40 %] |

### Pr. likviditetsspand (omkostning: 1,7 / 1,1 / 0,8 / 0,6 %)

| Spand | N | Brutto 5 d | Netto 5 d | Netto 21 d |
|---|---|---|---|---|
| $0–1 mio. | 409 | -0,20 % [-0,84 %; +0,45 %] | -1,90 % [-2,54 %; -1,25 %] | -1,67 % [-2,91 %; -0,44 %] |
| $1–5 mio. | 1.118 | +0,39 % [-0,07 %; +0,85 %] | -0,71 % [-1,17 %; -0,25 %] | -1,11 % [-1,87 %; -0,36 %] |
| $5–50 mio. | 1.134 | +0,26 % [-0,09 %; +0,61 %] | -0,54 % [-0,89 %; -0,19 %] | -0,38 % [-1,05 %; +0,29 %] |
| ≥ $50 mio. | 356 | +0,08 % [-0,27 %; +0,42 %] | -0,52 % [-0,87 %; -0,18 %] | -0,97 % [-1,68 %; -0,26 %] |

### Small/mid mod large

| Spand | N | Brutto 5 d | Netto 5 d | Netto 21 d |
|---|---|---|---|---|
| large (ADV ≥ $5 mio.) | 1.490 | +0,22 % [-0,07 %; +0,50 %] | -0,54 % [-0,82 %; -0,25 %] | -0,52 % [-1,04 %; -0,01 %] |
| small/mid (ADV < $5 mio.) | 1.527 | +0,23 % [-0,20 %; +0,66 %] | -1,03 % [-1,46 %; -0,60 %] | -1,26 % [-1,98 %; -0,55 %] |

### Cluster

| Spand | N | Brutto 5 d | Netto 5 d | Netto 21 d |
|---|---|---|---|---|
| 1 PDMR | 2.302 | +0,31 % [+0,01 %; +0,61 %] | -0,73 % [-1,03 %; -0,43 %] | -0,77 % [-1,25 %; -0,28 %] |
| ≥ 2 PDMR/10 d | 715 | -0,04 % [-0,44 %; +0,37 %] | -0,97 % [-1,38 %; -0,57 %] | -1,32 % [-2,15 %; -0,48 %] |

## 5. Robusthed (kun beskrivende)

| Udvalg | N | Netto 5 d [95 %] | Ensidet 97,5 %-nedre |
|---|---|---|---|
| Test 1, signal-tjek [0,5; 2] (`strict_ok`) | 2.968 | -0,78 % [-1,07 %; -0,48 %] | -1,07 % |
| Test 2, signal-tjek [0,5; 2] (`strict_ok`) | 279 | -1,31 % [-2,10 %; -0,52 %] | -2,10 % |
| Test 1 uden ISIN godkendt trods kursafvigelse (`ratio_flag`) | 2.935 | -0,78 % [-1,07 %; -0,48 %] | -1,07 % |

## 6. Spredning og påkrævet N

| Mål | Værdi |
|---|---|
| SD pr. enhed (netto 5 d) | 5,29 % |
| SE, uafhængige / uge-klynget | 0,096 % / 0,150 % |
| Designeffekt (SE²-forhold) | 2,43 |

| δ (netto 5 d) | Påkrævet N (80 % styrke, ensidet 97,5 %, målt SD og deff) |
|---|---|
| +0,5 % | 2.132 |
| +1,0 % | 533 |
| +1,5 % | 237 |

## 7. In-sample-resultat

**Test 1:** ikke bestået: nedre grænse ≤ 0. **Test 2:** ikke bestået: nedre grænse ≤ 0.

Kendte begrænsninger står i prereg-se.md afsnit 11. Desuden: handelsdage tælles efter aktiens egne Yahoo-bars, så en manglende bar (fx SAND.ST 17.6.2019) flytter exit én handelsdag.
