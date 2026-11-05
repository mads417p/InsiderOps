# Præregistrering – InsiderOps signal-ledger

**Version:** v1 · **Dato:** 5.11.2026 · **Status:** LÅST 5.11.2026

Reglerne nedenfor fastlægges, før der findes et eneste udfald i ledgeren. Første signal blev logget 4.11.2026 kl. 21:59 UTC, og første mulige udfald er 5.11.2026 efter US-lukning. Da udkastet blev færdigt (5.11.2026 kl. 09:42 UTC), indeholdt ledgeren 36 signaler og 0 udfald. En ændring efter data er set kræver en ny version (v2) med ny dato i en ny commit, og resultatet efter v1 rapporteres stadig ved siden af.

Koden, der udfører reglerne: `src/lib/ledger-stats.ts` (konstanten `PREREG`), `src/lib/outcomes.ts`, `src/lib/costs.ts` og `config/costs.json`. Fanen "📏 Måling" viser tallene. Tests låser værdierne i `PREREG` (150 enheder, 99 %/95 %, SPY/IWM, fristen) og omkostningsfilens version og sha256 til tallene i denne fil.

## 1. Formål

At måle, om de insiderkøb, systemet finder, giver et afkast efter offentliggørelse og efter omkostninger for en dansk detailinvestor, så beslutningen om rigtige penge træffes på data og ikke på enkeltsager. Porten gælder systemet, ikke den enkelte aktie (roadmap afsnit 6).

## 2. Data

- **Ledger:** `data/insiderops.db` (SQLite) med tabellerne `signals`, `evaluations` og `outcomes`. Append-only håndhæves af triggers i databasen: historiske felter kan ikke ændres, gatekeeper-scoren kan kun sættes én gang, og udfald og domme kan hverken ændres eller slettes.
- **Hvad logges:** hver handel, der består hard-filteret (kode P, ≥ $50k, handelbar på Nordnet/Saxo), også dem med lav score, dem der aldrig sendes til rådet, og dem der aldrig handles.
- **Signal-id:** SEC = accession-nummer + reporting owner CIK; nordisk = meddelelses-id + person. Gentagne scans opretter aldrig en ny række; de opdaterer kun `lastSeenAt`.
- **detectedAt:** første gang signalet blev set. **scoredAt:** første gang en model (Claude) scorede det. En heuristisk reservescore låser ikke feltet.

## 3. Hypoteser

- **H1 (primær) – basisstrategien:** Insiderkøb i populationen (afsnit 4: består hard-filteret, har en Claude-score, er friske og ikke 10b5-1) har et positivt gennemsnitligt 5-dages abnormalt afkast i DKK efter estimerede omkostninger. H1 har **ingen score-tærskel**. Den tester, om insiderkøbene i sig selv giver en netto-edge, ikke om scoren gør.
- **H2 (sekundær) – scorens egen værdi:** Enheder med Claude-score ≥ 50 klarer sig bedre end populationen som helhed, og scoren rangerer (øverste tredjedel over nederste). Tærsklen er et reelt filter: i første scan (4.11.2026) havde **13 af 36 signaler score ≥ 50 (12 af de 32 i populationen; 5 af 26 tickers)**. Derfor testes scoren separat og kun sekundært.
- **H3 (sekundær):** Effekten er størst på kort sigt (1 og 5 handelsdage) og aftager ved 21 og 63 handelsdage (roadmap afsnit 1).
- **H4 (eksplorativ):** Rådets `asymmetryScore` hænger sammen med afkast blandt de signaler, rådet har vurderet. Kun beskrivende: N er lille, og udvælgelsen (top 3 pr. scan) er ikke tilfældig.

## 4. Population og analyseenhed

Et signal indgår, når alle betingelser er opfyldt:

1. `scoreSource = claude` (Gemini- og heuristiske scorer udelukkes; absolutte scorer kan ikke sammenlignes på tværs af modeller).
2. **Frisk:** 0 ≤ `detectedAt` − `filedAtUtc` ≤ 72 timer. Signaler uden kendt offentliggørelsestid udelukkes. Det udelukker bl.a. ticker-scans af ældre handler.
3. Ikke markeret som 10b5-1 (`is10b51 = 1` udelukkes; ukendt tæller med).
4. Markedet findes i `config/costs.json` (ellers kan nettoafkastet ikke beregnes).

**Analyseenhed:** (ticker, entry-dag). Flere signaler i samme aktie med samme entry-dag (fx en cluster) har samme kursforløb og tælles som én enhed med den højeste score blandt dem.

## 5. Udfald

- **Anker** = max(`detectedAt`, `scoredAt`).
- **Entry** = åbningskursen ved den **første ordinære åbning, hvis tidspunkt i børsens tidszone ligger mindst 10 minutter efter ankeret**. Ordinære åbninger: USA 09:30 (America/New_York); København, Stockholm og Oslo 09:00 lokal tid; Helsinki 10:00 lokal tid. Eksempler: anker 09:42 UTC → samme dags US-åbning (14:30 UTC); anker 14:25 UTC → næste handelsdag; nordisk anker 07:40 UTC → samme dags åbning i København (08:00 UTC). Begrundelse: et signal set før åbning kunne være købt ved samme dags åbning, og en regel om "næste kalenderdag" ville smide dag 1 væk, hvor den største reaktion ligger (roadmap afsnit 1). De 10 minutter er tid til at nå at lægge ordren.
- **Exit** = lukkekursen på handelsdag *h*, hvor entry-dagen er dag 1; *h* ∈ {1, 5, 21, 63}. Handelsdage er de dage, der findes kurser for; weekender og helligdage springes dermed over.
- **Kurser:** Yahoo chart v8, `interval=1d`, split-justeret, uden udbytte (prisafkast).
- **Benchmarks:** **SPY er primær**, **IWM (Russell 2000) er sekundær**. Begge måles i aktiens kalendervindue (åbning første handelsdag ≥ entry, lukning sidste handelsdag ≤ exit). Handlede benchmarken ikke i vinduet, er dens afkast 0. Mangler IWM-kurser, beregnes udfaldet stadig mod SPY, og IWM-felterne står tomme.
- **Valuta:** valutakursens lukning på eller før entry- og exit-datoen (højst 7 dage gammel) for aktie og benchmarks.
- **Abnormalt afkast** = aktiens afkast i DKK − benchmarkens afkast i DKK.
- **Manglende kurs giver intet udfald** (aldrig 0). Antallet af signaler, der mangler udfald efter nået horisont, vises og rapporteres sammen med resultatet (survivorship).
- Et udfald beregnes én gang og overskrives aldrig.

## 6. Omkostninger (frosset)

Round-trip i procent af handelsbeløbet:

> 2 × max(min-gebyr ÷ handelsstørrelse, kurtage-%) + 2 × FX-spread for handelsvalutaen + spread/slippage efter likviditetsspand (ukendt likviditet = dyreste spand)

**Satser:** Nordnet prisklasse Standard (US 0,15 %, Norden 0,10 %, minimum 25 kr.), typisk handelsstørrelse 10.000 kr. Ved 10.000 kr. styrer minimumsgebyret: 25 kr. = 0,25 % pr. handel. Spread/slippage er konservative skøn, ikke Nordnet-satser.

**FX-spread pr. handel, valutaspecifik:** USD 0 % (US-aktier handles fra en USD-valutakonto; selve vekslingen DKK→USD til kontoen koster 0,15 % én gang og indgår ikke i round-trip), SEK, EUR og NOK 0,25 % (automatisk veksling), DKK 0 %.

| US-aktie, gns. daglig omsætning | Round-trip |
|---|---|
| ≥ $50 mio. | 0,6 % |
| $5–50 mio. | 0,8 % |
| $1–5 mio. | 1,1 % |
| under $1 mio. eller ukendt | 1,7 % |

En svensk, finsk eller norsk aktie koster 0,5 procentpoint mere (2 × 0,25 % veksling); en dansk aktie det samme som en US-aktie i samme likviditetsspand.

**Frysning:** `config/costs.json` **version 3**, **sha256 `fad087e981ecdcf8c9e6dcea4d9037a2362abbc1e2d9c9683d45f380433cc7f0`** (beregnet på filens indhold med LF-linjeskift). Ændres filen, viser fanen en advarsel, og testen fejler. Ændrede omkostninger, også faktiske satser, kræver en ny prereg-version.

**Nettoafkast** = abnormalt afkast i DKK − round-trip-omkostning.

## 7. Primær metrik

Gennemsnitligt **5-dages netto abnormalt afkast i DKK mod SPY** over **alle enheder i populationen**.

## 8. Sekundære metrikker

1. Den primære metrik mod IWM.
2. **Bruttoafkast:** gennemsnitligt abnormalt afkast i DKK mod SPY før omkostninger, for hele populationen og hver horisont. Viser, hvor meget af en eventuel effekt omkostningerne tager.
3. Den primære metrik for enheder med score ≥ 50 (H2).
4. Den primære metrik for 1, 21 og 63 handelsdage (H3).
5. **Sanity-tjek (punktestimat):** blandt enhederne med fuldt 21-dages udfald har den øverste tredjedel efter score et højere gennemsnitligt 5-dages nettoafkast end den nederste tredjedel. Tjekket fanger en score, der peger den forkerte vej; det beviser ikke, at scoren virker (det er H2's opgave), og det indgår ikke i go-live-reglen.
6. Kalibrering pr. 10-point-spand: gennemsnit, 95 %-interval og hit rate (andel med netto > 0), mod SPY og IWM.
7. Signaler pr. uge og antal uden udfald.

## 9. Statistisk metode

- **Usikkerhed:** bootstrap klynget på ISO-ugen for entry-dagen (hele uger trækkes med tilbagelægning, fordi signaler i samme uge deler marked), 10.000 gentagelser, fast seed 20261104. Fanen bruger 2.000 gentagelser pr. score-spand.
- **Ensidet nedre grænse:** 1 %-percentilen (99 %) eller 5 %-percentilen (95 %) af bootstrap-gennemsnittene, jf. afsnit 10.
- Under 30 enheder i et spand vises tallet som "for få" og bruges ikke til konklusioner.

## 10. Go-live-regel

Porten er opfyldt, når begge betingelser holder ved samme vurdering:

1. Mindst **150 enheder** i populationen med fuldt 21-dages udfald.
2. På netop de enheder er den **nedre grænse af det ensidede interval for den primære metrik > 0**:
   - **månedlige vurderinger før 4.5.2027** (6 måneder efter første signal): ensidet **99 %**,
   - **den endelige vurdering fra 4.5.2027**: ensidet **95 %**.

**Ved go-live handles basisstrategien – alle signaler i populationen eller et udvalg, der ikke afhænger af scoren (fx de første N pr. uge). Scoren må først bruges til at udvælge handler, når H2 er dokumenteret i en senere prereg-version.**

**Hvorfor 150 og ikke 60:** Med en antaget spredning på 7 % på 5-dages abnormalt afkast er standardfejlen 7 % ÷ √N. En ensidet 95 %-grænse over 0 kræver et gennemsnit over ca. 1,645 × 7 % ÷ √60 ≈ **1,5 %** ved 60 enheder, men kun ca. 1,645 × 7 % ÷ √150 ≈ **0,9 %** ved 150. Med 99 % (interim) er kravet ca. 2,1 % ved 60 og ca. 1,3 % ved 150. Uge-klyngningen gør kravet højere, fordi signaler i samme uge ikke er uafhængige. Når fase 4 har målt den faktiske spredning på historiske data, tilføjes den som en dateret note under "Vurderinger" uden at ændre reglen.

**Krævet brutto-effekt med de frosne omkostninger:** I det typiske likviditetsspand ($5–50 mio./dag, round-trip 0,8 %) kræver slutvurderingen ca. 0,94 % netto + 0,8 % omkostning ≈ **1,7 % brutto** 5-dages abnormalt afkast. Ved interim-vurderingerne (99 %) er det ca. 1,33 % + 0,8 % ≈ 2,1 %. Det ligger over de ca. 1 % efter 5 dage, som litteraturen finder for C-suite-køb før omkostninger (roadmap afsnit 1). Porten er altså bevidst streng: den åbner kun, hvis de insiderkøb, systemet finder og filtrerer, klarer sig markant bedre end gennemsnittet i litteraturen.

**Gentagne kig:** Porten vurderes første gang, når betingelse 1 er nået, og derefter **højst én gang pr. kalendermåned**. Den strengere 99 %-grænse før 4.5.2027 modvirker, at gentagne kig giver et tilfældigt "ja". Hver vurdering noteres med dato, N, netto- og bruttogennemsnit, nedre grænse og sanity-tjek under "Vurderinger" nederst i denne fil. Det er en tilføjelse, ikke en ændring af reglerne.

**Ved fristen:** Er porten ikke opfyldt ved den endelige vurdering 4.5.2027 (også hvis der er færre end 150 enheder), er konklusionen, at systemet ikke har dokumenteret en netto-edge i sin nuværende form (roadmap afsnit 1, "Ærlig forventning").

## 11. Hvad der ikke ændres, efter data er set

Populationsfiltrene, analyseenheden, entry-reglen (første ordinære åbning ≥ anker + 10 min), den primære metrik (5 dage, netto, SPY, ingen score-tærskel), score-tærsklen for H2 (50), omkostningsfilen (version og sha256), den statistiske metode og go-live-reglen (150 enheder, 99 %/95 %, frist 4.5.2027, basisstrategien handles).

Skiftes gatekeeper-model eller -prompt, behandles signaler efter skiftet som en ny serie, fordi scorerne ikke er sammenlignelige. Skiftet identificeres ved dato og `gatekeeperModel` i ledgeren og noteres under "Vurderinger". H1 og go-live-porten påvirkes kun via populationsfilteret (Claude-score findes); H2 og sanity-tjekket påvirkes direkte.

## 12. Kendte begrænsninger

- Gratis kursdata mangler typisk afnoterede aktier; antallet uden udfald rapporteres.
- Prisafkast uden udbytte (påvirker 5-dages tal minimalt, 63-dages tal en smule).
- Scanning er manuel indtil fase 6. Forsinkelsen mellem offentliggørelse og detektion begrænses af 72-timers-filteret, men ikke helt.
- Joint Form 4 med flere reporting owners logger kun den første ejer.
- De første 36 signaler (4.11.2026) har `scoredAt` = `detectedAt`, selv om scoren forelå ca. 30 sekunder senere. Det ændrer ikke entry-dagen, fordi det skete efter US-lukning.
- Entry ved åbningskursen forudsætter en ordre til åbningsauktionen; daglige data har ingen intradag-kurser, så et signal set midt i handelsdagen venter til næste åbning.
- Ordinære åbningstider er faste pr. børs; forskudte åbninger og handelsstop er ikke modelleret.
- Rådets domme har intet eget anker; H4 er derfor kun beskrivende.
- Med 150 enheder som krav og en ukendt rate af nye signaler kan fristen nås, før N er stor nok. Så er resultatet "ikke dokumenteret", ikke "ingen edge".

## Vurderinger

_(Ingen endnu.)_
