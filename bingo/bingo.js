'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const API='https://153-127-64-17.sslip.io/api/bingo';
  const storage={get:k=>{try{return localStorage.getItem(k)}catch{return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch{}},remove:k=>{try{localStorage.removeItem(k)}catch{}}};
  let state=null, token='', participants=[], overview={onlineCount:0,name:'',messages:[]}, busy=false, loading=false, continuousMode=false, continuousTimer=null, continuousIntervalSec=Math.max(5,Math.min(3600,Math.round(Number(storage.get('yplus.bingo.continuous.interval.v1')||10))||10)), miniPlayerCardIndex=0;

  let miniVideoCanvas=null, miniVideoStream=null, lastStateSyncAt=0, dialogParticipantId='', serverClockOffsetMs=0, eventSettingsDirty=false, settingsSaving=false;

  function deviceId(){
    let id=storage.get('yplus.bingo.device.v1');
    if(!id){id='dev-'+crypto.randomUUID();storage.set('yplus.bingo.device.v1',id)}
    return id;
  }
  function message(s){['adminMessage','adminControlMessage','continuousSettingsMessage'].forEach(id=>{if($(id))$(id).textContent=s})}
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
  function lineDefinitions(){
    const defs=[];
    for(let r=0;r<5;r++)defs.push({name:'横'+(r+1)+'列',indexes:[0,1,2,3,4].map(c=>r*5+c)});
    for(let c=0;c<5;c++)defs.push({name:'縦'+(c+1)+'列',indexes:[0,1,2,3,4].map(r=>r*5+c)});
    defs.push({name:'左上→右下',indexes:[0,6,12,18,24]},{name:'右上→左下',indexes:[4,8,12,16,20]});
    return defs;
  }
  function winnerEvents(){
    if(!state?.drawn?.length)return [];
    const order=new Map(state.drawn.map((n,i)=>[Number(n),i+1]));
    const events=[];
    participants.filter(p=>p.status==='approved').forEach(person=>{
      (person.cards||[]).forEach((card,cardIndex)=>{
        lineDefinitions().forEach((def,lineIndex)=>{
          const needed=def.indexes.filter(i=>i!==12).map(i=>Number(card.numbers[i]));
          if(!needed.every(n=>order.has(n)))return;
          const completedAt=Math.max(...needed.map(n=>order.get(n)));
          const lastNumber=state.drawn[completedAt-1];
          events.push({participantId:person.id,name:person.name,cardIndex,lineIndex,lineName:def.name,completedAt,lastNumber});
        });
      });
    });
    events.sort((a,b)=>a.completedAt-b.completedAt||a.name.localeCompare(b.name,'ja')||a.cardIndex-b.cardIndex||a.lineIndex-b.lineIndex);
    return events;
  }
  function renderWinners(){
    const root=$('winnerList'),count=$('winnerCount');
    if(!root||!count)return;
    root.replaceChildren();
    const events=winnerEvents();
    count.textContent=events.length+' BINGO';
    if(!events.length){const p=document.createElement('p');p.className='small-note';p.textContent='まだビンゴ成立者はいません。';root.append(p);return;}
    const personCounts=new Map();
    events.forEach((event,index)=>{
      const current=(personCounts.get(event.participantId)||0)+1;personCounts.set(event.participantId,current);
      const row=document.createElement('div');row.className='winner-row';
      const rank=document.createElement('span');rank.className='winner-rank';rank.textContent=String(index+1);
      const main=document.createElement('div');main.className='winner-main';
      const title=document.createElement('strong');title.textContent=event.name+' · '+current+'ビンゴ目';
      const detail=document.createElement('div');detail.className='participant-card-status';
      detail.textContent='CARD '+(event.cardIndex+1)+' · '+event.lineName+' · 抽選 #'+event.completedAt+'（'+String(event.lastNumber).padStart(2,'0')+'）で成立';
      main.append(title,detail);row.append(rank,main);root.append(row);
    });
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
    const root=$('publicCards'); if(!root)return; root.replaceChildren();
    const id=$('participantSelect')?.value||'';
    if(!id){
      const p=document.createElement('p');p.className='hint';p.textContent='確認したい参加者を選択してください。';root.append(p);return;
    }
    const person=participants.find(p=>p.id===id&&p.status==='approved');
    if(!person||!person.cards?.length){
      const p=document.createElement('p');p.className='hint';p.textContent='発行済みカードはありません。';root.append(p);return;
    }
    const section=document.createElement('section');section.className='public-person';
    const title=document.createElement('h3');title.textContent=person.name+'（'+person.cards.length+'枚）';section.append(title);
    miniPlayerCardIndex=Math.max(0,Math.min(miniPlayerCardIndex,person.cards.length-1));
    const view=document.createElement('div');view.className='public-card-view';
    view.append(makeCardElement(person.cards[miniPlayerCardIndex],miniPlayerCardIndex));
    if(person.cards.length>1){
      view.classList.add('has-multiple');
      const nav=document.createElement('nav');nav.className='public-card-nav';nav.setAttribute('aria-label','表示カードの切り替え');
      const previous=document.createElement('button');previous.type='button';previous.className='secondary';previous.textContent='‹ 前';previous.dataset.cardStep='-1';previous.setAttribute('aria-label','前のカード');previous.disabled=miniPlayerCardIndex===0;
      const count=document.createElement('span');count.className='public-card-position';count.textContent=(miniPlayerCardIndex+1)+' / '+person.cards.length+'枚';count.setAttribute('aria-live','polite');
      const next=document.createElement('button');next.type='button';next.className='secondary';next.textContent='次 ›';next.dataset.cardStep='1';next.setAttribute('aria-label','次のカード');next.disabled=miniPlayerCardIndex===person.cards.length-1;
      nav.append(previous,count,next);view.append(nav);
    }
    section.append(view);root.append(section);
  }
  function selectedPublicPerson(){
    const id=$('participantSelect')?.value||'';
    return participants.find(p=>p.id===id&&p.status==='approved')||null;
  }
  function renderMiniPlayer(){
    const player=$('miniPlayer'); if(!player||player.hidden)return;
    const person=selectedPublicPerson();
    if(!person||!person.cards?.length){closeMiniPlayer();return;}
    miniPlayerCardIndex=Math.max(0,Math.min(miniPlayerCardIndex,person.cards.length-1));
    const card=person.cards[miniPlayerCardIndex];
    $('miniPlayerName').textContent=person.name;
    $('miniCardLabel').textContent='CARD '+(miniPlayerCardIndex+1)+' / '+person.cards.length;
    $('miniPrevCard').disabled=person.cards.length<2;
    $('miniNextCard').disabled=person.cards.length<2;
    const root=$('miniPlayerCard');root.replaceChildren();
    'BINGO'.split('').forEach(x=>{const el=document.createElement('div');el.className='mini-cell mini-head';el.textContent=x;root.append(el)});
    const hits=new Set(state?.drawn||[]);
    card.numbers.forEach((n,i)=>{const el=document.createElement('div');const mark=i===12||hits.has(n);el.className='mini-cell'+(mark?' marked':'')+(i===12?' free':'');el.textContent=i===12?'FREE':String(n);root.append(el)});
    const stats=lineStats(card);
    $('miniPlayerStats').textContent='BINGO '+stats.bingo+' / REACH '+stats.reach+' / あと'+stats.remaining;
    const active=drawAnimationActive(),until=Number(state?.lastDraw?.animationUntilMs||0),remaining=Math.max(0,until-serverNow());
    const picked=Number(state?.lastDraw?.number||state?.drawn?.at(-1)||0);
    const reveal=active&&remaining<=900&&picked>0;
    $('miniDrawNumber').textContent=active?(reveal?String(picked).padStart(2,'0'):String(1+Math.floor(Math.random()*99)).padStart(2,'0')):(picked?String(picked).padStart(2,'0'):'--');
    $('miniDrawStatus').textContent=active?(reveal?'決定！':'抽選中...'):(state?.drawActive?'次の抽選待ち':'抽選停止中');
    player.classList.toggle('is-drawing',active);
    drawMiniVideoFrame(person,card,stats);
  }
  // Keep launch visibility independent of participant loading and card rendering.
  function syncMiniPlayerVisibility(){
    const active=state?.drawActive===true;
    const button=$('miniPlayerOpen');
    if(button)button.hidden=!active;
    if(!active)closeMiniPlayer();
  }
  function openMiniPlayer(){
    if(state?.drawActive!==true)return;
    const person=selectedPublicPerson();
    if(!person||!person.cards?.length){
      const viewer=document.querySelector('.viewer-box');
      if(viewer)viewer.open=true;
      $('participantSelect')?.focus();
      return;
    }
    $('miniPlayer').hidden=false;
    renderMiniPlayer();
    $('miniPlayerMessage').textContent='小窓用の動画を準備しています…';
    enterMiniPictureInPicture();
  }
  function miniPlayerInPictureInPicture(){
    const video=$('miniPlayerVideo');
    return !!video&&(document.pictureInPictureElement===video||video.webkitPresentationMode==='picture-in-picture');
  }
  function miniPlayerSessionActive(){
    return !!miniVideoStream&&!$('miniPlayer').hidden;
  }
  function drawMiniVideoFrame(person,card,stats){
    if(!miniVideoCanvas)return;
    const ctx=miniVideoCanvas.getContext('2d');
    if(!ctx)return;
    ctx.fillStyle='#0b1019';ctx.fillRect(0,0,960,600);
    ctx.textAlign='left';ctx.textBaseline='middle';
    const text=(value,x,y,size,color,maxWidth)=>{ctx.font='700 '+size+'px system-ui, sans-serif';ctx.fillStyle=color;ctx.fillText(value,x,y,maxWidth)};
    text(person.name,28,43,32,'#f5f0e9',620);
    text('CARD '+(miniPlayerCardIndex+1)+' / '+person.cards.length,700,43,25,'#e1bc8c',230);
    ctx.fillStyle='#172131';ctx.fillRect(24,86,360,450);
    ctx.textAlign='center';
    text('DRAW NUMBER',204,147,28,'#a6b1c2',320);
    text($('miniDrawNumber').textContent,204,295,164,'#e1bc8c',340);
    text($('miniDrawStatus').textContent,204,455,34,'#f5f0e9',320);
    const hits=new Set(state?.drawn||[]);
    const cell=(label,col,row,color,ink)=>{
      const x=420+col*102,y=86+row*75;
      ctx.fillStyle=color;ctx.fillRect(x,y,96,69);
      text(label,x+48,y+35,label==='FREE'?22:34,ink,90);
    };
    'BINGO'.split('').forEach((label,col)=>cell(label,col,0,'#e1bc8c','#172131'));
    card.numbers.forEach((n,i)=>cell(i===12?'FREE':String(n),i%5,1+Math.floor(i/5),i===12?'#6e5991':hits.has(n)?'#32795e':'#28364a','#fff'));
    text('BINGO '+stats.bingo+' / REACH '+stats.reach+' / あと'+stats.remaining,480,557,29,'#e1bc8c',900);
    const stale=lastStateSyncAt&&Date.now()-lastStateSyncAt>10000;
    const time=lastStateSyncAt?new Date(lastStateSyncAt).toLocaleTimeString('ja-JP'):'未同期';
    text((stale?'同期が遅れています · ':'最終更新 ')+time,480,586,19,stale?'#ffbc8c':'#a6b1c2',900);
    paintCelebrationOnCanvas(ctx);
  }
  function enforceMiniPlayerMute(){
    const video=$('miniPlayerVideo');if(!video)return;
    if(!video.defaultMuted)video.defaultMuted=true;
    if(!video.muted)video.muted=true;
    if(video.volume!==0)video.volume=0;
  }
  async function prepareMiniVideo(){
    const video=$('miniPlayerVideo');
    if(miniVideoStream)return;
    const canvas=document.createElement('canvas');canvas.width=960;canvas.height=600;
    if(typeof canvas.captureStream!=='function')throw new Error('このブラウザーは小窓用の動画生成に対応していません。');
    miniVideoCanvas=canvas;
    renderMiniPlayer();
    miniVideoStream=canvas.captureStream(10);
    enforceMiniPlayerMute();
    video.playsInline=true;video.srcObject=miniVideoStream;video.hidden=false;
    $('miniPlayer').classList.add('is-video');
    await video.play();
  }
  async function enterMiniPictureInPicture(){
    const button=$('miniPictureInPicture'),video=$('miniPlayerVideo'),status=$('miniPlayerMessage');
    if(state?.drawActive!==true||$('miniPlayer').hidden)return;
    button.disabled=true;
    try{
      await prepareMiniVideo();
      if(state?.drawActive!==true||$('miniPlayer').hidden)return;
      enforceMiniPlayerMute();
      if(video.paused)await video.play();
      if(state?.drawActive!==true||$('miniPlayer').hidden)return;
      if(miniPlayerInPictureInPicture())return;
      if(typeof video.requestPictureInPicture==='function'&&document.pictureInPictureEnabled){
        await video.requestPictureInPicture();
      }else if(typeof video.webkitSetPresentationMode==='function'&&video.webkitSupportsPresentationMode?.('picture-in-picture')){
        video.webkitSetPresentationMode('picture-in-picture');
      }else{
        status.textContent='この端末・ブラウザーでは小窓再生を開始できません。Safari または Chrome で開き、動画の再生メニューも確認してください。';
        return;
      }
      if(state?.drawActive!==true||$('miniPlayer').hidden){closeMiniPlayer();return;}
      status.textContent='小窓再生中です。カードの切り替えはこのページで操作してください。';
    }catch(e){
      status.textContent=e.name==='NotAllowedError'?'動画の準備ができました。「スマホの小窓で再生」をもう一度押してください。':('小窓再生を開始できませんでした。再試行するか、動画の再生メニューを確認してください。'+(e.message?' '+e.message:''));
    }finally{button.disabled=false}
  }
  function releaseMiniVideo(){
    const video=$('miniPlayerVideo');
    miniVideoStream?.getTracks().forEach(track=>track.stop());
    miniVideoStream=null;miniVideoCanvas=null;
    if(video){video.pause();video.srcObject=null;video.hidden=true}
    $('miniPlayer')?.classList.remove('is-video');
  }
  function closeMiniPlayer(){
    if($('miniPlayer'))$('miniPlayer').hidden=true;
    const video=$('miniPlayerVideo');
    if(document.pictureInPictureElement===video&&typeof document.exitPictureInPicture==='function'){
      document.exitPictureInPicture().catch(()=>{}).finally(()=>{if($('miniPlayer').hidden)releaseMiniVideo()});
    }else{
      if(video?.webkitPresentationMode==='picture-in-picture'){
        try{video.webkitSetPresentationMode('inline')}catch{}
      }
      releaseMiniVideo();
    }
  }


  function openDialog(person){dialogParticipantId=person.id;$('dialogTitle').textContent=person.name+' のビンゴカード';renderPersonCards(person,$('dialogCards'));$('cardDialog').showModal();}
  function renderParticipants(){
    const select=$('participantSelect'), current=select.value; select.replaceChildren();
    const base=document.createElement('option');base.value='';base.textContent='参加者を選択';select.append(base);
    participants.filter(p=>p.status==='approved').forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name+(p.cards?.length>1?'（'+p.cards.length+'枚）':'');select.append(o)});
    if([...select.options].some(o=>o.value===current))select.value=current;
  }
  let adminPeopleRenderKey='';
  function renderAdminPeople(){
    if(!token)return;
    const renderKey=JSON.stringify([participants,state?.drawn,overview.canDeleteParticipants]);
    if(renderKey===adminPeopleRenderKey)return;
    adminPeopleRenderKey=renderKey;
    const openMenus=new Set([...document.querySelectorAll('.participant-menu[open]')].map(menu=>menu.dataset.menuId));
    const canDelete=overview.canDeleteParticipants===true;
    const makeMenu=(person,kind)=>{
      const menu=document.createElement('details');menu.className='participant-menu';menu.setAttribute('name','participant-actions');menu.dataset.menuId=kind+':'+person.id;menu.open=openMenus.has(menu.dataset.menuId);
      const summary=document.createElement('summary');summary.textContent='操作';summary.setAttribute('aria-label',person.name+'の操作メニュー');
      const actions=document.createElement('div');actions.className='participant-actions';actions.setAttribute('role','group');actions.setAttribute('aria-label',person.name+'の操作');
      menu.append(summary,actions);
      menu.addEventListener('toggle',()=>{if(menu.open)document.querySelectorAll('.participant-menu[open]').forEach(other=>{if(other!==menu)other.open=false})});
      menu.addEventListener('click',event=>{if(event.target.closest('button'))menu.open=false});
      return {menu,actions};
    };
    $('participantDeletionStatus').textContent=canDelete?'':'削除機能は現在準備中です。';
    const deletePersonButton=person=>{
      const button=document.createElement('button');button.type='button';button.className='danger delete-participant';button.textContent='参加者を削除';button.disabled=!canDelete;
      button.addEventListener('click',()=>participantAction(person.id,'delete_participant',{expectedCardIds:(person.cards||[]).map(card=>card.id)},'「'+person.name+'」と発行済みカード'+(person.cards?.length||0)+'枚を削除します。元に戻せません。削除しますか？'));
      return button;
    };
    const pending=$('pendingParticipants'), approved=$('approvedParticipants'); pending.replaceChildren();approved.replaceChildren();
    const pend=participants.filter(p=>p.status==='pending'||(p.status==='approved'&&Number(p.pendingExtra||0)>0));
    const ok=participants.filter(p=>p.status==='approved');
    if(!pend.length)pending.textContent='申請待ちはありません。';
    pend.forEach(p=>{
      const row=document.createElement('div');row.className='participant-row participant-record';
      const main=document.createElement('div');main.className='participant-main';
      const {menu,actions}=makeMenu(p,'pending');
      const header=document.createElement('div');header.className='participant-record-head';
      const name=document.createElement('strong');name.textContent=p.name;header.append(name,menu);main.append(header);
      const note=document.createElement('div');note.className='participant-card-status';note.textContent=p.status==='pending'?'新規カード申請':'追加カード申請';main.append(note);row.append(main);
      const yes=document.createElement('button');yes.textContent='承認';yes.addEventListener('click',()=>participantAction(p.id,'approve'));actions.append(yes);
      const no=document.createElement('button');no.className='secondary';no.textContent='却下';no.addEventListener('click',()=>participantAction(p.id,'reject'));actions.append(no);
      actions.append(deletePersonButton(p));pending.append(row);
    });
    if(!ok.length)approved.textContent='承認済み参加者はいません。';
    ok.forEach(p=>{
      const row=document.createElement('div');row.className='participant-row participant-record';
      const main=document.createElement('div');main.className='participant-main';
      const {menu,actions}=makeMenu(p,'approved');
      const header=document.createElement('div');header.className='participant-record-head';
      const name=document.createElement('strong');name.textContent=p.name+' · '+(p.cards?.length||0)+'枚';header.append(name,menu);main.append(header);
      const view=document.createElement('button');view.type='button';view.className='secondary';view.textContent='カード確認';view.addEventListener('click',()=>openDialog(p));actions.append(view);
      const extra=document.createElement('button');extra.type='button';extra.textContent='追加発行';extra.addEventListener('click',()=>participantAction(p.id,'issue_extra'));actions.append(extra);
      if(!p.cards?.length){const s=document.createElement('div');s.className='participant-card-status';s.textContent='カードなし';main.append(s);}
      else p.cards.forEach((card,i)=>{
        const st=lineStats(card),s=document.createElement('div');s.className='participant-card-status admin-card-status';
        const detail=document.createElement('span');detail.textContent='CARD '+(i+1)+' · BINGO '+st.bingo+' / REACH '+st.reach+' / あと'+st.remaining;
        const del=document.createElement('button');del.type='button';del.className='danger delete-card';del.textContent='CARD '+(i+1)+'を削除';del.disabled=!canDelete||!card.id;
        del.addEventListener('click',()=>participantAction(p.id,'delete_card',{cardId:card.id},'「'+p.name+'」のCARD '+(i+1)+'を削除します。参加者は残ります。元に戻せません。削除しますか？'));
        s.append(detail);main.append(s);actions.append(del);
      });
      row.append(main);
      actions.append(deletePersonButton(p));approved.append(row);
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
    $('chatNameStatus').textContent=overview.adminId?'投稿ID：'+overview.adminId:'ログイン中の管理者IDで投稿します。';
    if($('adminUserSettings'))$('adminUserSettings').hidden=!overview.canManageUsers;
    const root=$('adminChatMessages'), shouldStick=root.scrollTop+root.clientHeight>=root.scrollHeight-40;root.replaceChildren();
    (overview.messages||[]).forEach(m=>{
      const row=document.createElement('div');row.className='chat-message';
      const head=document.createElement('div');head.className='chat-message-head';
      const name=document.createElement('strong');name.textContent=m.adminId||m.name||'運営';head.append(name);
      const time=document.createElement('span');const d=new Date(m.createdAt);time.textContent=Number.isNaN(d.getTime())?'':d.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});head.append(time);
      const body=document.createElement('div');body.textContent=m.message||'';row.append(head,body);root.append(row);
    });
    if(shouldStick)root.scrollTop=root.scrollHeight;
  }
  function serverNow(){return Date.now()+serverClockOffsetMs}
  function receiveState(data){
    if(Number.isFinite(data.serverTimeMs))serverClockOffsetMs=data.serverTimeMs-Date.now();
    state=data.state;lastStateSyncAt=Date.now();syncMiniPlayerVisibility();
  }
  function activeCelebration(){
    if(!state?.drawActive)return null;
    const now=serverNow();
    return (state.celebrations||[]).find(event=>event.startsAtMs<=now&&now<event.endsAtMs)||null;
  }
  function celebrationPending(){return !!state?.drawActive&&(state.celebrations||[]).some(event=>event.endsAtMs>serverNow())}
  function achievementLabel(entry){
    if(entry.type==='reach')return 'REACH! あと1個';
    return (entry.bingoFrom===entry.bingoTo?entry.bingoTo:entry.bingoFrom+'〜'+entry.bingoTo)+'ビンゴ目！';
  }
  function renderCelebrations(){
    const event=activeCelebration(),now=serverNow();
    ['publicCelebration','miniCelebration','adminCelebration'].forEach(id=>{
      const root=$(id);if(!root)return;
      root.hidden=!event;if(!event){root.dataset.eventId='';return;}
      if(root.dataset.eventId!==event.id){
        root.dataset.eventId=event.id;root.replaceChildren();
        const title=document.createElement('strong');title.className='celebration-kicker';title.textContent=event.entries.some(entry=>entry.type==='bingo')?'BINGO!':'REACH!';
        const viewport=document.createElement('div');viewport.className='celebration-viewport';
        const list=document.createElement('div');list.className='celebration-list';
        event.entries.forEach(entry=>{
          const row=document.createElement('div');row.className='celebration-person';
          const name=document.createElement('strong');name.textContent=entry.name;
          const label=document.createElement('span');label.textContent=achievementLabel(entry);
          row.append(name,label);list.append(row);
        });viewport.append(list);root.append(title,viewport);
      }
      const progress=Math.max(0,Math.min(1,(now-event.startsAtMs)/(event.endsAtMs-event.startsAtMs)));
      const list=root.querySelector('.celebration-list'),viewport=root.querySelector('.celebration-viewport');
      list.style.transform='translateY(-'+Math.max(0,list.scrollHeight-viewport.clientHeight)*progress+'px)';
      root.style.opacity=String(Math.min(1,(now-event.startsAtMs)/300,(event.endsAtMs-now)/500));
    });
  }
  function paintCelebrationOnCanvas(ctx){
    const event=activeCelebration();if(!event)return;
    const progress=(serverNow()-event.startsAtMs)/(event.endsAtMs-event.startsAtMs);
    ctx.save();ctx.fillStyle='#10192bf5';ctx.fillRect(0,0,960,600);
    for(let i=0;i<24;i++){
      ctx.fillStyle=i%2?'#69e7b4':'#e1bc8c';
      ctx.fillRect((i*131+progress*80)%960,(i*73+progress*640)%600,8,16);
    }
    ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#e1bc8c';ctx.font='900 76px system-ui, sans-serif';
    ctx.fillText(event.entries.some(entry=>entry.type==='bingo')?'BINGO!':'REACH!',480,90,900);
    const pageCount=Math.ceil(event.entries.length/3),page=Math.min(pageCount-1,Math.floor(progress*pageCount));
    const entries=event.entries.slice(page*3,page*3+3);
    entries.forEach((entry,i)=>{
      const y=210+i*122;
      ctx.fillStyle='#fff';ctx.font='800 43px system-ui, sans-serif';ctx.fillText(entry.name,480,y,850);
      ctx.fillStyle=entry.type==='bingo'?'#e1bc8c':'#69e7b4';ctx.font='800 34px system-ui, sans-serif';ctx.fillText(achievementLabel(entry),480,y+48,850);
    });
    ctx.restore();
  }
  function syncEventSettings(){
    if(!state||eventSettingsDirty||settingsSaving)return;
    if(document.activeElement===$('editTitle')||document.activeElement===$('editAnnouncement'))return;
    $('editTitle').value=state.title||'';$('editAnnouncement').value=state.announcement||'';
  }
  async function saveEventSettings(){
    if(settingsSaving||busy||!token)return;
    const title=$('editTitle').value.trim(),announcement=$('editAnnouncement').value;
    if(!title||title.length>60||announcement.length>300){message('イベント名は1〜60文字、お知らせは300文字以内で入力してください。');return;}
    settingsSaving=true;$('editTitle').disabled=true;$('editAnnouncement').disabled=true;$('saveEventSettings').disabled=true;
    try{
      if(await mutate('save',{title,announcement})){eventSettingsDirty=false;message('イベント名とお知らせを保存しました。')}
    }finally{
      settingsSaving=false;$('editTitle').disabled=false;$('editAnnouncement').disabled=false;
      syncEventSettings();$('saveEventSettings').disabled=!eventSettingsDirty;
    }
  }

  function drawAnimationActive(){return !!(state?.lastDraw&&Number(state.lastDraw.animationUntilMs)>serverNow())}
  function updateDrawAnimation(){
    const active=drawAnimationActive();
    const until=Number(state?.lastDraw?.animationUntilMs||0);
    const remaining=Math.max(0,until-serverNow());
    const picked=Number(state?.lastDraw?.number||state?.drawn?.at(-1)||0);
    const reveal=active&&remaining<=900&&picked>0;
    const rolling=String(1+Math.floor(Math.random()*99)).padStart(2,'0');
    const value=reveal?String(picked).padStart(2,'0'):rolling;
    const publicEl=$('publicDrawAnimation');
    if(publicEl){
      publicEl.hidden=!active;publicEl.classList.toggle('is-final',reveal);
      const strong=publicEl.querySelector('strong'),caption=publicEl.querySelector('.draw-caption');
      if(active&&strong)strong.textContent=value;if(caption)caption.textContent=reveal?'決定！':'抽選中...';
    }
    const adminEl=$('adminDrawAnimation');
    if(adminEl){adminEl.hidden=!active;if(active){const strong=adminEl.querySelector('strong');if(strong)strong.textContent=value}}
    if(!active&&state&&$('latestNumber'))$('latestNumber').textContent=state.drawn.length?String(state.drawn.at(-1)).padStart(2,'0'):'–';
  }

  function formatDuration(totalSec){
    totalSec=Math.max(0,Math.round(totalSec));
    const h=Math.floor(totalSec/3600),m=Math.floor((totalSec%3600)/60),s=totalSec%60;
    if(h>0)return h+'時間'+(m?m+'分':'');
    if(m>0)return m+'分'+(s?s+'秒':'');
    return s+'秒';
  }
  function updateContinuousEstimate(){
    if(!state)return;
    const remaining=Math.max(0,99-(state.drawn?.length||0));
    const dlg=$('continuousSettingsDialog');
    const input=$('continuousIntervalSec');
    const editing=!!dlg?.open;
    const raw=editing&&input?Number(input.value):continuousIntervalSec;
    const interval=Math.max(5,Math.min(3600,Number.isFinite(raw)&&raw>0?raw:continuousIntervalSec));
    const total=remaining*interval;
    const text='残り'+remaining+'個 · '+interval+'秒間隔 · 終了まで約'+formatDuration(total);
    if($('continuousEstimate'))$('continuousEstimate').textContent=text;
    if($('continuousSettingsEstimate'))$('continuousSettingsEstimate').textContent=text;
  }
  function renderState(){
    syncMiniPlayerVisibility();
    if(!state)return;
    $('eventTitle').textContent=(state.title||'特設ビンゴ').replace(/^Y\+\+\s*/,'').trim()||'特設ビンゴ';
    const onAir=state.liveOnAir===true,status=onAir?'ONAIR':'OFFAIR';
    $('liveStatus').textContent=status;
    $('liveStatus').classList.toggle('is-onair',onAir);$('liveStatus').classList.toggle('is-offair',!onAir);
    const liveButton=$('toggleLiveState');
    liveButton.textContent='LIVE：'+status;liveButton.disabled=busy;
    liveButton.setAttribute('aria-pressed',String(onAir));liveButton.setAttribute('aria-label','LIVEを'+(onAir?'OFFAIR':'ONAIR')+'に切り替える');
    $('eventDescription').textContent='参加者みんなで楽しむBINGO！';
    $('announcement').textContent=state.announcement||'';
    $('gameStatus').textContent=state.drawActive?'現在抽選中':(({waiting:'準備中',running:'開催中',paused:'一時停止',finished:'終了'})[state.status]||'準備中');
    $('latestNumber').textContent=drawAnimationActive()?'…':(state.drawn.length?String(state.drawn.at(-1)).padStart(2,'0'):'–');
    renderHistory('history','drawCount');renderHistory('adminHistory','adminDrawCount');$('applicationArea').hidden=false;
    if(token){
      syncEventSettings();$('saveEventSettings').disabled=!eventSettingsDirty||busy||settingsSaving;
      $('drawNumber').disabled=!state.drawActive||state.drawn.length===99||busy||drawAnimationActive()||celebrationPending();
      $('drawSpecifiedNumber').disabled=$('drawNumber').disabled||overview.canSpecifyDrawNumber!==true;
      $('specifiedDrawHint').textContent=overview.canSpecifyDrawNumber===true?'未抽選の1〜99を指定できます。通常と同じ演出で抽選します。':'指定番号抽選は現在準備中です。';
      $('undoNumber').disabled=!state.drawn.length||busy;$('startDrawMode').disabled=!!state.drawActive||busy;$('stopDrawMode').disabled=!state.drawActive||busy;
      const continuous=$('continuousDraw');
      continuous.disabled=!state.drawActive||state.drawn.length===99||busy;
      continuous.textContent='連続抽選：'+(continuousMode?'ON':'OFF');
      continuous.setAttribute('aria-pressed',continuousMode?'true':'false');continuous.classList.toggle('toggle-on',continuousMode);
      if(!state.drawActive&&continuousMode)setContinuousMode(false);
    }
    renderParticipants();renderAdminPeople();renderWinners();renderPublicCards();renderChat();updateDrawAnimation();updateContinuousEstimate();
    if(state.drawActive===true)renderMiniPlayer();
    if($('cardDialog').open){const p=participants.find(x=>x.id===dialogParticipantId);if(p)renderPersonCards(p,$('dialogCards'));else $('cardDialog').close()}
  }
  async function refresh(silent=false){
    if(loading||busy)return;loading=true;
    try{
      const [,p]=await Promise.all([
        api('/state').then(receiveState),
        api('/participants')
      ]);participants=p.participants||[];
      if(token){const [admin,ov]=await Promise.all([api('/admin/participants','GET',null,token),api('/admin/overview','GET',null,token)]);participants=admin.participants||participants;overview=ov||overview;}
      renderState();
      const now=new Date().toLocaleTimeString('ja-JP');
      $('connection').textContent='● 共有データ接続中 · 最終確認 '+now;$('connection').style.color='#69e7b4';
      if($('adminConnection'))$('adminConnection').textContent='● 接続中 · '+now;
    }catch(e){
      $('connection').textContent='⚠ 同期できません：'+e.message;$('connection').style.color='#f6bd89';
      if($('adminConnection'))$('adminConnection').textContent='⚠ 同期エラー';if(!silent)message(e.message)
    }finally{loading=false}
  }

  async function apply(){
    const name=$('playerName').value.trim();if(!name)return $('applicationMessage').textContent='REALITY上の名前を入力してください。';
    $('applyCard').disabled=true;
    try{const r=await api('/apply','POST',{name,deviceId:deviceId()});$('applicationMessage').textContent=r.additional?'追加カードを申請しました。管理者の承認をお待ちください。':'申請しました。管理者の承認をお待ちください。';$('playerName').value='';await refresh(true)}
    catch(e){$('applicationMessage').textContent='申請できませんでした：'+e.message}
    finally{$('applyCard').disabled=false}
  }
  async function login(){
    const adminId=$('adminId').value.trim(),password=$('adminPassword').value,remember=$('rememberAdmin').checked;
    if(!adminId||!password)return message('管理者IDとパスワードを入力してください。');
    $('adminPasswordLogin').disabled=true;
    try{const r=await api('/admin/login','POST',{adminId,password,remember});token=r.token;if(remember)storage.set('yplus.bingo.admin.token.v1',token);else storage.remove('yplus.bingo.admin.token.v1');$('adminLoginDialog').close();$('publicView').hidden=true;$('adminView').hidden=false;message('');await refresh(true);await refreshAdminUsers()}
    catch(e){message('管理画面を開けません：'+e.message)}
    finally{$('adminPassword').value='';$('adminPasswordLogin').disabled=false}
  }
  async function participantAction(id,action,extra={},confirmText=''){
    if(!token||busy)return;
    if(confirmText&&!confirm(confirmText))return;
    busy=true;
    const status=$('participantActionMessage');
    status.textContent='処理中…';
    try{
      await api('/admin/participant','POST',{participantId:id,action,...extra},token);
      status.textContent=action==='delete_participant'?'参加者と発行済みカードを削除しました。':action==='delete_card'?'カードを削除しました。':'参加者情報を更新しました。';
    }catch(e){status.textContent='操作できませんでした：'+e.message}
    finally{busy=false}
    await refresh(true);
  }
  async function mutate(action,extra={},confirmText=''){
    if(!token||busy||!state)return false;
    if(confirmText&&!confirm(confirmText))return false;
    busy=true;let success=false;
    try{
      const result=await api('/admin/action','POST',{action,expectedRevision:state.revision,...extra},token);
      receiveState(result);renderState();success=true;
    }catch(e){message('保存できませんでした：'+e.message)}
    finally{busy=false}
    await refresh(true);return success;
  }

  async function drawSpecifiedNumber(){
    if(!token||busy||!state)return;
    if(overview.canSpecifyDrawNumber!==true){message('指定番号抽選は現在準備中です。');return;}
    if(!state.drawActive){message('先に「抽選開始」を押してください。');return;}
    if(drawAnimationActive()||celebrationPending()){message('現在の演出が終了してから抽選してください。');return;}
    const input=$('specifiedNumber'),number=Number(input.value);
    if(!input.value.trim()||!Number.isInteger(number)||number<1||number>99){message('1〜99の整数を入力してください。');input.focus();return;}
    if(state.drawn.includes(number)){message('その番号はすでに抽選済みです。別の番号を指定してください。');input.focus();return;}
    if(await mutate('draw',{number})){
      input.value='';message('指定番号 '+String(number).padStart(2,'0')+' を抽選しました。');
      if(continuousMode)scheduleContinuousDraw();
    }
  }

  function setContinuousMode(on){
    if(on&&(!state?.drawActive||state.drawn.length>=99)){message('先に「抽選開始」を押してから連続抽選をONにしてください。');return}
    continuousMode=!!on;
    if(continuousTimer){clearTimeout(continuousTimer);continuousTimer=null}
    const btn=$('continuousDraw');
    if(btn){btn.textContent='連続抽選：'+(continuousMode?'ON':'OFF');btn.setAttribute('aria-pressed',continuousMode?'true':'false');btn.classList.toggle('toggle-on',continuousMode)}
    message(continuousMode?'連続抽選を開始しました（'+continuousIntervalSec+'秒間隔）。':'連続抽選を停止しました。');
    if(continuousMode)scheduleContinuousDraw();
  }
  function scheduleContinuousDraw(){
    if(continuousTimer){clearTimeout(continuousTimer);continuousTimer=null}
    if(!continuousMode||!token||!state?.drawActive||state.drawn.length>=99)return;
    const lastStarted=Math.max(0,Number(state?.lastDraw?.animationUntilMs||0)-5000);
    const base=lastStarted||serverNow();
    const nextAt=Math.max(serverNow()+300,base+continuousIntervalSec*1000);
    continuousTimer=setTimeout(async()=>{
      continuousTimer=null;
      if(!continuousMode||!token||!state?.drawActive)return;
      if(busy||drawAnimationActive()||celebrationPending()){scheduleContinuousDraw();return}
      await mutate('draw');
      if(continuousMode)scheduleContinuousDraw();
    },Math.max(300,nextAt-serverNow()));
  }
  function openContinuousSettings(){
    $('continuousSettingsMessage').textContent='';
    const input=$('continuousIntervalSec');
    if(!input||!$('continuousSettingsDialog'))return message('連続抽選設定を開けませんでした。ページを再読み込みしてください。');
    input.value=String(continuousIntervalSec);
    $('continuousSettingsDialog').showModal();
    updateContinuousEstimate();
    setTimeout(()=>{input.focus();input.select();},0);
  }
  function saveContinuousSettings(){
    const input=$('continuousIntervalSec');
    const raw=Number(input?.value);
    if(!input.value.trim()||!Number.isFinite(raw)||raw<5||raw>3600){message('抽選間隔は5〜3600秒で入力してください。');return}
    continuousIntervalSec=Math.max(5,Math.min(3600,Math.round(raw)));
    storage.set('yplus.bingo.continuous.interval.v1',String(continuousIntervalSec));
    if(input)input.value=String(continuousIntervalSec);
    if(continuousMode)scheduleContinuousDraw();
    updateContinuousEstimate();
    $('continuousSettingsDialog').close();
    message('連続抽選の間隔を '+continuousIntervalSec+' 秒に変更しました。');
  }

  async function sendChat(){
    const input=$('adminChatInput'),text=input.value.trim();if(!text)return;
    $('sendAdminChat').disabled=true;
    try{
      // Older API deployments still require a session name before posting.
      const me=await api('/admin/overview','GET',null,token);
      if(!me.adminId)throw new Error('管理者IDを確認できません。再ログインしてください。');
      if(me.name!==me.adminId)await api('/admin/name','POST',{name:me.adminId},token);
      await api('/admin/chat','POST',{message:text},token);
      input.value='';await refresh(true);
    }catch(e){$('chatNameStatus').textContent='送信できませんでした：'+e.message}
    finally{$('sendAdminChat').disabled=false}
  }
  async function refreshAdminUsers(){if(!token||!$('adminUserSettings')||$('adminUserSettings').hidden)return;try{const r=await api('/admin/users','GET',null,token),root=$('adminUsersList');root.replaceChildren();(r.users||[]).forEach(u=>{const row=document.createElement('div');row.className='participant-row';const main=document.createElement('div');main.className='participant-main';const name=document.createElement('strong');name.textContent=u.id+(u.role==='owner'?'（オーナー）':'');main.append(name);row.append(main);if(u.role!=='owner'){const del=document.createElement('button');del.className='danger';del.textContent='削除';del.addEventListener('click',()=>adminUserAction('delete',u.id));row.append(del)}root.append(row)})}catch(e){$('adminUsersMessage').textContent='管理者一覧を取得できません：'+e.message}}
  async function adminUserAction(action,adminId,password=''){try{await api('/admin/users','POST',{action,adminId,password},token);$('adminUsersMessage').textContent=action==='create'?'管理者を追加しました。':'管理者を削除しました。';await refreshAdminUsers()}catch(e){$('adminUsersMessage').textContent='操作できませんでした：'+e.message}}
  async function restoreAdminSession(){const saved=storage.get('yplus.bingo.admin.token.v1');if(!saved)return;token=saved;try{await api('/admin/overview','GET',null,token);$('publicView').hidden=true;$('adminView').hidden=false;await refresh(true);await refreshAdminUsers()}catch{token='';storage.remove('yplus.bingo.admin.token.v1')}}

  const adminTrigger=$('adminTrigger');let adminTapCount=0, adminTapTimer=null, adminHoldTimer=null, adminHoldOpened=false;
  function openAdminPanel(){if(!$('adminLoginDialog').open)$('adminLoginDialog').showModal();setTimeout(()=>$('adminPassword').focus(),0)}
  adminTrigger.addEventListener('click',()=>{if(adminHoldOpened){adminHoldOpened=false;return}adminTapCount++;clearTimeout(adminTapTimer);if(adminTapCount>=5){adminTapCount=0;openAdminPanel();return}adminTapTimer=setTimeout(()=>{adminTapCount=0},1800)});
  const startAdminHold=()=>{adminHoldOpened=false;clearTimeout(adminHoldTimer);adminHoldTimer=setTimeout(()=>{adminHoldOpened=true;adminTapCount=0;openAdminPanel()},3000)},cancelAdminHold=()=>clearTimeout(adminHoldTimer);
  adminTrigger.addEventListener('pointerdown',startAdminHold);adminTrigger.addEventListener('pointerup',cancelAdminHold);adminTrigger.addEventListener('pointercancel',cancelAdminHold);adminTrigger.addEventListener('pointerleave',cancelAdminHold);adminTrigger.addEventListener('contextmenu',e=>e.preventDefault());

  document.addEventListener('click',event=>{if(!event.target.closest('.participant-menu'))document.querySelectorAll('.participant-menu[open]').forEach(menu=>{menu.open=false})});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelectorAll('.participant-menu[open]').forEach(menu=>{menu.open=false})});
  $('applyCard').addEventListener('click',apply);
  $('participantSelect').addEventListener('change',()=>{miniPlayerCardIndex=0;renderPublicCards();renderMiniPlayer()});
  $('publicCards').addEventListener('click',e=>{
    const button=e.target.closest('[data-card-step]');if(!button||button.disabled)return;
    const person=selectedPublicPerson();if(!person?.cards?.length)return;
    miniPlayerCardIndex=Math.max(0,Math.min(miniPlayerCardIndex+Number(button.dataset.cardStep),person.cards.length-1));
    renderPublicCards();renderMiniPlayer();
    $('publicCards').querySelector('[data-card-step="'+button.dataset.cardStep+'"]:not(:disabled)')?.focus({preventScroll:true});
  });
  $('miniPlayerOpen').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();openMiniPlayer()});
  enforceMiniPlayerMute();
  ['volumechange','play','loadedmetadata','enterpictureinpicture','webkitpresentationmodechanged'].forEach(event=>{
    $('miniPlayerVideo').addEventListener(event,enforceMiniPlayerMute);
  });
  $('miniPictureInPicture').addEventListener('click',enterMiniPictureInPicture);
  $('miniPlayerVideo').addEventListener('enterpictureinpicture',()=>{$('miniPlayerMessage').textContent='小窓再生中です。カードの切り替えはこのページで操作してください。'});
  const miniPipEnded=()=>{if($('miniPlayer').hidden)releaseMiniVideo();else $('miniPlayerMessage').textContent='小窓再生を終了しました。もう一度ボタンを押すと再開できます。'};
  $('miniPlayerVideo').addEventListener('leavepictureinpicture',miniPipEnded);
  $('miniPlayerVideo').addEventListener('webkitpresentationmodechanged',()=>{if(miniPlayerInPictureInPicture())$('miniPlayerMessage').textContent='小窓再生中です。';else miniPipEnded()});
  $('miniPlayerClose').addEventListener('click',closeMiniPlayer);
  $('miniPrevCard').addEventListener('click',()=>{const p=selectedPublicPerson();if(!p?.cards?.length)return;miniPlayerCardIndex=(miniPlayerCardIndex-1+p.cards.length)%p.cards.length;renderPublicCards();renderMiniPlayer()});
  $('miniNextCard').addEventListener('click',()=>{const p=selectedPublicPerson();if(!p?.cards?.length)return;miniPlayerCardIndex=(miniPlayerCardIndex+1)%p.cards.length;renderPublicCards();renderMiniPlayer()});
  $('dialogClose').addEventListener('click',()=>$('cardDialog').close());
  $('adminLoginClose').addEventListener('click',()=>{$('adminLoginDialog').close();$('adminPassword').value='';message('')});
  $('adminPasswordLogin').addEventListener('click',login);$('adminId').addEventListener('keydown',e=>{if(e.key==='Enter')login()});$('adminPassword').addEventListener('keydown',e=>{if(e.key==='Enter')login()});
  $('adminLogout').addEventListener('click',async()=>{setContinuousMode(false);const t=token;token='';storage.remove('yplus.bingo.admin.token.v1');$('adminView').hidden=true;$('publicView').hidden=false;if(t)await api('/admin/logout','POST',{},t).catch(()=>{});await refresh(true)});
  ['editTitle','editAnnouncement'].forEach(id=>$(id).addEventListener('input',()=>{eventSettingsDirty=true;$('saveEventSettings').disabled=false}));
  $('saveEventSettings').addEventListener('click',saveEventSettings);
  $('startDrawMode').addEventListener('click',async()=>{setContinuousMode(false);await mutate('draw_start')});
  $('stopDrawMode').addEventListener('click',async()=>{setContinuousMode(false);await mutate('draw_stop')});
  $('toggleLiveState').addEventListener('click',async()=>{
    const next=state?.liveOnAir!==true;
    if(await mutate('set_live',{onAir:next}))message('LIVEを'+(next?'ONAIR':'OFFAIR')+'に切り替えました。');
  });
  $('drawNumber').addEventListener('click',()=>mutate('draw'));
  $('drawSpecifiedNumber').addEventListener('click',drawSpecifiedNumber);
  $('specifiedNumber').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();drawSpecifiedNumber()}});
  $('continuousDraw').addEventListener('click',()=>setContinuousMode(!continuousMode));
  $('continuousSettings').addEventListener('click',openContinuousSettings);
  $('continuousSettingsClose').addEventListener('click',()=>$('continuousSettingsDialog').close());
  $('saveContinuousSettings').addEventListener('click',saveContinuousSettings);
  $('continuousIntervalSec').addEventListener('input',updateContinuousEstimate);
  $('continuousIntervalSec').addEventListener('change',updateContinuousEstimate);
  document.querySelectorAll('[data-interval]').forEach(btn=>btn.addEventListener('click',()=>{const input=$('continuousIntervalSec');input.value=btn.dataset.interval;updateContinuousEstimate()}));
  $('undoNumber').addEventListener('click',()=>mutate('undo',{},'最後の抽選番号を取り消しますか？'));
  $('resetGame').addEventListener('click',()=>{setContinuousMode(false);mutate('reset',{},'抽選番号をすべてリセットしますか？ 発行済みカードは保持されます。')});
  $('sendAdminChat').addEventListener('click',sendChat);
  $('createAdminUser').addEventListener('click',()=>{const id=$('newAdminId').value.trim(),pw=$('newAdminPassword').value;if(!id||!pw)return $('adminUsersMessage').textContent='IDとパスワードを入力してください。';adminUserAction('create',id,pw).then(()=>{$('newAdminId').value='';$('newAdminPassword').value=''})});
  $('adminChatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat()}});

  refresh();restoreAdminSession();
  setInterval(()=>{if(!document.hidden||miniPlayerSessionActive())refresh(true)},1000);
  setInterval(()=>{updateDrawAnimation();renderMiniPlayer();renderCelebrations()},100);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(true)});
})();





