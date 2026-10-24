---
description: Test en specifik aktie-ticker for insider-asymmetri eller juster The Council specialist-prompts
---

# /test-ticker: Insider Asymmetri Analyse

Dette workflow bruges til lynhurtigt at teste en aktie-ticker mod InsiderOps multi-agent pipelinen eller teste/tilpasse The Council specialist-prompts.

## Trin for afvikling

1. **Definer Transaktionen**:
   - Angiv Ticker (f.eks. `$NVCR`, `$PLXR`, `$MTLR`) samt insider-detaljer:
     - Rolle: `CFO`, `CEO`, `General Counsel`, `Chairman`
     - Type: `P` (Åbent markedskøb), `M` (Option), `S` (Salg)
     - Beløb i USD og procentuel stigning i insiderens samlede beholdning (`holdingsIncreasePct`)
     - Kursudvikling seneste 30 dage og eventuel cluster-adfærd.

2. **Kørsel gennem InsiderOps Pipeline**:
   - **Trin 1 (Hard Filter)**: Filtrer automatisk støj (kræver kode `P` og >= `$50.000`).
   - **Trin 2 (Gemini Gatekeeper)**: Beregn præ-score (0-100) og identifikation af PR-stunts vs. reel asymmetri.
   - **Trin 3 (Claude The Council)**: Afvikl parallelt:
     - *The Insider Profiler* (Skin-in-the-game & incitamenter)
     - *The Catalyst Hunter* (Tidsmæssig asymmetri & kurstrigger)
     - *The Forensic Skeptic* (Djævelens advokat & value trap kontrol)
     - *The Judge (CIO)* (Endelig dom, Asymmetry Score 1-100 og syntese).

3. **Prompt-finjustering**:
   - Hvis en af specialist-agenterne skal justeres (f.eks. skarpere skepsis mod biotekselskaber eller højere vægtning af General Counsel), kan prompts opdateres direkte i `src/lib/claude-council.ts`.
