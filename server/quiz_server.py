#!/usr/bin/env python3
"""Independent Y++ quiz server. No shared bingo/Y-OBS state or authentication."""
import base64
import hashlib
import hmac
import io
import json
import mimetypes
import os
import pathlib
import secrets
import sqlite3
import sys
import time
import unicodedata
import warnings
from contextlib import contextmanager
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from PIL import Image, ImageOps, UnidentifiedImageError

ROOT = pathlib.Path(os.environ.get('QUIZ_DATA', '/var/lib/yplus-quiz'))
STATIC = pathlib.Path(os.environ.get('QUIZ_STATIC', '/opt/yplus-quiz/quiz'))
DB_PATH = ROOT / 'quiz.sqlite3'
COOKIE = '__Secure-yplus_quiz_session' if os.getenv('QUIZ_SECURE_COOKIE', '1') == '1' else 'yplus_quiz_session'
SECURE = os.getenv('QUIZ_SECURE_COOKIE', '1') == '1'
ORIGIN = os.getenv('QUIZ_ORIGIN', 'https://153-127-64-17.sslip.io')
Image.MAX_IMAGE_PIXELS = 20_000_000


class Error(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def now_ms():
    return int(time.time() * 1000)


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)
    return 'scrypt:' + salt.hex() + ':' + digest.hex()


def valid_hash(value):
    try:
        kind, salt, digest = value.split(':')
        return kind == 'scrypt' and len(bytes.fromhex(salt)) == 16 and len(bytes.fromhex(digest)) == 64
    except (ValueError, AttributeError):
        return False


def verify_password(password, encoded):
    if not valid_hash(encoded):
        return False
    _, salt, digest = encoded.split(':')
    actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1)
    return hmac.compare_digest(actual, bytes.fromhex(digest))


def text(value, maximum, label, required=False):
    if not isinstance(value, str) or len(value) > maximum or (required and not value.strip()):
        raise Error(400, label + 'を確認してください。')
    return value.strip()


def integer(value, low, high, label):
    if type(value) is not int or not low <= value <= high:
        raise Error(400, f'{label}は{low}〜{high}で指定してください。')
    return value


@contextmanager
def db(write=False):
    connection = sqlite3.connect(DB_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA foreign_keys=ON')
    try:
        if write:
            connection.execute('BEGIN IMMEDIATE')
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize():
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / 'media').mkdir(exist_ok=True)
    with db() as connection:
        connection.execute('PRAGMA journal_mode=WAL')
        connection.executescript('''
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, password_hash TEXT NOT NULL, role TEXT NOT NULL,
          slot INTEGER UNIQUE, enabled INTEGER NOT NULL DEFAULT 1,
          expires_ms INTEGER, avatar_id TEXT, created_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
          expires_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS questions (
          id TEXT PRIMARY KEY, label TEXT NOT NULL, prompt TEXT NOT NULL,
          correct_answer TEXT NOT NULL, duration INTEGER NOT NULL,
          image_ids TEXT NOT NULL, created_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS media (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, created_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS game (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS answers (
          round_id TEXT NOT NULL, slot INTEGER NOT NULL, user_id TEXT NOT NULL,
          answer TEXT NOT NULL, updated_ms INTEGER NOT NULL, PRIMARY KEY(round_id,slot)
        );
        CREATE TABLE IF NOT EXISTS login_failures (ip TEXT NOT NULL, at_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS intake (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS submissions (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, mode TEXT, slot INTEGER, target_id TEXT,
          round_id TEXT, batch_id TEXT, sender TEXT NOT NULL, label TEXT NOT NULL,
          prompt TEXT NOT NULL, correct_answer TEXT NOT NULL, duration INTEGER NOT NULL,
          status TEXT NOT NULL, visible INTEGER NOT NULL DEFAULT 0, question_id TEXT, created_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS submissions_round ON submissions(round_id,kind,visible);
        CREATE TABLE IF NOT EXISTS post_limits (ip_hash TEXT NOT NULL, at_ms INTEGER NOT NULL);
        ''')
        initial = {'revision': 0, 'phase': 'lobby', 'screen': 'lobby', 'questionId': None,
                   'roundId': None, 'deadlineMs': None, 'duration': 30, 'mediaId': None}
        connection.execute('INSERT OR IGNORE INTO game VALUES(1,?)', (json.dumps(initial),))
        connection.execute('INSERT OR IGNORE INTO intake VALUES(1,?)', (json.dumps({
            'revision': 0, 'questionOpen': False, 'questionLimit': 10,
            'questionBatch': secrets.token_hex(16), 'hintMode': 'off'}),))


def game_state(connection):
    game = json.loads(connection.execute('SELECT data FROM game WHERE id=1').fetchone()['data'])
    if game['phase'] == 'answering' and now_ms() >= game['deadlineMs']:
        game['phase'] = 'timeup'
        game['screen'] = 'timeup'
        save_game(connection, game)
    return game


def save_game(connection, game):
    game['revision'] += 1
    connection.execute('UPDATE game SET data=? WHERE id=1', (json.dumps(game, ensure_ascii=False),))


def question_row(connection, qid):
    row = connection.execute('SELECT * FROM questions WHERE id=?', (qid,)).fetchone()
    if row is None:
        raise Error(404, '問題が見つかりません。')
    return row


def media_url(connection, mid, kind=None):
    if not mid:
        return None
    row = connection.execute('SELECT kind FROM media WHERE id=?', (mid,)).fetchone()
    if row is None or (kind and row['kind'] != kind):
        return None
    return '/quiz/media/' + mid + '.png'


def question_dict(row):
    return {'id': row['id'], 'label': row['label'], 'prompt': row['prompt'],
            'correctAnswer': row['correct_answer'], 'duration': row['duration'],
            'imageIds': json.loads(row['image_ids'])}


def intake_state(connection):
    config = json.loads(connection.execute('SELECT data FROM intake WHERE id=1').fetchone()['data'])
    count = connection.execute("SELECT COUNT(*) FROM submissions WHERE kind='question' AND batch_id=?", (config['questionBatch'],)).fetchone()[0]
    return {**config, 'questionCount': count, 'questionRemaining': max(0, config['questionLimit'] - count)}


def save_intake(connection, data):
    config = intake_state(connection)
    if data.get('expectedRevision') != config['revision']:
        raise Error(409, '受付設定が変更されました。再読み込みしてから設定してください。')
    opened, mode = data.get('questionOpen'), data.get('hintMode')
    if type(opened) is not bool or mode not in ('off', 'private', 'global', 'both'):
        raise Error(400, '受付設定を確認してください。')
    limit = integer(data.get('questionLimit'), 1, 200, '問題受付上限')
    config = {key: config[key] for key in ('revision', 'questionOpen', 'questionLimit', 'questionBatch', 'hintMode')}
    config.update(revision=config['revision'] + 1, questionOpen=opened, questionLimit=limit, hintMode=mode)
    if data.get('resetQuestions') is True:
        config['questionBatch'] = secrets.token_hex(16)
    connection.execute('UPDATE intake SET data=? WHERE id=1', (json.dumps(config),))
    return {'ok': True}


def save_question(connection, data):
    qid = data.get('id') or secrets.token_hex(12)
    old = connection.execute('SELECT id FROM questions WHERE id=?', (qid,)).fetchone()
    if data.get('id') and not old:
        raise Error(404, '問題が見つかりません。')
    if connection.execute('SELECT COUNT(*) FROM questions').fetchone()[0] >= 200 and not old:
        raise Error(400, '問題は200問まで登録できます。')
    game = game_state(connection)
    if game['questionId'] == qid and game['phase'] in ('question', 'answering', 'timeup'):
        raise Error(409, '出題中の問題は編集できません。待機画面へ戻してから編集してください。')
    label = text(data.get('label'), 100, '問題タイトル', True)
    prompt = text(data.get('prompt', ''), 2000, '問題文')
    correct = text(data.get('correctAnswer'), 1000, '正解', True)
    duration = integer(data.get('duration', 30), 1, 3600, 'タイマー秒数')
    ids = data.get('imageIds', [])
    if not isinstance(ids, list) or len(ids) > 20 or any(not isinstance(mid, str) or not media_url(connection, mid, 'screen') for mid in ids):
        raise Error(400, '問題画像を確認してください。')
    if not prompt and not ids:
        raise Error(400, '問題文または問題画像を設定してください。')
    connection.execute('INSERT INTO questions VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,prompt=excluded.prompt,correct_answer=excluded.correct_answer,duration=excluded.duration,image_ids=excluded.image_ids',
                       (qid, label, prompt, correct, duration, json.dumps(ids), now_ms()))
    return {'ok': True, 'id': qid}


def submit_post(connection, data, ip):
    config = intake_state(connection)
    kind = data.get('kind')
    sender = text(data.get('sender', ''), 40, '投稿者名') or 'リスナー'
    prompt = text(data.get('prompt'), 2000 if kind == 'question' else 300, '投稿内容', True)
    mid, slot, target, round_id, label, correct, duration = None, None, None, None, '', '', 30
    if kind == 'question':
        if not config['questionOpen'] or config['questionRemaining'] <= 0:
            raise Error(409, '問題投稿は受付停止中、または上限に達しています。')
        if data.get('batchId') != config['questionBatch']:
            raise Error(409, '問題受付が切り替わりました。画面を確認して再投稿してください。')
        label = text(data.get('label'), 100, '問題タイトル', True)
        correct = text(data.get('correctAnswer'), 1000, '正解', True)
        duration = integer(data.get('duration', 30), 1, 3600, 'タイマー秒数')
    elif kind == 'hint':
        mid = data.get('mode')
        if mid not in ('private', 'global') or config['hintMode'] not in (mid, 'both'):
            raise Error(409, 'この種類のヒントは現在受付していません。')
        game = game_state(connection)
        round_id = game['roundId']
        if game['phase'] not in ('question', 'answering', 'timeup') or data.get('roundId') != round_id:
            raise Error(409, '現在の問題へのヒント受付は終了しています。')
        if mid == 'private':
            slot = integer(data.get('slot'), 1, 4, 'ヒントの宛先')
            player = connection.execute("SELECT id FROM users WHERE role='player' AND slot=? AND enabled=1", (slot,)).fetchone()
            if not player:
                raise Error(409, 'その回答者は現在参加していません。')
            target = player['id']
        if connection.execute("SELECT COUNT(*) FROM submissions WHERE kind='hint' AND round_id=?", (round_id,)).fetchone()[0] >= 200:
            raise Error(409, 'この問題のヒント投稿が上限に達しました。')
    else:
        raise Error(400, '投稿の種類を確認してください。')
    if connection.execute("SELECT COUNT(*) FROM submissions WHERE status='pending'").fetchone()[0] >= 500:
        raise Error(409, '未確認の投稿が多いため、受付を一時停止しています。')
    stamp = now_ms()
    hashed_ip = hashlib.sha256(ip.encode()).hexdigest()
    connection.execute('DELETE FROM post_limits WHERE at_ms<?', (stamp - 60000,))
    if connection.execute('SELECT COUNT(*) FROM post_limits WHERE ip_hash=?', (hashed_ip,)).fetchone()[0] >= 30:
        raise Error(429, '投稿が続いています。1分ほど待ってから再投稿してください。')
    connection.execute('INSERT INTO post_limits VALUES(?,?)', (hashed_ip, stamp))
    sid = secrets.token_hex(16)
    connection.execute('INSERT INTO submissions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (sid, kind, mid, slot, target, round_id, config['questionBatch'], sender, label, prompt, correct, duration, 'pending', 0, None, stamp))
    # Bound reviewed history without deleting the current question-reception count.
    connection.execute("DELETE FROM submissions WHERE status!='pending' AND visible=0 AND (kind!='question' OR batch_id!=?) AND id NOT IN (SELECT id FROM submissions ORDER BY created_ms DESC LIMIT 1000)", (config['questionBatch'],))
    return {'ok': True, 'id': sid}


def review_post(connection, data):
    sid = text(data.get('submissionId'), 40, '投稿ID', True)
    post = connection.execute('SELECT * FROM submissions WHERE id=?', (sid,)).fetchone()
    if post is None:
        raise Error(404, '投稿が見つかりません。')
    action = data.get('action')
    if action == 'reject':
        if post['status'] != 'pending':
            raise Error(409, 'この投稿はすでに確認済みです。')
        connection.execute("UPDATE submissions SET status='rejected',visible=0 WHERE id=?", (sid,))
    elif action == 'approve_question':
        if post['kind'] != 'question' or post['status'] != 'pending':
            raise Error(409, 'この問題はすでに確認済みです。')
        approved = save_question(connection, {**data, 'id': None})
        connection.execute("UPDATE submissions SET status='approved',question_id=? WHERE id=?", (approved['id'], sid))
        return approved
    elif action in ('publish_hint', 'hide_hint'):
        if post['kind'] != 'hint' or post['status'] not in ('pending', 'approved'):
            raise Error(409, 'このヒントは表示できません。')
        if action == 'hide_hint':
            connection.execute('UPDATE submissions SET visible=0 WHERE id=?', (sid,))
        else:
            game = game_state(connection)
            if post['round_id'] != game['roundId'] or game['phase'] == 'lobby':
                raise Error(409, '前の問題のヒントは表示できません。')
            if post['mode'] == 'private':
                player = connection.execute("SELECT id FROM users WHERE role='player' AND slot=? AND enabled=1", (post['slot'],)).fetchone()
                if not player or player['id'] != post['target_id']:
                    raise Error(409, '宛先の回答者が変更されています。')
            prompt = text(data.get('prompt', post['prompt']), 300, '表示するヒント', True)
            connection.execute("UPDATE submissions SET visible=0 WHERE kind='hint' AND round_id=? AND mode=? AND slot IS ?", (game['roundId'], post['mode'], post['slot']))
            connection.execute("UPDATE submissions SET status='approved',visible=1,prompt=? WHERE id=?", (prompt, sid))
    else:
        raise Error(400, '確認操作を選んでください。')
    return {'ok': True}


def public_state(connection, me=None, host=False):
    game = game_state(connection)
    active = None
    if game['questionId'] and game['phase'] != 'lobby':
        row = question_row(connection, game['questionId'])
        active = {'label': row['label'], 'prompt': row['prompt']}
        if game['phase'] == 'answer' and game['screen'] == 'answer':
            active['correctAnswer'] = row['correct_answer']
    answers = {r['slot']: r for r in connection.execute('SELECT * FROM answers WHERE round_id=?', (game['roundId'],))}
    users = {r['slot']: r for r in connection.execute("SELECT * FROM users WHERE role='player' AND enabled=1")}
    players = []
    reveal = game['phase'] == 'answer' and game['screen'] == 'answer'
    correct_answer = unicodedata.normalize('NFKC', row['correct_answer']).strip() if reveal else None
    for slot in range(1, 5):
        user, answer = users.get(slot), answers.get(slot)
        player = {'slot': slot, 'id': user['id'] if user else '',
                  'avatar': media_url(connection, user['avatar_id'], 'avatar') if user else None,
                  'submitted': bool(answer) if user else False}
        if answer and user and (host or reveal or (me and me['role'] == 'player' and me['slot'] == slot)):
            player['answer'] = answer['answer']
            player['updatedMs'] = answer['updated_ms']
        if reveal and user:
            player['correct'] = bool(answer and unicodedata.normalize('NFKC', answer['answer']).strip() == correct_answer)
        players.append(player)
    public_game = {key: game[key] for key in ['revision', 'phase', 'screen', 'roundId', 'deadlineMs', 'duration']}
    public_game['image'] = media_url(connection, game['mediaId'], 'screen') if game['screen'] == 'image' else None
    result = {'serverTimeMs': now_ms(), 'game': public_game, 'question': active, 'players': players,
              'me': {'id': me['id'], 'role': me['role'], 'slot': me['slot'], 'expiresMs': me['expires_ms']} if me else None}
    config = intake_state(connection)
    result['intake'] = config
    result['globalHint'] = None
    result['privateHint'] = None
    if game['phase'] != 'lobby':
        hint = connection.execute("SELECT prompt FROM submissions WHERE kind='hint' AND mode='global' AND visible=1 AND round_id=? ORDER BY created_ms DESC LIMIT 1", (game['roundId'],)).fetchone()
        result['globalHint'] = hint['prompt'] if hint else None
        if me and me['role'] == 'player':
            hint = connection.execute("SELECT prompt FROM submissions WHERE kind='hint' AND mode='private' AND visible=1 AND round_id=? AND slot=? AND target_id=? ORDER BY created_ms DESC LIMIT 1", (game['roundId'], me['slot'], me['id'])).fetchone()
            result['privateHint'] = hint['prompt'] if hint else None
    if host:
        result['game']['questionId'] = game['questionId']
        result['questions'] = [question_dict(r) for r in connection.execute('SELECT * FROM questions ORDER BY created_ms,id')]
        result['media'] = [{'id': r['id'], 'label': r['label'], 'url': media_url(connection, r['id'])}
                           for r in connection.execute("SELECT * FROM media WHERE kind='screen' ORDER BY created_ms DESC")]
        result['accounts'] = [{'slot': r['slot'], 'id': r['id'], 'enabled': bool(r['enabled']),
                               'avatarId': r['avatar_id'], 'avatar': media_url(connection, r['avatar_id'], 'avatar')}
                              for r in connection.execute("SELECT * FROM users WHERE role='player' ORDER BY slot")]
        result['submissions'] = [dict(r) for r in connection.execute("SELECT * FROM submissions WHERE status='pending' OR (kind='hint' AND status='approved' AND round_id=?) ORDER BY created_ms DESC,id LIMIT 700", (game['roundId'],))]
        if me and me['role'] == 'owner':
            result['delegates'] = [{'id': r['id'], 'expiresMs': r['expires_ms']}
                                   for r in connection.execute("SELECT * FROM users WHERE role='gm' ORDER BY created_ms DESC")]
    return result


def save_player(connection, data):
    slot = integer(data.get('slot'), 1, 4, '参加枠')
    identifier = text(data.get('id'), 40, 'ID', True)
    if any(ord(char) < 32 for char in identifier):
        raise Error(400, 'IDに改行などは使えません。')
    password = text(data.get('password', ''), 128, 'パスワード')
    if password and len(password) < 6:
        raise Error(400, 'パスワードは6文字以上にしてください。')
    enabled = data.get('enabled', True)
    if type(enabled) is not bool:
        raise Error(400, '参加設定を確認してください。')
    old = connection.execute("SELECT * FROM users WHERE role='player' AND slot=?", (slot,)).fetchone()
    collision = connection.execute('SELECT * FROM users WHERE id=?', (identifier,)).fetchone()
    if collision and (not old or collision['id'] != old['id']):
        raise Error(409, 'そのIDはすでに使われています。')
    avatar = data.get('avatarId', old['avatar_id'] if old else None)
    if avatar and not media_url(connection, avatar, 'avatar'):
        raise Error(400, 'アイコン画像を確認してください。')
    generated = None
    if not old and not password:
        password = generated = secrets.token_urlsafe(12)
    password_hash = hash_password(password) if password else old['password_hash']
    changed = bool(old and (password or old['id'] != identifier or not enabled))
    if old:
        if changed:
            connection.execute('DELETE FROM sessions WHERE user_id=?', (old['id'],))
            connection.execute('DELETE FROM answers WHERE slot=?', (slot,))
        connection.execute('UPDATE users SET id=?,password_hash=?,enabled=?,avatar_id=? WHERE slot=?',
                           (identifier, password_hash, int(enabled), avatar, slot))
    else:
        connection.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)',
                           (identifier, password_hash, 'player', slot, int(enabled), None, avatar, now_ms()))
    return {'ok': True, 'generatedPassword': generated}


def host_action(connection, data):
    game = game_state(connection)
    action = data.get('action')
    if data.get('expectedRevision') != game['revision']:
        raise Error(409, '進行状況が更新されました。画面を確認してもう一度操作してください。')
    if action == 'present':
        row = question_row(connection, data.get('questionId'))
        connection.execute("UPDATE submissions SET visible=0 WHERE kind='hint'")
        ids = json.loads(row['image_ids'])
        game.update(phase='question', screen='image' if ids else 'question', questionId=row['id'],
                    roundId=secrets.token_urlsafe(16), deadlineMs=None, duration=row['duration'], mediaId=ids[0] if ids else None)
    elif action == 'start':
        if game['phase'] != 'question':
            raise Error(409, '先に問題一覧の「出題」を押してください。')
        duration = integer(data.get('duration', game['duration']), 1, 3600, 'タイマー秒数')
        game.update(phase='answering', duration=duration, deadlineMs=now_ms() + duration * 1000)
    elif action == 'reveal':
        if game['phase'] not in ('timeup', 'answer'):
            raise Error(409, 'タイムアップ後に正解を表示できます。')
        game.update(phase='answer', screen='answer')
    elif action == 'show_image':
        mid = data.get('mediaId')
        if not media_url(connection, mid, 'screen'):
            raise Error(404, '画像が見つかりません。')
        game.update(screen='image', mediaId=mid)
    elif action == 'show_question':
        if not game['questionId'] or game['phase'] == 'lobby':
            raise Error(409, '先に問題を出題してください。')
        game['screen'] = 'question'
    elif action == 'lobby':
        connection.execute("UPDATE submissions SET visible=0 WHERE kind='hint'")
        game.update(phase='lobby', screen='lobby', deadlineMs=None, mediaId=None)
    else:
        raise Error(400, '操作を確認してください。')
    save_game(connection, game)
    # Keep a bounded history while retaining this round's latest answers.
    connection.execute('DELETE FROM answers WHERE round_id NOT IN (SELECT round_id FROM answers GROUP BY round_id ORDER BY MAX(updated_ms) DESC LIMIT 100)')
    return {'ok': True}


class Handler(BaseHTTPRequestHandler):
    server_version = 'YQuiz/1'

    def log_message(self, fmt, *args):
        # Do not log request payloads, cookies, passwords, or answers.
        sys.stderr.write('%s %s\n' % (self.command, urlsplit(self.path).path))

    def respond(self, status, payload, cookie=None):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def session_cookie(self, token='', maximum=0):
        return f'{COOKIE}={token}; Path=/quiz; HttpOnly; SameSite=Strict; Max-Age={maximum}' + ('; Secure' if SECURE else '')

    def token(self):
        try:
            parsed = SimpleCookie(self.headers.get('Cookie', ''))
            return parsed[COOKIE].value if COOKIE in parsed else ''
        except Exception:
            return ''

    def me(self, connection, roles=None):
        token = self.token()
        row = connection.execute('''SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
          WHERE s.token_hash=? AND s.expires_ms>? AND u.enabled=1 AND (u.expires_ms IS NULL OR u.expires_ms>?)''',
                                 (hashlib.sha256(token.encode()).hexdigest(), now_ms(), now_ms())).fetchone() if token else None
        if roles and (row is None or row['role'] not in roles):
            raise Error(401 if row is None else 403, 'この操作には対応するIDでのログインが必要です。')
        return row

    def body(self):
        if self.headers.get('Origin') not in (None, ORIGIN):
            raise Error(403, 'このサイトからは操作できません。')
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            raise Error(415, 'JSON形式で送信してください。')
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 9_000_000:
                raise ValueError()
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise ValueError()
            return body
        except (ValueError, UnicodeError):
            raise Error(400, '送信内容を確認してください。')

    def login(self, connection, data):
        ip = self.headers.get('X-Real-IP', self.client_address[0])[:80]
        connection.execute('DELETE FROM login_failures WHERE at_ms<?', (now_ms() - 900000,))
        failures = connection.execute('SELECT COUNT(*) FROM login_failures WHERE ip=?', (ip,)).fetchone()[0]
        if failures >= 8:
            return 429, {'error': '認証失敗が続いたため、15分後に再試行してください。'}, None
        identifier = text(data.get('id'), 40, 'ID', True)
        password = text(data.get('password'), 128, 'パスワード', True)
        user = connection.execute('SELECT * FROM users WHERE id=?', (identifier,)).fetchone()
        if not user or not user['enabled'] or (user['expires_ms'] and user['expires_ms'] <= now_ms()) or not verify_password(password, user['password_hash']):
            connection.execute('INSERT INTO login_failures VALUES(?,?)', (ip, now_ms()))
            return 401, {'error': 'IDまたはパスワードが正しくありません。'}, None
        connection.execute('DELETE FROM login_failures WHERE ip=?', (ip,))
        connection.execute('DELETE FROM sessions WHERE expires_ms<=?', (now_ms(),))
        token = secrets.token_urlsafe(32)
        expires = min(now_ms() + 43200000, user['expires_ms'] or now_ms() + 43200000)
        connection.execute('INSERT INTO sessions VALUES(?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), identifier, expires))
        return 200, {'ok': True, 'role': user['role']}, self.session_cookie(token, max(0, (expires - now_ms()) // 1000))

    def upload(self, connection, data):
        kind = data.get('kind')
        if kind not in ('avatar', 'screen'):
            raise Error(400, '画像の用途を確認してください。')
        label = text(data.get('label', '画像'), 100, '画像名', True)
        if connection.execute('SELECT COUNT(*) FROM media').fetchone()[0] >= 400:
            raise Error(400, '画像は合計400枚まで登録できます。')
        try:
            encoded = data.get('data', '')
            if not isinstance(encoded, str) or len(encoded) > 8_000_000:
                raise ValueError()
            raw = base64.b64decode(encoded, validate=True)
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(raw)) as image:
                    if image.format not in ('PNG', 'JPEG', 'WEBP'):
                        raise ValueError()
                    image.load()
                    image = ImageOps.exif_transpose(image).convert('RGBA')
                    if kind == 'avatar':
                        image = ImageOps.fit(image, (256, 256), method=Image.Resampling.LANCZOS)
                    else:
                        image.thumbnail((1920, 1080), Image.Resampling.LANCZOS)
                    mid = secrets.token_hex(16)
                    image.save(ROOT / 'media' / (mid + '.png'), 'PNG')
        except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise Error(400, 'PNG・JPEG・WebPの画像を選んでください（大きすぎる画像は使えません）。')
        connection.execute('INSERT INTO media VALUES(?,?,?,?)', (mid, kind, label, now_ms()))
        return {'id': mid, 'url': '/quiz/media/' + mid + '.png', 'label': label}

    def do_GET(self):
        path = urlsplit(self.path).path
        try:
            if path == '/quiz/api/health':
                return self.respond(200, {'ok': True, 'service': 'yplus-quiz'})
            if path in ('/quiz/api/state', '/quiz/api/host'):
                with db(True) as connection:
                    me = self.me(connection, ('owner', 'gm')) if path.endswith('/host') else self.me(connection)
                    data = public_state(connection, me, host=path.endswith('/host'))
                return self.respond(200, data)
            if path.startswith('/quiz/media/'):
                name = path.removeprefix('/quiz/media/')
                if len(name) != 36 or not name.endswith('.png') or any(c not in '0123456789abcdef' for c in name[:-4]):
                    raise Error(404, '画像が見つかりません。')
                with db() as connection:
                    if not connection.execute('SELECT id FROM media WHERE id=?', (name[:-4],)).fetchone():
                        raise Error(404, '画像が見つかりません。')
                return self.serve_file(ROOT / 'media' / name, 'image/png', immutable=True)
            assets = {'/quiz/': 'index.html', '/quiz/index.html': 'index.html', '/quiz/quiz.js': 'quiz.js', '/quiz/quiz.css': 'quiz.css'}
            if path == '/quiz':
                self.send_response(302); self.send_header('Location', '/quiz/'); self.end_headers(); return
            if path in assets:
                file = STATIC / assets[path]
                return self.serve_file(file, mimetypes.guess_type(file)[0] or 'application/octet-stream')
            raise Error(404, 'ページが見つかりません。')
        except Error as error:
            self.respond(error.status, {'error': str(error)})
        except Exception:
            self.respond(503, {'error': '一時的に接続できません。少し待って再試行してください。'})

    def serve_file(self, file, content_type, immutable=False):
        if not file.is_file():
            raise Error(404, 'ファイルが見つかりません。')
        body = file.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', content_type + ('; charset=utf-8' if content_type.startswith(('text/', 'application/javascript')) else ''))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self' https://y-tools.github.io")
        self.send_header('Cache-Control', 'public,max-age=31536000,immutable' if immutable else 'no-cache')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            data = self.body()
            with db(True) as connection:
                cookie = None
                if path == '/quiz/api/login':
                    status, result, cookie = self.login(connection, data)
                elif path == '/quiz/api/logout':
                    connection.execute('DELETE FROM sessions WHERE token_hash=?', (hashlib.sha256(self.token().encode()).hexdigest(),))
                    status, result, cookie = 200, {'ok': True}, self.session_cookie()
                elif path == '/quiz/api/answer':
                    me = self.me(connection, ('player',))
                    game = game_state(connection)
                    if game['phase'] != 'answering' or now_ms() >= game['deadlineMs'] or data.get('roundId') != game['roundId']:
                        raise Error(409, 'この問題の回答受付は終了しています。')
                    answer = text(data.get('answer'), 500, '回答', True)
                    connection.execute('INSERT INTO answers VALUES(?,?,?,?,?) ON CONFLICT(round_id,slot) DO UPDATE SET answer=excluded.answer,updated_ms=excluded.updated_ms,user_id=excluded.user_id',
                                       (game['roundId'], me['slot'], me['id'], answer, now_ms()))
                    status, result = 200, {'ok': True, 'answer': answer}
                elif path == '/quiz/api/submit':
                    result = submit_post(connection, data, self.headers.get('X-Real-IP', self.client_address[0])[:80])
                    status = 200
                elif path.startswith('/quiz/api/admin/'):
                    me = self.me(connection, ('owner', 'gm'))
                    if path.endswith('/player'):
                        result = save_player(connection, data)
                    elif path.endswith('/upload'):
                        result = self.upload(connection, data)
                    elif path.endswith('/question'):
                        result = save_question(connection, data)
                    elif path.endswith('/intake'):
                        result = save_intake(connection, data)
                    elif path.endswith('/review'):
                        result = review_post(connection, data)
                    elif path.endswith('/action'):
                        result = host_action(connection, data)
                    elif path.endswith('/delegate'):
                        if me['role'] != 'owner':
                            raise Error(403, '委任はオーナーのYのみ設定できます。')
                        identifier = text(data.get('id'), 40, '委任ID', True)
                        if data.get('action') == 'revoke':
                            connection.execute("DELETE FROM users WHERE id=? AND role='gm'", (identifier,))
                            result = {'ok': True}
                        else:
                            if connection.execute('SELECT id FROM users WHERE id=?', (identifier,)).fetchone():
                                raise Error(409, 'そのIDはすでに使われています。')
                            if connection.execute("SELECT COUNT(*) FROM users WHERE role='gm'").fetchone()[0] >= 20:
                                raise Error(400, '委任IDは20件まで作成できます。不要な委任を解除してください。')
                            password = text(data.get('password', ''), 128, 'パスワード') or secrets.token_urlsafe(12)
                            if len(password) < 6:
                                raise Error(400, 'パスワードは6文字以上にしてください。')
                            hours = integer(data.get('hours', 24), 1, 168, '有効時間')
                            expires = now_ms() + hours * 3600000
                            connection.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)', (identifier, hash_password(password), 'gm', None, 1, expires, None, now_ms()))
                            result = {'ok': True, 'id': identifier, 'password': password, 'expiresMs': expires}
                    else:
                        raise Error(404, '操作が見つかりません。')
                    status = 200
                else:
                    raise Error(404, '操作が見つかりません。')
            self.respond(status, result, cookie)
        except Error as error:
            self.respond(error.status, {'error': str(error)})
        except sqlite3.IntegrityError:
            self.respond(409, {'error': 'IDなどが重複しています。画面を更新してください。'})
        except Exception:
            self.respond(503, {'error': '保存できませんでした。少し待って再試行してください。'})


def main():
    initialize()
    if len(sys.argv) > 1 and sys.argv[1] == 'init-owner-hash':
        record = json.load(sys.stdin)
        if record.get('id') != 'Y' or not valid_hash(record.get('hash')):
            raise SystemExit('Invalid owner initialization')
        with db(True) as connection:
            existing = connection.execute("SELECT id FROM users WHERE role='owner'").fetchone()
            if existing:
                print('Owner already initialized; preserved')
            else:
                connection.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)', ('Y', record['hash'], 'owner', None, 1, None, None, now_ms()))
                print('Owner initialized')
        return
    with db() as connection:
        if not connection.execute("SELECT id FROM users WHERE role='owner'").fetchone():
            raise SystemExit('Initialize the owner before starting the service')
    ThreadingHTTPServer(('127.0.0.1', int(os.getenv('QUIZ_PORT', '8793'))), Handler).serve_forever()


if __name__ == '__main__':
    main()
