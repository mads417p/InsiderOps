"""Henter rådata til research/data/ (gitignored). Alt caches pr. fil, så en afbrudt kørsel kan genoptages.

  fetch.py sec          SEC Form 345 (2006Q1→), submissions.zip, company_tickers_exchange.json, XBRL frames
  fetch.py prices       Yahoo chart v8 for symbolerne i data/symbols.txt (+ SPY, IWM, USDDKK=X)  [efter build.py tx]
  fetch.py prospectus   424B-prospekter i data/prospectus_needed.parquet → data/prospectus_prices.parquet  [efter build.py tx]
"""
from __future__ import annotations

import gzip
import json
import sys
import time
import urllib.parse
from datetime import date, datetime, timezone

import pandas as pd

from common import DATA, download, http_get

FORM345 = 'https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/{y}q{q}_form345.zip'
FRAMES = 'https://data.sec.gov/api/xbrl/frames/dei/EntityCommonStockSharesOutstanding/shares/CY{y}Q{q}I.json'
BENCH = ('SPY', 'IWM', 'USDDKK=X')
PRICE_START = int(datetime(2004, 12, 1, tzinfo=timezone.utc).timestamp())  # 250 bars før 2006


def quarters(start_year: int):
    today = date.today()
    for y in range(start_year, today.year + 1):
        for q in range(1, 5):
            if (y, q) < (today.year, (today.month - 1) // 3 + 1):  # kun afsluttede kvartaler
                yield y, q


def fetch_sec() -> None:
    missing = []
    for y, q in quarters(2006):
        if download(FORM345.format(y=y, q=q), DATA / 'form345' / f'{y}q{q}_form345.zip') is None:
            missing.append(f'{y}q{q}')
    print(f'Form 345: {len(list((DATA / "form345").glob("*.zip")))} kvartaler; ikke udgivet: {missing or "ingen"}')
    t = time.time()
    download('https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip', DATA / 'submissions.zip')
    print(f'submissions.zip: {(DATA / "submissions.zip").stat().st_size / 1e9:.2f} GB ({time.time() - t:.0f} s)')
    p = DATA / 'company_tickers_exchange.json'
    if not p.exists():
        p.write_bytes(http_get('https://www.sec.gov/files/company_tickers_exchange.json', sec=True))
    n = 0
    for y, q in quarters(2009):
        out = DATA / 'frames' / f'CY{y}Q{q}I.json'
        if out.exists():
            n += 1
            continue
        b = http_get(FRAMES.format(y=y, q=q), sec=True)
        if b:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b)
            n += 1
    print(f'XBRL frames: {n} kvartaler')


def fetch_prices() -> None:
    symbols = list(BENCH) + (DATA / 'symbols.txt').read_text(encoding='utf-8').split()
    out = DATA / 'yahoo'
    out.mkdir(parents=True, exist_ok=True)
    period2 = int(time.time())
    todo = [s for s in dict.fromkeys(symbols) if not (out / f'{s}.json.gz').exists() and not (out / f'{s}.missing').exists()]
    print(f'Yahoo: {len(symbols)} symboler, {len(todo)} mangler i cache')
    t, fails = time.time(), 0
    for i, s in enumerate(todo, 1):
        url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(s)}'
               f'?period1={PRICE_START}&period2={period2}&interval=1d&events=split')
        try:
            b = http_get(url, sec=False, timeout=30)
        except Exception as e:  # noqa: BLE001 – et enkelt symbol må ikke stoppe kørslen; tælles og rapporteres
            fails += 1
            print(f'  fejl {s}: {e}')
            continue
        ok = b and (json.loads(b).get('chart') or {}).get('result')
        if ok:
            (out / f'{s}.json.gz').write_bytes(gzip.compress(b))
        else:
            (out / f'{s}.missing').write_text('ingen data', encoding='utf-8')
        if i % 250 == 0:
            print(f'  {i}/{len(todo)} ({(time.time() - t) / i:.2f} s/symbol)')
    print(f'Yahoo færdig: {len(list(out.glob("*.json.gz")))} med data, {len(list(out.glob("*.missing")))} uden, {fails} fejl')


def fetch_prospectus() -> None:
    from common import extract_offering_prices
    need = pd.read_parquet(DATA / 'prospectus_needed.parquet')  # cik, accession, primary_doc, form, filing_date
    out = DATA / 'prospectus_prices.parquet'
    done = pd.read_parquet(out) if out.exists() else pd.DataFrame(columns=['accession', 'price'])
    seen = set(done.accession)
    todo = need[~need.accession.isin(seen)]
    print(f'Prospekter: {len(need)} nødvendige, {len(todo)} mangler')
    rows = []
    for i, r in enumerate(todo.itertuples(), 1):
        url = f'https://www.sec.gov/Archives/edgar/data/{int(r.cik)}/{r.accession.replace("-", "")}/{r.primary_doc}'
        try:
            b = http_get(url, sec=True, timeout=60)
        except Exception as e:  # noqa: BLE001 – appen springer også et enkelt prospekt over
            print(f'  fejl {url}: {e}')
            continue
        prices = extract_offering_prices(b.decode('utf-8', 'replace')) if b else []
        rows += [{'accession': r.accession, 'price': p} for p in prices] or [{'accession': r.accession, 'price': float('nan')}]
        if i % 500 == 0:
            pd.concat([done, pd.DataFrame(rows)]).to_parquet(out)
            print(f'  {i}/{len(todo)}')
    pd.concat([done, pd.DataFrame(rows)]).to_parquet(out)


if __name__ == '__main__':
    {'sec': fetch_sec, 'prices': fetch_prices, 'prospectus': fetch_prospectus}[sys.argv[1] if len(sys.argv) > 1 else 'sec']()
