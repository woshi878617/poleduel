import os
import re
import json
import secrets
import hashlib
import urllib.request
import urllib.error
from datetime import datetime
from functools import wraps

import psycopg2
import psycopg2.extras
import psycopg2.errors
from flask import Flask, request, jsonify, g, send_from_directory

app = Flask(__name__, static_folder='static', static_url_path='/static')


@app.after_request
def add_cache_control(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TOPICS_PATH = os.path.join(BASE_DIR, 'topics.json')

GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '')
DATABASE_URL = os.environ.get('DATABASE_URL', '')


# ── Database ──────────────────────────────────────────────

class DbWrapper:
    """Thin wrapper around psycopg2 connection to mimic sqlite3 .execute() API."""
    def __init__(self, conn):
        self.conn = conn

    def execute(self, query, params=None):
        cur = self.conn.cursor()
        if params is not None:
            cur.execute(query, params)
        else:
            cur.execute(query)
        return cur

    def commit(self):
        self.conn.commit()

    def close(self):
        self.conn.close()


def get_db():
    if 'db' not in g:
        if not DATABASE_URL:
            raise RuntimeError('DATABASE_URL environment variable is not set')
        conn = psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
        g.db = DbWrapper(conn)
    return g.db


@app.teardown_appcontext
def close_db(exception):
    db = g.pop('db', None)
    if db is not None:
        db.close()


def init_db():
    """Create tables if they don't exist (PostgreSQL)."""
    if not DATABASE_URL:
        print("WARNING: DATABASE_URL not set, skipping database initialization")
        return
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS votes (
            id SERIAL PRIMARY KEY,
            topic_id INTEGER NOT NULL,
            option_index INTEGER NOT NULL,
            ip_address TEXT NOT NULL,
            voted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(topic_id, ip_address)
        );

        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            auth_type TEXT NOT NULL CHECK(auth_type IN ('guest', 'google')),
            identifier TEXT NOT NULL,
            display_name TEXT DEFAULT '',
            avatar_url TEXT DEFAULT '',
            token TEXT UNIQUE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS user_topics (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            question TEXT NOT NULL,
            options_json TEXT NOT NULL,
            category TEXT DEFAULT 'General',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS user_topic_votes (
            id SERIAL PRIMARY KEY,
            topic_id INTEGER NOT NULL,
            option_index INTEGER NOT NULL,
            ip_address TEXT NOT NULL,
            voted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(topic_id, ip_address),
            FOREIGN KEY(topic_id) REFERENCES user_topics(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS favorites (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            topic_type TEXT NOT NULL CHECK(topic_type IN ('preset', 'user')),
            topic_id INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, topic_type, topic_id),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS topic_heat (
            topic_id INTEGER PRIMARY KEY,
            heat INTEGER DEFAULT 100
        );

        CREATE TABLE IF NOT EXISTS push_logs (
            id SERIAL PRIMARY KEY,
            topic_id INTEGER NOT NULL,
            ip_hash TEXT NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('push', 'skip')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS comments (
            id SERIAL PRIMARY KEY,
            topic_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);
        CREATE INDEX IF NOT EXISTS idx_user_topics_user ON user_topics(user_id);
        CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
        CREATE INDEX IF NOT EXISTS idx_push_logs_topic_ip ON push_logs(topic_id, ip_hash);
    """)
    # Migration: add country column if not exists
    cur.execute("ALTER TABLE votes ADD COLUMN IF NOT EXISTS country TEXT DEFAULT '未知'")
    conn.commit()
    cur.close()
    conn.close()


def ensure_topic_heat():
    """Ensure all preset topics have a heat entry (default 100)."""
    db = get_db()
    topics = load_preset_topics()
    for t in topics:
        db.execute(
            "INSERT INTO topic_heat (topic_id, heat) VALUES (%s, 100) ON CONFLICT (topic_id) DO NOTHING",
            (t['id'],)
        )
    db.commit()


def get_topic_heat_map():
    """Return dict of topic_id -> heat."""
    db = get_db()
    rows = db.execute("SELECT topic_id, heat FROM topic_heat").fetchall()
    return {row['topic_id']: row['heat'] for row in rows}


# ── Auth helpers ──────────────────────────────────────────

def generate_token():
    return secrets.token_hex(32)


def hash_ip(ip):
    return hashlib.sha256((ip + 'vote-site-salt').encode()).hexdigest()


def get_user_by_token(token):
    db = get_db()
    return db.execute("SELECT * FROM users WHERE token = %s", (token,)).fetchone()


def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify({'error': 'Authentication required'}), 401
        token = auth_header[7:]
        user = get_user_by_token(token)
        if not user:
            return jsonify({'error': 'Invalid authentication'}), 401
        g.current_user = user
        return f(*args, **kwargs)
    return decorated


def get_client_ip():
    if request.headers.get('X-Forwarded-For'):
        return request.headers['X-Forwarded-For'].split(',')[0].strip()
    return request.remote_addr or '127.0.0.1'


def get_country_from_ip(ip):
    """Query IP geolocation using ip-api.com (free, no API key). Returns country name or '未知'."""
    if ip in ('127.0.0.1', '::1', 'localhost') or ip.startswith('192.168.') or ip.startswith('10.') or ip.startswith('172.'):
        return '未知'
    try:
        url = f'http://ip-api.com/json/{ip}?fields=country'
        req = urllib.request.Request(url, headers={'User-Agent': 'ControveRUS/1.0'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        return data.get('country', '未知') or '未知'
    except Exception:
        return '未知'


# ── Static ────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')


@app.route('/api/config')
def api_config():
    return jsonify({'google_client_id': GOOGLE_CLIENT_ID})


# ── Preset topics ─────────────────────────────────────────

def load_preset_topics():
    with open(TOPICS_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


@app.route('/api/topics')
def get_topics():
    topics = load_preset_topics()
    ip = get_client_ip()
    db = get_db()

    # Ensure heat entries exist
    ensure_topic_heat()

    voted = db.execute(
        "SELECT topic_id FROM votes WHERE ip_address = %s", (ip,)
    ).fetchall()
    voted_ids = {row['topic_id'] for row in voted}

    heat_map = get_topic_heat_map()

    result = []
    for t in topics:
        t['voted'] = t['id'] in voted_ids
        t['heat'] = heat_map.get(t['id'], 100)
        result.append(t)

    # Sort: unvoted first, then by heat descending
    result.sort(key=lambda x: (x['voted'], -x['heat']))
    return jsonify(result)


@app.route('/api/vote', methods=['POST'])
def vote_preset():
    data = request.get_json()
    topic_id = data.get('topic_id')
    option_index = data.get('option_index')

    if topic_id is None or option_index is None:
        return jsonify({'error': 'topic_id and option_index required'}), 400

    topics = load_preset_topics()
    topic = next((t for t in topics if t['id'] == topic_id), None)
    if not topic:
        return jsonify({'error': 'Topic not found'}), 404

    if option_index < 0 or option_index >= len(topic['options']):
        return jsonify({'error': 'Invalid option'}), 400

    ip = get_client_ip()
    country = get_country_from_ip(ip)
    db = get_db()
    try:
        db.execute(
            "INSERT INTO votes (topic_id, option_index, ip_address, country) VALUES (%s, %s, %s, %s)",
            (topic_id, option_index, ip, country)
        )
        # Vote = participation = +2 heat
        db.execute(
            "INSERT INTO topic_heat (topic_id, heat) VALUES (%s, 102) ON CONFLICT(topic_id) DO UPDATE SET heat = topic_heat.heat + 2",
            (topic_id,)
        )
        db.commit()
        return jsonify({'success': True, 'message': 'Vote recorded'})
    except psycopg2.errors.UniqueViolation:
        db.conn.rollback()
        return jsonify({'error': 'You have already voted on this topic'}), 409


@app.route('/api/topics/<int:topic_id>/push', methods=['POST'])
def push_topic(topic_id):
    topics = load_preset_topics()
    topic = next((t for t in topics if t['id'] == topic_id), None)
    if not topic:
        return jsonify({'error': 'Topic not found'}), 404

    ip = get_client_ip()
    ip_hash_val = hash_ip(ip)
    db = get_db()

    # Check 24h cooldown
    from datetime import timezone
    cutoff = (datetime.now(timezone.utc).timestamp() - 86400)
    existing = db.execute(
        "SELECT id FROM push_logs WHERE topic_id = %s AND ip_hash = %s AND action = 'push' AND EXTRACT(EPOCH FROM created_at) > %s",
        (topic_id, ip_hash_val, cutoff)
    ).fetchone()
    if existing:
        return jsonify({'error': 'You have already pushed this topic in the last 24 hours'}), 429

    db.execute(
        "INSERT INTO topic_heat (topic_id, heat) VALUES (%s, 110) ON CONFLICT(topic_id) DO UPDATE SET heat = topic_heat.heat + 10",
        (topic_id,)
    )
    db.execute(
        "INSERT INTO push_logs (topic_id, ip_hash, action) VALUES (%s, %s, 'push')",
        (topic_id, ip_hash_val)
    )
    db.commit()

    new_heat = db.execute("SELECT heat FROM topic_heat WHERE topic_id = %s", (topic_id,)).fetchone()['heat']
    return jsonify({'success': True, 'heat': new_heat})


@app.route('/api/topics/<int:topic_id>/skip', methods=['POST'])
def skip_topic(topic_id):
    topics = load_preset_topics()
    topic = next((t for t in topics if t['id'] == topic_id), None)
    if not topic:
        return jsonify({'error': 'Topic not found'}), 404

    ip = get_client_ip()
    ip_hash_val = hash_ip(ip)
    db = get_db()

    db.execute(
        "INSERT INTO topic_heat (topic_id, heat) VALUES (%s, 100) ON CONFLICT(topic_id) DO UPDATE SET heat = GREATEST(0, topic_heat.heat - 3)",
        (topic_id,)
    )
    db.execute(
        "INSERT INTO push_logs (topic_id, ip_hash, action) VALUES (%s, %s, 'skip')",
        (topic_id, ip_hash_val)
    )
    db.commit()

    new_heat = db.execute("SELECT heat FROM topic_heat WHERE topic_id = %s", (topic_id,)).fetchone()['heat']
    return jsonify({'success': True, 'heat': new_heat})


@app.route('/api/stats/<int:topic_id>')
def get_stats_legacy(topic_id):
    """Legacy alias for backward compatibility."""
    return get_topic_stats(topic_id)


@app.route('/api/topics/<int:topic_id>/stats')
def get_topic_stats(topic_id):
    topics = load_preset_topics()
    topic = next((t for t in topics if t['id'] == topic_id), None)
    if not topic:
        return jsonify({'error': 'Topic not found'}), 404

    db = get_db()

    # Option stats
    rows = db.execute(
        "SELECT option_index, COUNT(*) as count FROM votes WHERE topic_id = %s GROUP BY option_index",
        (topic_id,)
    ).fetchall()

    stats = {i: 0 for i in range(len(topic['options']))}
    total = 0
    for r in rows:
        stats[r['option_index']] = r['count']
        total += r['count']

    option_stats = []
    for i in range(len(topic['options'])):
        count = stats[i]
        pct = round(count / total * 100, 1) if total > 0 else 0.0
        option_stats.append({
            'option_text': topic['options'][i],
            'count': count,
            'percentage': pct
        })

    # Country stats
    country_rows = db.execute(
        "SELECT country, COUNT(*) as count FROM votes WHERE topic_id = %s GROUP BY country ORDER BY count DESC",
        (topic_id,)
    ).fetchall()

    country_stats = [
        {'country': r['country'], 'count': r['count']}
        for r in country_rows if r['country'] != '未知'
    ]

    return jsonify({
        'topic_id': topic_id,
        'question': topic['question'],
        'total': total,
        'option_stats': option_stats,
        'country_stats': country_stats
    })


@app.route('/api/my-votes')
def my_votes():
    ip = get_client_ip()
    db = get_db()
    rows = db.execute(
        "SELECT topic_id, option_index, voted_at FROM votes WHERE ip_address = %s ORDER BY voted_at DESC",
        (ip,)
    ).fetchall()

    topics = {t['id']: t for t in load_preset_topics()}
    result = []
    for r in rows:
        t = topics.get(r['topic_id'])
        if not t:
            continue
        stats_rows = db.execute(
            "SELECT option_index, COUNT(*) as count FROM votes WHERE topic_id = %s GROUP BY option_index",
            (r['topic_id'],)
        ).fetchall()
        stats = {i: 0 for i in range(len(t['options']))}
        for s in stats_rows:
            stats[s['option_index']] = s['count']

        result.append({
            'topic_id': r['topic_id'],
            'question': t['question'],
            'category': t['category'],
            'options': t['options'],
            'your_choice': r['option_index'],
            'your_answer': t['options'][r['option_index']],
            'voted_at': r['voted_at'],
            'total_votes': sum(stats.values()),
            'stats': [{'option': t['options'][i], 'count': stats[i]} for i in range(len(t['options']))]
        })
    return jsonify(result)


@app.route('/api/reset-ip', methods=['POST'])
def reset_ip():
    ip = get_client_ip()
    db = get_db()
    db.execute("DELETE FROM votes WHERE ip_address = %s", (ip,))
    db.commit()
    return jsonify({'success': True, 'message': 'IP voting records cleared'})


# ── Auth ──────────────────────────────────────────────────

@app.route('/api/auth/guest', methods=['POST'])
def auth_guest():
    ip = get_client_ip()
    identifier = hash_ip(ip)
    db = get_db()

    existing = db.execute(
        "SELECT * FROM users WHERE auth_type = 'guest' AND identifier = %s",
        (identifier,)
    ).fetchone()

    if existing:
        return jsonify({
            'token': existing['token'],
            'user': user_to_dict(existing)
        })

    token = generate_token()
    display_name = f"Guest-{ip.split('.')[-1]}"
    db.execute(
        "INSERT INTO users (auth_type, identifier, token, display_name) VALUES (%s, %s, %s, %s)",
        ('guest', identifier, token, display_name)
    )
    db.commit()

    user = db.execute("SELECT * FROM users WHERE token = %s", (token,)).fetchone()
    return jsonify({'token': token, 'user': user_to_dict(user)}), 201


@app.route('/api/auth/google', methods=['POST'])
def auth_google():
    if not GOOGLE_CLIENT_ID:
        return jsonify({'error': 'Google Sign-In is not configured on this server'}), 501

    data = request.get_json()
    credential = data.get('credential')

    if not credential:
        return jsonify({'error': 'Missing Google credential'}), 400

    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests

        idinfo = id_token.verify_oauth2_token(
            credential,
            google_requests.Request(),
            GOOGLE_CLIENT_ID
        )

        google_id = idinfo['sub']
        email = idinfo.get('email', '')
        name = idinfo.get('name', email)
        picture = idinfo.get('picture', '')

    except ValueError as e:
        return jsonify({'error': f'Invalid Google token: {str(e)}'}), 401
    except ImportError:
        return jsonify({'error': 'Server not configured for Google auth (google-auth not installed)'}), 501

    db = get_db()
    existing = db.execute(
        "SELECT * FROM users WHERE auth_type = 'google' AND identifier = %s",
        (google_id,)
    ).fetchone()

    if existing:
        db.execute(
            "UPDATE users SET display_name = %s, avatar_url = %s WHERE id = %s",
            (name, picture, existing['id'])
        )
        db.commit()
        return jsonify({'token': existing['token'], 'user': user_to_dict(existing)})

    token = generate_token()
    db.execute(
        "INSERT INTO users (auth_type, identifier, token, display_name, avatar_url) VALUES (%s, %s, %s, %s, %s)",
        ('google', google_id, token, name, picture)
    )
    db.commit()

    user = db.execute("SELECT * FROM users WHERE token = %s", (token,)).fetchone()
    return jsonify({'token': token, 'user': user_to_dict(user)}), 201


@app.route('/api/auth/me')
@require_auth
def auth_me():
    return jsonify({'user': user_to_dict(g.current_user)})


@app.route('/api/auth/bind-google', methods=['POST'])
@require_auth
def bind_google():
    """Bind a Google account to the current guest user, upgrading to Google auth."""
    if g.current_user['auth_type'] != 'guest':
        return jsonify({'error': 'Only guest accounts can bind Google. Current account is already bound.'}), 400

    if not GOOGLE_CLIENT_ID:
        return jsonify({'error': 'Google Sign-In is not configured on this server'}), 501

    data = request.get_json()
    credential = data.get('credential')
    if not credential:
        return jsonify({'error': 'Missing Google credential'}), 400

    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests

        idinfo = id_token.verify_oauth2_token(
            credential,
            google_requests.Request(),
            GOOGLE_CLIENT_ID
        )

        google_id = idinfo['sub']
        email = idinfo.get('email', '')
        name = idinfo.get('name', email)
        picture = idinfo.get('picture', '')

    except ValueError as e:
        return jsonify({'error': f'Invalid Google token: {str(e)}'}), 401
    except ImportError:
        return jsonify({'error': 'Server not configured for Google auth (google-auth not installed)'}), 501

    db = get_db()

    # Check if this Google account is already used by another user
    existing_google = db.execute(
        "SELECT * FROM users WHERE auth_type = 'google' AND identifier = %s",
        (google_id,)
    ).fetchone()

    if existing_google:
        if existing_google['id'] == g.current_user['id']:
            return jsonify({'error': 'This Google account is already bound to your account'}), 400
        return jsonify({'error': 'This Google account is already linked to another account'}), 409

    # Upgrade current guest user to Google
    db.execute(
        "UPDATE users SET auth_type = 'google', identifier = %s, display_name = %s, avatar_url = %s WHERE id = %s",
        (google_id, name, picture, g.current_user['id'])
    )
    db.commit()

    # Refresh user data
    user = db.execute("SELECT * FROM users WHERE id = %s", (g.current_user['id'],)).fetchone()
    return jsonify({'token': user['token'], 'user': user_to_dict(user)})


def user_to_dict(user):
    return {
        'id': user['id'],
        'auth_type': user['auth_type'],
        'display_name': user['display_name'],
        'avatar_url': user['avatar_url'],
        'created_at': user['created_at']
    }


# ── User topics ───────────────────────────────────────────

@app.route('/api/user-topics', methods=['POST'])
@require_auth
def create_user_topic():
    data = request.get_json()
    question = data.get('question', '').strip()
    options = data.get('options', [])
    category = data.get('category', 'General')

    if not question:
        return jsonify({'error': 'Question is required'}), 400
    if len(options) < 2:
        return jsonify({'error': 'At least 2 options required'}), 400
    if len(options) > 10:
        return jsonify({'error': 'Maximum 10 options allowed'}), 400

    options = [o.strip() for o in options if o.strip()]
    if len(options) < 2:
        return jsonify({'error': 'Need at least 2 non-empty options'}), 400

    db = get_db()

    # Check daily limit (3 per day)
    today = datetime.utcnow().strftime('%Y-%m-%d')
    daily_count = db.execute(
        "SELECT COUNT(*) FROM user_topics WHERE user_id = %s AND date(created_at) = %s",
        (g.current_user['id'], today)
    ).fetchone()['count']
    if daily_count >= 3:
        return jsonify({'error': 'Daily limit reached (3 polls per day)', 'remaining': 0}), 429

    cursor = db.execute(
        "INSERT INTO user_topics (user_id, question, options_json, category) VALUES (%s, %s, %s, %s) RETURNING id",
        (g.current_user['id'], question, json.dumps(options), category)
    )
    topic_id = cursor.fetchone()['id']
    db.commit()

    return jsonify({
        'success': True,
        'topic': {
            'id': topic_id,
            'question': question,
            'options': options,
            'category': category,
            'created_at': datetime.utcnow().isoformat()
        }
    }), 201


@app.route('/api/user-topics/mine')
@require_auth
def my_user_topics():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM user_topics WHERE user_id = %s ORDER BY created_at DESC",
        (g.current_user['id'],)
    ).fetchall()

    result = []
    for r in rows:
        options = json.loads(r['options_json'])
        vr = db.execute(
            "SELECT option_index, COUNT(*) as count FROM user_topic_votes WHERE topic_id = %s GROUP BY option_index",
            (r['id'],)
        ).fetchall()
        stats = {i: 0 for i in range(len(options))}
        for v in vr:
            stats[v['option_index']] = v['count']

        result.append({
            'id': r['id'],
            'question': r['question'],
            'options': options,
            'category': r['category'],
            'created_at': r['created_at'],
            'total_votes': sum(stats.values()),
            'votes': [{'option': options[i], 'count': stats[i]} for i in range(len(options))]
        })
    return jsonify(result)


@app.route('/api/user-topics/all')
def all_user_topics():
    db = get_db()
    rows = db.execute(
        "SELECT ut.*, u.display_name, u.avatar_url FROM user_topics ut JOIN users u ON ut.user_id = u.id ORDER BY ut.created_at DESC"
    ).fetchall()

    ip = get_client_ip()
    result = []
    for r in rows:
        options = json.loads(r['options_json'])
        already_voted = db.execute(
            "SELECT option_index FROM user_topic_votes WHERE topic_id = %s AND ip_address = %s",
            (r['id'], ip)
        ).fetchone()

        vr = db.execute(
            "SELECT option_index, COUNT(*) as count FROM user_topic_votes WHERE topic_id = %s GROUP BY option_index",
            (r['id'],)
        ).fetchall()
        stats = {i: 0 for i in range(len(options))}
        for v in vr:
            stats[v['option_index']] = v['count']

        result.append({
            'id': r['id'],
            'question': r['question'],
            'options': options,
            'category': r['category'],
            'created_at': r['created_at'],
            'author_name': r['display_name'],
            'author_avatar': r['avatar_url'],
            'total_votes': sum(stats.values()),
            'votes': [{'option': options[i], 'count': stats[i]} for i in range(len(options))],
            'voted': already_voted is not None,
            'your_choice': already_voted['option_index'] if already_voted else None
        })
    return jsonify(result)


@app.route('/api/user-topics/<int:topic_id>/stats')
def user_topic_stats(topic_id):
    db = get_db()
    row = db.execute("SELECT * FROM user_topics WHERE id = %s", (topic_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Topic not found'}), 404

    options = json.loads(row['options_json'])
    vr = db.execute(
        "SELECT option_index, COUNT(*) as count FROM user_topic_votes WHERE topic_id = %s GROUP BY option_index",
        (topic_id,)
    ).fetchall()
    stats = {i: 0 for i in range(len(options))}
    for v in vr:
        stats[v['option_index']] = v['count']

    return jsonify({
        'id': row['id'],
        'question': row['question'],
        'options': options,
        'votes': [{'option': options[i], 'count': stats[i]} for i in range(len(options))],
        'total': sum(stats.values())
    })


@app.route('/api/user-topics/<int:topic_id>/vote', methods=['POST'])
def vote_user_topic(topic_id):
    data = request.get_json()
    option_index = data.get('option_index')

    if option_index is None:
        return jsonify({'error': 'option_index required'}), 400

    db = get_db()
    row = db.execute("SELECT * FROM user_topics WHERE id = %s", (topic_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Topic not found'}), 404

    options = json.loads(row['options_json'])
    if option_index < 0 or option_index >= len(options):
        return jsonify({'error': 'Invalid option'}), 400

    ip = get_client_ip()
    try:
        db.execute(
            "INSERT INTO user_topic_votes (topic_id, option_index, ip_address) VALUES (%s, %s, %s)",
            (topic_id, option_index, ip)
        )
        db.commit()
        return jsonify({'success': True, 'message': 'Vote recorded'})
    except psycopg2.errors.UniqueViolation:
        db.conn.rollback()
        return jsonify({'error': 'You have already voted on this topic'}), 409


@app.route('/api/user-topics/<int:topic_id>', methods=['DELETE'])
@require_auth
def delete_user_topic(topic_id):
    db = get_db()
    row = db.execute("SELECT * FROM user_topics WHERE id = %s AND user_id = %s",
                     (topic_id, g.current_user['id'])).fetchone()
    if not row:
        return jsonify({'error': 'Topic not found or not yours'}), 404

    db.execute("DELETE FROM user_topics WHERE id = %s", (topic_id,))
    db.commit()
    return jsonify({'success': True, 'message': 'Topic deleted'})


@app.route('/api/user-topics/daily-remaining')
@require_auth
def daily_remaining():
    db = get_db()
    today = datetime.utcnow().strftime('%Y-%m-%d')
    daily_count = db.execute(
        "SELECT COUNT(*) FROM user_topics WHERE user_id = %s AND date(created_at) = %s",
        (g.current_user['id'], today)
    ).fetchone()['count']
    return jsonify({'used': daily_count, 'remaining': max(0, 3 - daily_count), 'limit': 3})


# ── Favorites ─────────────────────────────────────────────

@app.route('/api/favorites', methods=['POST'])
@require_auth
def add_favorite():
    data = request.get_json()
    topic_type = data.get('topic_type')
    topic_id = data.get('topic_id')

    if topic_type not in ('preset', 'user'):
        return jsonify({'error': 'topic_type must be "preset" or "user"'}), 400
    if topic_id is None:
        return jsonify({'error': 'topic_id required'}), 400

    db = get_db()

    # Verify topic exists
    if topic_type == 'preset':
        topics = load_preset_topics()
        topic = next((t for t in topics if t['id'] == topic_id), None)
        if not topic:
            return jsonify({'error': 'Topic not found'}), 404
    else:
        row = db.execute("SELECT * FROM user_topics WHERE id = %s", (topic_id,)).fetchone()
        if not row:
            return jsonify({'error': 'Topic not found'}), 404

    try:
        db.execute(
            "INSERT INTO favorites (user_id, topic_type, topic_id) VALUES (%s, %s, %s)",
            (g.current_user['id'], topic_type, topic_id)
        )
        db.commit()
        return jsonify({'success': True, 'message': 'Added to favorites'}), 201
    except psycopg2.errors.UniqueViolation:
        db.conn.rollback()
        return jsonify({'error': 'Already in favorites'}), 409


@app.route('/api/favorites', methods=['DELETE'])
@require_auth
def remove_favorite():
    data = request.get_json()
    topic_type = data.get('topic_type')
    topic_id = data.get('topic_id')

    if topic_type not in ('preset', 'user'):
        return jsonify({'error': 'topic_type must be "preset" or "user"'}), 400
    if topic_id is None:
        return jsonify({'error': 'topic_id required'}), 400

    db = get_db()
    db.execute(
        "DELETE FROM favorites WHERE user_id = %s AND topic_type = %s AND topic_id = %s",
        (g.current_user['id'], topic_type, topic_id)
    )
    db.commit()
    return jsonify({'success': True, 'message': 'Removed from favorites'})


@app.route('/api/favorites')
@require_auth
def list_favorites():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM favorites WHERE user_id = %s ORDER BY created_at DESC",
        (g.current_user['id'],)
    ).fetchall()

    preset_topics = load_preset_topics()
    result = []

    for r in rows:
        if r['topic_type'] == 'preset':
            topic = next((t for t in preset_topics if t['id'] == r['topic_id']), None)
            if not topic:
                continue
            result.append({
                'fav_id': r['id'],
                'topic_type': 'preset',
                'topic_id': r['topic_id'],
                'question': topic['question'],
                'options': topic['options'],
                'category': topic['category'],
                'created_at': r['created_at']
            })
        else:
            ut = db.execute("SELECT * FROM user_topics WHERE id = %s", (r['topic_id'],)).fetchone()
            if not ut:
                continue
            result.append({
                'fav_id': r['id'],
                'topic_type': 'user',
                'topic_id': r['topic_id'],
                'question': ut['question'],
                'options': json.loads(ut['options_json']),
                'category': ut['category'],
                'created_at': r['created_at']
            })

    return jsonify(result)


# ── Comments ──────────────────────────────────────────────

@app.route('/api/topics/<topic_id>/comments')
def get_comments(topic_id):
    db = get_db()
    rows = db.execute(
        """SELECT c.id, c.topic_id, c.user_id, c.content, c.created_at,
                  u.display_name, u.avatar_url
           FROM comments c
           JOIN users u ON c.user_id::INT = u.id
           WHERE c.topic_id = %s
           ORDER BY c.created_at ASC""",
        (str(topic_id),)
    ).fetchall()
    result = []
    for r in rows:
        result.append({
            'id': r['id'],
            'topic_id': r['topic_id'],
            'user_id': r['user_id'],
            'content': r['content'],
            'created_at': r['created_at'],
            'display_name': r['display_name'],
            'avatar_url': r['avatar_url']
        })
    return jsonify(result)


@app.route('/api/topics/<topic_id>/comments', methods=['POST'])
@require_auth
def create_comment(topic_id):
    data = request.get_json()
    content = data.get('content', '').strip()

    if not content:
        return jsonify({'error': 'Content cannot be empty'}), 400

    # Detect if content contains Chinese characters
    has_chinese = bool(re.search(r'[\u4e00-\u9fff]', content))
    if has_chinese:
        if len(content) > 100:
            return jsonify({'error': f'回复过长（当前 {len(content)} 字，限制 100 字）'}), 400
    else:
        if len(content) > 200:
            return jsonify({'error': f'Reply too long ({len(content)} chars, limit 200)'}), 400

    db = get_db()
    cursor = db.execute(
        "INSERT INTO comments (topic_id, user_id, content) VALUES (%s, %s, %s) RETURNING id",
        (str(topic_id), g.current_user['id'], content)
    )
    comment_id = cursor.fetchone()['id']
    db.commit()

    # Return the new comment with user info
    row = db.execute(
        """SELECT c.id, c.topic_id, c.user_id, c.content, c.created_at,
                  u.display_name, u.avatar_url
           FROM comments c
           JOIN users u ON c.user_id = u.id
           WHERE c.id = %s""",
        (comment_id,)
    ).fetchone()

    return jsonify({
        'id': row['id'],
        'topic_id': row['topic_id'],
        'user_id': row['user_id'],
        'content': row['content'],
        'created_at': row['created_at'],
        'display_name': row['display_name'],
        'avatar_url': row['avatar_url']
    }), 201


# ── Main ──────────────────────────────────────────────────

# Auto-initialize database on import (for gunicorn)
init_db()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    print("═" * 50)
    print("  ControveRUS Vote Platform")
    print(f"  http://0.0.0.0:{port}")
    if GOOGLE_CLIENT_ID:
        print(f"  Google Sign-In: ENABLED")
    else:
        print(f"  Google Sign-In: NOT CONFIGURED")
        print(f"  Set GOOGLE_CLIENT_ID env var to enable")
    print("═" * 50)
    app.run(host='0.0.0.0', port=port, debug=False)
