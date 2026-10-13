/* ============================================================
   nse-fetch-test.js — standalone test (no DB, no server)
   Purpose: check if openchart-js can fetch 3 days of 1-min
   candles for 378 NSE stocks without getting blocked.

   Usage:  node nse-fetch-test.js
   Output: console logs + ./nse-test-output.json
   ============================================================ */

import NSEData from 'openchart';
import moment from 'moment';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

// Load stock list
const ALL_STOCKS = JSON.parse(
  readFileSync(join(__dir, 'brokers/angelone/Angel_nifty500.json'), 'utf8')
);
const STOCKS = ALL_STOCKS.filter(s => !s.disabled);

console.log(`📋 Testing ${STOCKS.length} stocks`);

// Config
const DAYS_BACK = 3;
const DELAY_BETWEEN_STOCKS_MS = 250;   // be nice to NSE
const SAVE_EVERY = 25;                 // dump partial results
const OUTPUT_FILE = join(__dir, 'nse-test-output.json');

async function main() {
  const nse = new NSEData();

  console.log('⏳ Downloading NSE master list...');
  await nse.download();
  console.log('✅ Master downloaded');

  const endDate = moment().subtract(1, 'days').toDate();   // yesterday (today incomplete)
  const startDate = moment().subtract(DAYS_BACK + 3, 'days').toDate();  // extra buffer for weekends

  const results = {};
  let ok = 0, empty = 0, failed = 0;
  const t0 = Date.now();

  for (let i = 0; i < STOCKS.length; i++) {
    const s = STOCKS[i];
    const sym = s.sym.replace(/-EQ$/, '');

    try {
      const data = await nse.historical(sym, 'NSE', startDate, endDate, '1m');

      if (!data || !data.length) {
        empty++;
        results[sym] = { ok: false, reason: 'no_data' };
      } else {
        ok++;
        results[sym] = {
          ok: true,
          candles: data.length,
          first: data[0],
          last: data[data.length - 1]
        };
      }
    } catch (e) {
      failed++;
      results[sym] = { ok: false, reason: e.message };
    }

    if ((i + 1) % 25 === 0 || i === STOCKS.length - 1) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`📊 ${i + 1}/${STOCKS.length} | ok=${ok} empty=${empty} failed=${failed} | ${elapsed}s`);
      // save partial
      writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    }

    await new Promise(r => setTimeout(r, DELAY_BETWEEN_STOCKS_MS));
  }

  console.log('═══════════════════════════════════════');
  console.log(`✅ DONE in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`   ok=${ok}  empty=${empty}  failed=${failed}`);
  console.log(`   Saved: ${OUTPUT_FILE}`);
  console.log('═══════════════════════════════════════');

  // Show 5 samples
  console.log('\nSample results:');
  Object.entries(results).slice(0, 5).forEach(([sym, r]) => {
    console.log(`  ${sym}: ${JSON.stringify(r).slice(0, 200)}`);
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
