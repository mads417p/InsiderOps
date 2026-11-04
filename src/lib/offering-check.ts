import { secFetch } from '@/lib/sec-client';

/**
 * Registrerede udbud (Rule 424(b)-prospekter) og deres kurs. Et insiderkøb på samme dato (±7 dage) og
 * præcis samme kurs som et udbud er sandsynligvis deltagelse i udbuddet/IPO'en – ikke et markedskøb
 * (RAPP 28.10.2026: Healy-fonde købte til udbudskursen $21,00; IPO 10.6.2024 til $17,00).
 */
export interface Offering {
  form: string; // 424B1 / 424B3 / 424B4 / 424B5
  filingDate: string; // YYYY-MM-DD
  price: number; // kurs pr. aktie fra prospektet
  url: string;
}

const OFFERING_FORM_RE = /^424B[1345]$/;
export const OFFERING_WINDOW_DAYS = 7;
const PRICE_TOLERANCE = 0.006; // "præcis samme kurs" – tillader $20,999 (pre-funded) mod $21,00

// Fodnoter, der siger, at købet skete i et udbud (samme mønster som 10b5-1: kun refererede fodnoter).
const OFFERING_FOOTNOTE_RE =
  /\b(?:initial public offering|IPO|public offering|underwrit(?:ten|ing|ers?)|private placement|registered direct|concurrent (?:equity )?offering)\b/i;

export const isOfferingFootnote = (text: string) => OFFERING_FOOTNOTE_RE.test(text);

const num = (s: string) => Number(s.replace(/,/g, ''));

/**
 * Kurser pr. aktie fra et prospekt (HTML eller tekst). Kun formuleringer med en fast pris pr. aktie;
 * ATM-programmer ("at-the-market") og obligationer ("99.5% of principal") giver ingen pris.
 */
export function extractOfferingPrices(htmlOrText: string): number[] {
  const text = htmlOrText
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#160;|&nbsp;|&#8195;/g, ' ')
    .replace(/&#36;/g, '$')
    .replace(/\s+/g, ' ');
  const patterns = [
    /offering price (?:of|is|was|will be)?\s*\$\s?(\d[\d,]*(?:\.\d+)?)\s*per share/gi, // "(initial) public offering price of $21.00 per share"
    /per share (?:purchase )?price (?:of|equal to)\s*\$\s?(\d[\d,]*(?:\.\d+)?)/gi, // "at a per share price of $21.00"
    /price to (?:the )?public of \$\s?(\d[\d,]*(?:\.\d+)?)\s*per share/gi,
  ];
  const prices = new Set<number>();
  for (const re of patterns) for (const m of text.matchAll(re)) {
    const p = num(m[1]);
    if (p > 0 && p < 100_000) prices.add(p);
  }
  return [...prices];
}

const DAY_MS = 86_400_000;
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / DAY_MS;

/** Udbuddet, et køb matcher: samme kurs (±$0,006) og prospekt inden for ±7 dage af handelsdatoen. */
export function matchOffering(
  buy: { tradeDate?: string; price: number },
  offerings: Offering[],
  days = OFFERING_WINDOW_DAYS
): Offering | undefined {
  if (!buy.tradeDate || !(buy.price > 0)) return undefined;
  return offerings.find((o) => Math.abs(o.price - buy.price) < PRICE_TOLERANCE && dayDiff(o.filingDate, buy.tradeDate!) <= days);
}

export const offeringNote = (o: Offering) =>
  `Mulig deltagelse i udbud: ${o.form} ${o.filingDate} til $${o.price.toFixed(2)} pr. aktie`;

type FilingRef = { form: string; filingDate: string; url: string };
const SUBMISSIONS_TTL_MS = 6 * 3600_000;
const submissionsCache = new Map<string, { at: number; filings: FilingRef[] }>();
const pricesByUrl = new Map<string, number[]>(); // prospekter ændres ikke

async function offeringFilings(cik: string): Promise<FilingRef[]> {
  const hit = submissionsCache.get(cik);
  if (hit && Date.now() - hit.at < SUBMISSIONS_TTL_MS) return hit.filings;
  const padded = cik.replace(/^0+/, '').padStart(10, '0');
  const res = await secFetch(`https://data.sec.gov/submissions/CIK${padded}.json`, { accept: 'application/json', timeoutMs: 20_000 });
  if (!res.ok) throw new Error(`SEC submissions for CIK ${cik} svarede ${res.status}`);
  // ponytail: kun filings.recent (de ca. 1.000 nyeste); ældre udbud hos selskaber med mange filings ses ikke.
  // Hent filings.files-siderne, hvis track record over 4 år mangler udbud for store selskaber.
  const r = (await res.json())?.filings?.recent;
  const filings: FilingRef[] = [];
  for (let i = 0; i < (r?.form?.length ?? 0); i++) {
    if (!OFFERING_FORM_RE.test(r.form[i])) continue;
    const acc = String(r.accessionNumber[i]).replace(/-/g, '');
    filings.push({
      form: r.form[i],
      filingDate: r.filingDate[i],
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${r.primaryDocument[i]}`,
    });
  }
  submissionsCache.set(cik, { at: Date.now(), filings });
  return filings;
}

/**
 * Udbud for udstederen nær de givne handelsdatoer. Kun prospekter inden for ±7 dage af mindst én dato
 * hentes (de kan være 0,5 MB). Kaster ved fejl i submissions-opslaget; et enkelt prospekt, der fejler,
 * springes over.
 */
export async function getOfferingsNear(cik: string, dates: string[], days = OFFERING_WINDOW_DAYS): Promise<Offering[]> {
  const valid = dates.filter((d) => !Number.isNaN(Date.parse(d?.slice(0, 10))));
  if (valid.length === 0) return [];
  const near = (await offeringFilings(cik)).filter((f) => valid.some((d) => dayDiff(f.filingDate, d) <= days));
  const out: Offering[] = [];
  for (const f of near) {
    let prices = pricesByUrl.get(f.url);
    if (!prices) {
      try {
        const res = await secFetch(f.url, { accept: 'text/html, text/plain', timeoutMs: 20_000 });
        if (!res.ok) throw new Error(`svarede ${res.status}`);
        prices = extractOfferingPrices(await res.text());
        pricesByUrl.set(f.url, prices);
      } catch (err) {
        console.warn(`Prospekt ${f.form} ${f.url} kunne ikke læses:`, err instanceof Error ? err.message : err);
        continue;
      }
    }
    for (const price of prices) out.push({ form: f.form, filingDate: f.filingDate, price, url: f.url });
  }
  return out;
}
