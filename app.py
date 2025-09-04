from flask import Flask, jsonify, send_from_directory, request, abort, g
import os, json, time
from pathlib import Path
import logging
from logging.handlers import RotatingFileHandler

app = Flask(__name__, static_folder='static')
DATA_DIR = os.path.join(os.path.dirname(__file__), 'comparison_result')

logger = logging.getLogger("exp")
logger.setLevel(logging.INFO)
os.makedirs("logs", exist_ok=True)
fh = RotatingFileHandler("logs/server.log", maxBytes=2*1024*1024, backupCount=3, encoding="utf-8")
fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
logger.addHandler(fh)

@app.before_request
def _start_timer():
    g._t0 = time.perf_counter()

@app.after_request
def _log(req):
    try:
        dt = (time.perf_counter() - getattr(g, "_t0", time.perf_counter())) * 1000.0
        size = req.calculate_content_length() or 0
        logger.info("%s %s %s %d %.1fms bytes=%d",
                    request.method, request.path, request.remote_addr,
                    req.status_code, dt, size)
    except Exception:
        pass
    return req


@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:filename>')
def serve_static(filename):
    return send_from_directory(app.static_folder, filename)


def _json_or_error(filename: str):
    path = Path(DATA_DIR) / filename
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        try:
            fsize = path.stat().st_size
        except Exception:
            fsize = None
        logger.info("serve_json file=%s size=%sB", filename, fsize)
        return jsonify(data)
    except FileNotFoundError:
        logger.error("file_not_found file=%s", filename)
        return jsonify(error="file not found", file=filename), 404
    except json.JSONDecodeError as e:
        logger.error("bad_json file=%s err=%s", filename, e)
        return jsonify(error="invalid json", file=filename, detail=str(e)), 400


@app.route('/api/class_index')
def class_index():
    return _json_or_error('class_index.json')

@app.route('/api/validity_index')
def validity_index():
    return _json_or_error('validity_index.json')

@app.route('/api/class_data')
def class_data():
    return _json_or_error('grouped_by_class.json')

@app.route('/api/before_graph')
def before_graph():
    return _json_or_error('before_graph.json')

@app.route('/api/after_graph')
def after_graph():
    return _json_or_error('after_graph.json')

@app.post('/api/exp_log')
def exp_log():
    data = request.get_json(force=True, silent=True) or {}
    events = data.get('events') or []
    if not isinstance(events, list):
        events = []
    session = str(data.get('session', 'unknown'))
    logger.info("exp_log session=%s count=%d", session, len(events))

    os.makedirs('exp_logs', exist_ok=True)
    fname = f"exp_logs/session_{session}_{int(time.time())}.jsonl"
    try:
        with open(fname, 'a', encoding='utf-8') as f:
            for e in events:
                if isinstance(e, dict):
                    f.write(json.dumps(e, ensure_ascii=False) + '\n')
    except Exception as ex:
        logger.error("exp_log_write_error file=%s err=%s", fname, ex)
        return jsonify(ok=False, error="write_failed"), 500
    return jsonify(ok=True)

@app.route('/api/health')
def health():
    return jsonify(ok=True, data_dir=DATA_DIR), 200

if __name__ == '__main__':
    app.run(debug=True)
