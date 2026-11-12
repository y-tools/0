'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const API='https://153-127-64-17.sslip.io/api/bingo';
  let state=null, token='', participants=[], overview={onlineCount:0,name:'',messages:[]}, busy=false, loading=false;
  const storage={get:k=>{try{return localStorage.getItem(k)}catch{return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch{}},remove:k=>{try{localStorage.removeItem(k)}catch{}}};

  function deviceId(){
    let id=storage.get('yplus.bingo.device.v1');
    if(!id){id='dev-'+crypto.randomUUID();storage.set('yplus.bingo.device.v1',id)}
    return id;
  }
  function message(s){if($('adminMessage'))$('adminMessage').textContent=s}
  async function api(path,method='GET',body=null,accessToken=''){
    const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),15000);
    try{
      const resp=await fetch(API+path,{method,mode:'cors',cache:'no-store',signal:ctl.signal,headers:{'Content-Type':'application/json',...(accessToken?{Authorization:'Bearer '+accessToken}:{})},body:body?JSON.stringify(body):undefined});
      const data=await resp.json().catch(()=>({}));
      if(!resp.ok)throw new Error(String(data.error||('HTTP '+resp.status)));
      return data;
    } finally {clearTimeout(timer)}
  }

  function lineStats(card){
    if(!state||!card||!Array.isArray(card.numbers))return {bingo:0,reach:0,remaining:5};
    const hits=new Set(state.drawn), marked=card.numbers.map((n,i)=>i===12||hits.has(n));
    const lines=[];
    for(let r=0;r<5;r++)lines.push([0,1,2,3,4].map(c=>r*5+c));
    for(let c=0;c<5;c++)lines.push([0,1,2,3,4].map(r=>r*5+c));
    lines.push([0,6,12,18,24],[4,8,12,16,20]);
    const counts=lines.map(l=>l.filter(i=>marked[i]).length);
    return {
      bingo:counts.filter(n=>n===5).length,
      reach:counts.filter(n=>n===4).length,
      remaining:Math.min(...counts.map(n=>5-n))
    };
  }
  function makeCardElement(card,index){
    const wrap=document.createElement('section'); wrap.className='issued-card';
    const head=document.createElement('div'); head.className='issued-card-head';
    const counts=lineStats(card); head.textContent='CARD '+(index+1)+' · BINGO '+counts.bingo+' / REACH '+counts.reach+' / あと'+counts.remaining; wrap.append(head);
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
    const pend=participants.filter(p=>p.status==='pending'||(p.status==='approved'&&Number(p.pendingExtra||0)>0));
    const ok=participants.filter(p=>p.status==='approved');
    if(!pend.length)pending.textContent='申請待ちはありません。';
    pend.forEach(p=>{
      const row=document.createElement('div');row.className='participant-row';
      const main=document.createElement('div');main.className='participant-main';
      const name=document.createElement('strong');name.textContent=p.name;main.append(name);
      const note=document.createElement('div');note.className='participant-card-status';note.textContent=p.status==='pending'?'新規カード申請':'追加カード申請';main.append(note);row.append(main);
      const yes=document.createElement('button');yes.textContent='承認';yes.addEventListener('click',()=>participantAction(p.id,'approve'));row.append(yes);
      const no=document.createElement('button');no.className='secondary';no.textContent='却下';no.addEventListener('click',()=>participantAction(p.id,'reject'));row.append(no);
      pending.append(row);
    });
    if(!ok.length)approved.textContent='承認済み参加者はいません。';
    ok.forEach(p=>{
      const row=document.createElement('div');row.className='participant-row';
      const main=document.createElement('div');main.className='participant-main';
      const name=document.createElement('strong');name.textContent=p.name+' · '+(p.cards?.length||0)+'枚';main.append(name);
      if(!p.cards?.length){
        const s=document.createElement('div');s.className='participant-card-status';s.textContent='カードなし';main.append(s);
      }else{
        p.cards.forEach((card,i)=>{
          const st=lineStats(card), s=document.createElement('div');s.className='participant-card-status';
          s.innerHTML='CARD '+(i+1)+' · <b>BINGO '+st.bingo+'</b> / REACH '+st.reach+' / あと'+st.remaining;
          main.append(s);
        });
      }
      row.append(main);
      const view=document.createElement('button');view.className='secondary';view.textContent='確認';view.addEventListener('click',()=>openDialog(p));row.append(view);
      const extra=document.createElement('button');extra.textContent='追加発行';extra.addEventListener('click',()=>participantAction(p.id,'issue_extra'));row.append(extra);
      approved.append(row);
    });
  }
  function renderHistory(rootId,countId){
    const root=$(rootId); if(!root)return;
    const hits=new Set(state?.drawn||[]);root.replaceChildren();
    for(let n=1;n<=99;n++){const el=document.createElement('span');el.className='ball'+(hits.has(n)?' hit':'');el.textContent=String(n).padStart(2,'0');root.append(el)}
    if($(countId))$(countId).textContent=(state?.drawn?.length||0)+' / 99';
  }
  function renderChat(){
    if(!$('adminOnlineCount'))return;
    $('adminOnlineCount').textContent=Number(overview.onlineCount||0)+'人ログイン中';
    if(overview.name&&!$('adminChatName').value)$('adminChatName').value=overview.name;
    $('chatNameStatus').textContent=overview.name?'現在の名前：'+overview.name:'最初に名前を設定してください。';
    if($('adminUserSettings'))$('adminUserSettings').hidden=!overview.canManageUsers;
    const root=$('adminChatMessages'), shouldStick=root.scrollTop+root.clientHeight>=root.scrollHeight-40;root.replaceChildren();
    (overview.messages||[]).forEach(m=>{
      const row=document.createElement('div');row.className='chat-message';
      const head=document.createElement('div');head.className='chat-message-head';
      const name=document.createElement('strong');name.textContent=m.name||'運営';head.append(name);
      const time=document.createElement('span');const d=new Date(m.createdAt);time.textContent=Number.isNaN(d.getTime())?'':d.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});head.append(time);
      const body=document.createElement('div');body.textContent=m.message||'';row.append(head,body);root.append(row);
    });
    if(shouldStick)root.scrollTop=root.scrollHeight;
  }
  function drawAnimationActive(){return !!(state?.lastDraw&&Number(state.lastDraw.animationUntilMs)>Date.now())}
  function updateDrawAnimation(){
    const active=drawAnimationActive();
    const until=Number(state?.lastDraw?.animationUntilMs||0);
    const remaining=Math.max(0,until-Date.now());
    const picked=Number(state?.lastDraw?.number||state?.drawn?.at(-1)||0);
    const reveal=active&&remaining<=900&&picked>0;
    const rolling=String(1+Math.floor(Math.random()*99)).padStart(2,'0');
    const value=reveal?String(picked).padStart(2,'0'):rolling;
    const publicEl=$('publicDrawAnimation');
    if(publicEl){
      publicEl.hidden=!active;
      publicEl.classList.toggle('is-final',reveal);
      const strong=publicEl.querySelector('strong');
      const caption=publicEl.querySelector('.draw-caption');
      const small=publicEl.querySelector('small');
      if(active&&strong)strong.textContent=value;
      if(caption)caption.textContent=reveal?'決定！':'抽選中...';
      if(small)small.textContent=reveal?'今回の番号はこちら！':'運命の番号を選んでいます';
    }
    const adminEl=$('adminDrawAnimation');
    if(adminEl){
      adminEl.hidden=!active;
      if(active){const strong=adminEl.querySelector('strong');if(strong)strong.textContent=value}
    }
    if(!active&&state&&$('latestNumber'))$('latestNumber').textContent=state.drawn.length?String(state.drawn.at(-1)).padStart(2,'0'):'–';
  }

  function renderState(){
    if(!state)return;
    $('eventTitle').textContent=state.title||'Y++ 特設ビンゴ';
    $('eventDescription').textContent=state.description||'参加者みんなで楽しむ、99球のビンゴ！';
    $('announcement').textContent=state.announcement||'';
    $('gameStatus').textContent=({waiting:'準備中',running:'開催中',paused:'一時停止',finished:'終了'})[state.status]||'準備中';
    $('latestNumber').textContent=drawAnimationActive()?'…':(state.drawn.length?String(state.drawn.at(-1)).padStart(2,'0'):'–');
    renderHistory('history','drawCount');
    renderHistory('adminHistory','adminDrawCount');
    $('applicationArea').hidden=false;
    if(token){
      $('editTitle').value=state.title||'';$('editAnnouncement').value=state.announcement||'';
      $('drawNumber').disabled=state.status!=='running'||state.drawn.length===99||busy;
      $('undoNumber').disabled=!state.drawn.length||busy;
    }
    renderParticipants(); renderAdminPeople(); renderPublicCards(); renderChat(); updateDrawAnimation();
    if($('cardDialog').open){const name=$('dialogTitle').textContent.replace(' のビンゴカード','');const p=participants.find(x=>x.name===name);if(p)renderPersonCards(p,$('dialogCards'))}
  }
  async function refresh(silent=false){
    if(loading||busy)return;loading=true;
    try{
      const [s,p]=await Promise.all([api('/state'),api('/participants')]); state=s.state; participants=p.participants||[];
      if(token){
        const [admin,ov]=await Promise.all([api('/admin/participants','GET',null,token),api('/admin/overview','GET',null,token)]);
        participants=admin.participants||participants;overview=ov||overview;
      }
      renderState();
      const now=new Date().toLocaleTimeString('ja-JP');
      $('connection').textContent='● 共有データ接続中 · 最終確認 '+now;$('connection').style.color='#69e7b4';
      if($('adminConnection'))$('adminConnection').textContent='● 接続中 · '+now;
    }catch(e){
      $('connection').textContent='⚠ 同期できません：'+e.message;$('connection').style.color='#f6bd89';
      if($('adminConnection'))$('adminConnection').textContent='⚠ 同期エラー';
      if(!silent)message(e.message)
    } finally {loading=false}
  }

  async function apply(){
    const name=$('playerName').value.trim(); if(!name)return $('applicationMessage').textContent='REALITY上の名前を入力してください。';
    $('applyCard').disabled=true;
    try{
      const r=await api('/apply','POST',{name,deviceId:deviceId()});
      $('applicationMessage').textContent=r.additional?'追加カードを申請しました。管理者の承認をお待ちください。':'申請しました。管理者の承認をお待ちください。';
      $('playerName').value='';await refresh(true)
    }catch(e){$('applicationMessage').textContent='申請できませんでした：'+e.message}
    finally{$('applyCard').disabled=false}
  }
  async function login(){
    const adminId=$('adminId').value.trim(),password=$('adminPassword').value,remember=$('rememberAdmin').checked;
    if(!adminId||!password)return message('管理者IDとパスワードを入力してください。');
    $('adminPasswordLogin').disabled=true;
    try{
      const r=await api('/admin/login','POST',{adminId,password,remember});token=r.token;
      if(remember)storage.set('yplus.bingo.admin.token.v1',token);else storage.remove('yplus.bingo.admin.token.v1');
      $('adminLoginDialog').close();$('publicView').hidden=true;$('adminView').hidden=false;message('');await refresh(true);await refreshAdminUsers();
    }catch(e){message('管理画面を開けません：'+e.message)}
    finally{$('adminPassword').value='';$('adminPasswordLogin').disabled=false}
  }
  async function participantAction(id,action){
    if(!token||busy)return;busy=true;
    try{await api('/admin/participant','POST',{participantId:id,action},token);await refresh(true)}
    catch(e){message('参加者操作に失敗しました：'+e.message)}
    finally{busy=false}
  }
  async function mutate(action,extra={},confirmText=''){
    if(!token||busy||!state)return;if(confirmText&&!confirm(confirmText))return;busy=true;
    try{const r=await api('/admin/action','POST',{action,expectedRevision:state.revision,...extra},token);state=r.state;await refresh(true)}
    catch(e){message('保存できませんでした：'+e.message);await refresh(true)}
    finally{busy=false}
  }
  async function saveChatName(){
    const name=$('adminChatName').value.trim();if(!name)return;
    try{const r=await api('/admin/name','POST',{name},token);overview.name=r.name;$('chatNameStatus').textContent='現在の名前：'+r.name;await refresh(true)}
    catch(e){$('chatNameStatus').textContent='名前を設定できませんでした：'+e.message}
  }
  async function sendChat(){
    const input=$('adminChatInput'), text=input.value.trim();if(!text)return;
    $('sendAdminChat').disabled=true;
    try{await api('/admin/chat','POST',{message:text},token);input.value='';await refresh(true)}
    catch(e){$('chatNameStatus').textContent='送信できませんでした：'+e.message}
    finally{$('sendAdminChat').disabled=false}
  }


  async function refreshAdminUsers(){
    if(!token||!$('adminUserSettings')||$('adminUserSettings').hidden)return;
    try{
      const r=await api('/admin/users','GET',null,token),root=$('adminUsersList');root.replaceChildren();
      (r.users||[]).forEach(u=>{
        const row=document.createElement('div');row.className='participant-row';
        const main=document.createElement('div');main.className='participant-main';
        const name=document.createElement('strong');name.textContent=u.id+(u.role==='owner'?'（オーナー）':'');main.append(name);row.append(main);
        if(u.role!=='owner'){
          const del=document.createElement('button');del.className='danger';del.textContent='削除';del.addEventListener('click',()=>adminUserAction('delete',u.id));row.append(del);
        }
        root.append(row);
      });
    }catch(e){$('adminUsersMessage').textContent='管理者一覧を取得できません：'+e.message}
  }
  async function adminUserAction(action,adminId,password=''){
    try{
      await api('/admin/users','POST',{action,adminId,password},token);
      $('adminUsersMessage').textContent=action==='create'?'管理者を追加しました。':'管理者を削除しました。';
      await refreshAdminUsers();
    }catch(e){$('adminUsersMessage').textContent='操作できませんでした：'+e.message}
  }
  async function restoreAdminSession(){
    const saved=storage.get('yplus.bingo.admin.token.v1');if(!saved)return;
    token=saved;
    try{
      await api('/admin/overview','GET',null,token);
      $('publicView').hidden=true;$('adminView').hidden=false;
      await refresh(true);await refreshAdminUsers();
    }catch{
      token='';storage.remove('yplus.bingo.admin.token.v1');
    }
  }

  const adminTrigger=$('adminTrigger');
  let adminTapCount=0, adminTapTimer=null, adminHoldTimer=null, adminHoldOpened=false;
  function openAdminPanel(){
    if(!$('adminLoginDialog').open)$('adminLoginDialog').showModal();
    setTimeout(()=>$('adminPassword').focus(),0);
  }
  adminTrigger.addEventListener('click',()=>{
    if(adminHoldOpened){adminHoldOpened=false;return}
    adminTapCount++;clearTimeout(adminTapTimer);
    if(adminTapCount>=5){adminTapCount=0;openAdminPanel();return}
    adminTapTimer=setTimeout(()=>{adminTapCount=0},1800);
  });
  const startAdminHold=()=>{adminHoldOpened=false;clearTimeout(adminHoldTimer);adminHoldTimer=setTimeout(()=>{adminHoldOpened=true;adminTapCount=0;openAdminPanel()},3000)};
  const cancelAdminHold=()=>{clearTimeout(adminHoldTimer)};
  adminTrigger.addEventListener('pointerdown',startAdminHold);
  adminTrigger.addEventListener('pointerup',cancelAdminHold);
  adminTrigger.addEventListener('pointercancel',cancelAdminHold);
  adminTrigger.addEventListener('pointerleave',cancelAdminHold);
  adminTrigger.addEventListener('contextmenu',e=>{e.preventDefault()});

  $('applyCard').addEventListener('click',apply);
  $('participantSelect').addEventListener('change',()=>{const p=participants.find(x=>x.id===$('participantSelect').value);renderPersonCards(p,$('publicCards'))});
  $('viewParticipant').addEventListener('click',()=>{const p=participants.find(x=>x.id===$('participantSelect').value);if(p)openDialog(p)});
  $('dialogClose').addEventListener('click',()=>$('cardDialog').close());
  $('adminLoginClose').addEventListener('click',()=>{$('adminLoginDialog').close();$('adminPassword').value='';message('')});
  $('adminPasswordLogin').addEventListener('click',login);
  $('adminId').addEventListener('keydown',e=>{if(e.key==='Enter')login()});
  $('adminPassword').addEventListener('keydown',e=>{if(e.key==='Enter')login()});
  $('adminLogout').addEventListener('click',async()=>{const t=token;token='';storage.remove('yplus.bingo.admin.token.v1');$('adminView').hidden=true;$('publicView').hidden=false;if(t)await api('/admin/logout','POST',{},t).catch(()=>{});await refresh(true)});
  $('saveEvent').addEventListener('click',()=>mutate('save',{title:$('editTitle').value.slice(0,60),announcement:$('editAnnouncement').value.slice(0,300)}));
  $('startGame').addEventListener('click',()=>mutate('start'));
  $('pauseGame').addEventListener('click',()=>mutate('pause'));
  $('finishGame').addEventListener('click',()=>mutate('finish',{},'ビンゴ大会を終了しますか？'));
  $('drawNumber').addEventListener('click',()=>mutate('draw'));
  $('undoNumber').addEventListener('click',()=>mutate('undo',{},'最後の抽選番号を取り消しますか？'));
  $('resetGame').addEventListener('click',()=>mutate('reset',{},'抽選番号をすべてリセットしますか？ 発行済みカードは保持されます。'));
  $('saveChatName').addEventListener('click',saveChatName);
  $('adminChatName').addEventListener('keydown',e=>{if(e.key==='Enter')saveChatName()});
  $('sendAdminChat').addEventListener('click',sendChat);
  $('createAdminUser').addEventListener('click',()=>{const id=$('newAdminId').value.trim(),pw=$('newAdminPassword').value;if(!id||!pw)return $('adminUsersMessage').textContent='IDとパスワードを入力してください。';adminUserAction('create',id,pw).then(()=>{$('newAdminId').value='';$('newAdminPassword').value=''})});
  $('adminChatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat()}});
  window.addEventListener('pagehide',()=>{});

  refresh();restoreAdminSession();
  setInterval(()=>{if(!document.hidden)refresh(true)},1000);
  setInterval(updateDrawAnimation,100);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(true)});
})();