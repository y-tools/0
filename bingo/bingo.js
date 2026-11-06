'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const API = 'https://api.github.com/repos/y-tools/0/issues/1';
  const START = '<!-- YPLUS_BINGO_STATE_START -->';
  const END = '<!-- YPLUS_BINGO_STATE_END -->';
  const CARD_PREFIX = 'yplus.bingo.card.v1.';
  let state = null, issue = null, token = '', card = null, busy = false, loading = false;
  const escapeText = s => String(s ?? '');
  const storage = {
    get(k){try{return localStorage.getItem(k)}catch{return null}},
    set(k,v){try{localStorage.setItem(k,v)}catch{}}
  };
  function message(s){ $('adminMessage').textContent = s; }
  function parseIssue(raw) {
    const body = String(raw.body || '');
    const start = body.indexOf(START), end = body.indexOf(END);
    if (start < 0 || end <= start) throw new Error('共有データが見つかりません。');
    const segment = body.slice(start + START.length,end);
    const match = segment.match(/```json\s*([\s\S]*?)\s*```/);
    if (!match) throw new Error('共有データの形式が正しくありません。');
    const result = JSON.parse(match[1]);
    if (result.schemaVersion !== 1 || !Array.isArray(result.drawn) || !/^[\w-]{1,100}$/.test(result.roundId)) throw new Error('共有データが不正です。');
    return result;
  }
  async function request(method='GET', body=null, auth=false) {
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(),15000);
    try {
      const headers = {'Accept':'application/vnd.github+json'};
      if (auth && token) headers.Authorization = 'Bearer ' + token;
      if (body) headers['Content-Type'] = 'application/json';
      const resp = await fetch(API + (method === 'GET' ? '?t=' + Date.now() : ''), {method,headers,body:body?JSON.stringify(body):undefined,cache:'no-store',signal:controller.signal});
      const result = await resp.json().catch(()=>({}));
      if (!resp.ok) {
        if(resp.status===403||resp.status===429) throw new Error('GitHub APIのアクセス制限または権限不足です（HTTP '+resp.status+'）。');
        throw new Error(escapeText(result.message||'通信エラー HTTP '+resp.status));
      }
      return result;
    } finally {clearTimeout(timeout)}
  }
  function shuffle(values){const a=[...values];for(let i=a.length-1;i>0;i--){const n=new Uint32Array(1);crypto.getRandomValues(n);const j=n[0]%(i+1);[a[i],a[j]]=[a[j],a[i]]}return a}
  function newCard() {
    const columns = [];
    for(let c=0;c<5;c++) columns.push(shuffle(Array.from({length:15},(_,i)=>c*15+i+1)).slice(0,5));
    const nums = [];
    for(let r=0;r<5;r++)for(let c=0;c<5;c++) nums.push(r===2&&c===2?0:columns[c][r]);
    return nums;
  }
  function setupCard() {
    if(!state) return;
    const key=CARD_PREFIX+state.roundId;
    let value=null;
    try {value=JSON.parse(storage.get(key)||'null')}catch{}
    if(!Array.isArray(value)||value.length!==25||value[12]!==0||value.some(n=>!Number.isInteger(n)||n<0||n>75)) {
      value=newCard();storage.set(key,JSON.stringify(value));
    }
    card=value;
    $('roundLabel').textContent = state.roundId;
    const name=storage.get('yplus.bingo.name')||'';
    if($('playerName')!==document.activeElement) $('playerName').value=name;
  }
  function renderCard() {
    const root=$('bingoCard');root.replaceChildren();
    if(!card||!state)return;
    'BINGO'.split('').forEach(letter=>{const item=document.createElement('div');item.className='bingo-cell head';item.textContent=letter;root.append(item)});
    const hits=new Set(state.drawn);
    const marked = card.map((n,i)=>i===12||hits.has(n));
    card.forEach((n,i)=>{
      const item=document.createElement('div');
      item.className='bingo-cell'+(marked[i]?' marked':'')+(i===12?' free':'');
      item.textContent=i===12?'FREE':String(n);root.append(item);
    });
    const lines=[];
    for(let r=0;r<5;r++)lines.push([0,1,2,3,4].map(c=>r*5+c));
    for(let c=0;c<5;c++)lines.push([0,1,2,3,4].map(r=>r*5+c));
    lines.push([0,6,12,18,24],[4,8,12,16,20]);
    $('bingoCount').textContent=String(lines.filter(l=>l.every(i=>marked[i])).length);
    $('reachCount').textContent=String(lines.filter(l=>l.filter(i=>marked[i]).length===4).length);
  }
  function render() {
    if(!state)return;
    $('eventTitle').textContent=escapeText(state.title||'Y++ 特設ビンゴ');
    $('eventDescription').textContent=escapeText(state.description||'');
    $('announcement').textContent=escapeText(state.announcement||'');
    $('gameStatus').textContent=({waiting:'準備中',running:'開催中',paused:'一時停止',finished:'終了'})[state.status]||'準備中';
    $('latestNumber').textContent=state.drawn.length?String(state.drawn.at(-1)).padStart(2,'0'):'–';
    $('drawCount').textContent=state.drawn.length+' / 75';
    const hits=new Set(state.drawn);
    const root=$('history');root.replaceChildren();
    for(let n=1;n<=75;n++){const item=document.createElement('span');item.className='ball'+(hits.has(n)?' hit':'');item.textContent=String(n).padStart(2,'0');root.append(item)}
    if(!card||card.length!==25)setupCard();
    renderCard();
    if(token) {
      if(document.activeElement!==$('editTitle')) $('editTitle').value=escapeText(state.title||'');
      if(document.activeElement!==$('editAnnouncement')) $('editAnnouncement').value=escapeText(state.announcement||'');
      $('drawNumber').disabled=state.status!=='running'||state.drawn.length===75||busy;
      $('undoNumber').disabled=!state.drawn.length||busy;
    }
  }
  async function refresh(silent=false) {
    if(loading||busy) return;
    loading=true;
    try {
      const freshIssue=await request();
      const fresh=parseIssue(freshIssue);
      const changed=!state||state.roundId!==fresh.roundId||state.revision!==fresh.revision;
      if(changed&&state&&state.roundId!==fresh.roundId)card=null;
      state=fresh;issue=freshIssue;
      if(changed)render();
      $('connection').textContent='● 共有データ接続中 · 最終確認 '+new Date().toLocaleTimeString('ja-JP');
      $('connection').style.color='#69e7b4';
    } catch(e) {
      $('connection').textContent='⚠ 同期できません：'+e.message;
      $('connection').style.color='#f6bd89';
      if(!silent)message(e.message);
    } finally {loading=false}
  }
  async function authenticate(){
    const input=$('adminToken').value.trim();
    if(!/^((github_pat_|ghp_)[A-Za-z0-9_]+)$/.test(input))return message('GitHubのアクセストークンを入力してください。');
    token=input;
    try{
      const result=await request('GET',null,true);
      parseIssue(result);
      // Token validity must be tested against the authenticated identity. A public Issue GET is not authentication by itself.
      const me=await fetch('https://api.github.com/user',{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'},cache:'no-store'});
      if(!me.ok)throw new Error('トークンを確認できません（HTTP '+me.status+'）。');
      $('adminControls').hidden=false;$('adminLogout').hidden=false;$('adminLogin').hidden=true;$('adminToken').value='';$('adminToken').hidden=true;
      message('GitHubトークンを確認しました。Issueの更新権限は保存時に確認されます。');render();
    }catch(e){token='';message(e.message)}
  }
  async function mutate(change,confirmation){
    if(!token||busy)return;
    if(confirmation&&!confirm(confirmation))return;
    busy=true;const buttons=$('adminControls').querySelectorAll('button');buttons.forEach(b=>b.disabled=true);
    try{
      // Read the newest version immediately before a mutation.
      const freshIssue=await request('GET',null,true);
      const before=parseIssue(freshIssue);
      const after=JSON.parse(JSON.stringify(before));
      change(after);
      after.revision=before.revision+1;after.updatedAt=new Date().toISOString();
      const newBody=freshIssue.body.replace(/<!-- YPLUS_BINGO_STATE_START -->[\s\S]*?<!-- YPLUS_BINGO_STATE_END -->/,START+'\n```json\n'+JSON.stringify(after,null,2)+'\n```\n'+END);
      // GitHub Issue PATCH has no compare-and-swap; multiple concurrent administrators are not supported.
      const result=await request('PATCH',{body:newBody},true);
      issue=result;state=parseIssue(result);
      if(state.roundId!==before.roundId)card=null;
      setupCard();render();
      message('GitHubへ保存しました。視聴者画面は次回の定期取得で反映されます。');
    }catch(e){message('保存できませんでした：'+e.message);await refresh(true)}
    finally{busy=false;buttons.forEach(b=>b.disabled=false);render()}
  }
  $('generateCard').addEventListener('click',()=>{if(!state)return;if(!confirm('この端末のビンゴカードを作り直しますか？'))return;card=newCard();storage.set(CARD_PREFIX+state.roundId,JSON.stringify(card));renderCard()});
  $('playerName').addEventListener('input',()=>storage.set('yplus.bingo.name',$('playerName').value.slice(0,30)));
  $('adminLogin').addEventListener('click',authenticate);
  $('adminLogout').addEventListener('click',()=>{token='';$('adminControls').hidden=true;$('adminLogout').hidden=true;$('adminLogin').hidden=false;$('adminToken').hidden=false;message('管理者トークンを解除しました。')});
  $('saveEvent').addEventListener('click',()=>mutate(s=>{s.title=$('editTitle').value.slice(0,60);s.announcement=$('editAnnouncement').value.slice(0,300)}));
  $('startGame').addEventListener('click',()=>mutate(s=>{s.status='running'}));
  $('pauseGame').addEventListener('click',()=>mutate(s=>{s.status='paused'}));
  $('finishGame').addEventListener('click',()=>mutate(s=>{s.status='finished'},'ビンゴを終了しますか？'));
  $('drawNumber').addEventListener('click',()=>mutate(s=>{if(s.status!=='running')throw new Error('開始後に抽選できます。');const remaining=Array.from({length:75},(_,i)=>i+1).filter(n=>!s.drawn.includes(n));if(!remaining.length)throw new Error('すべて抽選済みです。');const arr=new Uint32Array(1);crypto.getRandomValues(arr);s.drawn.push(remaining[arr[0]%remaining.length])}));
  $('undoNumber').addEventListener('click',()=>mutate(s=>{s.drawn.pop()},'最後に抽選した番号を取り消しますか？'));
  $('resetGame').addEventListener('click',()=>mutate(s=>{s.roundId='round-'+Date.now();s.status='waiting';s.drawn=[]},'新しいゲームを開始するため、全員のカードと抽選履歴をリセットします。よろしいですか？'));
  window.addEventListener('pagehide',()=>{token=''});
  refresh();setInterval(()=>{if(!document.hidden)refresh(true)},60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(true)});
})();