"""
python-rsi — TradingView RSI microservice
Step 6: Freshness Check & Session Fix
"""

import os
import time
import datetime
from flask import Flask, jsonify, request
from tvDatafeed import TvDatafeed, Interval

app = Flask(__name__)

# ── TradingView connection ─────────────────────
_tv = None

def get_tv():
    global _tv
    # Fresh session banayenge taaki cached/stale data na aaye
    sessionid = os.environ.get('TV_SESSIONID')

    if sessionid:
        print('🔌 Creating TvDatafeed with session token')
        try:
            _tv = TvDatafeed(token=sessionid)
        except Exception as e:
            print(f'⚠️ Token method failed: {e}')
            _tv = TvDatafeed()
    else:
        print('🔌 Anonymous mode (no TV_SESSIONID)')
        _tv = TvDatafeed()

    return _tv

# ── Wilder's RMA RSI (TradingView-exact) ──────────────────────
def compute_rsi_wilder(closes, period=14):
    if len(closes) < period + 1:
        return None

    changes = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [c if c > 0 else 0 for c in changes]
    losses = [-c if c < 0 else 0 for c in changes]

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(changes)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))

# ── Fetch candles from TradingView + compute RSI ──────────────
def fetch_rsi(symbol, exchange='NSE', interval=Interval.in_1_minute, bars=100):
    try:
        tv = get_tv()
        df = tv.get_hist(
            symbol=symbol,
            exchange=exchange,
            interval=interval,
            n_bars=bars
        )
        
        if df is None or df.empty:
            return {'ok': False, 'symbol': symbol, 'error': 'no_data'}

        # ✅ STALE DATA CHECK (Sabse important fix)
        last_candle_time = df.index[-1]
        
        # Timezone handle karna (NSE ke liye IST aata hai, par safe side check lagayenge)
        if last_candle_time.tzinfo is None:
            # Agar timezone nahi hai, toh IST (UTC+5:30) maan lenge
            now = datetime.datetime.utcnow() + datetime.timedelta(hours=5, minutes=30)
        else:
            now = datetime.datetime.now(last_candle_time.tzinfo)

        # Agar aakhri candle 15 minute se purani hai, toh matlab session expire hai
        time_diff = (now - last_candle_time).total_seconds()
        if time_diff > 900: # 15 mins * 60 secs
            return {
                'ok': False, 
                'symbol': symbol, 
                'error': 'stale_data_session_expired', 
                'last_candle_time': str(last_candle_time)
            }

        closes = df['close'].tolist()
        rsi = compute_rsi_wilder(closes, period=14)
        
        if rsi is None:
            return {'ok': False, 'symbol': symbol, 'error': 'insufficient_candles'}

        return {
            'ok': True,
            'symbol': symbol,
            'rsi': round(rsi, 2),
            'candles': len(closes),
            'last_close': round(closes[-1], 2),
            'last_candle_time': str(last_candle_time)
        }
    except Exception as e:
        return {'ok': False, 'symbol': symbol, 'error': str(e)}


# ── Routes ────────────────────────────────────────────────────
@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'ok': True,
        'service': 'python-rsi',
        'version': '1.1',
        'step': 6
    })

@app.route('/', methods=['GET'])
def root():
    return jsonify({'ok': True, 'msg': 'python-rsi service alive'})

@app.route('/rsi', methods=['GET'])
def rsi_endpoint():
    symbol = request.args.get('symbol', '').strip().upper()
    symbols = request.args.get('symbols', '').strip().upper()
    exchange = request.args.get('exchange', 'NSE').upper()
    bars = int(request.args.get('bars', 100))

    if symbols:
        sym_list = [s.strip() for s in symbols.split(',') if s.strip()]
        results = []
        for s in sym_list:
            results.append(fetch_rsi(s, exchange=exchange, bars=bars))
            time.sleep(0.5)   # Rate limit safe
        return jsonify({'ok': True, 'results': results})

    if not symbol:
        return jsonify({'ok': False, 'error': 'symbol required'}), 400

    result = fetch_rsi(symbol, exchange=exchange, bars=bars)
    return jsonify(result)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
