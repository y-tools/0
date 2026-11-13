"""Integration checks on an isolated disposable service, never production state."""
import base64
import http.cookiejar
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from PIL import Image

HERE = Path(__file__).resolve().parent
if HERE.name == 'server':
    HERE = HERE.parent
TEMP = Path(tempfile.mkdtemp(prefix='yplus-quiz-test-'))
PORT = 18793
os.environ.update(QUIZ_DATA=str(TEMP), QUIZ_STATIC=str(HERE / 'quiz'), QUIZ_PORT=str(PORT), QUIZ_SECURE_COOKIE='0', QUIZ_ORIGIN=f'http://127.0.0.1:{PORT}')
spec = importlib.util.spec_from_file_location('quiz_server', HERE / 'server/quiz_server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
server.initialize()
TEST_PASSWORD = 'local-test-only-8793'
with server.db(True) as conn:
    conn.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)', ('Y', server.hash_password(TEST_PASSWORD), 'owner', None, 1, None, None, server.now_ms()))

def client():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def request(c, path='state', data=None, expected=200, origin=None):
    headers = {'Content-Type': 'application/json', 'Origin': origin or os.environ['QUIZ_ORIGIN']}
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}/quiz/api/{path}', data=json.dumps(data).encode() if data is not None else None, headers=headers)
    try:
        with c.open(req) as response:
            status, result = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status, result = error.code, json.load(error)
    assert status == expected, (path, status, result)
    return result

def run():
    host, guest = client(), client()
    for _ in range(50):
        try:
            request(guest, 'health')
            break
        except OSError:
            time.sleep(.1)
    request(host, 'login', {'id': 'Y', 'password': TEST_PASSWORD})
    request(guest, 'host', expected=401)
    request(host, 'admin/player', {'slot': 5, 'id': 'extra'}, expected=400)
    request(host, 'admin/player', {'slot': 1, 'id': 'Y'}, expected=409)
    players = []
    for i in range(1, 5):
        created = request(host, 'admin/player', {'slot': i, 'id': f'p{i}'})
        assert created['generatedPassword']
        c = client()
        request(c, 'login', {'id': f'p{i}', 'password': created['generatedPassword']})
        players.append(c)
    image = io.BytesIO()
    Image.new('RGB', (360, 240), '#52c9b3').save(image, 'PNG')
    b64 = base64.b64encode(image.getvalue()).decode()
    avatar = request(host, 'admin/upload', {'kind': 'avatar', 'label': 'icon', 'data': b64})
    assert Image.open(TEMP / 'media' / (avatar['id'] + '.png')).size == (256, 256)
    request(host, 'admin/player', {'slot': 1, 'id': 'p1', 'avatarId': avatar['id']})
    screen = request(host, 'admin/upload', {'kind': 'screen', 'label': 'screen', 'data': b64})
    request(players[0], 'admin/player', {'slot': 1, 'id': 'hacked'}, expected=403)
    delegate = request(host, 'admin/delegate', {'id': 'delegate', 'hours': 1})
    gm = client()
    request(gm, 'login', {'id': 'delegate', 'password': delegate['password']})
    request(gm, 'host')
    request(gm, 'admin/delegate', {'id': 'forbidden'}, expected=403)
    q = request(gm, 'admin/question', {'label': '第1問', 'prompt': 'What is the answer?', 'correctAnswer': 'SECRET-CORRECT', 'duration': 3, 'imageIds': [screen['id']]})
    assert 'SECRET-CORRECT' not in json.dumps(request(guest))
    def action(name, **extra):
        return request(gm, 'admin/action', {'action': name, 'expectedRevision': request(gm, 'host')['game']['revision'], **extra})
    action('present', questionId=q['id'])
    current = request(guest)
    round_id = current['game']['roundId']
    assert current['game']['screen'] == 'image'
    request(players[0], 'answer', {'roundId': round_id, 'answer': 'early'}, expected=409)
    action('start', duration=3)
    deadline = request(guest)['game']['deadlineMs']
    action('show_image', mediaId=screen['id'])
    assert request(guest)['game']['deadlineMs'] == deadline
    for i, p in enumerate(players):
        request(p, 'answer', {'roundId': round_id, 'answer': f'answer-{i}'})
    request(players[0], 'answer', {'roundId': round_id, 'answer': 'LATEST'})
    request(players[1], 'answer', {'roundId': round_id, 'answer': ' ＳＥＣＲＥＴ－ＣＯＲＲＥＣＴ '})
    public = request(guest)
    assert all(p['submitted'] for p in public['players'])
    assert not any('answer' in p for p in public['players'])
    assert not any('correct' in p for p in public['players'])
    assert not any('correct' in p for p in request(players[1])['players'])
    assert 'LATEST' in json.dumps(request(players[0])) and 'answer-1' not in json.dumps(request(players[0]))
    assert request(gm, 'host')['players'][0]['answer'] == 'LATEST'
    request(gm, 'admin/action', {'action': 'lobby', 'expectedRevision': -1}, expected=409)
    request(host, 'admin/player', {'slot': 2, 'id': 'p2'}, expected=403, origin='https://evil.example')
    time.sleep(max(0, (deadline - server.now_ms()) / 1000) + .15)
    request(players[0], 'answer', {'roundId': round_id, 'answer': 'late'}, expected=409)
    assert request(guest)['game']['screen'] == 'timeup'
    assert 'SECRET-CORRECT' not in json.dumps(request(guest))
    action('reveal')
    public = request(guest)
    assert public['question']['correctAnswer'] == 'SECRET-CORRECT'
    assert public['players'][0]['answer'] == 'LATEST'
    assert public['players'][0]['correct'] is False
    assert public['players'][1]['correct'] is True
    assert public['players'][2]['correct'] is False
    action('show_question')
    assert request(guest)['game']['screen'] == 'question'
    assert not any('correct' in p for p in request(guest)['players'])
    action('present', questionId=q['id'])
    action('start', duration=30)
    request(players[0], 'answer', {'roundId': round_id, 'answer': 'old-round'}, expected=409)
    action('lobby')
    request(host, 'admin/player', {'slot': 1, 'id': 'p1-new', 'password': 'replacement'})
    assert request(players[0])['me'] is None
    request(host, 'admin/delegate', {'action': 'revoke', 'id': 'delegate'})
    request(gm, 'host', expected=401)
    expired = request(host, 'admin/delegate', {'id': 'expired', 'hours': 1})
    with server.db(True) as conn:
        conn.execute('UPDATE users SET expires_ms=? WHERE id=?', (server.now_ms() - 1, 'expired'))
    request(client(), 'login', {'id': 'expired', 'password': expired['password']}, expected=401)
    # Keep a separate clean fixture for the browser smoke check.
    request(host, 'admin/player', {'slot': 1, 'id': 'browser-player', 'password': 'browser-test-pass'})
    print('PASS: 4 players, overwrites, deadline, hidden answers, reveal, images, avatars, roles, delegation expiry/revoke, session revocation, stale rounds, CSRF')
    print('FIXTURE=' + str(TEMP))

if __name__ == '__main__':
    logfile = (TEMP / 'server.log').open('w')
    proc = subprocess.Popen([sys.executable, str(HERE / 'server/quiz_server.py')], stdout=logfile, stderr=logfile, env=os.environ.copy())
    try:
        run()
        if '--serve' in sys.argv:
            print('Browser fixture listening on', PORT, flush=True)
            proc.wait()
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        logfile.close()
