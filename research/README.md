# research/ – fase 4: historisk backtest

Python-projekt adskilt fra appen. Det måler på SEC-data fra 2006 og frem, om US-insiderkøb giver et abnormalt afkast efter offentliggørelse og efter omkostninger. Reglerne er de samme som i ledgeren (`docs/prereg.md` v1), så resultaterne kan sammenlignes direkte. Der bruges ingen LLM.

## Kørsel (PowerShell fra repo-roden)

```powershell
.\research\run.ps1 -Step setup     # venv i research/.venv (Python 3.13) + requirements.txt
.\research\run.ps1 -Step test      # låste regler: entry, omkostninger, ISO-uge, CMP, N-formel, ujusterede kurser
.\research\run.ps1 -Step fetch     # SEC-bulk + Yahoo til research/data/ (gitignored; cache, kan genoptages)
.\research\run.ps1 -Step build     # transaktioner → population → enheder (ticker, entry-dag) + features
.\research\run.ps1 -Step analyze   # in-sample (entry før 1.1.2025) → reports/backtest-v1.md
.\research\run.ps1 -Step holdout   # 2025–2026; kører kun, når reports/holdout-plan.md er committet og uændret
```

`SEC_USER_AGENT` læses fra `.env.local` (samme nøgle som appen). SEC-trafikken holdes på højst 8 forespørgsler pr. sekund.

## Regler, der spejler appen

| Regel | Kilde i appen | Her |
|---|---|---|
| Entry = første åbning (09:30 NY) mindst 10 minutter efter ankeret; uden accepttid åbningen dagen efter filing-datoen | `src/lib/outcomes.ts` | `common.entry_index` |
| Omkostninger, frosset (version 3, sha256 `fad087e9…`) | `src/lib/costs.ts`, `config/costs.json` | `common.load_costs`, `round_trip_pct` |
| ISO-uge og bootstrap (10.000 gentagelser, seed 20261104) | `src/lib/ledger-stats.ts` | `common.iso_week`, `week_bootstrap` |
| Hard-filter: P/A, mindst $50k, kurs ≥ $2, ADV ≥ $500k, børs, fonde | `sec-scanner.ts`, `market-enricher.ts` | `common.*` |
| 10b5-1, fond eller person, udbud | `sec-scanner.ts`, `offering-check.ts` | `common.*` |

**Kursniveau eller afkast:**
- Yahoo justerer kurser for splits bagud i tid.
- Alle niveau-tal bruger ujusterede kurser, hvor split-events er tilbageregnet: kursfilteret ≥ $2, markedsværdi og sammenligningen med Form 4-kursen.
- Afkast og forholdstal bruger justerede kurser.

## Data (research/data/, gitignored)

| Kilde | Indhold |
|---|---|
| SEC Insider Transactions Data Sets (`form345/*.zip`) | Form 3/4/5-tabeller pr. kvartal fra 2006Q1 |
| EDGAR `submissions.zip` | `acceptanceDateTime` pr. filing og 424B-prospekter pr. udsteder |
| `company_tickers_exchange.json` | CIK → nuværende ticker |
| XBRL frames `dei:EntityCommonStockSharesOutstanding` | aktier i omløb (markedsværdi) |
| Yahoo chart v8 | daglige kurser og split-events for aktier, SPY, IWM og USDDKK=X |

Rapporter ligger i `reports/`.
