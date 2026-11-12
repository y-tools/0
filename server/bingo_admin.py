#!/usr/bin/env python3
"""Y++ Bingo API. Isolated service: loopback only; proxy /api/bingo/* over HTTPS."""
import base64, getpass, hashlib, hmac, json, os, secrets, sys, threading, time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ORIGINS=set(os.getenv("YPLUS_BINGO_ORIGINS","https://y-tools.github.io").split(","))
PIN_HASH=os.getenv("YPLUS_BINGO_PIN_HASH","")
STATE_FILE=os.getenv("YPLUS_BINGO_STATE_FILE","/var/lib/yplus-bingo/state.json")
PARTICIPANTS_FILE=os.getenv("YPLUS_BINGO_PARTICIPANTS_FILE","/var/lib/yplus-bingo/participants.json")
SESSIONS={}; FAILURES={}; LOCK=threading.Lock(); WRITE_LOCK=threading.Lock()

class Error(Exception):
    def __init__(self,status,message): super().__init__(message); self.status=status

def now_text():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z")
def b64(v): return base64.urlsafe_b64encode(v).decode().rstrip("=")
def unb64(v): return base64.urlsafe_b64decode(v+"="*(-len(v)%4))
def make_hash(pin):
    salt=secrets.token_bytes(16); digest=hashlib.scrypt(pin.encode(),salt=salt,n=16384,r=8,p=1)
    return "scrypt:"+b64(salt)+":"+b64(digest)
def check_hash(pin):
    try:
        version,salt,digest=PIN_HASH.split(":")
        if version!="scrypt": return False
        actual=hashlib.scrypt(pin.encode(),salt=unb64(salt),n=16384,r=8,p=1)
        return hmac.compare_digest(actual,unb64(digest))
    except (ValueError,TypeError): return False

def load_json(path,default):
    try:
        with open(path,encoding="utf-8") as h: return json.load(h)
    except FileNotFoundError: return default
    except (OSError,ValueError) as exc: raise Error(503,"保存データを読み込めません。") from exc
def save_json(path,data):
    temp=path+".tmp"
    try:
        with open(temp,"w",encoding="utf-8") as h:
            json.dump(data,h,ensure_ascii=False,indent=2); h.flush(); os.fsync(h.fileno())
        os.replace(temp,path)
    except OSError as exc: raise Error(503,"保存に失敗しました。") from exc

def load_state():
    state=load_json(STATE_FILE,{})
    if state.get("schemaVersion")!=1 or not isinstance(state.get("drawn"),list):
        raise Error(503,"ゲームデータが不正です。")
    return state
def save_state(state): save_json(STATE_FILE,state)
def load_people():
    data=load_json(PARTICIPANTS_FILE,{"schemaVersion":1,"participants":[]})
    if data.get("schemaVersion")!=1 or not isinstance(data.get("participants"),list):
        raise Error(503,"参加者データが不正です。")
    return data
def save_people(data): save_json(PARTICIPANTS_FILE,data)
def make_card():
    columns=[]
    for c in range(5):
        pool=list(range(c*15+1,c*15+16)); chosen=[]
        while len(chosen)<5:
            n=secrets.choice(pool); pool.remove(n); chosen.append(n)
        columns.append(chosen)
    return [0 if r==2 and c==2 else columns[c][r] for r in range(5) for c in range(5)]
def card_obj(round_id):
    return {"id":"card-"+secrets.token_urlsafe(7),"numbers":make_card(),"roundId":round_id,"issuedAt":now_text()}
def public_person(p):
    return {"id":p["id"],"name":p["name"],"status":p["status"],"cards":p.get("cards",[])}
def admin_person(p):
    return {**public_person(p),"deviceId":p.get("deviceId",""),"createdAt":p.get("createdAt"),"updatedAt":p.get("updatedAt")}
def find_person(data,pid):
    return next((p for p in data["participants"] if p.get("id")==pid),None)

def change_state(state,payload):
    action=payload.get("action"); numbers=state["drawn"]
    if action=="save":
        title=payload.get("title"); announcement=payload.get("announcement")
        if not isinstance(title,str) or not 1<=len(title.strip())<=60: raise Error(400,"イベント名は1〜60文字で入力してください。")
        if not isinstance(announcement,str) or len(announcement)>300: raise Error(400,"お知らせは300文字以内で入力してください。")
        state["title"]=title.strip(); state["announcement"]=announcement
    elif action=="start": state["status"]="running"
    elif action=="pause": state["status"]="paused"
    elif action=="finish": state["status"]="finished"
    elif action=="draw":
        if state.get("status")!="running": raise Error(400,"ゲームを開始してください。")
        remaining=[n for n in range(1,76) if n not in numbers]
        if not remaining: raise Error(400,"すべて抽選済みです。")
        numbers.append(secrets.choice(remaining))
    elif action=="undo":
        if not numbers: raise Error(400,"取り消す番号がありません。")
        numbers.pop()
    elif action=="reset":
        state["drawn"]=[]; state["status"]="waiting"
    else: raise Error(400,"不正な管理操作です。")
    state["revision"]=int(state.get("revision",0))+1; state["updatedAt"]=now_text(); return state

class Handler(BaseHTTPRequestHandler):
    def respond(self,status,payload):
        raw=json.dumps(payload,ensure_ascii=False).encode()
        self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Cache-Control","no-store"); self.send_header("Vary","Origin")
        origin=self.headers.get("Origin")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin",origin)
            self.send_header("Access-Control-Allow-Headers","Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods","GET, POST, OPTIONS")
        self.send_header("Content-Length",str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def do_OPTIONS(self):
        if self.headers.get("Origin") not in ORIGINS: return self.respond(403,{"error":"Origin not allowed"})
        return self.respond(204,{})
    def parse(self):
        if self.headers.get("Content-Type","").split(";")[0]!="application/json": raise Error(415,"JSON形式で送信してください。")
        try:
            size=int(self.headers.get("Content-Length","0"))
            if not 0<size<=8192: raise ValueError()
            result=json.loads(self.rfile.read(size).decode())
            if not isinstance(result,dict): raise ValueError()
            return result
        except (ValueError,UnicodeError): raise Error(400,"JSON形式が不正です。")
    def check_auth(self):
        value=self.headers.get("Authorization","")
        if not value.startswith("Bearer "): raise Error(401,"管理画面にログインしてください。")
        session=value[7:]
        with LOCK:
            if SESSIONS.get(session,0)<time.time():
                SESSIONS.pop(session,None); raise Error(401,"ログインの有効期限が切れました。")
        return session
    def do_GET(self):
        try:
            if self.path=="/api/bingo/health": return self.respond(200,{"ok":True})
            if self.path=="/api/bingo/state": return self.respond(200,{"state":load_state()})
            if self.path=="/api/bingo/participants":
                people=load_people()
                approved=[public_person(p) for p in people["participants"] if p.get("status")=="approved"]
                return self.respond(200,{"participants":approved})
            if self.path=="/api/bingo/admin/state":
                self.check_auth(); return self.respond(200,{"state":load_state()})
            if self.path=="/api/bingo/admin/participants":
                self.check_auth(); return self.respond(200,{"participants":[admin_person(p) for p in load_people()["participants"]]})
            return self.respond(404,{"error":"Not found"})
        except Error as exc: return self.respond(exc.status,{"error":str(exc)})
    def do_POST(self):
        try:
            if self.headers.get("Origin") not in (None,*ORIGINS): raise Error(403,"Origin not allowed")
            data=self.parse()
            if self.path=="/api/bingo/apply":
                state=load_state()
                if state.get("status")!="waiting": raise Error(409,"抽選開始後は新しいカードを申請できません。")
                name=data.get("name"); device=data.get("deviceId")
                if not isinstance(name,str) or not 1<=len(name.strip())<=30: raise Error(400,"REALITY上の名前を1〜30文字で入力してください。")
                if not isinstance(device,str) or not 12<=len(device)<=100: raise Error(400,"端末識別情報が不正です。")
                name=name.strip()
                with WRITE_LOCK:
                    store=load_people()
                    same=[p for p in store["participants"] if p.get("deviceId")==device and p.get("status") in ("pending","approved")]
                    if same: raise Error(409,"この端末からはすでに申請されています。")
                    now=now_text()
                    p={"id":"p-"+secrets.token_urlsafe(8),"name":name,"deviceId":device,"status":"pending","cards":[],"createdAt":now,"updatedAt":now}
                    store["participants"].append(p); save_people(store)
                return self.respond(201,{"participant":public_person(p)})
            if self.path=="/api/bingo/admin/login":
                ip=self.client_address[0]
                if ip in ("127.0.0.1","::1"): ip=self.headers.get("X-Real-IP",ip).strip()[:64]
                now=time.time()
                with LOCK:
                    bad=[t for t in FAILURES.get(ip,[]) if now-t<900]; FAILURES[ip]=bad
                    if len(bad)>=5: raise Error(429,"認証失敗が続いたため、15分後に再試行してください。")
                password=data.get("password")
                if not isinstance(password,str) or len(password)>128 or not check_hash(password):
                    with LOCK: FAILURES.setdefault(ip,[]).append(now)
                    raise Error(401,"パスワードが正しくありません。")
                session=secrets.token_urlsafe(32)
                with LOCK: FAILURES.pop(ip,None); SESSIONS[session]=now+7200
                return self.respond(200,{"token":session,"expiresIn":7200})
            if self.path=="/api/bingo/admin/logout":
                session=self.check_auth()
                with LOCK: SESSIONS.pop(session,None)
                return self.respond(200,{"ok":True})
            if self.path=="/api/bingo/admin/participant":
                self.check_auth(); pid=data.get("participantId"); action=data.get("action")
                if not isinstance(pid,str) or action not in ("approve","reject","issue_extra"): raise Error(400,"参加者操作が不正です。")
                with WRITE_LOCK:
                    store=load_people(); p=find_person(store,pid)
                    if not p: raise Error(404,"参加者が見つかりません。")
                    state=load_state()
                    if action=="approve":
                        if p.get("status")!="pending": raise Error(409,"この申請はすでに処理済みです。")
                        p["status"]="approved"; p["cards"]=[card_obj(state["roundId"])]
                    elif action=="reject":
                        if p.get("status")!="pending": raise Error(409,"この申請はすでに処理済みです。")
                        p["status"]="rejected"
                    else:
                        if p.get("status")!="approved": raise Error(409,"承認済み参加者にのみ追加発行できます。")
                        p.setdefault("cards",[]).append(card_obj(state["roundId"]))
                    p["updatedAt"]=now_text(); save_people(store)
                return self.respond(200,{"participant":admin_person(p)})
            if self.path=="/api/bingo/admin/action":
                self.check_auth()
                with WRITE_LOCK:
                    state=load_state(); rev=data.get("expectedRevision")
                    if type(rev) is not int or rev!=state.get("revision"): raise Error(409,"更新履歴が変わりました。ページを再取得してください。")
                    state=change_state(state,data); save_state(state)
                return self.respond(200,{"state":state})
            raise Error(404,"Not found")
        except Error as exc: return self.respond(exc.status,{"error":str(exc)})

def main():
    if len(sys.argv)==2 and sys.argv[1]=="hash-password":
        password=getpass.getpass("管理画面パスワード: ")
        if not password or len(password)>128: sys.exit("パスワードが不正です。")
        print(make_hash(password)); return
    if not PIN_HASH.startswith("scrypt:"): sys.exit("YPLUS_BINGO_PIN_HASH が必要です。")
    print("Y++ Bingo API on loopback",flush=True)
    ThreadingHTTPServer(("127.0.0.1",int(os.getenv("YPLUS_BINGO_PORT","8791"))),Handler).serve_forever()
if __name__=="__main__": main()
