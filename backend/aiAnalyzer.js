import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

// Lightweight Prompt: No JSON, just raw numbers
const getSystemPrompt = (sym, dailyPrices, m15Prices) => `
You are an Institutional Price Action Expert. Analyze the data for ${sym}.

DATA:
- Daily Closes (Last 15 days, oldest to newest): ${dailyPrices}
- 5-Min Closes (Last 2 days): ${m15Prices}

RULES:
1. Identify major Support/Resistance.
2. Look for liquidity traps (fake breakouts).
3. If choppy, return "no_trade": true.
4. Calculate: BUY Trigger, BUY SL, BUY T1, BUY T2, SELL Trigger, SELL SL, SELL T1, SELL T2.

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
    if (!process.env.DEEPSEEK_API_KEY) {
       console.log('⚠️ Skipped AI for', sym, '- No API key.');
       return null;
    }

    const dailyRes = await db.query(
      `SELECT day_close FROM strategy_bs_snapshot 
       WHERE token = $1 AND date <= CURRENT_DATE 
       ORDER BY date ASC LIMIT 15`, [token]
    );

    const m15Res = await db.query(
      `SELECT ws_5min_close FROM strategy_bs_snapshot 
       WHERE token = $1 AND date <= CURRENT_DATE 
       ORDER BY date ASC LIMIT 2`, [token]
    );
    
    if (!dailyRes.rows.length || !m15Res.rows.length) return null;

    // Convert arrays to simple comma-separated strings
    const dailyPrices = dailyRes.rows.map(r => r.day_close).join(', ');
    const m15Prices = m15Res.rows.map(r => (r.ws_5min_close || []).join(', ')).join(' | ');

    const response = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: getSystemPrompt(sym, dailyPrices, m15Prices) }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const plan = JSON.parse(response.choices[0].message.content);
    if (plan.no_trade) return plan;

    // Save to Neon
    if (plan.buy_plan || plan.sell_plan) {
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
    if (error.message.includes('402')) {
       console.error('🛑 AI Error: Insufficient Balance in DeepSeek API.');
    } else {
       console.error(`❌ AI Error for ${sym}:`, error.message);
    }
    return null;
  }
}
