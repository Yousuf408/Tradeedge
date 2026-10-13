"""
python-rsi — TradingView RSI microservice
Step 4: Session cookie auth + Wilder's RSI(14)

Endpoints:
  GET /health                 — health check
  GET /rsi?symbol=BSOFT       — compute TradingView RSI for one symbol
  GET /rsi?symbols=BSOFT,TCS  — batch (comma-separated)
"""
import os
import time
from flask import Flask, jsonify, request
from tvDatafeed import TvDatafeed, Interval

app = Flask(__name__)

# ── TradingView connection (lazy, reused) ─────────────────────
_tv = None

def get_tv():
    global _tv
    if _tv is not None:
        return _tv

    sessionid = os.environ.get('TV_SESSIONID')

    if sessionid:
        print('🔌 Creating TvDatafeed with session cookie')
        _tv = TvDatafeed()
        # name-mangled private attrs in tvdatafeed library
        try:
            _tv._TvDatafeed__ws._TVWebsocket__auth_token = sessionid
            print('🔑 Session token injected')
        except Exception as e:
            print(f'⚠️ Could not inject session: {e}')
    else:
        print('🔌 Anonymous mode (no TV_SESSIONID)')
        _tv = TvDatafeed()

    return _tv


# ── Wilder's RMA RSI (TradingView-exact) ──────────────────────
def compute_rsi_wilder(closes, period=14):
    """
    Wilder's RSI with RMA smoothing — exactly as TradingView computes.
    Input: list of closes (oldest -> newest)
    Returns: RSI value (float) or None
    """
    if len(closes) < period + 1:
        return None

    # 1. price changes
    changes = [closes[i] - closes[i - 1] for i in range(1, len(closes))]

    # 2. gains / losses
    gains = [c if c > 0 else 0 for c in changes]
    losses = [-c if c < 0 else 0 for c in changes]

    # 3. seed: simple average of first `period`
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    # 4. Wilder's RMA smoothing
    for i in range(period, len(changes)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    # 5. RSI
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
            'last_candle_time': str(df.index[-1])
        }
    except Exception as e:
        return {'ok': False, 'symbol': symbol, 'error': str(e)}


# ── Routes ────────────────────────────────────────────────────
@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'ok': True,
        'service': 'python-rsi',
        'version': '1.0',
        'step': 4
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
            time.sleep(0.3)   # gentle pacing — TradingView rate limits
        return jsonify({'ok': True, 'results': results})

    if not symbol:
        return jsonify({'ok': False, 'error': 'symbol required'}), 400

    result = fetch_rsi(symbol, exchange=exchange, bars=bars)
    return jsonify(result)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
