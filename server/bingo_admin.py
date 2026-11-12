#!/usr/bin/env python3
"""Y++ Bingo API. Isolated service: loopback only; proxy /api/bingo/* over HTTPS."""
import base64, getpass, hashlib, hmac, json, os, secrets, sys, threading, time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ORIGINS=set(os.getenv("YPLUS_BINGO_ORIGINS","https://y-tools.github.io").split(","))
PIN_HASH=os.getenv("YPLUS_BINGO_PIN_HASH","")
OWNER_ID=os.getenv("YPLUS_BINGO_OWNER_ID","Y")
SESSION_FILE=os.getenv("YPLUS_BINGO_SESSION_FILE","/var/lib/yplus-bingo/sessions.json")
ADMIN_USERS_FILE=os.getenv("YPLUS_BINGO_ADMIN_USERS_FILE","/var/lib/yplus-bingo/admin_users.json")
STATE_FILE=os.getenv("YPLUS_BINGO_STATE_FILE","/var/lib/yplus-bingo/state.json")
PARTICIPANTS_FILE=os.getenv("YPLUS_BINGO_PARTICIPANTS_FILE","/var/lib/yplus-bingo/participants.json")
CHAT_FILE=os.getenv("YPLUS_BINGO_CHAT_FILE","/var/lib/yplus-bingo/chat.json")
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
def verify_hash(pin,encoded):
    try:
        version,salt,digest=encoded.split(":")
        if version!="scrypt": return False
        actual=hashlib.scrypt(pin.encode(),salt=unb64(salt),n=16384,r=8,p=1)
        return hmac.compare_digest(actual,unb64(digest))
    except (ValueError,TypeError): return False
def check_hash(pin): return verify_hash(pin,PIN_HASH)

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
def load_chat():
    data=load_json(CHAT_FILE,{"schemaVersion":1,"messages":[]})
    if data.get("schemaVersion")!=1 or not isinstance(data.get("messages"),list):
        raise Error(503,"チャットデータが不正です。")
    return data
def save_chat(data): save_json(CHAT_FILE,data)
def load_sessions():
    data=load_json(SESSION_FILE,{"schemaVersion":1,"sessions":{}})
    if data.get("schemaVersion")!=1 or not isinstance(data.get("sessions"),dict):
        raise Error(503,"セッションデータが不正です。")
    now=time.time()
    return {k:v for k,v in data["sessions"].items() if isinstance(v,dict) and v.get("expiresAt",0)>=now}
def save_sessions(): save_json(SESSION_FILE,{"schemaVersion":1,"sessions":SESSIONS})
def load_admin_users():
    data=load_json(ADMIN_USERS_FILE,{"schemaVersion":1,"users":[]})
    if data.get("schemaVersion")!=1 or not isinstance(data.get("users"),list):
        raise Error(503,"管理者アカウントデータが不正です。")
    return data
def save_admin_users(data): save_json(ADMIN_USERS_FILE,data)
def find_admin_user(admin_id):
    admin_id=str(admin_id or "").strip()
    if admin_id==OWNER_ID:
        return {"id":OWNER_ID,"role":"owner","passwordHash":PIN_HASH}
    data=load_admin_users()
    return next((u for u in data["users"] if u.get("id")==admin_id),None)
def make_card():
    ranges=[range(1,21),range(21,41),range(41,61),range(61,81),range(81,100)]
    columns=[]
    for source in ranges:
        pool=list(source); chosen=[]
        while len(chosen)<5:
            n=secrets.choice(pool); pool.remove(n); chosen.append(n)
        columns.append(chosen)
    return [0 if r==2 and c==2 else columns[c][r] for r in range(5) for c in range(5)]
def card_obj(round_id):
    return {"id":"card-"+secrets.token_urlsafe(7),"numbers":make_card(),"roundId":round_id,"issuedAt":now_text()}
def public_person(p):
    return {"id":p["id"],"name":p["name"],"status":p["status"],"cards":p.get("cards",[])}
def admin_person(p):
    return {**public_person(p),"deviceId":p.get("deviceId",""),"pendingExtra":int(p.get("pendingExtra",0) or 0),"createdAt":p.get("createdAt"),"updatedAt":p.get("updatedAt")}
def find_person(data,pid):
    return next((p for p in data["participants"] if p.get("id")==pid),None)

def card_line_counts(card,drawn):
    numbers=card.get("numbers",[])
    if len(numbers)!=25: return []
    hits=set(drawn)
    marked=[i==12 or n in hits for i,n in enumerate(numbers)]
    lines=[[r*5+c for c in range(5)] for r in range(5)]
    lines += [[r*5+c for r in range(5)] for c in range(5)]
    lines += [[0,6,12,18,24],[4,8,12,16,20]]
    return [sum(marked[i] for i in line) for line in lines]

def draw_achievement_entries(people,before,after):
    entries=[]
    for person in people:
        if person.get("status")!="approved": continue
        previous=[]; current=[]
        for card in person.get("cards",[]):
            previous.extend(card_line_counts(card,before))
            current.extend(card_line_counts(card,after))
        before_bingo=previous.count(5); after_bingo=current.count(5)
        identity={"participantId":person["id"],"name":person["name"]}
        if after_bingo>before_bingo:
            entries.append({**identity,"type":"bingo","bingoFrom":before_bingo+1,"bingoTo":after_bingo})
        if any(old<4 and new==4 for old,new in zip(previous,current)):
            entries.append({**identity,"type":"reach","reach":current.count(4)})
    return sorted(entries,key=lambda entry:entry["type"]!="bingo")


def change_state(state,payload):
    action=payload.get("action"); numbers=state["drawn"]
    if action=="save":
        title=payload.get("title"); announcement=payload.get("announcement")
        if not isinstance(title,str) or not 1<=len(title.strip())<=60: raise Error(400,"イベント名は1〜60文字で入力してください。")
        if not isinstance(announcement,str) or len(announcement)>300: raise Error(400,"お知らせは300文字以内で入力してください。")
        state["title"]=title.strip(); state["announcement"]=announcement
    elif action=="set_live":
        on_air=payload.get("onAir")
        if type(on_air) is not bool: raise Error(400,"LIVEの状態を指定してください。")
        state["liveOnAir"]=on_air
    elif action in ("start","draw_start"):
        state["status"]="running"; state["drawActive"]=True
    elif action in ("pause","draw_stop"):
        state["drawActive"]=False; state.pop("celebrations",None)
        if state.get("status")=="waiting": state["status"]="running"
    elif action=="finish":
        state["status"]="finished"; state["drawActive"]=False; state.pop("celebrations",None)
    elif action=="draw":
        if not state.get("drawActive",False): raise Error(400,"抽選開始を押してください。")
        animation_until=int((state.get("lastDraw") or {}).get("animationUntilMs",0) or 0)
        if animation_until>int(time.time()*1000): raise Error(409,"前の抽選演出が終了してから次を抽選してください。")
        remaining=[n for n in range(1,100) if n not in numbers]
        if not remaining: raise Error(400,"すべて抽選済みです。")
        before=list(numbers)
        picked=secrets.choice(remaining); numbers.append(picked)
        now_ms=int(time.time()*1000)
        state["lastDraw"]={"number":picked,"animationUntilMs":now_ms+5000}
        events=[event for event in state.get("celebrations",[]) if event.get("endsAtMs",0)>now_ms]
        entries=draw_achievement_entries(load_people()["participants"],before,numbers)
        if entries:
            starts_at=max([now_ms+5000]+[event["endsAtMs"] for event in events])
            events.append({"id":"celebration-"+secrets.token_urlsafe(8),"startsAtMs":starts_at,"endsAtMs":starts_at+10000,"entries":entries})
        state["celebrations"]=events
    elif action=="undo":
        if not numbers: raise Error(400,"取り消す番号がありません。")
        numbers.pop(); state.pop("lastDraw",None); state.pop("celebrations",None)
    elif action=="reset":
        state["drawn"]=[]; state["status"]="waiting"; state["drawActive"]=False; state.pop("lastDraw",None); state.pop("celebrations",None)
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
        origin=self.headers.get("Origin")
        if origin not in ORIGINS:
            return self.respond(403,{"error":"Origin not allowed"})
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin",origin)
        self.send_header("Access-Control-Allow-Headers","Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods","GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age","600")
        self.send_header("Vary","Origin")
        self.send_header("Content-Length","0")
        self.end_headers()
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
        session=value[7:]; now=time.time()
        with LOCK:
            info=SESSIONS.get(session)
            if not info or info.get("expiresAt",0)<now:
                SESSIONS.pop(session,None); save_sessions(); raise Error(401,"ログインの有効期限が切れました。")
            info["lastSeen"]=now
        return session
    def do_GET(self):
        try:
            if self.path=="/api/bingo/health": return self.respond(200,{"ok":True})
            if self.path=="/api/bingo/state": return self.respond(200,{"state":load_state(),"serverTimeMs":int(time.time()*1000)})
            if self.path=="/api/bingo/participants":
                people=load_people()
                approved=[public_person(p) for p in people["participants"] if p.get("status")=="approved"]
                return self.respond(200,{"participants":approved})
            if self.path=="/api/bingo/admin/state":
                self.check_auth(); return self.respond(200,{"state":load_state()})
            if self.path=="/api/bingo/admin/participants":
                self.check_auth(); return self.respond(200,{"participants":[admin_person(p) for p in load_people()["participants"]]})
            if self.path=="/api/bingo/admin/overview":
                session=self.check_auth(); now=time.time()
                with LOCK:
                    online=sum(1 for info in SESSIONS.values() if info.get("expiresAt",0)>=now and now-info.get("lastSeen",0)<=15)
                    me=SESSIONS.get(session,{})
                chat=load_chat()
                return self.respond(200,{"onlineCount":online,"name":me.get("adminId",""),"adminId":me.get("adminId",""),"canManageUsers":me.get("role")=="owner","canDeleteParticipants":True,"messages":chat["messages"][-100:]})
            if self.path=="/api/bingo/admin/users":
                session=self.check_auth()
                with LOCK: info=SESSIONS.get(session,{})
                if info.get("role")!="owner": raise Error(403,"この設定はYのみ変更できます。")
                users=[{"id":OWNER_ID,"role":"owner"}]+[{"id":u.get("id"),"role":"admin"} for u in load_admin_users()["users"]]
                return self.respond(200,{"users":users})
            return self.respond(404,{"error":"Not found"})
        except Error as exc: return self.respond(exc.status,{"error":str(exc)})
    def do_POST(self):
        try:
            if self.headers.get("Origin") not in (None,*ORIGINS): raise Error(403,"Origin not allowed")
            data=self.parse()
            if self.path=="/api/bingo/apply":
                state=load_state()
                if state.get("status")=="finished": raise Error(409,"イベント終了後はカードを申請できません。")
                name=data.get("name"); device=data.get("deviceId")
                if not isinstance(name,str) or not 1<=len(name.strip())<=30: raise Error(400,"REALITY上の名前を1〜30文字で入力してください。")
                if not isinstance(device,str) or not 12<=len(device)<=100: raise Error(400,"端末識別情報が不正です。")
                name=name.strip()
                with WRITE_LOCK:
                    store=load_people()
                    pending=next((p for p in store["participants"] if p.get("deviceId")==device and (p.get("status")=="pending" or int(p.get("pendingExtra",0) or 0)>0)),None)
                    if pending: raise Error(409,"この端末には承認待ちの申請があります。")
                    approved=next((p for p in store["participants"] if p.get("deviceId")==device and p.get("status")=="approved"),None)
                    now=now_text()
                    if approved:
                        approved["pendingExtra"]=1; approved["updatedAt"]=now; p=approved
                    else:
                        p={"id":"p-"+secrets.token_urlsafe(8),"name":name,"deviceId":device,"status":"pending","pendingExtra":0,"cards":[],"createdAt":now,"updatedAt":now}
                        store["participants"].append(p)
                    save_people(store)
                return self.respond(201,{"participant":public_person(p),"additional":p.get("status")=="approved"})
            if self.path=="/api/bingo/admin/login":
                ip=self.client_address[0]
                if ip in ("127.0.0.1","::1"): ip=self.headers.get("X-Real-IP",ip).strip()[:64]
                now=time.time()
                with LOCK:
                    bad=[t for t in FAILURES.get(ip,[]) if now-t<900]; FAILURES[ip]=bad
                    if len(bad)>=5: raise Error(429,"認証失敗が続いたため、15分後に再試行してください。")
                admin_id=data.get("adminId"); password=data.get("password"); remember=bool(data.get("remember"))
                if not isinstance(admin_id,str) or not 1<=len(admin_id.strip())<=64:
                    raise Error(400,"管理者IDを入力してください。")
                user=find_admin_user(admin_id)
                if not user or not isinstance(password,str) or len(password)>128 or not verify_hash(password,user.get("passwordHash","")):
                    with LOCK: FAILURES.setdefault(ip,[]).append(now)
                    raise Error(401,"管理者IDまたはパスワードが正しくありません。")
                ttl=86400 if remember else 7200
                session=secrets.token_urlsafe(32)
                with LOCK:
                    FAILURES.pop(ip,None)
                    SESSIONS[session]={"expiresAt":now+ttl,"lastSeen":now,"name":user["id"],"adminId":user["id"],"role":user["role"]}
                    save_sessions()
                return self.respond(200,{"token":session,"expiresIn":ttl,"adminId":user["id"],"canManageUsers":user["role"]=="owner"})
            if self.path=="/api/bingo/admin/logout":
                session=self.check_auth()
                with LOCK:
                    SESSIONS.pop(session,None); save_sessions()
                return self.respond(200,{"ok":True})
            if self.path=="/api/bingo/admin/participant":
                self.check_auth(); pid=data.get("participantId"); action=data.get("action")
                if not isinstance(pid,str) or action not in ("approve","reject","issue_extra","delete_participant","delete_card"): raise Error(400,"参加者操作が不正です。")
                with WRITE_LOCK:
                    store=load_people(); p=find_person(store,pid)
                    if not p: raise Error(404,"参加者が見つかりません。")
                    if action=="delete_participant":
                        expected=data.get("expectedCardIds")
                        current=[card.get("id") for card in p.get("cards",[])]
                        if not isinstance(expected,list) or any(not isinstance(cid,str) for cid in expected) or sorted(expected)!=sorted(current):
                            raise Error(409,"カード構成が変わりました。一覧を確認してやり直してください。")
                        store["participants"]=[person for person in store["participants"] if person.get("id")!=pid]
                        save_people(store)
                        return self.respond(200,{"ok":True,"deletedParticipantId":pid})
                    if action=="delete_card":
                        card_id=data.get("cardId")
                        if not isinstance(card_id,str) or not card_id: raise Error(400,"削除するカードIDを指定してください。")
                        cards=p.get("cards",[])
                        if not any(card.get("id")==card_id for card in cards): raise Error(404,"カードが見つかりません。一覧を確認してください。")
                        p["cards"]=[card for card in cards if card.get("id")!=card_id]
                        p["updatedAt"]=now_text(); save_people(store)
                        return self.respond(200,{"participant":admin_person(p),"deletedCardId":card_id})
                    state=load_state()
                    if action=="approve":
                        if p.get("status")=="pending":
                            p["status"]="approved"; p["cards"]=[card_obj(state["roundId"])]
                        elif p.get("status")=="approved" and int(p.get("pendingExtra",0) or 0)>0:
                            p.setdefault("cards",[]).append(card_obj(state["roundId"])); p["pendingExtra"]=0
                        else: raise Error(409,"この申請はすでに処理済みです。")
                    elif action=="reject":
                        if p.get("status")=="pending": p["status"]="rejected"
                        elif p.get("status")=="approved" and int(p.get("pendingExtra",0) or 0)>0: p["pendingExtra"]=0
                        else: raise Error(409,"この申請はすでに処理済みです。")
                    else:
                        if p.get("status")!="approved": raise Error(409,"承認済み参加者にのみ追加発行できます。")
                        p.setdefault("cards",[]).append(card_obj(state["roundId"]))
                    p["updatedAt"]=now_text(); save_people(store)
                return self.respond(200,{"participant":admin_person(p)})
            if self.path=="/api/bingo/admin/name":
                session=self.check_auth()
                # Retain this endpoint for older clients; identity is fixed by login.
                with LOCK:
                    name=SESSIONS[session]["adminId"]
                    SESSIONS[session]["name"]=name; save_sessions()
                return self.respond(200,{"name":name})
            if self.path=="/api/bingo/admin/chat":
                session=self.check_auth(); message=data.get("message")
                if not isinstance(message,str) or not 1<=len(message.strip())<=300: raise Error(400,"メッセージは1〜300文字で入力してください。")
                with LOCK: name=SESSIONS[session]["adminId"]
                with WRITE_LOCK:
                    chat=load_chat(); chat["messages"].append({"id":"m-"+secrets.token_urlsafe(6),"name":name,"adminId":name,"message":message.strip(),"createdAt":now_text()})
                    chat["messages"]=chat["messages"][-200:]; save_chat(chat)
                return self.respond(201,{"ok":True})
            if self.path=="/api/bingo/admin/users":
                session=self.check_auth()
                with LOCK: info=SESSIONS.get(session,{})
                if info.get("role")!="owner": raise Error(403,"この設定はYのみ変更できます。")
                action=data.get("action"); admin_id=data.get("adminId")
                if action not in ("create","delete","change_password"): raise Error(400,"管理者アカウント操作が不正です。")
                if not isinstance(admin_id,str) or not 1<=len(admin_id.strip())<=64: raise Error(400,"管理者IDを1〜64文字で入力してください。")
                admin_id=admin_id.strip()
                if admin_id==OWNER_ID: raise Error(409,"Yアカウントはこの画面から削除・変更できません。")
                with WRITE_LOCK:
                    store=load_admin_users(); existing=next((u for u in store["users"] if u.get("id")==admin_id),None)
                    if action=="create":
                        password=data.get("password")
                        if existing: raise Error(409,"同じ管理者IDがすでにあります。")
                        if not isinstance(password,str) or not 8<=len(password)<=128: raise Error(400,"パスワードは8〜128文字で設定してください。")
                        store["users"].append({"id":admin_id,"role":"admin","passwordHash":make_hash(password),"createdAt":now_text()})
                    elif action=="delete":
                        if not existing: raise Error(404,"管理者IDが見つかりません。")
                        store["users"]=[u for u in store["users"] if u.get("id")!=admin_id]
                    else:
                        password=data.get("password")
                        if not existing: raise Error(404,"管理者IDが見つかりません。")
                        if not isinstance(password,str) or not 8<=len(password)<=128: raise Error(400,"パスワードは8〜128文字で設定してください。")
                        existing["passwordHash"]=make_hash(password); existing["updatedAt"]=now_text()
                    save_admin_users(store)
                return self.respond(200,{"ok":True})
            if self.path=="/api/bingo/admin/action":
                self.check_auth()
                with WRITE_LOCK:
                    state=load_state(); rev=data.get("expectedRevision")
                    if type(rev) is not int or rev!=state.get("revision"): raise Error(409,"更新履歴が変わりました。ページを再取得してください。")
                    state=change_state(state,data); save_state(state)
                return self.respond(200,{"state":state,"serverTimeMs":int(time.time()*1000)})
            raise Error(404,"Not found")
        except Error as exc: return self.respond(exc.status,{"error":str(exc)})

def main():
    global SESSIONS
    SESSIONS=load_sessions()
    if len(sys.argv)==2 and sys.argv[1]=="hash-password":
        password=getpass.getpass("管理画面パスワード: ")
        if not password or len(password)>128: sys.exit("パスワードが不正です。")
        print(make_hash(password)); return
    if not PIN_HASH.startswith("scrypt:"): sys.exit("YPLUS_BINGO_PIN_HASH が必要です。")
    print("Y++ Bingo API on loopback",flush=True)
    ThreadingHTTPServer(("127.0.0.1",int(os.getenv("YPLUS_BINGO_PORT","8791"))),Handler).serve_forever()
if __name__=="__main__": main()



