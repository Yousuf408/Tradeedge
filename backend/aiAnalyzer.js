import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

const getSystemPrompt = (sym, daily, m15, m5) => `
You are an Institutional Price Action Expert. Analyze the multi-timeframe data for ${sym} and create a Two-Sided Trading Plan (Buy and Sell) for tomorrow's intraday session.

DATA:
- Daily Candles (Last 15 days): ${JSON.stringify(daily)}
- 15-Min Candles (Last 2 days): ${JSON.stringify(m15)}
- 5-Min Candles (Last 1 day): ${JSON.stringify(m5)}

RULES:
1. Identify major Support/Resistance from Daily and 15-Min data.
2. Look for liquidity traps (fake breakouts).
3. If the setup is choppy or no clear edge, return "no_trade": true.
4. If a valid setup exists, calculate:
   - BUY Trigger: Price to break above.
   - BUY SL: Strictly below the recent swing low.
   - BUY T1, T2: Logical resistance levels.
   - SELL Trigger: Price to break below.
   - SELL SL: Strictly above the recent swing high.
   - SELL T1, T2: Logical support levels.

OUTPUT STRICT JSON ONLY:
{
  "sym": "${sym}",
  "no_trade": false,
  "buy_plan": { "trigger": 0.0, "sl": 0.0, "t1": 0.0, "t2": 0.0 },
  "sell_plan": { "trigger": 0.0, "sl": 0.0, "t1": 0.0, "t2": 0.0 },
  "reasoning": "Brief 1-sentence explanation"
}
`;

export async function generateAIPlan(db, token, sym) {
  try {
    const dailyRes = await db.query(
      `SELECT date, day_open, day_high, day_low, day_close, volume 
       FROM strategy_bs_snapshot 
       WHERE token = $1 AND date <= CURRENT_DATE 
       ORDER BY date DESC LIMIT 15`, [token]
    );

    const m15Res = await db.query(
      `SELECT date, ws_5min_close 
       FROM strategy_bs_snapshot 
       WHERE token = $1 AND date <= CURRENT_DATE 
       ORDER BY date DESC LIMIT 2`, [token]
    );
    
    const m5Res = m15Res.rows[0] || {}; 
    const daily = dailyRes.rows;
    const m15 = m15Res.rows;
    const m5 = m5Res.ws_5min_close || [];

    if (!daily.length || !m15.length) return null;

    const response = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: getSystemPrompt(sym, daily, m15, m5) }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const plan = JSON.parse(response.choices[0].message.content);

    if (plan.no_trade) return plan;

    if (plan.buy_plan || plan.sell_plan) {
      // SAVE FOR TOMORROW (CURRENT_DATE + 1)
      await db.query(`
        INSERT INTO ai_trade_plans 
        (date, sym, token, buy_trigger, buy_sl, buy_t1, buy_t2, sell_trigger, sell_sl, sell_t1, sell_t2, reasoning)
        VALUES (CURRENT_DATE + 1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (date, sym) DO UPDATE SET
          buy_trigger=EXCLUDED.buy_trigger, buy_sl=EXCLUDED.buy_sl, buy_t1=EXCLUDED.buy_t1, buy_t2=EXCLUDED.buy_t2,
          sell_trigger=EXCLUDED.sell_trigger, sell_sl=EXCLUDED.sell_sl, sell_t1=EXCLUDED.sell_t1, sell_t2=EXCLUDED.sell_t2,
          reasoning=EXCLUDED.reasoning
      `, [
        sym, token,
        plan.buy_plan?.trigger || null, plan.buy_plan?.sl || null, plan.buy_plan?.t1 || null, plan.buy_plan?.t2 || null,
        plan.sell_plan?.trigger || null, plan.sell_plan?.sl || null, plan.sell_plan?.t1 || null, plan.sell_plan?.t2 || null,
        plan.reasoning || ''
      ]);
    }

    return plan;
  } catch (error) {
    console.error(`❌ AI Error for ${sym}:`, error.message);
    return null;
  }
}
