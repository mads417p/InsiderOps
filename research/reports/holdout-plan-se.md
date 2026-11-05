# Holdout-plan SE – replikation på 2025–2026

**Skrevet:** 5.11.2026, før nogen holdout-enhed er analyseret.
**Status:** låst, når filen committes.

`research/src/se_analyze.py holdout` afviser at køre, hvis filen ikke er committet og uændret (`analyze.load_units(holdout=True, plan='holdout-plan-se.md')`). En ændring efter holdout-kørslen kræver en ny version af planen med ny dato. Resultatet efter denne version rapporteres stadig.

## 1. Grundlag
- **Prereg:** `research/reports/prereg-se.md` (commit b599007) med ISIN-kontroltabellen `isin-map-se.csv`. Testene og kriterierne står i prereg afsnit 8 og gentages her uændret.
- **In-sample:** `research/reports/backtest-se-v1.md` (commit b7e4a56), entry 21.7.2016–30.12.2024, 3.017 enheder.
  - Test 1: netto 5 d −0,79 %, ensidet 97,5 %-nedre grænse −1,08 %.
  - Test 2: netto 5 d −1,31 % (281 enheder), ensidet 97,5 %-nedre grænse −2,09 %.
  - Ingen består in-sample. Holdout er derfor en replikation, der kun kan bekræfte en negativ konklusion eller vise et brud.
- **Data:** `research/data/se/units.parquet` (gitignored), sha256 `0fe47da1680f4118da8b2f68089739865a460f50dae14988330326cb633da4b1`. Den er bygget af `se.py build` med reglerne i prereg og indeholder 4.147 enheder, heraf 1.130 med entry ≥ 2025-01-01. FI-data og kurser er hentet 5.11.2026.
- **Kode:** `se_analyze.holdout`, `holdout.confirm` og `analyze.stat` som de står i samme commit som denne fil.

## 2. Holdout-population
Alle enheder (symbol, entry-dag) i `units.parquet` med entry-dag ≥ 2025-01-01. Seneste entry er 4.11.2026. Enheder uden udfald for en horisont (ikke nået endnu, eller manglende kurs) indgår ikke i den horisont.

## 3. Bekræftende tests (Bonferroni)
Hver test bestås, hvis den **ensidede 97,5 %-nedre grænse er > 0**: gennemsnit − 1,96 × uge-klynget SE (ISO-uge for entry-dagen). Har en test færre end **150 enheder** med 5-dages udfald, er resultatet kun beskrivende.
- **Test 1 – basisstrategien:** alle holdout-enheder, netto 5 d mod `^OMXSBGI`. Forventet N ca. 1.130.
- **Test 2 – clusters i small/mid cap:** `cluster` ∧ `small_mid`, netto 5 d mod `^OMXSBGI`. Forventet N ca. 120, altså under 150. **Test 2 er derfor kun beskrivende i holdout.** Det var kendt og skrevet i prereg afsnit 12, før noget afkast blev set.

## 4. Fortolkning
- Test 1 består i holdout: et brud med in-sample, der kræver en ny, præregistreret test på senere data, før det kan bruges. Det giver ikke grønt lys for rigtige penge.
- Test 1 består ikke: der er ingen dokumenteret netto-edge i svenske insiderkøb efter FI-publicering, hverken in-sample eller i holdout.
- Test 2: kun beskrivende (N < 150).

## 5. Beskrivende (ingen konklusioner)
Horisonter 1/5/21/63 d mod begge benchmarks, robusthed (signal-tjek [0,5; 2] og uden `ratio_flag`), pr. likviditetsspand og kursdækning 2025–2026.
