"""
python-rsi — TradingView RSI microservice
Step 1: health check only
"""
from flask import Flask, jsonify

app = Flask(__name__)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'ok': True,
        'service': 'python-rsi',
        'version': '1.0',
        'step': 1
    })

@app.route('/', methods=['GET'])
def root():
    return jsonify({'ok': True, 'msg': 'python-rsi service alive'})

if __name__ == '__main__':
    import os
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
