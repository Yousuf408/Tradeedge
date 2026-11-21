/* ============================================================
   Kotak_Orders.js — Order Execution for Kotak Neo
   ============================================================
   Features:
   1. Place, Modify, Cancel orders.
   2. Supports CNC (Delivery), MIS (Intraday), and MTF.
   3. Multi-user: Uses the userId to fetch the correct session.
   ============================================================ */

import { getKotakSession } from './Kotak_Auth.js';

// Helper to make Kotak API requests
async function kotakRequest(userId, endpoint, method, payloadJson) {
  const session = getKotakSession(userId);
  if (!session) {
    throw new Error('Kotak session not found or expired. Please login again.');
  }

  const url = `${session.baseUrl}${endpoint}`;
  const headers = {
    'Auth': session.token,
    'Sid': session.sid,
    'neo-fin-key': 'neotradeapi',
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  const options = { method, headers };

  if (method === 'POST' || method === 'PUT') {
    // Kotak requires the JSON string to be passed as 'jData' in urlencoded format
    options.body = new URLSearchParams({ jData: JSON.stringify(payloadJson) });
  }

  const res = await fetch(url, options);
  const data = await res.json();

  // Kotak usually returns { stat: "Ok", ... } on success, or an error structure
  if (data.stat !== 'Ok' && !data.nOrdNo) {
    throw new Error(data.emsg || data.message || 'Order execution failed');
  }

  return data;
}

/**
 * Place an Order
 * @param {string} userId - Unique User ID
 * @param {Object} order - { sym, qty, side, price, type, product, triggerPrice }
 */
export async function placeOrder(userId, order) {
  try {
    const isBuy = order.side.toUpperCase() === 'BUY';
    
    // Map product types: CNC (Delivery), MIS (Intraday), MTF (Margin)
    const validProducts = ['CNC', 'MIS', 'MTF'];
    const product = validProducts.includes(order.product?.toUpperCase()) 
                    ? order.product.toUpperCase() 
                    : 'MIS'; // Default to Intraday

    const payload = {
      am: "NO",                                // Algo Name (None)
      dq: "0",                                 // Disclosed Quantity
      es: "nse_cm",                            // Exchange Segment (NSE Cash)
      mp: "0",                                 // Market Protection
      pc: product,                             // Product Code (CNC/MIS/MTF)
      pf: "N",                                 // Portfolio Flag
      pr: String(order.price || "0"),          // Price (0 for Market)
      pt: order.type?.toUpperCase() || "MKT",  // Price Type (MKT/L)
      qt: String(order.qty),                   // Quantity
      rt: "DAY",                               // Retention Type (DAY/IOC)
      tp: String(order.triggerPrice || "0"),   // Trigger Price (For SL)
      ts: order.sym,                           // Trading Symbol (e.g., INFY-EQ)
      tt: isBuy ? "B" : "S"                    // Transaction Type (Buy/Sell)
    };

    const res = await kotakRequest(userId, '/quick/order/rule/ms/place', 'POST', payload);
    console.log(`✅ [Kotak] Order Placed for ${userId}: ${res.nOrdNo} (${order.sym} ${order.side})`);
    
    return { success: true, orderId: res.nOrdNo, raw: res };

  } catch (error) {
    console.error(`❌ [Kotak] Place Order Failed for ${userId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Modify an existing Order
 * @param {string} userId - Unique User ID
 * @param {Object} order - { orderId, qty, price, type }
 */
export async function modifyOrder(userId, order) {
  try {
    const payload = {
      am: "NO",
      no: String(order.orderId),               // Order ID to modify
      pr: String(order.price || "0"),          // New Price
      pt: order.type?.toUpperCase() || "MKT",  // Price Type
      qt: String(order.qty),                   // New Quantity
      rt: "DAY",                               // Retention Type
      tp: String(order.triggerPrice || "0"),   // New Trigger Price
      vd: "DAY"                                // Validity
    };

    const res = await kotakRequest(userId, '/quick/order/rule/ms/modify', 'POST', payload);
    console.log(`✅ [Kotak] Order Modified for ${userId}: ${order.orderId}`);
    
    return { success: true, raw: res };

  } catch (error) {
    console.error(`❌ [Kotak] Modify Order Failed for ${userId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Cancel an existing Order
 * @param {string} userId - Unique User ID
 * @param {string} orderId - Order ID to cancel
 */
export async function cancelOrder(userId, orderId) {
  try {
    const payload = {
      am: "NO",
      no: String(orderId)
    };

    const res = await kotakRequest(userId, '/quick/order/rule/ms/cancel', 'POST', payload);
    console.log(`✅ [Kotak] Order Cancelled for ${userId}: ${orderId}`);
    
    return { success: true, raw: res };

  } catch (error) {
    console.error(`❌ [Kotak] Cancel Order Failed for ${userId}:`, error.message);
    return { success: false, error: error.message };
  }
}
