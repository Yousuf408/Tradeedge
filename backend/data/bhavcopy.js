/* ============================================================
   bhavcopy.js — NSE Bhavcopy downloader + parser
   ============================================================

   Downloads the official NSE Bhavcopy ZIP (published ~6:30 PM IST),
   parses CSV, returns symbol → { open, high, low, close, volume }.

   Used by server.js to save day_high / day_low / day_close
   and compute pivot for the next trading day.

   Exports:
     - downloadBhavcopy(date)  → CSV text
     - parseBhavcopyCSV(csv)   → Map<symbol, OHLCV>
     - calcPivot(h, l, c)      → number | null
   ============================================================ */

import AdmZip from 'adm-zip';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BHAVCOPY_BASE = 'https://nsearchives.nseindia.com/content/cm';

/* Build the NSE bhavcopy URL for a given date.
   Format: BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip */
function bhavcopyUrl(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${BHAVCOPY_BASE}/BhavCopy_NSE_CM_0_0_0_${y}${m}${d}_F_0000.csv.zip`;
}

/* Classic pivot point = (H + L + C) / 3 */
export function calcPivot(high, low, close) {
  const h = +high, l = +low, c = +close;
  if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) return null;
  if (h <= 0 || l <= 0 || c <= 0) return null;
  return (h + l + c) / 3;
}

/* Download the ZIP from NSE and return the inner CSV as UTF-8 string. */
export async function downloadBhavcopy(date) {
  const url = bhavcopyUrl(date);
  console.log(`📥 Bhavcopy: downloading ${url}`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.nseindia.com/all-reports'
    }
  });

  if (!res.ok) {
    throw new Error(`Bhavcopy HTTP ${res.status} — file may not be published yet (usually after 6:30 PM IST)`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error('Bhavcopy ZIP too small — likely an error page');

  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  const csvEntry = entries.find(e => e.entryName.toLowerCase().endsWith('.csv'));
  if (!csvEntry) throw new Error('No CSV inside bhavcopy ZIP');

  return csvEntry.getData().toString('utf8');
}

/* Parse the bhavcopy CSV → Map<symbol, {open, high, low, close, volume}>.
   Filters to SctySrs === 'EQ' (equities only). */
export function parseBhavcopyCSV(csv) {
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return new Map();

  const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const idx = {
    sym:    header.indexOf('TckrSymb'),
    series: header.indexOf('SctySrs'),
    open:   header.indexOf('OpnPric'),
    high:   header.indexOf('HghPric'),
    low:    header.indexOf('LwPric'),
    close:  header.indexOf('ClsPric'),
    volume: header.indexOf('TtlTradgVol')
  };

  if (idx.sym < 0 || idx.high < 0 || idx.low < 0 || idx.close < 0) {
    throw new Error(`Unexpected bhavcopy header: ${header.slice(0, 15).join(',')}`);
  }

  const out = new Map();

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');

    /* Skip non-equity series */
    if (idx.series >= 0 && (parts[idx.series] || '').trim() !== 'EQ') continue;

    const sym = (parts[idx.sym] || '').trim();
    if (!sym) continue;

    const open   = parseFloat(parts[idx.open]);
    const high   = parseFloat(parts[idx.high]);
    const low    = parseFloat(parts[idx.low]);
    const close  = parseFloat(parts[idx.close]);
    const volume = parseInt(parts[idx.volume] || '0', 10);

    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
    if (high <= 0 || low <= 0 || close <= 0) continue;

    out.set(sym, { open, high, low, close, volume });
  }

  return out;
}
