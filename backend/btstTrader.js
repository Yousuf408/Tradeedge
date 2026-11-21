/* ============================================================
   btstTrader.js — BTST Execution Engine
   ============================================================
   Listens for breakouts on the watchlist and places orders.
   Supports PAPER and REAL trading modes.
   ============================================================ */

import { placeOrder } from './brokers/kotak/Kotak_Orders.js';

// In-memory watchlists per user: Map<userId, Array<{ sym, token, mother_high, triggered }>>
const activeWatchlists = new Map();

// Simulated positions for paper trading
const paperPositions = new Map();

/**
 * Load a new BTST watchlist for a user
 */
export function startBtstWatchlist(userId, stocks) {
  // Format stocks to include a 'triggered' flag
  const list = stocks.map(s => ({
    sym: s.sym,
    token: String(s.token),
    mother_high: Number(s.mother_high),
    triggered: false
  }));

  activeWatchlists.set(userId, list);
  console.log(`🎯 [BTST Engine] Watchlist started for User ${userId} (${list.length} stocks)`);
  return list.length;
}

/**
 * Stop monitoring
 */
export function stopBtstWatchlist(userId) {
  activeWatchlists.delete(userId);
  console.log(`🛑 [BTST Engine] Watchlist stopped for User ${userId}`);
}

/**
 * Main Tick Handler — Call this from your WebSocket loop for every price update
 * @param {Object} ticks - { "token": LTP, ... }
 * @param {string} userId - The user whose watchlist we are checking
 * @param {Object} config - { tradeMode: 'PAPER' | 'REAL', productType: 'MIS' | 'CNC' | 'MTF', qty: 10 }
 */
export async function onBtstTick(ticks, userId, config) {
  const watchlist = activeWatchlists.get(userId);
  if (!watchlist || watchlist.length === 0) return;

  for (const [token, price] of Object.entries(ticks)) {
    const stock = watchlist.find(s => s.token === token);
    
    // If stock is in watchlist, hasn't triggered yet, and price breaks Mother High
    if (stock && !stock.triggered && Number(price) > stock.mother_high) {
      stock.triggered = true;
      console.log(`🚀 [BTST Engine] BREAKOUT! ${stock.sym} crossed ₹${stock.mother_high} at ₹${price}`);

      // Execute Trade
      await executeTrade(userId, stock, price, config);
    }
  }
}

/**
 * Execute the trade based on PAPER or REAL mode
 */
async function executeTrade(userId, stock, entryPrice, config) {
  const { tradeMode = 'PAPER', productType = 'MIS', qty = 1 } = config;

  if (tradeMode === 'PAPER') {
    // --- PAPER TRADING ---
    const paperKey = `${userId}_${stock.sym}`;
    paperPositions.set(paperKey, {
      sym: stock.sym,
      entry: entryPrice,
      qty: qty,
      time: new Date().toISOString()
    });
    console.log(`📝 [BTST Engine] PAPER TRADE: Bought ${qty} x ${stock.sym} @ ₹${entryPrice}`);
    return;
  }

  // --- REAL TRADING (Kotak) ---
  console.log(`💸 [BTST Engine] REAL TRADE: Sending order to Kotak for ${stock.sym}...`);
  
  const orderPayload = {
    sym: stock.sym, // Note: Ensure this matches Kotak's symbol format (e.g., INFY-EQ)
    qty: qty,
    side: 'BUY',
    price: 0, // 0 = Market Order
    type: 'MKT',
    product: productType // MIS, CNC, MTF
  };

  const result = await placeOrder(userId, orderPayload);
  
  if (result.success) {
    console.log(`✅ [BTST Engine] Real order placed successfully. Order ID: ${result.orderId}`);
    // Here you would typically save this to your database 'auto_positions' table
  } else {
    console.error(`❌ [BTST Engine] Real order failed: ${result.error}`);
    // Optionally, reset stock.triggered = false if the order failed so it tries again
    stock.triggered = false; 
  }
}
