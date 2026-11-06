#!/usr/bin/env python3
"""VPS-side Y++ Bingo admin API. Bind loopback; proxy /api/bingo/ over HTTPS.
Set YPLUS_BINGO_PIN_HASH and YPLUS_BINGO_GITHUB_TOKEN as private env vars.
Generate the PIN hash by running: python3 bingo_admin.py hash-password
"""
import base64
import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

URL = "https://api.github.com/repos/y-tools/0/issues/1"
START = "<!-- YPLUS_BINGO_STATE_START -->"
END = "<!-- YPLUS_BINGO_STATE_END -->"
BLOCK = re.compile(re.escape(START) + r".*?" + re.escape(END), re.S)
ORIGINS = set(os.getenv("YPLUS_BINGO_ORIGINS", "https://y-tools.github.io").split(","))
PIN_HASH = os.getenv("YPLUS_BINGO_PIN_HASH", "")
GITHUB_TOKEN = os.getenv("YPLUS_BINGO_GITHUB_TOKEN", "")
SESSIONS = {}
FAILURES = {}
LOCK = threading.Lock()
WRITE_LOCK = threading.Lock()


class Error(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def unb64(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def make_hash(pin):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(pin.encode(), salt=salt, n=16384, r=8, p=1)
    return "scrypt:" + b64(salt) + ":" + b64(digest)


def check_hash(pin):
    try:
        version, salt, digest = PIN_HASH.split(":")
        if version != "scrypt":
            return False
        actual = hashlib.scrypt(pin.encode(), salt=unb64(salt), n=16384, r=8, p=1)
        return hmac.compare_digest(actual, unb64(digest))
    except (ValueError, TypeError):
        return False


def issue_request(method, data=None):
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + GITHUB_TOKEN,
        "User-Agent": "YPlus-Bingo-Admin",
        "Content-Type": "application/json",
    }
    request = urllib.request.Request(
        URL, headers=headers, method=method,
        data=json.dumps(data, ensure_ascii=False).encode() if data is not None else None)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)
    except (OSError, urllib.error.HTTPError) as exc:
        raise Error(502, "GitHubとの通信に失敗しました。権限と接続状態を確認してください。") from exc


def load():
    issue = issue_request("GET")
    body = issue.get("body") or ""
    match = BLOCK.search(body)
    if not match:
        raise Error(502, "共有ビンゴデータが見つかりません。")
    match_json = re.search(chr(96) * 3 + r"json\s*([\s\S]*?)\s*" + chr(96) * 3, match.group())
    if not match_json:
        raise Error(502, "共有ビンゴデータが不正です。")
    try:
        state = json.loads(match_json.group(1))
    except ValueError as exc:
        raise Error(502, "共有ビンゴデータが不正です。") from exc
    if state.get("schemaVersion") != 1 or not isinstance(state.get("drawn"), list):
        raise Error(502, "共有ビンゴデータが不正です。")
    return body, state


def save(body, state):
    fence = chr(96) * 3
    replacement = START + "\n" + fence + "json\n" + json.dumps(state, ensure_ascii=False, indent=2) + "\n" + fence + "\n" + END
    updated, n = BLOCK.subn(lambda _: replacement, body, count=1)
    if n != 1:
        raise Error(502, "保存先が見つかりません。")
    issue_request("PATCH", {"body": updated})


def change(state, payload):
    action = payload.get("action")
    numbers = state["drawn"]
    if action == "save":
        title, announcement = payload.get("title"), payload.get("announcement")
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 60:
            raise Error(400, "イベント名は1〜60文字で入力してください。")
        if not isinstance(announcement, str) or len(announcement) > 300:
            raise Error(400, "お知らせは300文字以内で入力してください。")
        state["title"], state["announcement"] = title.strip(), announcement
    elif action == "start":
        state["status"] = "running"
    elif action == "pause":
        state["status"] = "paused"
    elif action == "finish":
        state["status"] = "finished"
    elif action == "draw":
        if state.get("status") != "running":
            raise Error(400, "ゲームを開始してください。")
        if len(set(numbers)) != len(numbers) or any(type(n) is not int or n < 1 or n > 75 for n in numbers):
            raise Error(502, "抽選履歴が不正です。")
        remaining = [n for n in range(1, 76) if n not in numbers]
        if not remaining:
            raise Error(400, "すべて抽選済みです。")
        numbers.append(secrets.choice(remaining))
    elif action == "undo":
        if not numbers:
            raise Error(400, "取り消す番号がありません。")
        numbers.pop()
    elif action == "reset":
        state["roundId"] = "round-" + str(time.time_ns())
        state["drawn"], state["status"] = [], "waiting"
    else:
        raise Error(400, "不正な管理操作です。")
    state["revision"] = int(state.get("revision", 0)) + 1
    state["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return state


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Vary", "Origin")
        origin = self.headers.get("Origin")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        if self.headers.get("Origin") not in ORIGINS:
            return self.respond(403, {"error": "Origin not allowed"})
        return self.respond(204, {})

    def parse(self):
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            raise Error(415, "JSON形式で送信してください。")
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 4096:
                raise ValueError()
            result = json.loads(self.rfile.read(size).decode())
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (ValueError, UnicodeError):
            raise Error(400, "JSON形式が不正です。")

    def check_auth(self):
        value = self.headers.get("Authorization", "")
        if not value.startswith("Bearer "):
            raise Error(401, "管理画面にログインしてください。")
        session = value[len("Bearer "):]
        with LOCK:
            if SESSIONS.get(session, 0) < time.time():
                SESSIONS.pop(session, None)
                raise Error(401, "ログインの有効期限が切れました。")
        return session

    def do_GET(self):
        if self.path == "/api/bingo/health":
            return self.respond(200, {"ok": True})
        if self.path == "/api/bingo/admin/state":
            try:
                self.check_auth()
                _, state = load()
                return self.respond(200, {"state": state})
            except Error as exc:
                return self.respond(exc.status, {"error": str(exc)})
        return self.respond(404, {"error": "Not found"})

    def do_POST(self):
        try:
            if self.headers.get("Origin") not in (None, *ORIGINS):
                raise Error(403, "Origin not allowed")
            data = self.parse()
            if self.path == "/api/bingo/admin/login":
                ip = self.client_address[0]
                if ip in ("127.0.0.1", "::1"):
                    ip = self.headers.get("X-Real-IP", ip).strip()[:64]
                now = time.time()
                with LOCK:
                    bad = [t for t in FAILURES.get(ip, []) if now - t < 900]
                    FAILURES[ip] = bad
                    if len(bad) >= 5:
                        raise Error(429, "認証失敗が続いたため、15分後に再試行してください。")
                password = data.get("password")
                if not isinstance(password, str) or len(password) > 128 or not check_hash(password):
                    with LOCK:
                        FAILURES.setdefault(ip, []).append(now)
                    raise Error(401, "パスワードが正しくありません。")
                session = secrets.token_urlsafe(32)
                with LOCK:
                    FAILURES.pop(ip, None)
                    SESSIONS[session] = now + 7200
                return self.respond(200, {"token": session, "expiresIn": 7200})
            if self.path == "/api/bingo/admin/logout":
                session = self.check_auth()
                with LOCK:
                    SESSIONS.pop(session, None)
                return self.respond(200, {"ok": True})
            if self.path == "/api/bingo/admin/action":
                self.check_auth()
                with WRITE_LOCK:
                    body, state = load()
                    rev = data.get("expectedRevision")
                    if type(rev) is not int or rev != state.get("revision"):
                        raise Error(409, "更新履歴が変わりました。ページを再取得してください。")
                    state = change(state, data)
                    save(body, state)
                return self.respond(200, {"state": state})
            raise Error(404, "Not found")
        except Error as exc:
            return self.respond(exc.status, {"error": str(exc)})


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "hash-password":
        password = getpass.getpass("管理画面パスワード: ")
        if not password or len(password) > 128:
            sys.exit("パスワードが不正です。")
        print(make_hash(password))
        return
    if not PIN_HASH.startswith("scrypt:") or not GITHUB_TOKEN:
        sys.exit("YPLUS_BINGO_PIN_HASH と YPLUS_BINGO_GITHUB_TOKEN が必要です。")
    print("Y++ Bingo admin API: 127.0.0.1:8765", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8765), Handler).serve_forever()


if __name__ == "__main__":
    main()
