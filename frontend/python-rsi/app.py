"""
python-rsi — TradingView RSI microservice (real-time version)
Uses TradingView-Screener with session cookie authentication.
"""
import os
from flask import Flask, jsonify, request
from tradingview_screener import Query

app = Flask(__name__)

# ── Load cookies from environment or file ─────────────────────
# Option A: Set TV_SESSIONID env var (extract from browser)
# Option B: Use rookiepy to auto-extract (see below)
TV_SESSIONID = os.environ.get('TV_SESSIONID', '')

def get_cookies():
    """Return cookies dict for TradingView authentication."""
    if TV_SESSIONID:
        return {'sessionid': TV_SESSIONID}
    # Alternative: auto-extract with rookiepy (install: pip install rookiepy)
    # import rookiepy
    # return rookiepy.to_cookiejar(rookiepy.chrome(['.tradingview.com']))
    return None

# ── Fetch RSI directly from TradingView screener ───────────────
def fetch_rsi(symbol, exchange='NSE', interval='1'):
    """
    Get RSI directly from TradingView's screener API.
    interval: '1', '5', '15', '60', '240', '1D' etc.
    """
    try:
        cookies = get_cookies()
        
        # Build query: select RSI for the given timeframe
        # 'RSI|1' means RSI on 1-minute chart, 'RSI|60' on 1-hour, etc.
        rsi_field = f'RSI|{interval}'
        
        q = (Query()
             .select('name', 'close', rsi_field, 'update_mode')
             .where(
                 Query().symbol == symbol,
                 Query().exchange == exchange
             )
             .limit(1))
        
        _, df = q.get_scanner_data(cookies=cookies)
        
        if df is None or df.empty:
            return {'ok': False, 'symbol': symbol, 'error': 'no_data'}
        
        row = df.iloc[0]
        return {
            'ok': True,
            'symbol': symbol,
            'rsi': round(float(row[rsi_field]), 2),
            'last_close': round(float(row['close']), 2),
            'update_mode': row['update_mode'],  # 'streaming' = real-time
            'interval': interval
        }
    except Exception as e:
        return {'ok': False, 'symbol': symbol, 'error': str(e)}

# ── Routes ────────────────────────────────────────────────────
@app.route('/health', methods=['GET'])
def health():
    return jsonify({'ok': True, 'service': 'python-rsi', 'version': '2.0'})

@app.route('/rsi', methods=['GET'])
def rsi_endpoint():
    symbol = request.args.get('symbol', '').strip().upper()
    symbols = request.args.get('symbols', '').strip().upper()
    exchange = request.args.get('exchange', 'NSE').upper()
    interval = request.args.get('interval', '1')  # 1m default

    if symbols:
        sym_list = [s.strip() for s in symbols.split(',') if s.strip()]
        results = [fetch_rsi(s, exchange=exchange, interval=interval) for s in sym_list]
        return jsonify({'ok': True, 'results': results})

    if not symbol:
        return jsonify({'ok': False, 'error': 'symbol required'}), 400

    return jsonify(fetch_rsi(symbol, exchange=exchange, interval=interval))

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
