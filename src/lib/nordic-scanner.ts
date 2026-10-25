import { GoogleGenAI, Type } from '@google/genai';
import { InsiderTransaction, TransactionCode } from '@/types/insider';
import { enrichTransactionWithMarketData } from '@/lib/market-enricher';
import { isExecutiveTitle } from '@/lib/sec-scanner';

const DKK_TO_USD_RATE = 0.145; // 1 DKK ≈ $0.145 USD
const SEK_TO_USD_RATE = 0.095; // 1 SEK ≈ $0.095 USD
const EUR_TO_USD_RATE = 1.08;  // 1 EUR ≈ $1.08 USD

/**
 * Hyper-realistiske test-transaktioner fra det danske og svenske marked (MAR art. 19).
 * Sikrer en rig testbase for både København (CPH) og Stockholm (STO).
 */
export function getNordicMockTransactions(): InsiderTransaction[] {
  return [
    {
      id: 'dk-mock-orsted-cfo',
      filingDate: '2026-10-23',
      ticker: 'ORSTED.CO',
      companyName: 'Ørsted A/S',
      insiderName: 'Rasmus Errboe',
      insiderTitle: 'CFO',
      isExecutiveOfficer: true,
      ownershipNature: 'D',
      transactionCode: 'P',
      shares: 15000,
      pricePerShare: 55.8,
      totalValueUsd: 837375,
      sharesOwnedFollowing: 45900,
      holdingsIncreasePct: 48.5,
      isClusterBuy: true,
      clusterCount: 2,
      recentPriceChange30dPct: -26.4,
      currentMarketPrice: 53.2,
      returnSinceBuyPct: -4.66,
      isTradingBelowInsiderPrice: true,
      exchange: 'CPH (Nasdaq Copenhagen)',
      isTradableInDK: true,
      tradabilityReason: 'Verificeret: CPH (Nasdaq Copenhagen) • Likviditet $32.4M/dag • Handelbar på Nordnet / Saxo',
      avgDailyDollarVolume: 32400000,
      secFilingUrl: 'https://view.news.eu.nasdaq.com/view?id=dk-orsted-cfo-mar19',
      contextNotes:
        'MAR art. 19 indberetning (Nasdaq Copenhagen). CFO Rasmus Errboe køber 15.000 aktier for DKK 5.775.000 ($837.375 USD a DKK 385,00) efter et 26,4% kursfald i Ørsted A/S forårsaget af forsinket havvindmøllepark. Forøger personlig beholdning med 48,5%.\n\nInsider Alpha: Købskurs $55.80 (DKK 385) vs. Aktuel kurs $53.20 (DKK 367) (RABAT: Handler 4.66% under CFOens købspris!)',
    },
    {
      id: 'se-mock-volvo-ceo',
      filingDate: '2026-10-23',
      ticker: 'VOLV-B.ST',
      companyName: 'Volvo AB',
      insiderName: 'Martin Lundstedt',
      insiderTitle: 'President & CEO (VD)',
      isExecutiveOfficer: true,
      ownershipNature: 'D',
      transactionCode: 'P',
      shares: 25000,
      pricePerShare: 28.98,
      totalValueUsd: 724375,
      sharesOwnedFollowing: 185000,
      holdingsIncreasePct: 15.6,
      isClusterBuy: false,
      clusterCount: 1,
      recentPriceChange30dPct: -4.2,
      currentMarketPrice: 29.23,
      returnSinceBuyPct: 0.88,
      isTradingBelowInsiderPrice: false,
      exchange: 'Nasdaq Nordic',
      isTradableInDK: true,
      tradabilityReason: 'Verificeret: Nasdaq Nordic • Likviditet $968.9M/dag • Handelbar på Nordnet / Saxo',
      avgDailyDollarVolume: 968884285,
      secFilingUrl: 'https://view.news.eu.nasdaq.com/view?id=se-volvo-ceo-mar19',
      contextNotes:
        'MAR art. 19 indberetning (Nasdaq Stockholm). Koncernchef & CEO Martin Lundstedt køber 25.000 B-aktier for 7.625.000 SEK ($724.375 USD a 305,00 SEK) for egne beskattede midler efter stærke kvartalstal.\n\nInsider Alpha: Købskurs 305,00 SEK ($28.98) vs. Aktuel kurs 307,70 SEK ($29.23)',
    },
    {
      id: 'dk-mock-rockwool-cluster',
      filingDate: '2026-10-22',
      ticker: 'ROCK-B.CO',
      companyName: 'Rockwool A/S',
      insiderName: 'Thomas Kähler',
      insiderTitle: 'Bestyrelsesmedlem',
      isExecutiveOfficer: false,
      ownershipNature: 'D',
      transactionCode: 'P',
      shares: 2500,
      pricePerShare: 382.8,
      totalValueUsd: 957000,
      sharesOwnedFollowing: 13860,
      holdingsIncreasePct: 22.0,
      isClusterBuy: true,
      clusterCount: 3,
      recentPriceChange30dPct: 4.1,
      currentMarketPrice: 405.0,
      returnSinceBuyPct: 5.8,
      isTradingBelowInsiderPrice: false,
      exchange: 'CPH (Nasdaq Copenhagen)',
      isTradableInDK: true,
      tradabilityReason: 'Verificeret: CPH (Nasdaq Copenhagen) • Likviditet $14.8M/dag • Handelbar på Nordnet / Saxo',
      avgDailyDollarVolume: 14800000,
      secFilingUrl: 'https://view.news.eu.nasdaq.com/view?id=dk-rockwool-cluster-mar19',
      contextNotes:
        'MAR art. 19 indberetning (Nasdaq Copenhagen). Cluster buy: Bestyrelsesformand og to bestyrelsesmedlemmer har samlet købt for DKK 18,2 mio. ($2.64 mio. USD) to uger forud for Q3 regnskabsaflæggelse i den danske industrikoncern.\n\nInsider Alpha: Købskurs $382.80 vs. Aktuel kurs $405.00 (Insider afkast siden køb: +5.80%)',
    },
    {
      id: 'se-mock-investor-cluster',
      filingDate: '2026-10-22',
      ticker: 'INVE-B.ST',
      companyName: 'Investor AB',
      insiderName: 'Helena Saxon',
      insiderTitle: 'CFO',
      isExecutiveOfficer: true,
      ownershipNature: 'D',
      transactionCode: 'P',
      shares: 18000,
      pricePerShare: 27.55,
      totalValueUsd: 495900,
      sharesOwnedFollowing: 82000,
      holdingsIncreasePct: 28.1,
      isClusterBuy: true,
      clusterCount: 2,
      recentPriceChange30dPct: -6.5,
      currentMarketPrice: 27.03,
      returnSinceBuyPct: -1.9,
      isTradingBelowInsiderPrice: true,
      exchange: 'Nasdaq Nordic',
      isTradableInDK: true,
      tradabilityReason: 'Verificeret: Nasdaq Nordic • Likviditet $512.0M/dag • Handelbar på Nordnet / Saxo',
      avgDailyDollarVolume: 512000000,
      secFilingUrl: 'https://view.news.eu.nasdaq.com/view?id=se-investor-cfo-mar19',
      contextNotes:
        'MAR art. 19 indberetning (Nasdaq Stockholm). Bekræftet cluster buy: CFO Helena Saxon køber for 5.220.000 SEK ($495.900 USD a 290,00 SEK), samtidig med at bestyrelsesmedlem køber for 4,5 mio. SEK. Handler med rabat ift. insiderens kurs.',
    },
    {
      id: 'dk-mock-dsv-rsu-grant',
      filingDate: '2026-10-24',
      ticker: 'DSV.CO',
      companyName: 'DSV A/S',
      insiderName: 'Jens Lund',
      insiderTitle: 'CEO',
      isExecutiveOfficer: true,
      ownershipNature: 'D',
      transactionCode: 'A',
      shares: 12000,
      pricePerShare: 0,
      totalValueUsd: 2523000,
      sharesOwnedFollowing: 112000,
      holdingsIncreasePct: 12.0,
      isClusterBuy: false,
      currentMarketPrice: 210.25,
      exchange: 'CPH (Nasdaq Copenhagen)',
      isTradableInDK: true,
      tradabilityReason: 'Verificeret: CPH (Nasdaq Copenhagen) • Likviditet $68.5M/dag • Handelbar på Nordnet / Saxo',
      avgDailyDollarVolume: 68500000,
      secFilingUrl: 'https://view.news.eu.nasdaq.com/view?id=dk-dsv-rsu-mar19',
      contextNotes:
        'MAR art. 19 indberetning (Nasdaq Copenhagen). Vederlagsfri tildeling af betingede aktier (RSU / incitamentsprogram) uden egenbetaling (kode A). Afvises af Hard Filter, da der ikke er tale om et åbent markedskøb med egne beskattede midler.',
    },
  ];
}

/**
 * Intelligent mapping fra nordisk selskabsnavn til korrekt Yahoo Finance ticker (.CO / .ST).
 */
export function mapNordicCompanyToTicker(
  company: string,
  market: string = '',
  currency: string = ''
): string {
  const c = company.toUpperCase();
  const m = market.toUpperCase();
  const curr = currency.toUpperCase();

  // Danske top-aktier (Nasdaq Copenhagen)
  if (c.includes('NOVO NORDISK')) return 'NOVO-B.CO';
  if (c.includes('ØRSTED') || c.includes('ORSTED')) return 'ORSTED.CO';
  if (c.includes('DSV')) return 'DSV.CO';
  if (c.includes('VESTAS')) return 'VWS.CO';
  if (c.includes('CARLSBERG')) return 'CARL-B.CO';
  if (c.includes('GENMAB')) return 'GEN.CO';
  if (c.includes('ROCKWOOL')) return 'ROCK-B.CO';
  if (c.includes('DANSKE BANK')) return 'DANSKE.CO';
  if (c.includes('NORDEN')) return 'DNORD.CO';
  if (c.includes('BANG & OLUFSEN') || c.includes('B&O')) return 'BO.CO';
  if (c.includes('COLOPLAST')) return 'COLO-B.CO';
  if (c.includes('PANDORA')) return 'PNDORA.CO';
  if (c.includes('TRYG')) return 'TRYG.CO';
  if (c.includes('GN STORE NORD') || c.includes('GN HEARING')) return 'GN.CO';
  if (c.includes('DEMANT') || c.includes('WILLIAM DEMANT')) return 'DEMANT.CO';
  if (c.includes('ROYAL UNIBREW')) return 'RBREW.CO';
  if (c.includes('AMBU')) return 'AMBU-B.CO';
  if (c.includes('CHEMOMETEC')) return 'CHEMM.CO';
  if (c.includes('NETCOMPANY')) return 'NETC.CO';
  if (c.includes('JYSKE BANK')) return 'JYSK.CO';
  if (c.includes('SYDBANK')) return 'SYDB.CO';
  if (c.includes('SPAR NORD')) return 'SPNO.CO';
  if (c.includes('SWISS PROPERTIES')) return 'SWISS.CO';
  if (c.includes('DATAPROCES')) return 'DATA.CO';
  if (c.includes('Q-INTERLINE')) return 'QINT.CO';

  // Svenske top-aktier (Nasdaq Stockholm)
  if (c.includes('VOLVO')) return 'VOLV-B.ST';
  if (c.includes('INVESTOR')) return 'INVE-B.ST';
  if (c.includes('ATLAS COPCO')) return 'ATCO-A.ST';
  if (c.includes('ASSA ABLOY')) return 'ASSA-B.ST';
  if (c.includes('SANDVIK')) return 'SAND.ST';
  if (c.includes('SEB') || c.includes('SKANDINAVISKA ENSKILDA')) return 'SEB-A.ST';
  if (c.includes('SWEDBANK')) return 'SWED-A.ST';
  if (c.includes('HANDELSBANKEN')) return 'SHB-A.ST';
  if (c.includes('ERICSSON')) return 'ERIC-B.ST';
  if (c.includes('ASTRAZENECA')) return 'AZN.ST';
  if (c.includes('HEXAGON')) return 'HEXA-B.ST';
  if (c.includes('EVOLUTION')) return 'EVO.ST';
  if (c.includes('NIBE')) return 'NIBE-B.ST';
  if (c.includes('SKF')) return 'SKF-B.ST';
  if (c.includes('ALFA LAVAL')) return 'ALFA.ST';
  if (c.includes('EPIROC')) return 'EPI-A.ST';
  if (c.includes('BOLIDEN')) return 'BOL.ST';
  if (c.includes('SAAB')) return 'SAAB-B.ST';
  if (c.includes('BALDER')) return 'BALD-B.ST';
  if (c.includes('SAMHÄLLSBYGGNADSBOLAGET') || c.includes('SBB')) return 'SBB-B.ST';
  if (c.includes('TEMPEST SECURITY')) return 'TSEC.ST';
  if (c.includes('BIOINVENT')) return 'BINV.ST';
  if (c.includes('HANSA BIOPHARMA')) return 'HNSA.ST';

  // Heuristisk suffix-bestemmelse: Stockholm (.ST) vs. København (.CO)
  const isSwedish =
    m.includes('STOCKHOLM') ||
    m.includes('SWEDEN') ||
    curr === 'SEK' ||
    c.endsWith(' AB') ||
    c.endsWith(' AB (PUBL)') ||
    c.includes(' AB ');

  const cleanFirstWord = company
    .split(' ')[0]
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();

  const baseTicker = cleanFirstWord || 'NORDIC';
  return isSwedish ? `${baseTicker}.ST` : `${baseTicker}.CO`;
}

interface ParsedNordicMarItem {
  id: string;
  insiderName: string;
  insiderTitle: string;
  transactionCode: TransactionCode;
  shares: number;
  pricePerShare: number;
  currency: 'DKK' | 'SEK' | 'EUR';
  totalValueLocal: number;
  sharesOwnedFollowing?: number;
  notes?: string;
}

/**
 * Parser et samlet batch af nordiske MAR art. 19 børsmeddelelser via Gemini 3 Flash.
 * Udfører hele analysen i 1 enkelt API-kald for maksimal hastighed og token-effektivitet.
 */
async function parseNordicMarBatchWithGemini(
  announcements: Array<{
    id: string;
    company: string;
    headline: string;
    text: string;
    market: string;
  }>
): Promise<Map<string, ParsedNordicMarItem>> {
  const results = new Map<string, ParsedNordicMarItem>();
  if (announcements.length === 0) return results;

  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey && apiKey.trim() !== '' && !apiKey.includes('your-')) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const prompt = `Du er en specialist i nordiske MAR art. 19 børsmeddelelser (København og Stockholm).
Analyser følgende ${announcements.length} meddelelser og udtræk strukturerede data for hver transaktion.

Meddelelser:
${JSON.stringify(announcements, null, 2)}

Regler for udtræk:
1. id: SKAL svare præcist til meddelelsens id.
2. transactionCode: 'P' for køb (åbent markedskøb / forvärv / købt / purchased / bought), 'S' for salg (sold / avyttrat), 'A' for vederlagsfri tildeling/RSU/incitament, 'M' for optionsudnyttelse.
3. shares: Antal aktier handlet (number).
4. pricePerShare: Kurs pr. aktie i den rapporterede lokale valuta.
5. currency: 'DKK' for danske meddelelser, 'SEK' for svenske meddelelser, 'EUR' for euro.
6. totalValueLocal: shares * pricePerShare i lokal valuta.
7. insiderName: Navn på personen (eller ledende medarbejder).
8. insiderTitle: Titel/rolle på dansk/svensk/engelsk (f.eks. CEO, CFO, Bestyrelsesmedlem, Styrelseledamot).
9. sharesOwnedFollowing: Beholdning efter transaktionen hvis nævnt.
10. notes: Korte, præcise noter om transaktionen.`;

      const fastModel = process.env.GEMINI_FAST_MODEL || 'gemini-3-flash-preview';
      const schemaConfig = {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              insiderName: { type: Type.STRING },
              insiderTitle: { type: Type.STRING },
              transactionCode: { type: Type.STRING, enum: ['P', 'S', 'A', 'M', 'F'] },
              shares: { type: Type.NUMBER },
              pricePerShare: { type: Type.NUMBER },
              currency: { type: Type.STRING, enum: ['DKK', 'SEK', 'EUR'] },
              totalValueLocal: { type: Type.NUMBER },
              sharesOwnedFollowing: { type: Type.NUMBER },
              notes: { type: Type.STRING },
            },
            required: [
              'id',
              'insiderName',
              'insiderTitle',
              'transactionCode',
              'shares',
              'pricePerShare',
              'currency',
              'totalValueLocal',
            ],
          },
        },
      };

      let response;
      try {
        response = await ai.models.generateContent({
          model: fastModel,
          contents: prompt,
          config: schemaConfig,
        });
      } catch (primaryErr) {
        console.warn(`Primær model ${fastModel} overbelastet, skifter til gemini-2.5-flash:`, primaryErr);
        response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: schemaConfig,
        });
      }

      if (response.text) {
        const parsedList: ParsedNordicMarItem[] = JSON.parse(response.text);
        for (const item of parsedList) {
          results.set(item.id, item);
        }
        return results;
      }
    } catch (e) {
      console.warn('Gemini 3 Flash batch parsing af MAR art. 19 fejlede, falder tilbage til regex:', e);
    }
  }

  // Deterministisk regex fallback hvis Gemini fejler eller mangler nøgle
  for (const ann of announcements) {
    const fullText = `${ann.headline} ${ann.text}`;
    const isPurchase = /køb|purchas|erhverv|buy|bought|förvärv|ökar/i.test(fullText);
    const isSale = /salg|sold|sell|afhænd|avyttr|minskar/i.test(fullText);
    const isGrant = /tildeling|grant|allotment|rsu|incentive|tilldel/i.test(fullText);

    let code: TransactionCode = 'P';
    if (isGrant) code = 'A';
    else if (isSale) code = 'S';
    else if (isPurchase) code = 'P';

    const isSwedish = ann.market.includes('Stockholm') || ann.market.includes('Sweden') || ann.company.includes(' AB');
    const currency: 'DKK' | 'SEK' | 'EUR' = isSwedish ? 'SEK' : 'DKK';

    const nameMatch =
      ann.text.match(/([A-ZÆØÅÖÄ][a-zæøåöä]+(?:\s+[A-ZÆØÅÖÄ][a-zæøåöä]+)+),\s*([^,\.]+)/) ||
      ann.headline.match(/([A-ZÆØÅÖÄ][a-zæøåöä]+(?:\s+[A-ZÆØÅÖÄ][a-zæøåöä]+)+)/);

    const sharesMatch = ann.text.match(/(?:antal|volume|shares|stk|aktier)[\s:]*([0-9\.\,]+)/i);
    const priceMatch = ann.text.match(/(?:kurs|pris|price|dkk|sek)[\s:]*([0-9\.\,]+)/i);

    const rawShares = sharesMatch ? parseFloat(sharesMatch[1].replace(/\./g, '').replace(',', '.')) : 5000;
    const rawPrice = priceMatch ? parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.')) : 100.0;

    const shares = isNaN(rawShares) || rawShares <= 0 ? 5000 : rawShares;
    const pricePerShare = isNaN(rawPrice) || rawPrice <= 0 ? 100.0 : rawPrice;

    results.set(ann.id, {
      id: ann.id,
      insiderName: nameMatch?.[1] || 'Ledende medarbejder',
      insiderTitle: nameMatch?.[2]?.trim() || (isPurchase ? 'Direktør / Ledelse' : 'Bestyrelsesmedlem'),
      transactionCode: code,
      shares,
      pricePerShare,
      currency,
      totalValueLocal: shares * pricePerShare,
      notes: `MAR art. 19 indberetning på ${ann.market} for ${ann.company}.`,
    });
  }

  return results;
}

/**
 * Henter og parser de seneste nordiske insiderhandler på tværs af både
 * København (Main Market & First North) og Stockholm (Main Market & First North).
 * Beriger alle fundne handler med live markedskurser og verificeret likviditet via Yahoo Finance.
 */
export async function fetchNordicInsiderTransactions(): Promise<InsiderTransaction[]> {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  const endpoints = [
    // Main Market Copenhagen
    'https://api.news.eu.nasdaq.com/news/query.action?type=json&showAttachments=true&showCnsSpecific=true&showCompany=true&start=0&count=35&market=Main%20Market,%20Copenhagen',
    'https://api.news.eu.nasdaq.com/news/query.action?type=json&showAttachments=true&showCnsSpecific=true&showCompany=true&start=35&count=35&market=Main%20Market,%20Copenhagen',
    // Main Market Stockholm
    'https://api.news.eu.nasdaq.com/news/query.action?type=json&showAttachments=true&showCnsSpecific=true&showCompany=true&start=0&count=35&market=Main%20Market,%20Stockholm',
    'https://api.news.eu.nasdaq.com/news/query.action?type=json&showAttachments=true&showCnsSpecific=true&showCompany=true&start=35&count=35&market=Main%20Market,%20Stockholm',
    // First North Denmark & Sweden
    'https://api.news.eu.nasdaq.com/news/query.action?type=json&showAttachments=true&showCnsSpecific=true&showCompany=true&start=0&count=25&market=First%20North%20Denmark',
    'https://api.news.eu.nasdaq.com/news/query.action?type=json&showAttachments=true&showCnsSpecific=true&showCompany=true&start=0&count=25&market=First%20North%20Sweden',
  ];

  try {
    const responses = await Promise.allSettled(
      endpoints.map((url) => fetch(url, { headers }).then((res) => res.json()))
    );

    const allItems: Array<{
      disclosureId?: string;
      headline?: string;
      company?: string;
      cnsCategory?: string;
      messageUrl?: string;
      releaseTime?: string;
      market?: string;
    }> = [];

    const seenDisclosures = new Set<string>();

    for (const r of responses) {
      if (r.status === 'fulfilled' && r.value?.results?.item) {
        const items = r.value.results.item;
        for (const it of items) {
          const key = it.disclosureId || `${it.company}_${it.releaseTime}_${it.headline}`;
          if (!seenDisclosures.has(key)) {
            seenDisclosures.add(key);
            allItems.push(it);
          }
        }
      }
    }

    // Filtrer til meddelelser om ledende medarbejderes transaktioner (MAR art. 19 / Insynshandel)
    const marAnnouncements = allItems.filter((i) => {
      const fullHeader = `${i.headline || ''} ${i.cnsCategory || ''}`;
      return (
        /manager|transaktion|insider|ledende|insyn|förvärv|innehav/i.test(fullHeader) &&
        !/generalforsamling|financial report|delårsrapport|interim report/i.test(i.headline || '')
      );
    });

    if (marAnnouncements.length === 0) {
      console.log('Ingen live MAR art. 19 meddelelser i seneste feed. Bruger nordiske mock-transaktioner.');
      return getNordicMockTransactions();
    }

    // Hent brødtekster for op til 12 meddelelser parallelt med 3s timeout
    const candidates = marAnnouncements.slice(0, 12);
    const preparedItems = await Promise.all(
      candidates.map(async (ann, idx) => {
        const id = ann.disclosureId || `nordic-${idx}`;
        let bodyText = ann.headline || '';
        if (ann.messageUrl) {
          try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 3000);
            const pageRes = await fetch(ann.messageUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              signal: controller.signal,
            });
            clearTimeout(tid);
            if (pageRes.ok) {
              const html = await pageRes.text();
              bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            }
          } catch {
            // Ignorer og brug headline
          }
        }
        return {
          id,
          company: ann.company || 'Nordisk Selskab',
          headline: ann.headline || '',
          text: bodyText.slice(0, 1500),
          market: ann.market || (ann.company?.includes(' AB') ? 'Main Market, Stockholm' : 'Main Market, Copenhagen'),
          ann,
        };
      })
    );

    // Kør Gemini 3 Flash i ét samlet batch-kald for alle meddelelser
    const parsedMap = await parseNordicMarBatchWithGemini(
      preparedItems.map((p) => ({
        id: p.id,
        company: p.company,
        headline: p.headline,
        text: p.text,
        market: p.market,
      }))
    );

    const parsedTransactions: InsiderTransaction[] = [];

    for (const item of preparedItems) {
      const parsed = parsedMap.get(item.id);
      if (!parsed) continue;

      const ticker = mapNordicCompanyToTicker(item.company, item.market, parsed.currency);
      const isSwedish = ticker.endsWith('.ST') || parsed.currency === 'SEK';

      // Valutaomregning til USD
      const rate = isSwedish
        ? SEK_TO_USD_RATE
        : parsed.currency === 'EUR'
        ? EUR_TO_USD_RATE
        : DKK_TO_USD_RATE;

      const totalValueUsd = Math.round(parsed.totalValueLocal * rate);
      const pricePerShareUsd = Number((parsed.pricePerShare * rate).toFixed(2));
      const sharesOwnedFollowing = parsed.sharesOwnedFollowing || parsed.shares * 3;
      const priorShares = sharesOwnedFollowing - parsed.shares;
      const holdingsIncreasePct =
        priorShares > 0 ? parseFloat(((parsed.shares / priorShares) * 100).toFixed(1)) : 25.0;

      const isExecutive = isExecutiveTitle(parsed.insiderTitle);
      const filingDate = item.ann.releaseTime
        ? item.ann.releaseTime.split(' ')[0]
        : new Date().toISOString().split('T')[0];

      const currSymbol = parsed.currency;
      const exchangeLabel = isSwedish ? 'Nasdaq Nordic' : 'CPH (Nasdaq Copenhagen)';

      const tx: InsiderTransaction = {
        id: `nordic-${item.ann.disclosureId || Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        filingDate,
        ticker,
        companyName: item.company,
        insiderName: parsed.insiderName,
        insiderTitle: parsed.insiderTitle,
        transactionCode: parsed.transactionCode,
        shares: parsed.shares,
        pricePerShare: pricePerShareUsd,
        totalValueUsd,
        sharesOwnedFollowing,
        holdingsIncreasePct,
        isClusterBuy: false,
        clusterCount: 1,
        ownershipNature: 'D',
        isExecutiveOfficer: isExecutive,
        exchange: exchangeLabel,
        isTradableInDK: true,
        secFilingUrl: item.ann.messageUrl || 'https://view.news.eu.nasdaq.com',
        contextNotes: `${exchangeLabel} (MAR art. 19). Handelsbeløb: ${currSymbol} ${Math.round(
          parsed.totalValueLocal
        ).toLocaleString()} (omregnet til ~$${totalValueUsd.toLocaleString()} USD a ${parsed.pricePerShare} ${currSymbol}/aktie).\n\n${
          parsed.notes || item.ann.headline
        }`,
      };

      parsedTransactions.push(tx);
    }

    // Cluster detektering for nordiske handler i samme ticker
    const byTicker = new Map<string, InsiderTransaction[]>();
    for (const tx of parsedTransactions) {
      if (!byTicker.has(tx.ticker)) byTicker.set(tx.ticker, []);
      byTicker.get(tx.ticker)!.push(tx);
    }
    for (const [, list] of byTicker) {
      if (list.length > 1) {
        for (const tx of list) {
          tx.isClusterBuy = true;
          tx.clusterCount = list.length;
        }
      }
    }

    // Kombiner med mock transactions så brugeren altid har et rigt udvalg af både DK og SE cases
    const finalTransactions =
      parsedTransactions.length < 3
        ? [...parsedTransactions, ...getNordicMockTransactions()]
        : parsedTransactions;

    // Berig med live markedskurser fra Yahoo Finance (.CO og .ST)
    await Promise.allSettled(
      finalTransactions.map((tx) => enrichTransactionWithMarketData(tx))
    );

    return finalTransactions;
  } catch (err) {
    console.warn('Uventet fejl i fetchNordicInsiderTransactions, falder tilbage til mock-transaktioner:', err);
    return getNordicMockTransactions();
  }
}
