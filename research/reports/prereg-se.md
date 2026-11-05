# Præregistrering – fase 4-SE: svenske insiderkøb (slank version)

**Skrevet:** 5.11.2026, før noget afkast er beregnet for svenske data.
**Status:** låst, når filen committes. `research/src/se.py build` (det eneste sted, hvor afkast beregnes) afviser at køre, hvis filen ikke er committet og uændret. En ændring efter data er set kræver en ny version med ny dato i en ny commit, og resultatet efter denne version rapporteres stadig.

Hvad der er set før commit: antal rækker, signaler og enheder pr. filtertrin, kursdækning, ADV og kursforholdet mellem meddelelse og Yahoo på handelsdagen (afsnit 12). Ingen kurser efter entry og intet afkast.

## 1. Formål og hypotese
Fase 4 (US 2006–2024 + holdout 2025–26) gav en brutto-effekt, men intet nettoafkast efter omkostninger. Hypotesen her er, at insiderkøb i et mindre og mindre effektivt marked (Sverige, især small/mid cap og clusters af købere) giver et nettoafkast efter offentliggørelse for en dansk detailinvestor. Den eneste forudgående nordiske evidens for clusters er Ek & Erlinder (2015, Lund-speciale, Stockholm 2005–14): clusters af køb gav positivt merafkast over 10 dage i mid og small cap, målt på midtkurser uden kurtage.

## 2. Data
- **Insiderhandler:** Finansinspektionens insynsregister, CSV-eksport (`marknadssok.fi.se/Publiceringsklient/sv-SE/Search/Search?SearchFunctionType=Insyn&…&button=export`), hentet ugevis efter publiceringsdato fra **4.7.2016** (MAR) til hentedagen. Intet før 4.7.2016.
- **Kurser, udbytte, FX og benchmarks:** Yahoo chart v8 (`interval=1d`, `events=div|split`) fra 1.1.2016. Ingen betalt kursdata.
- **Survivorship:** afnoterede selskaber mangler i Yahoo. Andelen af kandidatsignaler uden kursdata rapporteres pr. år og rettes ikke.
- **Hentet:** 5.11.2026 (FI 168.406 rækker, 4.7.2016–5.11.2026; Yahoo-søgning for 1.128 ISIN og 587 kursserier). Bars fra hentedagen og senere bruges ikke (ufærdig dagsbar).
- Der bruges ingen LLM til at vurdere eller score historiske hændelser.

## 3. Population
1. **Rækker:** original meddelelse (Korrigering ≠ "Ja" og Status ≠ "Makulerad"), Karaktär = "Förvärv", aktie og Handelsplats ≠ "Utanför handelsplats".
   - **Aktie:** Instrumenttyp = "Aktie". Er Instrumenttyp tom (typisk 2016–18), tæller rækken som aktie, medmindre instrumentnavnet matcher `se.NON_SHARE_RE` (option, teckningsrätt, BTA/BTU, warrant, konvertibel, obligation, TO, interim, certifikat, termin, CFD, swap). ISIN'er med præfikset EZ (ANNA DSB-ISIN for OTC-derivater) er ikke aktier.
   - Alle handelspladser medtages: Nasdaq Stockholm, First North, Spotlight, NGM og MTF'er. ADV-filteret tager likviditeten.
   - En korrigeret meddelelse indgår med de oprindelige tal og det oprindelige tidspunkt (det, markedet så). Makulerede meddelelser udelukkes. Det er et lille kendt lookahead (afsnit 11).
2. **Signal** = (ISIN, PDMR, publiceringstidspunkt). PDMR-navnet normaliseres (små bogstaver, ét mellemrum). En nærtstående persons eller et selskabs køb står under PDMR'ens navn og tæller som PDMR'en.
   - **Værdi** = Σ volumen × kurs over signalets rækker (Volymsenhet "Belopp": volumen er beløbet), omregnet til SEK og USD med **dagskursen på transaktionsdagen** (Yahoo `{valuta}SEK=X` og `USDSEK=X`, close på eller før dagen, højst 7 dage gammel). Mangler en kurs, har signalet ingen værdi og udgår.
   - **VWAP (SEK)** = Σ værdi i SEK ÷ Σ antal aktier fra meddelelsen.
3. **Filtre** (i denne rækkefølge, første fejlende filter er status):
   1. værdi ≥ **$50.000** (kandidatsignal),
   2. VWAP ≥ **10 SEK** (meddelelsens egen kurs, aldrig Yahoos),
   3. ISIN → symbol (afsnit 3.4); status "intet symbol",
   4. Yahoo-serien er noteret i SEK; ellers "ikke SEK-noteret",
   5. kursdata på handelsdagen og en entry-bar; ellers "ingen kursdata" eller "entry ikke nået",
   6. **Signal-tjek (primær regel):** signalets VWAP ÷ Yahoo ujusteret close på handelsdagen ∈ **[0,5; 10]**; ellers "kurs-mismatch".
      - Tjekket fanger tastefejl (pris = totalbeløb, öre/kronor, 100× og mere) og programkøb til strike under markedskursen, der er registreret som markedskøb.
      - Den øvre grænse på 10 beholder rigtige køb fra før kraftige nyemissioner, hvor afvigelsen kun skyldes, at Yahoo har justeret ældre kurser ned uden split-event. At udelukke dem ville fjerne netop de selskaber, der senere udvandede, og trække resultatet opad.
      - [0,5; 2] køres som robusthed (afsnit 9).
      - Yahoos kurs bruges kun til at genkende papiret, aldrig som niveau.
   7. **ADV(20) ≥ $500.000.** Beregnes over de 20 handelsdage før entry-dagen med close > 0 og volumen > 0 som **minimum af**:
      - (a) signalets VWAP × gennemsnitlig ujusteret volumen (Yahoo-volumen ÷ split-faktor),
      - (b) gennemsnittet af Yahoo close × Yahoo volumen.
      Omregnes med USDSEK på sidste handelsdag før entry (`se.raw_adv_usd`). For aktier uden emissionsjustering er (a) og (b) ens. Det er ukendt, om Yahoo også justerer volumen ved emissioner, så den laveste værdi bruges.
4. **ISIN → Yahoo-symbol** (`se.control_table`, `se.symbol_map`). Kursforhold = median over ISIN'ets kandidatsignaler af (VWAP ÷ Yahoo ujusteret close på handelsdagen). GUARD = [0,75; 1,33].
   - ISIN'et skal have gyldigt kontrolciffer (`se.valid_isin`, port af appens `isValidIsin`).
   - **ISIN-søgning** (`se.search_isin`, port af appens `mapIsinToYahooTicker`: Yahoo search, `quoteType = EQUITY`, begrænset til `.ST`): det første hit bruges. Ligger kursforholdet uden for GUARD, flages ISIN'et "kursafvigelse" og kræver en manuel beslutning.
   - **Navnesøgning**, når ISIN-søgningen ikke giver et `.ST`-hit (typisk et ISIN, der skiftede ved et split, fx Investor, Handelsbanken, Wallenstam): Yahoo search på det hyppigste emittentnavn uden selskabsform. Kun `.ST`-aktier med kursforhold inden for GUARD kommer i betragtning. Er der flere, vælges den, hvis aktieklasse (A–D) svarer til instrumentnavnet. Er der stadig flere, flages "flere kandidater efter navn" (manuel). Er der ingen, har ISIN'et intet symbol (dækning, ikke tvetydighed).
   - Manuelle beslutninger står i `research/reports/isin-map-se.csv` (symbol eller "afvis" med begrundelse). De er truffet alene ud fra navn og kursniveau og committes sammen med denne fil. Filen viser også alle navnematch til gennemsyn.

## 4. Analyseenhed, anker og entry
- **Enhed** = (symbol, entry-dag). Flere signaler samme dag i samme symbol er én enhed. Enhedens VWAP er værdivægtet over signalerne, og ADV, omkostning og small/mid beregnes med den.
- **Anker** = FI's publiceringstidspunkt, tolket som Europe/Stockholm-tid. For en enhed med flere signaler bruges det seneste anker til cluster-vinduet.
- **Entry** = åbningskursen ved den første ordinære åbning (09:00 Europe/Stockholm), der ligger mindst 10 minutter efter ankeret (`common.entry_index` med `tz=Europe/Stockholm`, `open_hm='09:00'`). Handelsdage er de dage, Yahoo har kurser for symbolet.
- **Exit** = lukkekursen på handelsdag *h*, hvor entry-dagen er dag 1; *h* ∈ {1, 5, 21, 63}.

## 5. Udfald
- **Abnormalt afkast i DKK** (`build._outcomes`): aktiens totalafkast i DKK minus benchmarkens afkast i DKK over samme vindue, omregnet med `SEKDKK=X` (close på eller før dagen, højst 7 dage gammel).
- **Aktiens totalafkast** = (close_exit + Σ udbytte med ex-dato i (entry-dag, exit-dag]) ÷ open_entry − 1. Udbytte på entry-dagen tæller ikke. Udbyttet er Yahoos dividend-events i Yahoos egen basis, som er justeret ligesom kurserne. Det er målt 5.11.2026: INVE-B (split 4:1) og ALMB.CO (emission uden split-event: 5,00 kr. vist som 1,2252 med samme faktor som kursen). Derfor bliver den direkte rente rigtig.
- **Primær benchmark:** `^OMXSBGI` (OMX Stockholm Benchmark Gross Index; brutto, inkl. udbytte). **Sekundær:** `XACT-SMABOLAG.ST` (akkumulerende small cap-ETF uden udlodninger). Benchmarkafkast = close på sidste bar ≤ exit ÷ open på første bar ≥ entry − 1.
- **Brutto** = AR. **Netto** = AR − round-trip-omkostning (afsnit 6).
- Mangler aktiens open eller close, benchmarkens open eller close, eller FX, får enheden intet udfald for den horisont (aldrig 0).
- **Primær metrik:** netto 5 d mod `^OMXSBGI`.

## 6. Omkostninger (frosset)
`config/costs-v4.json`, version 4, sha256 `067e6ec4e2d3a4b95b7ac8847a4fb4c9554de4819bc1c82447b56ed198b7199b` (efter normalisering af CRLF til LF, `common.load_costs`).
- v4 = v3 + SEK handlet fra en SEK-valutakonto: 0 % FX pr. handel. Vekslingen DKK→SEK koster 0,15 % én gang og ligger uden for round-trip.
- Round-trip = 2 × max(25 kr. ÷ 10.000 kr.; 0,10 %) + spread/slippage efter ADV: **1,7 % / 1,1 % / 0,8 % / 0,6 %** for ADV < $1 mio. / $1–5 mio. / $5–50 mio. / ≥ $50 mio.
- `config/costs.json` (v3) er uændret og gælder fortsat for appen, ledgerens prereg v1 og fase 4.

## 7. Small/mid cap og cluster (punkt-i-tid)
- **Small/mid cap** = enhedens ADV(20) < **$5 mio.** ved entry (samme ADV som i afsnit 3.3). Grænsen er skellet mellem costs-spandene og flaget "ADV < $5 mio." fra fase 4. Der bruges ingen markedsværdi-model, og proxyen er ikke kalibreret mod Nasdaq Stockholms Large/Mid/Small Cap-segmenter.
- **Cluster** = mindst **2 forskellige PDMR'er** (normaliseret navn) med kandidatsignaler (værdi ≥ $50k, uanset kurs- og ADV-filter) i samme emittent, publiceret inden for [anker − 10 kalenderdage; anker]. Emittent = normaliseret emittentnavn (små bogstaver, uden "(publ)", AB, ASA, Oyj, plc, Ltd, Inc, SE, SA, NV og tegnsætning), så A- og B-aktier tæller sammen. Det spejler `personal_buyers_10d` i fase 4.

## 8. Bekræftende tests
To tests med Bonferroni. Hver bestås, hvis den **ensidede 97,5 %-nedre grænse er > 0**: gennemsnit − 1,96 × uge-klynget SE, hvor SE er klynget på ISO-ugen for entry-dagen (`holdout.confirm`: statsmodels OLS på konstant med `cov_type='cluster'`). Har en test færre end **150 enheder** med 5-dages udfald, er den kun beskrivende og ikke bekræftende.

- **Test 1 – basisstrategien:** alle enheder. Netto 5 d mod `^OMXSBGI`.
- **Test 2 – clusters i small/mid cap:** enheder med cluster = sand og small/mid = sand. Netto 5 d mod `^OMXSBGI`.

**Kørsler:**
1. **In-sample** (bekræftende): entry 4.7.2016–31.12.2024.
2. **Holdout** (replikation): entry fra 1.1.2025 til seneste mulige entry. Samme to tests og samme kriterier. `research/reports/holdout-plan-se.md` committes (med sha256 af `units.parquet`), før holdout køres; `se_analyze.py holdout` afviser at køre uden.

**Fortolkning:** En test, der består både in-sample og i holdout, er en dokumenteret netto-edge for den strategi i Sverige. Den ændrer ikke ledgerens prereg v1 og giver ikke grønt lys for rigtige penge. Det kræver en ny prereg-version for ledgeren. Består en test kun in-sample, er den ikke replikeret. Består ingen, er der ingen dokumenteret netto-edge.

## 9. Beskrivende tal (ingen konklusioner)
- Filter-tragt og kursdækning pr. år.
- Brutto og netto for 1/5/21/63 handelsdage mod begge benchmarks, for Test 1 og Test 2.
- Netto 5 d pr. rolle (højeste i enheden: VD, CFO, ordförande, styrelseledamot, anden ledelse, ukendt; fra Befattning), pr. år og pr. likviditetsspand.
- Påkrævet N for at påvise 0,5/1,0/1,5 % med den målte SD (`common.n_required`).
- **Robusthed (kun beskrivende):**
  1. **Strengt signal-tjek [0,5; 2]:** Test 1 og Test 2 på enheder, der har mindst ét signal med kursforhold i [0,5; 2] (`strict_ok`). Det er en tilnærmelse: ADV og omkostning beregnes stadig med alle enhedens signaler.
  2. Test 1 uden enheder fra ISIN'er, der er godkendt trods "kursafvigelse" (`ratio_flag`). Her er Yahoos serie emissionsjusteret, så ADV er mere usikker.

Spand med under 30 enheder vises som "for få". Der er ingen modeller, ingen walk-forward, ingen rutine/opportunistisk-klassifikation, intet udbudstjek og ingen markedsværdi-model.

## 10. Hvad der ikke ændres, efter afkast er set
Filtre, enhed, anker, entry, udfald, benchmarks, omkostninger, small/mid- og cluster-definitionen, testene, kriterierne og ISIN-beslutningerne i `isin-map-se.csv`. Fejl i kode, der opdages bagefter, rettes i en ny commit, og både det oprindelige og det rettede resultat rapporteres.

## 11. Kendte begrænsninger
- **Survivorship:** afnoterede selskaber mangler i Yahoo (afsnit 12).
- **Yahoo-volumen ved emissioner** er ukendt justeret. ADV er derfor minimum af to beregninger (afsnit 3.3.7), som er konservativ, og robustheden kører uden flaggede ISIN'er (afsnit 9).
- **FI's tidsstempel** antages at være Stockholm-tid (tjekket, afsnit 12). Udstederens egen pressemeddelelse kan komme før FI-publiceringen (afsnit 12). Ankeret er FI-tidspunktet uanset.
- FI-data indtastes af de indberetningspligtige uden kontrol. Fejl i antal eller kurs kan give forkerte værdier og VWAP.
- Makulerede meddelelser er udelukket med viden fra senere (lille lookahead).
- **Signal-tjekkets øvre grænse (10)** er et kompromis.
  - Emissionsjusteringer over 10× falder stadig ud. Før commit var der 29 kandidatsignaler med forhold 10–100, en blanding af kraftigt udvandede selskaber og tastefejl.
  - Tastefejl under 10× (fx en forkert kurs, der ligger 3× fra) slipper igennem. Det påvirker værdi-, kurs- og ADV-filtrene, men ikke afkastet, som kommer fra Yahoo.
  - Det strenge tjek [0,5; 2] vises som robusthed.
- Emittent-nøglen er navnebaseret, fordi LEI mangler i 2016–17.
- Benchmark-open mangler på ca. 1,5 % af dagene for `^OMXSBGI`; de enheder har intet udfald. `XACT-SMABOLAG.ST` har stale åbningskurser på ca. 23 % af dagene og er kun sekundær.
- Ordinære åbningstider er faste; forskudte åbninger og handelsstop er ikke modelleret.

## 12. Set før commit (ingen afkast)
Kørt med `se.py map` 5.11.2026. Ingen kurser efter entry er læst.

**Filter-tragt pr. publiceringsår** (enheder pr. entry-år):

| Trin | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| FI-rækker | 5.304 | 12.401 | 13.809 | 14.102 | 16.913 | 19.674 | 19.504 | 19.172 | 17.962 | 16.447 | 13.118 |
| + aktie-Förvärv på handelsplads (original) | 1.592 | 4.083 | 5.061 | 4.897 | 5.955 | 7.400 | 8.639 | 8.656 | 6.893 | 6.919 | 5.833 |
| signaler ≥ $50k | 304 | 841 | 915 | 704 | 829 | 1.213 | 1.227 | 924 | 989 | 1.151 | 1.110 |
| + kurs ≥ 10 SEK | 267 | 741 | 816 | 634 | 732 | 1.078 | 1.108 | 804 | 838 | 1.023 | 981 |
| + symbol | 164 | 502 | 607 | 493 | 519 | 767 | 866 | 627 | 718 | 931 | 900 |
| + SEK-serie, kursdata, entry og signal-tjek [0,5; 10] | 148 | 478 | 589 | 482 | 510 | 761 | 854 | 623 | 704 | 923 | 888 |
| + ADV ≥ $500k (minimum af to) | 110 | 369 | 403 | 305 | 400 | 594 | 656 | 439 | 500 | 678 | 667 |
| enheder | 86 | 272 | 311 | 235 | 331 | 469 | 544 | 355 | 414 | 571 | 559 |
| heraf small/mid | 65 | 139 | 141 | 133 | 170 | 223 | 261 | 173 | 222 | 303 | 327 |
| heraf Test 2 (cluster ∧ small/mid) | 7 | 25 | 32 | 20 | 33 | 40 | 59 | 26 | 39 | 60 | 60 |

**Forventet N** (enheder; et udfald kan mangle for enkelte):

| | Test 1 | Test 2 | Robusthed [0,5; 2]: Test 1 / Test 2 |
|---|---|---|---|
| In-sample (entry 21.7.2016–31.12.2024) | **3.017** | **281** | 2.968 / 279 |
| Holdout (entry 1.1.2025–4.11.2026) | **1.130** | **120 – under 150, altså kun beskrivende** | 1.129 / 120 |

In-sample har 7,2 enheder pr. uge (419 uger). Small/mid er 50,6 % og clusters 23,7 % af enhederne. Likviditet in-sample: $0–1 mio. 409, $1–5 mio. 1.118, $5–50 mio. 1.134, ≥ $50 mio. 356.

**Kursdækning (survivorship)**, kandidatsignaler med kurs ≥ 10 SEK uden symbol eller kursserie:

| | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Kandidater | 267 | 741 | 816 | 634 | 732 | 1.078 | 1.108 | 804 | 838 | 1.023 | 981 |
| Uden kurser | 103 | 243 | 215 | 142 | 218 | 314 | 248 | 178 | 121 | 92 | 82 |
| Andel | 38,6 % | 32,8 % | 26,3 % | 22,4 % | 29,8 % | 29,1 % | 22,4 % | 22,1 % | 14,4 % | 9,0 % | 8,4 % |

I alt 1.956 af 9.022 (21,7 %).

**Status for kandidatsignaler (≥ $50k):** ok 5.121, intet symbol 1.928, ADV < $500k 1.839, kurs < 10 SEK 1.185, kurs-mismatch 99 (forhold < 0,5: 15; 10–100: 29; > 100: 55), ingen kursdata 28, entry ikke nået 7. 78 signaler med forhold 2–10 er med under den primære regel og falder kun ud i robustheden.

**ISIN-kontroltabel:** `research/reports/isin-map-se.csv` (sha256 `443df58e013d1826f7932654f525d6a5f26356b215683eed769bb8e9270b9d6d` efter normalisering af CRLF til LF) har 149 rækker:
- 42 flaggede, alle med beslutning: 38 godkendt, 4 afvist (Verisure i EUR; Hifab, Scandinavian Chemotech og Ericsson-ADR). Sweco-EZ-ISIN'et er ude af populationen via EZ-reglen.
- 107 navnematch til gennemsyn (fx Investor, Handelsbanken, Wallenstam, NCC og Fabege med gamle ISIN'er fra før split).
- 82 enheder in-sample og 4 i holdout kommer fra godkendte "kursafvigelse"-ISIN'er (`ratio_flag`). De udelades i robusthedsanalysen.

**Tjek før commit:**
- **Tidszone:** FI's tidsstempel er Stockholm-tid. Timeprofilen er ens i vinter- og sommertid (frokostdyk kl. 12 i begge), og det seneste stempel (15:19:49) lå før klokken 15:26 Stockholm-tid ved hentning.
- **Udbyttebasis:** Yahoo justerer udbytter som kurserne. INVE-B før split 4:1: 8 kr. vises som 2,0. ALMB.CO efter emission: 5,00 kr. vises som 1,2252, faktor 0,245 som kursen.
- **Pressemeddelelser:** 5 tilfældige kandidatsignaler (seed 20261105: Scandi Standard 2025, Sandvik/L E Lundberg 2023, Collector 2020, Scandic 2020, Evolution 2017). Ingen havde en egen pressemeddelelse fra udstederen; nyhedsdækningen bygger på FI-registret og kommer efter. FI-tidspunktet var altså det første offentlige i alle 5. Ingen regel er ændret på baggrund af det.
- **Påviselig effekt** (80 % styrke, ensidet 97,5 %, SD 7,66 % fra fase 4, ρ 0,154): Test 1 in-sample ca. 0,55 % netto (deff ≈ 1,96), Test 2 in-sample ca. 1,3 %, Test 1 holdout ca. 1,0 % (deff ≈ 2,7).
- **Godkendt af Mads 5.11.2026:** navnesøgning og kontroltabel som de står, signal-tjek [0,5; 10] som primær regel med [0,5; 2] som robusthed, og ADV som minimum af to beregninger.
