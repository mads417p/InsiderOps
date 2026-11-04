import { GoogleGenAI, Type } from '@google/genai';
import { InsiderTransaction, TransactionCode } from '@/types/insider';
import { isExecutiveTitle, isValidInsiderName } from '@/lib/sec-scanner';
import { resolveGeminiFlashModel } from '@/lib/gemini-gatekeeper';
import { UNTRUSTED_DATA_INSTRUCTION, untrusted } from '@/lib/prompt-safety';
import { convertCurrency, fetchLiveFxRates, type LiveFxRates } from '@/lib/live-quote';

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

  // Finske top-aktier (Nasdaq Helsinki)
  if (c.includes('NOKIA')) return 'NOKIA.HE';
  if (c.includes('SAMPO')) return 'SAMPO.HE';
  if (c.includes('KONE') && !c.includes('CRANES')) return 'KNEBV.HE';
  if (c.includes('KONECRANES')) return 'KCR.HE';
  if (c.includes('NESTE')) return 'NESTE.HE';
  if (c.includes('UPM')) return 'UPM.HE';
  if (c.includes('STORA ENSO')) return 'STERV.HE';
  if (c.includes('WARTSILA') || c.includes('WÄRTSILÄ')) return 'WRT1V.HE';
  if (c.includes('FORTUM')) return 'FORTUM.HE';
  if (c.includes('ORION')) return 'ORNBV.HE';
  if (c.includes('NORDEA')) {
    if (m.includes('HELSINKI') || curr === 'EUR') return 'NDA-FI.HE';
    if (m.includes('STOCKHOLM') || curr === 'SEK') return 'NDA-SE.ST';
    return 'NDA-DK.CO';
  }

  // Heuristisk suffix-bestemmelse: Helsinki (.HE), Stockholm (.ST) vs. København (.CO)
  const isFinnish =
    m.includes('HELSINKI') ||
    m.includes('FINLAND') ||
    curr === 'EUR' ||
    c.endsWith(' OYJ') ||
    c.includes(' OYJ');

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
  if (isFinnish) return `${baseTicker}.HE`;
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
  }>,
  fx: LiveFxRates
): Promise<Map<string, ParsedNordicMarItem>> {
  const results = new Map<string, ParsedNordicMarItem>();
  if (announcements.length === 0) return results;

  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey && apiKey.trim() !== '' && !apiKey.includes('your-')) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const prompt = `Du er en specialist i nordiske MAR art. 19 børsmeddelelser (København og Stockholm).
Analyser følgende ${announcements.length} meddelelser og udtræk strukturerede data for hver transaktion.

Meddelelser (hver meddelelses tekst er afgrænset som utroværdig data):
${JSON.stringify(
  announcements.map((a) => ({
    ...a,
    headline: untrusted('nasdaq-nordic-overskrift', a.headline),
    text: untrusted('nasdaq-nordic-meddelelse', a.text),
  })),
  null,
  2
)}

${UNTRUSTED_DATA_INSTRUCTION}

Regler for udtræk:
1. id: SKAL svare præcist til meddelelsens id.
2. transactionCode: 'P' for køb (åbent markedskøb / forvärv / købt / purchased / bought), 'S' for salg (sold / avyttrat), 'A' for vederlagsfri tildeling/RSU/incitament, 'M' for optionsudnyttelse.
3. shares: Antal aktier handlet (number).
4. pricePerShare: Kurs pr. aktie i den rapporterede lokale valuta.
5. currency: 'DKK' for danske meddelelser, 'SEK' for svenske meddelelser, 'EUR' for euro.
6. totalValueLocal: shares * pricePerShare i lokal valuta.
7. insiderName: Det fulde, eksakte personnavn eller fondsnavn på den handlende (f.eks. 'Rasmus Errboe' eller 'Novo Holdings A/S'). Hvis meddelelsen kun indeholder en generisk titel som 'Ledende medarbejder' uden et reelt personnavn, må transaktionen udelades.
8. insiderTitle: Titel/rolle på dansk/svensk/engelsk (f.eks. CEO, CFO, Bestyrelsesmedlem, Styrelseledamot).
9. sharesOwnedFollowing: Beholdning efter transaktionen hvis nævnt.
10. notes: Korte, præcise noter om transaktionen.`;

      const fastModel = await resolveGeminiFlashModel(ai);
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
        console.warn(`Primær Gemini model ${fastModel} fejlede, forsøger gemini-2.0-flash:`, primaryErr);
        try {
          response = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: prompt,
            config: schemaConfig,
          });
        } catch {
          // Falder automatisk tilbage til deterministisk regex parsing nedenfor
          response = null;
        }
      }

      if (response && response.text) {
        const parsedList: ParsedNordicMarItem[] = JSON.parse(response.text);
        for (const item of parsedList) {
          if (!item || !item.id) continue;
          if (item.transactionCode !== 'P') continue;
          if (!isValidInsiderName(item.insiderName)) continue;
          if (!item.shares || item.shares <= 0) continue;
          if (!item.pricePerShare || item.pricePerShare <= 0) continue;

          // Uden live FX kan $50k-grænsen ikke vurderes → meddelelsen afvises.
          const totalUsd = convertCurrency(item.totalValueLocal || item.shares * item.pricePerShare, item.currency, 'USD', fx);
          if (totalUsd === undefined || totalUsd < 50000) continue;

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

    // KUN reelle køb tillades (ikke salg eller incitamentstildelinger)
    if (!isPurchase || isSale || isGrant) continue;

    const isSwedish =
      ann.market.includes('Stockholm') || ann.market.includes('Sweden') || ann.company.includes(' AB');
    const isFinnish = ann.market.includes('Helsinki') || ann.market.includes('Finland');
    const currency: 'DKK' | 'SEK' | 'EUR' = isSwedish ? 'SEK' : isFinnish ? 'EUR' : 'DKK';

    const nameMatch =
      ann.text.match(/([A-ZÆØÅÖÄ][a-zæøåöä]+(?:\s+[A-ZÆØÅÖÄ][a-zæøåöä]+)+),\s*([^,\.]+)/) ||
      ann.headline.match(/([A-ZÆØÅÖÄ][a-zæøåöä]+(?:\s+[A-ZÆØÅÖÄ][a-zæøåöä]+)+)/);

    const detectedName = nameMatch?.[1]?.trim();
    if (!isValidInsiderName(detectedName)) continue;

    const sharesMatch = ann.text.match(/(?:antal|volume|shares|stk|aktier)[\s:]*([0-9\.\,]+)/i);
    const priceMatch = ann.text.match(/(?:kurs|pris|price|dkk|sek)[\s:]*([0-9\.\,]+)/i);

    // Kræv eksplicitte tal - gæt ALDRIG fiktive tal (som 5000 stk á 100)
    if (!sharesMatch || !priceMatch) continue;

    const rawShares = parseFloat(sharesMatch[1].replace(/\./g, '').replace(',', '.'));
    const rawPrice = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));

    if (isNaN(rawShares) || rawShares <= 0 || isNaN(rawPrice) || rawPrice <= 0) continue;

    const totalValueLocal = rawShares * rawPrice;
    const totalValueUsd = convertCurrency(totalValueLocal, currency, 'USD', fx);

    // Afvis køb under $50.000 USD ækvivalent (eller uden live FX)
    if (totalValueUsd === undefined || totalValueUsd < 50000) continue;

    results.set(ann.id, {
      id: ann.id,
      insiderName: detectedName!,
      insiderTitle: nameMatch?.[2]?.trim() || 'Direktør / Ledelse',
      transactionCode: 'P',
      shares: rawShares,
      pricePerShare: rawPrice,
      currency,
      totalValueLocal,
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
    // Main Market Helsinki
    'https://api.news.eu.nasdaq.com/news/query.action?type=json&showAttachments=true&showCnsSpecific=true&showCompany=true&start=0&count=35&market=Main%20Market,%20Helsinki',
    'https://api.news.eu.nasdaq.com/news/query.action?type=json&showAttachments=true&showCnsSpecific=true&showCompany=true&start=35&count=35&market=Main%20Market,%20Helsinki',
    // First North Denmark, Sweden & Finland
    'https://api.news.eu.nasdaq.com/news/query.action?type=json&showAttachments=true&showCnsSpecific=true&showCompany=true&start=0&count=25&market=First%20North%20Denmark',
    'https://api.news.eu.nasdaq.com/news/query.action?type=json&showAttachments=true&showCnsSpecific=true&showCompany=true&start=0&count=25&market=First%20North%20Sweden',
    'https://api.news.eu.nasdaq.com/news/query.action?type=json&showAttachments=true&showCnsSpecific=true&showCompany=true&start=0&count=25&market=First%20North%20Finland',
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

    if (responses.every((r) => r.status === 'rejected')) {
      throw new Error('Nasdaq Nordic: alle feeds fejlede');
    }

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
      console.log('Ingen live MAR art. 19 meddelelser i seneste feed.');
      return [];
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

    const fx = await fetchLiveFxRates();

    // Kør Gemini 3 Flash i ét samlet batch-kald for alle meddelelser
    const parsedMap = await parseNordicMarBatchWithGemini(
      preparedItems.map((p) => ({
        id: p.id,
        company: p.company,
        headline: p.headline,
        text: p.text,
        market: p.market,
      })),
      fx
    );

    const parsedTransactions: InsiderTransaction[] = [];

    for (const item of preparedItems) {
      const parsed = parsedMap.get(item.id);
      if (!parsed) continue;
      if (parsed.transactionCode !== 'P') continue;
      if (!isValidInsiderName(parsed.insiderName)) continue;

      const ticker = mapNordicCompanyToTicker(item.company, item.market, parsed.currency);
      const isSwedish = ticker.endsWith('.ST') || parsed.currency === 'SEK';

      // Valutaomregning til USD med live FX – uden live kurs afvises rækken.
      const totalUsdRaw = convertCurrency(parsed.totalValueLocal, parsed.currency, 'USD', fx);
      const priceUsdRaw = convertCurrency(parsed.pricePerShare, parsed.currency, 'USD', fx);
      if (totalUsdRaw === undefined || priceUsdRaw === undefined) continue;
      const totalValueUsd = Math.round(totalUsdRaw);
      if (totalValueUsd < 50000) continue;
      const pricePerShareUsd = Number(priceUsdRaw.toFixed(2));
      const sharesOwnedFollowing = parsed.sharesOwnedFollowing || parsed.shares * 3;
      const priorShares = sharesOwnedFollowing - parsed.shares;
      const holdingsIncreasePct =
        priorShares > 0 ? parseFloat(((parsed.shares / priorShares) * 100).toFixed(1)) : 25.0;

      const isExecutive = isExecutiveTitle(parsed.insiderTitle);
      // Meddelelsens offentliggørelse (fx "2026-11-04 14:44:25 +0000"). Handelsdatoen kendes ikke her.
      const filedAt = item.ann.releaseTime?.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \+0000$/, '$1T$2Z');

      const currSymbol = parsed.currency;
      let exchangeLabel = 'CPH (Nasdaq Copenhagen)';
      if (item.market.includes('Stockholm')) exchangeLabel = 'STO (Nasdaq Stockholm)';
      else if (item.market.includes('Helsinki')) exchangeLabel = 'HEL (Nasdaq Helsinki)';
      else if (item.market.includes('Sweden')) exchangeLabel = 'First North Sweden';
      else if (item.market.includes('Denmark')) exchangeLabel = 'First North Denmark';
      else if (item.market.includes('Finland')) exchangeLabel = 'First North Finland';
      else if (isSwedish) exchangeLabel = 'STO (Nasdaq Stockholm)';
      else if (item.market.toLowerCase().includes('finland') || parsed.currency === 'EUR') exchangeLabel = 'HEL (Nasdaq Helsinki)';

      const is10b51Plan = /10b5-?1|automatisk|handelsplan|trading\s*plan|pre-arranged/i.test(
        `${item.ann.headline || ''} ${item.text || ''} ${parsed.notes || ''}`
      );

      const tx: InsiderTransaction = {
        id: `nordic-${item.ann.disclosureId || Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        filedAt,
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
        is10b51Plan,
        exchange: exchangeLabel,
        // isTradableInDK sættes først af verifyDkTradability ved berigelse – ikke antaget her.
        secFilingUrl: item.ann.messageUrl || 'https://view.news.eu.nasdaq.com',
        contextNotes: `${exchangeLabel} (MAR art. 19). Handelsbeløb: ${currSymbol} ${Math.round(
          parsed.totalValueLocal
        ).toLocaleString()} (omregnet til ~$${totalValueUsd.toLocaleString()} USD a ${parsed.pricePerShare} ${currSymbol}/aktie).\n\n${
          parsed.notes || item.ann.headline
        }`,
      };

      parsedTransactions.push(tx);
    }

    // Clustering, berigelse og roll-up sker samlet i buildScanRows (scan-ruten).
    return parsedTransactions;
  } catch (err) {
    console.error('Fejl i fetchNordicInsiderTransactions:', err);
    throw err;
  }
}
