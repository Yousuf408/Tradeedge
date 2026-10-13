/* ============================================================
   nse-fetch-test.js — Standalone NSE 1-min candle test
   Purpose: Verify openchart-js can fetch 3 days of 1-min data
   for all active NSE stocks without getting blocked.
   ============================================================ */

import NSEData from 'openchart-js';
import moment from 'moment';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

// Load your stock list
const ALL_STOCKS = JSON.parse(
  readFileSync(join(__dir, 'brokers/angelone/Angel_nifty500.json'), 'utf8')
);
const STOCKS = ALL_STOCKS.filter(s => !s.disabled);

console.log(`📋 Testing ${STOCKS.length} stocks`);

const DAYS_BACK = 3;
const DELAY_MS = 300;        // Delay between stocks to be gentle on NSE
const OUTPUT_FILE = join(__dir, 'nse-test-output.json');

async function main() {
  const nse = new NSEData();
  console.log('⏳ Downloading NSE master data...');
  await nse.download();
  console.log('✅ Master data downloaded');

  // Use dates from 5 days ago to yesterday to account for weekends/holidays
  const endDate = moment().subtract(1, 'days').toDate();
  const startDate = moment().subtract(DAYS_BACK + 4, 'days').toDate();

  const results = {};
  let ok = 0, empty = 0, failed = 0;
  const t0 = Date.now();

  for (let i = 0; i < STOCKS.length; i++) {
    const stock = STOCKS[i];
    const symbol = stock.sym.replace(/-EQ$/, '');   // e.g., 'BSOFT'
    try {
      const data = await nse.historical(symbol, 'NSE', startDate, endDate, '1m');

      if (!data || data.length === 0) {
        empty++;
        results[symbol] = { ok: false, reason: 'no_data' };
      } else {
        ok++;
        results[symbol] = {
          ok: true,
          candles: data.length,
          first: data[0],
          last: data[data.length - 1]
        };
      }
    } catch (err) {
      failed++;
      results[symbol] = { ok: false, reason: err.message };
    }

    // Log progress every 25 stocks
    if ((i + 1) % 25 === 0 || i === STOCKS.length - 1) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`📊 ${i + 1}/${STOCKS.length} | ok=${ok} empty=${empty} failed=${failed} | ${elapsed}s`);
      writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));   // Save partial
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log('═══════════════════════════════════════');
  console.log(`✅ DONE in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`   ok=${ok}  empty=${empty}  failed=${failed}`);
  console.log(`   Saved: ${OUTPUT_FILE}`);
  console.log('═══════════════════════════════════════');

  // Print a sample
  console.log('\nSample results (first 5):');
  Object.entries(results).slice(0, 5).forEach(([sym, r]) => {
    console.log(`  ${sym}: ${JSON.stringify(r).slice(0, 150)}...`);
  });

  // Error breakdown
  const errors = {};
  Object.values(results).forEach(r => {
    if (!r.ok && r.reason) errors[r.reason] = (errors[r.reason] || 0) + 1;
  });
  if (Object.keys(errors).length) {
    console.log('\nError breakdown:');
    Object.entries(errors).forEach(([e, c]) => console.log(`  ${c}x  ${e}`));
  }
}

main().catch(e => {
  console.error('💥 Fatal:', e);
  process.exit(1);
});
