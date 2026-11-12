'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const API='https://153-127-64-17.sslip.io/api/bingo';
  let state=null, token='', participants=[], busy=false, loading=false;
  const storage={get:k=>{try{return localStorage.getItem(k)}catch{return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch{}}};
  function deviceId(){
    let id=storage.get('yplus.bingo.device.v1');
    if(!id){id='dev-'+crypto.randomUUID();storage.set('yplus.bingo.device.v1',id)}
    return id;
  }
  function message(s){$('adminMessage').textContent=s}
  async function api(path,method='GET',body=null,accessToken=''){
    const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),15000);
    try{
      const resp=await fetch(API+path,{method,mode:'cors',cache:'no-store',signal:ctl.signal,headers:{'Content-Type':'application/json',...(accessToken?{Authorization:'Bearer '+accessToken}:{})},body:body?JSON.stringify(body):undefined});
      const data=await resp.json().catch(()=>({}));
      if(!resp.ok)throw new Error(String(data.error||('HTTP '+resp.status)));
      return data;
    } finally {clearTimeout(timer)}
  }
  function statusCounts(card){
    if(!state||!card||!Array.isArray(card.numbers))return {bingo:0,reach:0};
    const hits=new Set(state.drawn), marked=card.numbers.map((n,i)=>i===12||hits.has(n));
    const lines=[];
    for(let r=0;r<5;r++)lines.push([0,1,2,3,4].map(c=>r*5+c));
    for(let c=0;c<5;c++)lines.push([0,1,2,3,4].map(r=>r*5+c));
    lines.push([0,6,12,18,24],[4,8,12,16,20]);
    return {bingo:lines.filter(l=>l.every(i=>marked[i])).length,reach:lines.filter(l=>l.filter(i=>marked[i]).length===4).length};
  }
  function makeCardElement(card,index){
    const wrap=document.createElement('section'); wrap.className='issued-card';
    const head=document.createElement('div'); head.className='issued-card-head';
    const counts=statusCounts(card); head.textContent='CARD '+(index+1)+' · BINGO '+counts.bingo+' / REACH '+counts.reach; wrap.append(head);
    const grid=document.createElement('div'); grid.className='bingo-card';
    'BINGO'.split('').forEach(x=>{const el=document.createElement('div');el.className='bingo-cell head';el.textContent=x;grid.append(el)});
    const hits=new Set(state?state.drawn:[]);
    card.numbers.forEach((n,i)=>{const el=document.createElement('div');const mark=i===12||hits.has(n);el.className='bingo-cell'+(mark?' marked':'')+(i===12?' free':'');el.textContent=i===12?'FREE':String(n);grid.append(el)});
    wrap.append(grid); return wrap;
  }
  function renderPersonCards(person,target){
    target.replaceChildren();
    if(!person||!person.cards?.length){const p=document.createElement('p');p.className='hint';p.textContent='発行済みカードはありません。';target.append(p);return}
    person.cards.forEach((card,i)=>target.append(makeCardElement(card,i)));
  }
  function renderPublicCards(){
    const root=$('publicCards'); root.replaceChildren();
    const approved=participants.filter(p=>p.status==='approved'&&p.cards?.length);
    if(!approved.length){const p=document.createElement('p');p.className='hint';p.textContent='発行済みカードはありません。';root.append(p);return}
    approved.forEach(person=>{
      const section=document.createElement('section');section.className='public-person';
      const title=document.createElement('h3');title.textContent=person.name+'（'+person.cards.length+'枚）';section.append(title);
      person.cards.forEach((card,i)=>section.append(makeCardElement(card,i)));
      root.append(section);
    });
  }
  function openDialog(person){
    $('dialogTitle').textContent=person.name+' のビンゴカード';
    renderPersonCards(person,$('dialogCards'));
    $('cardDialog').showModal();
  }
  function renderParticipants(){
    const select=$('participantSelect'), current=select.value; select.replaceChildren();
    const base=document.createElement('option');base.value='';base.textContent='参加者を選択';select.append(base);
    participants.filter(p=>p.status==='approved').forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name+(p.cards?.length>1?'（'+p.cards.length+'枚）':'');select.append(o)});
    if([...select.options].some(o=>o.value===current))select.value=current;
  }
  function renderAdminPeople(){
    if(!token)return;
    const pending=$('pendingParticipants'), approved=$('approvedParticipants'); pending.replaceChildren();approved.replaceChildren();
    const pend=participants.filter(p=>p.status==='pending'), ok=participants.filter(p=>p.status==='approved');
    if(!pend.length)pending.textContent='申請待ちはありません。';
    pend.forEach(p=>{
      const row=document.createElement('div');row.className='participant-row';
      const name=document.createElement('strong');name.textContent=p.name;row.append(name);
      const yes=document.createElement('button');yes.textContent='承認して発行';yes.addEventListener('click',()=>participantAction(p.id,'approve'));row.append(yes);
      const no=document.createElement('button');no.className='secondary';no.textContent='却下';no.addEventListener('click',()=>participantAction(p.id,'reject'));row.append(no);
      pending.append(row);
    });
    if(!ok.length)approved.textContent='承認済み参加者はいません。';
    ok.forEach(p=>{
      const row=document.createElement('div');row.className='participant-row';
      const name=document.createElement('strong');name.textContent=p.name+' · '+(p.cards?.length||0)+'枚';row.append(name);
      const view=document.createElement('button');view.className='secondary';view.textContent='確認';view.addEventListener('click',()=>openDialog(p));row.append(view);
      const extra=document.createElement('button');extra.textContent='追加発行';extra.addEventListener('click',()=>participantAction(p.id,'issue_extra'));row.append(extra);
      approved.append(row);
    });
  }
  function renderState(){
    if(!state)return;
    $('eventTitle').textContent=state.title||'Y++ 特設ビンゴ';
    $('eventDescription').textContent=state.description||'参加者みんなで楽しむ、75球のビンゴ！';
    $('announcement').textContent=state.announcement||'';
    $('gameStatus').textContent=({waiting:'準備中',running:'開催中',paused:'一時停止',finished:'終了'})[state.status]||'準備中';
    $('latestNumber').textContent=state.drawn.length?String(state.drawn.at(-1)).padStart(2,'0'):'–';
    $('drawCount').textContent=state.drawn.length+' / 75';
    const hits=new Set(state.drawn),root=$('history');root.replaceChildren();
    for(let n=1;n<=75;n++){const el=document.createElement('span');el.className='ball'+(hits.has(n)?' hit':'');el.textContent=String(n).padStart(2,'0');root.append(el)}
    $('applicationArea').hidden=state.status!=='waiting';
    if(token){
      $('editTitle').value=state.title||'';$('editAnnouncement').value=state.announcement||'';
      $('drawNumber').disabled=state.status!=='running'||state.drawn.length===75||busy;
      $('undoNumber').disabled=!state.drawn.length||busy;
    }
    renderParticipants(); renderAdminPeople(); renderPublicCards();
    if($('cardDialog').open){const name=$('dialogTitle').textContent.replace(' のビンゴカード','');const p=participants.find(x=>x.name===name);if(p)renderPersonCards(p,$('dialogCards'))}
  }
  async function refresh(silent=false){
    if(loading||busy)return;loading=true;
    try{
      const [s,p]=await Promise.all([api('/state'),api('/participants')]); state=s.state; participants=p.participants||[];
      if(token){const admin=await api('/admin/participants','GET',null,token);participants=admin.participants||participants}
      renderState(); $('connection').textContent='● 共有データ接続中 · 最終確認 '+new Date().toLocaleTimeString('ja-JP');$('connection').style.color='#69e7b4';
    }catch(e){$('connection').textContent='⚠ 同期できません：'+e.message;$('connection').style.color='#f6bd89';if(!silent)message(e.message)}
    finally{loading=false}
  }
  async function apply(){
    const name=$('playerName').value.trim(); if(!name)return $('applicationMessage').textContent='REALITY上の名前を入力してください。';
    $('applyCard').disabled=true;
    try{await api('/apply','POST',{name,deviceId:deviceId()});$('applicationMessage').textContent='申請しました。管理者の承認をお待ちください。';$('playerName').value='';await refresh(true)}
    catch(e){$('applicationMessage').textContent='申請できませんでした：'+e.message}
    finally{$('applyCard').disabled=false}
  }
  async function login(){
    const password=$('adminPassword').value;if(!password)return message('管理者パスワードを入力してください。');
    $('adminPasswordLogin').disabled=true;
    try{const r=await api('/admin/login','POST',{password});token=r.token;$('adminControls').hidden=false;$('adminLogout').hidden=false;$('adminPasswordLogin').hidden=true;$('adminPassword').hidden=true;message('管理画面を開きました。');await refresh(true)}
    catch(e){message('管理画面を開けません：'+e.message)}
    finally{$('adminPassword').value='';$('adminPasswordLogin').disabled=false}
  }
  async function participantAction(id,action){
    if(!token||busy)return;busy=true;
    try{await api('/admin/participant','POST',{participantId:id,action},token);message(action==='approve'?'カードを発行しました。':action==='reject'?'申請を却下しました。':'追加カードを発行しました。');await refresh(true)}
    catch(e){message('参加者操作に失敗しました：'+e.message)}
    finally{busy=false}
  }
  async function mutate(action,extra={},confirmText=''){
    if(!token||busy||!state)return;if(confirmText&&!confirm(confirmText))return;busy=true;
    try{const r=await api('/admin/action','POST',{action,expectedRevision:state.revision,...extra},token);state=r.state;message('VPSへ保存しました。');await refresh(true)}
    catch(e){message('保存できませんでした：'+e.message);await refresh(true)}
    finally{busy=false}
  }
  $('applyCard').addEventListener('click',apply);
  $('participantSelect').addEventListener('change',()=>{const p=participants.find(x=>x.id===$('participantSelect').value);renderPersonCards(p,$('publicCards'))});
  $('viewParticipant').addEventListener('click',()=>{const p=participants.find(x=>x.id===$('participantSelect').value);if(p)openDialog(p)});
  $('dialogClose').addEventListener('click',()=>$('cardDialog').close());
  $('adminPasswordLogin').addEventListener('click',login);$('adminPassword').addEventListener('keydown',e=>{if(e.key==='Enter')login()});
  $('adminLogout').addEventListener('click',async()=>{const t=token;token='';$('adminControls').hidden=true;$('adminLogout').hidden=true;$('adminPasswordLogin').hidden=false;$('adminPassword').hidden=false;if(t)await api('/admin/logout','POST',{},t).catch(()=>{});await refresh(true);message('ログアウトしました。')});
  $('saveEvent').addEventListener('click',()=>mutate('save',{title:$('editTitle').value.slice(0,60),announcement:$('editAnnouncement').value.slice(0,300)}));
  $('startGame').addEventListener('click',()=>mutate('start'));$('pauseGame').addEventListener('click',()=>mutate('pause'));
  $('finishGame').addEventListener('click',()=>mutate('finish',{},'ビンゴ大会を終了しますか？'));
  $('drawNumber').addEventListener('click',()=>mutate('draw'));$('undoNumber').addEventListener('click',()=>mutate('undo',{},'最後の抽選番号を取り消しますか？'));
  $('resetGame').addEventListener('click',()=>mutate('reset',{},'抽選番号をすべてリセットしますか？ 発行済みカードは保持されます。'));
  window.addEventListener('pagehide',()=>{token=''});
  refresh();setInterval(()=>{if(!document.hidden)refresh(true)},1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(true)});
})();