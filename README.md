# 🦅 InsiderOps // Information Asymmetry & Executive Order Terminal

[![Next.js 16](https://img.shields.io/badge/Next.js-16.4.3-black?style=flat&logo=next.js)](https://nextjs.org/)
[![Turbopack](https://img.shields.io/badge/Turbopack-Ready-blueviolet?style=flat)](https://turbo.build/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat&logo=typescript)](https://www.typescriptlang.org/)
[![Gemini 3 Flash](https://img.shields.io/badge/Gemini-3_Flash_Pre--Filter-4285F4?style=flat&logo=google)](https://ai.google.dev/)
[![Claude 5.5 Council](https://img.shields.io/badge/Claude-Sonnet_5.5_+_Opus_CIO-D97706?style=flat&logo=anthropic)](https://www.anthropic.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)

**InsiderOps** er en institutionel intelligence- og eksekveringsterminal designet til at detektere, dissekere og udnytte legal **informationsasymmetri** fra børsnoterede selskabers indberetninger af insiderhandler (**US SEC Form 4** og **Nordic MAR Art. 19**).

Systemet filtrerer automatisk markedsstøj (optioner, gaver, skatteafregninger, automatiske Rule 10b5-1 planer) fra og isolerer de sjældne **ægte åbne markedskøb (Kode P)** foretaget med personlige frie midler af C-Suite direktører (CEO, CFO, COO). En tiered flåde af AI-modeller (Google Gemini Flash + Anthropic Claude Sonnet & Opus) udfører dybdegående forensic analyse og fodnote-dekodning, hvorefter en kvantitativ eksekveringsmaskine beregner ATR-volatilitetsbaserede stop-losses, position sizing og live P&L i DKK.

---

## 🏛️ Den 6-Trins Asymmetri-Tragt (Systemarkitektur)

InsiderOps anvender en streng 6-trins tragtarkitektur, der garanterer, at kun de absolut mest overbevisende handler når frem til kapitalallokering:

```mermaid
flowchart TD
    subgraph S1 ["Trin 1: Multi-Market Live Feed"]
        A1["SEC EDGAR Live RSS"]
        A2["SEC EFTS Search API (Kode P)"]
        A3["Nasdaq Europe API (MAR Art. 19 DK/SE)"]
    end

    subgraph S2 ["Trin 2: 0-Token Gatekeepers"]
        B1["Hard Filter (Kode P, >$50k USD, Ikke-10b5-1)"]
        B2["DK Broker Tradability Gate (PRIIPs/KID, Børs-whitelist, Likviditet)"]
    end

    subgraph S3 ["Trin 3: Pre-Filter Gatekeeper"]
        C1["Google Gemini 3 Flash (Batch Evaluering, Pre-Score 0-100)"]
    end

    subgraph S4 ["Trin 4: Deep Context & Footnote Enricher"]
        D1["SEC Form 4 Footnote XML/HTML Parser"]
        D2["True Cluster Buys Deduplication"]
        D3["3-4 Års Historical Insider Track Record"]
        D4["Yahoo Finance 3-Month High/Low & ATR Volatilitet"]
    end

    subgraph S5 ["Trin 5: The Council of Experts"]
        E1["The Insider Profiler (Claude Sonnet 5.5)"]
        E2["The Catalyst Hunter (Claude Sonnet 5.5)"]
        E3["The Forensic Skeptic (Claude Sonnet 5.5)"]
        E4["CIO Judgment with Adaptive Thinking (Claude Opus 5.5 / Sonnet)"]
    end

    subgraph S6 ["Trin 6: Kvantitativ Eksekvering & Portfolio Tracker"]
        F1["14-Dages ATR Volatilitet Stop-Loss (Hard Invalidation)"]
        F2["Conviction & Volatilitets-Skaleret Position Sizing (Frie Midler)"]
        F3["2-Tranche Limit Eksekvering (60% Market Open / 40% Pullback)"]
        F4["Live Paper-Trading Portfolio Tracker (Realtids P&L i DKK)"]
    end

    S1 --> S2
    S2 -- "Bestået" --> S3
    S2 -- "Afvist (0 tokens)" --> Z1["Støj-affald"]
    S3 -- "Pre-Score >= 60" --> S4
    S4 --> S5
    S5 --> S6
```

---

## 🔍 Dybdegående Gennemgang af Tragten

### 1. Multi-Market Scannere
- **Live SEC EDGAR Atom Feed**: Scanner alle seneste amerikanske Form 4 indberetninger i realtid via `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4`.
- **C-Suite Executive Hunter**: Filtrerer målrettet efter CEO, CFO, COO, President og General Counsel med direkte personligt ejerskab (`OwnershipNature = 'D'`).
- **Nordisk MAR Art. 19 Scanner**: Henter ledelseshandler direkte fra Nasdaq Europe (Nasdaq Copenhagen & Nasdaq Stockholm) og mapper tickere med `.CO` og `.ST` suffikser.

### 2. 0-Token Hard Filter & DK Broker Tradability Gate
For at spare AI-tokens og beskytte dansk kapital afvises uegnede handler deterministisk uden API-kald:
- **Transaktionskode**: KUN ægte åbne markedskøb (`Kode P`). Salg (`S`), optioner/RSU (`M`, `A`) og skatteafregning (`F`) sorteres fra.
- **Minimumsværdi**: Handlen skal overstige \$50.000 USD (eller 350.000 DKK) for at repræsentere reel overbevisning.
- **Børs-whitelist**: Kun officielle markeder godkendes (`NASDAQ`, `NYSE`, `Nasdaq Copenhagen`, `Nasdaq Stockholm`). Amerikansk OTC / Pink Sheets afvises.
- **EU PRIIPs / KID Gate**: Amerikanske Closed-End Funds (CEF) og ETF'er uden EU Key Information Document (f.eks. `CLM`) blokeres automatisk for danske detailinvestorer.
- **Likviditets- og Penny Stock Filter**: Kursen skal være $\ge \$2.00$ og gennemsnitlig daglig omsætning $\ge \$500.000$ USD for at undgå illikvide spreads.

### 3. Gemini 3 Flash Batch Gatekeeper
- Analyserer hele batchet af beståede transaktioner i et enkelt prompt-kald.
- Tildeler en hurtig **Pre-Score (0–100)** og genererer en syntese af asymmetri-signalet (`HIGH`, `MEDIUM`, `LOW`, `NOISE`).

### 4. Deep Context Enricher & "Det med småt"
- **SEC Form 4 Fodnote-Parser**: Downloader den rå XML/HTML indberetning og udtrækker alle juridiske `<footnote>`-tekster (f.eks. vægtet gennemsnitspris, private placements, fonds-vehikler).
- **Rule 10b5-1 Detektor**: Scanner indberetningens Checkbox og fodnoter for forudbestemte handelsplaner. Hvis handlen er en 10b5-1 plan, neutraliseres asymmetriscoren, da handlen blev besluttet måneder forinden uden aktuel insider-viden.
- **True Cluster Buys**: Registrerer når flere *forskellige fysiske personer* i ledelsen køber i samme tidsvindue, mens fondsselskabers multi-entity indberetninger deduplikeres.
- **3-4 Års Historical Track Record**: Undersøger insiderens historiske køb for at identificere om vedkommende er en **🎯 Smart Money Sniper** (>70% Win-Rate) eller en **⚠️ Bagholder** (køber faldende knive).

### 5. The Council of Experts (Multi-Agent Råd)
Når en sag sendes til rådet, kaldes 3 specialister parallelt via `Promise.all` efterfulgt af en dommer:
1. **The Insider Profiler (Claude Sonnet 5.5)**: Analyserer insiderens magtbase, relative positionsøgning (% af formue) og historiske købsadfærd.
2. **The Catalyst Hunter (Claude Sonnet 5.5)**: Kigger fremad. Hvorfor køber ledelsen netop nu? Hvilke FDA-godkendelser, regnskaber eller produktlanceringer venter?
3. **The Forensic Skeptic (Claude Sonnet 5.5)**: Djævlens advokat. Leder efter gældsforfald, udvanding, PR-stunts og regnskabsfinter.
4. **Chief Investment Officer (Claude Opus 5.5 / Sonnet)**: Syntetiserer rapporterne med **Adaptive Extended Thinking (2048 tokens)**, afsiger en endelig dom (**Asymmetry Score 1–100**) og formulerer en konkret handlingsanvisning.

### 6. Kvantitativ Eksekvering, ATR Volatilitet & Paper Portfolio
Beregner en matematisk eksekveringsplan for frie midler:
- **14-dages ATR (Average True Range)**: Måler aktiens sande daglige svingningsbredde.
- **Volatilitetsjustering**: Biotek- og højvolatilitetsaktier (>5.5% dagsvolatilitet) nedskaleres automatisk med 25–40% i positionsstørrelse for at begrænse kronetabet.
- **Hard Invalidation Stop-Loss**: Sættes til:
  $$\text{Stop-Loss} = \min(\text{Aktuel Kurs}, \text{Insiderens Købskurs}) - (2.5 \times \text{ATR})$$
  (Sikkerhedsbegrænset mellem -7% og maksimalt -18%).
- **2-Tranche Ordre-Eksekvering**:
  - **Tranche 1 (60%)**: Markedsåbning / Limit ordre på aktuel kurs for at sikre basen.
  - **Tranche 2 (40%)**: Limit pullback ordre på støtteniveau i bunden af ordrebogen.
- **Live Paper-Trading Portfolio**: Track åbne positioner i realtid med live P&L i DKK, automatisk stop-loss / target hit registrering og win-rate beregning via Yahoo Finance.

---

## 📐 Kvantitative Formler

### 1. True Range & 14-Dages ATR
$$\text{TR}_i = \max\left(H_i - L_i,\; |H_i - C_{i-1}|,\; |L_i - C_{i-1}|\right)$$
$$\text{ATR}_{14} = \frac{1}{14} \sum_{i=1}^{14} \text{TR}_i$$
$$\text{Daglig Volatilitet \%} = \left(\frac{\text{ATR}_{14}}{\text{Aktuel Kurs}}\right) \times 100$$

### 2. Conviction & Volatilitets-Skaleret Allokering
Givet en brugerdefineret kapitalramme $K_{\text{DKK}}$ (f.eks. 25.000 kr.):

$$\text{Conviction Multiplikator } (C) = \begin{cases} 1.0 & \text{hvis Score } \ge 85 \\ 0.7 & \text{hvis } 75 \le \text{Score} < 85 \\ 0.4 & \text{hvis } 60 \le \text{Score} < 75 \\ 0.0 & \text{hvis Score } < 60 \text{ (Afvis)} \end{cases}$$

$$\text{Volatilitets Multiplikator } (V) = \begin{cases} 0.60 & \text{hvis Daglig Vol } > 8.0\% \\ 0.75 & \text{hvis Daglig Vol } > 5.5\% \\ 1.00 & \text{ellers} \end{cases}$$

$$\text{Allokering}_{\text{DKK}} = \text{round}\left(K_{\text{DKK}} \times C \times V\right)$$

### 3. Portefølje P&L i DKK
Givet en position med $S$ aktier, indgangskurs $P_{\text{entry}}$, aktuel kurs $P_{\text{nu}}$ og investeret beløb $I_{\text{DKK}}$:

$$\text{PnL \%} = \left(\frac{P_{\text{nu}} - P_{\text{entry}}}{P_{\text{entry}}}\right) \times 100$$
$$\text{PnL}_{\text{DKK}} = \text{round}\left(I_{\text{DKK}} \times \frac{\text{PnL \%}}{100}\right)$$

---

## 🛠️ Teknologier & Stack

- **Framework**: [Next.js 16](https://nextjs.org/) (App Router, Turbopack, Server Components, Route Handlers)
- **Sprog**: [TypeScript 5](https://www.typescriptlang.org/) (Strict typing på tværs af hele tragten)
- **Styling**: [Tailwind CSS 3](https://tailwindcss.com/) med cyberpunk/Bloomberg Terminal dark theme
- **Ikoner**: [Lucide React](https://lucide.dev/)
- **AI Ræsonnering**:
  - `@google/genai` (Google Gemini 3 Flash Preview)
  - `@anthropic-ai/sdk` (Claude 3.5 Sonnet / 3.7 Sonnet / 3.5 Opus)
- **Persistens**: Atomisk, serverside JSON-database (`data/insiderops-db.json`) med synkronisering til `localStorage`

---

## 🚀 Kom Hurtigt i Gang

### Forudsætninger
- [Node.js](https://nodejs.org/) v20+ eller v24+
- En [Google AI Studio](https://aistudio.google.com/) API-nøgle
- En [Anthropic Console](https://console.anthropic.com/) API-nøgle

### 1. Klon Repositoriet
```bash
git clone https://github.com/mads417p/InsiderOps.git
cd InsiderOps
```

### 2. Installer Afhængigheder
```bash
npm install
```

### 3. Konfigurer Miljøvariable
Opret en `.env.local` fil i roden af projektet:
```env
# Google Gemini API Nøgle (Pre-Filter & Batch Gatekeeper)
GEMINI_API_KEY=din_gemini_api_key_her
GEMINI_FAST_MODEL=gemini-3-flash-preview

# Anthropic API Nøgle (The Council of Experts)
ANTHROPIC_API_KEY=din_anthropic_api_key_her
ANTHROPIC_SONNET_MODEL=claude-3-5-sonnet-latest
ANTHROPIC_OPUS_MODEL=claude-3-opus-latest
```

### 4. Start Udviklingsserveren
```bash
npm run dev
```
Åbn [http://localhost:3000](http://localhost:3000) i din browser.

### 5. Byg til Produktion
```bash
npm run build
npm run start
```

---

## 📂 Projektstruktur

```
InsiderOps/
├── data/
│   └── insiderops-db.json          # Persistent serverside database (domme, historik, paper portfolio)
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── council/route.ts    # POST: Saml rådet / GET: Hent domme / DELETE
│   │   │   ├── portfolio/route.ts  # GET: Live P&L refresh / POST: Åbn trade / DELETE
│   │   │   └── scan/route.ts       # Multi-source Form 4 og MAR scanner endpoint
│   │   ├── layout.tsx              # Root HTML & font wrapper
│   │   └── page.tsx                # Hoved-dashboard (Radar, Watchlist, Paper Portfolio, Council)
│   ├── lib/
│   │   ├── claude-council.ts       # 4-agent Council orkestrering med Claude 5.5
│   │   ├── db.ts                   # Atomisk filbaseret JSON-database engine
│   │   ├── gemini-gatekeeper.ts    # Gemini 3 Flash batch evaluering & pre-score
│   │   ├── market-enricher.ts      # Yahoo Finance kurser, 14d ATR, volumen og DK tradability
│   │   ├── nordic-scanner.ts       # Nasdaq Europe MAR art. 19 scraper & XML parser
│   │   ├── sec-scanner.ts          # SEC EDGAR Atom & EFTS API, C-Suite hunter, footnotes parser
│   │   ├── track-record.ts         # 3-4 års insider track record & Smart Money sniper detektor
│   │   └── trade-planner.ts        # Kvantitativ ATR eksekvering, sizing & 2-tranche plan
│   └── types/
│       └── insider.ts              # Komplet TypeScript typesystem
├── public/                         # Statiske aktiver
├── package.json                    # Afhængigheder og scripts
├── tsconfig.json                   # TypeScript compiler opsætning
└── README.md                       # Teknisk arkitekturdokumentation
```

---

## ⚖️ Ansvarsfraskrivelse (Disclaimer)

> [!WARNING]
> Dette værktøj er udelukkende udviklet til uddannelses-, forsknings- og simuleringsformål. Det udgør under ingen omstændigheder finansiel rådgivning, investeringsanbefalinger eller opfordring til køb eller salg af værdipapirer. Historisk afkast eller insideraktivitet er ingen garanti for fremtidige gevinster. Foretag altid din egen grundige analyse (Due Diligence), før du investerer rigtige midler.

---

## 📜 Licens

Udgivet under [MIT License](LICENSE). Udviklet med fokus på kapitalbeskyttelse, legal asymmetri og robust datakvalitet.
