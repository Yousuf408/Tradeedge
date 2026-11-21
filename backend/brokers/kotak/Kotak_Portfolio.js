/* ============================================================
   Kotak_Portfolio.js — Margins, Positions & Holdings for Kotak
   ============================================================
   Features:
   1. Fetch live account limits (Margins).
   2. Fetch open intraday positions.
   3. Fetch delivery holdings.
   4. Multi-user safe: Uses userId to authenticate API calls.
   ============================================================ */

import { getKotakSession } from './Kotak_Auth.js';

// Helper for GET requests
async function kotakGet(userId, endpoint) {
  const session = getKotakSession(userId);
  if (!session) {
    throw new Error('Kotak session not found or expired. Please login again.');
  }

  const url = `${session.baseUrl}${endpoint}`;
  const headers = {
    'Auth': session.token,
    'Sid': session.sid,
    'neo-fin-key': 'neotradeapi'
  };

  const res = await fetch(url, { method: 'GET', headers });
  const data = await res.json();

  if (data.stat !== 'Ok') {
    throw new Error(data.emsg || data.message || 'Failed to fetch data');
  }

  return data;
}

/**
 * Get Account Margins (Limits)
 * Useful to check if the user has enough balance before placing an order.
 */
export async function getMargins(userId) {
  try {
    const data = await kotakGet(userId, '/quick/user/limits');
    // Kotak returns an array or object depending on the API version
    const limits = Array.isArray(data.data) ? data.data[0] : data.data;
    
    return {
      success: true,
      availableCash: parseFloat(limits?.Net || 0),
      collateral: parseFloat(limits?.CollateralValue || 0),
      raw: limits
    };
  } catch (error) {
    console.error(`❌ [Kotak] Fetch Margins Failed for ${userId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Get Intraday Positions
 * Used to track open trades for MIS (Intraday) or MTF.
 */
export async function getPositions(userId) {
  try {
    const data = await kotakGet(userId, '/quick/user/positions');
    
    // Map Kotak's format to a cleaner format for our app
    const positions = (data.data || []).map(p => ({
      sym: p.trdSym,
      qty: parseInt(p.netQty),
      avgPrice: parseFloat(p.avgPrc),
      ltp: parseFloat(p.ltp),
      pnl: parseFloat(p.upl || 0),
      product: p.prod, // CNC, MIS, MTF
      raw: p
    }));

    return { success: true, positions };
  } catch (error) {
    console.error(`❌ [Kotak] Fetch Positions Failed for ${userId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Get Delivery Holdings (Portfolio)
 * Used for CNC (Delivery) trades.
 */
export async function getHoldings(userId) {
  try {
    const data = await kotakGet(userId, '/quick/user/holdings');
    
    // Map Kotak's format to a cleaner format for our app
    const holdings = (data.data || []).map(h => ({
      sym: h.trdSym,
      qty: parseInt(h.qty),
      avgPrice: parseFloat(h.avgPrc),
      ltp: parseFloat(h.ltp),
      pnl: parseFloat(h.upl || 0),
      raw: h
    }));

    return { success: true, holdings };
  } catch (error) {
    console.error(`❌ [Kotak] Fetch Holdings Failed for ${userId}:`, error.message);
    return { success: false, error: error.message };
  }
}
