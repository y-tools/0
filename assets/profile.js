'use strict';
/* Public profile renderer and hidden four-pane editor. No GitHub credentials are used. */
(() => {
  const $ = id => document.getElementById(id);
  const API = 'https://153-127-64-17.sslip.io/api';
  const DRAFT_KEY = 'yplus.profile.draft.v1';
  const TOKEN_KEY = 'yplus.admin.token';
  const state = {base: null, published:null, data:null, revision:0, online:false, active:false, tap:0, lastTap:0, token:'', busy:false};
  const clone = x => JSON.parse(JSON.stringify(x));
  const text = (x,max) => String(x ?? '').slice(0,max);
  const el = (tag,className,content) => {const e=document.createElement(tag);if(className)e.className=className;if(content!==undefined)e.textContent=content;return e;};
  const normalize = raw => {
    const data=raw && typeof raw==='object' ? raw : {};
    const blocks=Array.isArray(data.blocks)?data.blocks.slice(0,24):[];
    return {
      displayName:text(data.displayName||'Y++',70),
      handle:text(data.handle||'CREATOR / STREAMING TOOLS',100),
      statement:text(data.statement||'',160),
      description:text(data.description||'',1000),
      links:Array.isArray(data.links)?data.links.slice(0,10):[],
      blocks:blocks.map(b=>({
        id:typeof b.id==='string' && /^[\w-]{1,80}$/.test(b.id)?b.id:randomId(),
        type:b.type==='weekly'?'weekly':'basic',
        title:text(b.title,80),
        content:text(b.content,1800)
      }))
    };
  };
  const randomId = () => (typeof crypto.randomUUID==='function'?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(12)),n=>n.toString(16).padStart(2,'0')).join(''));
  const safeExternal = url => {try{const x=new URL(url);return x.protocol==='https:'?x.href:'';}catch{return '';}};
  const readStorage = (store,key) => {try{return store.getItem(key)||'';}catch{return '';}};
  const writeStorage = (store,key,val) => {try{store.setItem(key,val);return true;}catch{return false;}};
  const clearStorage = (store,key) => {try{store.removeItem(key);}catch{}};
  const setStatus = msg => {$('profileEditorStatus').textContent=msg||'';};

  async function request(path,options={}){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),12000);
    try{
      const r=await fetch(API+path,{
        method:options.method||'GET',cache:'no-store',mode:'cors',
        headers:{'Content-Type':'application/json',...(options.token?{Authorization:'Bearer '+options.token}:{})},
        body:options.payload?JSON.stringify(options.payload):undefined,
        signal:controller.signal
      });
      const body=await r.json().catch(()=>({}));
      if(!r.ok){
        const err=new Error(text(body.error||('HTTP '+r.status),200));err.status=r.status;throw err;
      }
      return body;
    }finally{clearTimeout(timeout);}
  }

  function renderPublic(data){
    const p=normalize(data);
    $('profileName').textContent=p.displayName;
    $('profileTap').setAttribute('aria-label',p.displayName+' のプロフィール');
    $('profileHandle').textContent=p.handle;
    $('profileStatement').textContent=p.statement;
    $('profileDescription').textContent=p.description;
    const root=$('profileBlocks');root.replaceChildren();
    for(const b of p.blocks){
      if(!b.title.trim()&&!b.content.trim())continue;
      const box=el('article','profile-text-block');
      box.append(el('div','profile-block-type',b.type==='weekly'?'WEEKLY EVENT SCHEDULE':'PROFILE BLOCK'));
      if(b.title.trim())box.append(el('h4','',b.title));
      if(b.content.trim())box.append(el('p','',b.content));
      root.append(box);
    }
    const links=$('profileLinks');links.replaceChildren();
    for(const link of p.links){
      const href=safeExternal(link.href);
      if(!href)continue;
      const a=el('a','',text(link.label||'LINK',40)+' ↗');a.href=href;a.target='_blank';a.rel='noopener noreferrer';links.append(a);
    }
  }

  async function refreshPublished(){
    try{
      const result=await request('/profile');
      if(!result||!result.profile){state.online=true;return;}
      const fresh=normalize(result.profile);
      state.online=true;state.published=fresh;state.data=clone(fresh);
      state.revision=Number.isSafeInteger(result.revision)?result.revision:0;
      renderPublic(fresh);
    }catch{state.online=false;}
  }
  function onBaseLoaded(evt){
    state.base=normalize(evt.detail);
    if(!state.published){state.data=clone(state.base);renderPublic(state.base);}
    refreshPublished();
  }

  function preview(){
    const root=$('profileEditorPreview');root.replaceChildren();
    root.append(el('strong','',state.data.displayName||'Y++'));
    root.append(el('p','',state.data.statement),el('p','',state.data.description));
    for(const b of state.data.blocks){
      const row=el('div','editor-preview-item');
      row.append(el('strong','',b.title||'（タイトル未入力）'),el('span','',b.content||'（内容未入力）'));
      root.append(row);
    }
  }
  const field=(label,kind,val,onChange,max,placeholder) => {
    const lab=el('label','',label);
    const input=document.createElement(kind);
    if(kind==='input')input.type='text';else input.rows=3;
    input.value=val;input.maxLength=max;input.placeholder=placeholder;
    input.addEventListener('input',()=>onChange(input.value));
    return [lab,input];
  };
  function makeBlock(b,index){
    const card=el('div','editor-block-item');
    const controls=el('div','editor-block-actions');
    const up=el('button','', '↑');
    const down=el('button','','↓');
    const remove=el('button','remove','削除');
    for(const btn of [up,down,remove])btn.type='button';
    up.disabled=index===0||state.data.blocks[index-1]?.type!==b.type;
    down.disabled=index===state.data.blocks.length-1||state.data.blocks[index+1]?.type!==b.type;
    up.setAttribute('aria-label','上へ移動');down.setAttribute('aria-label','下へ移動');
    up.addEventListener('click',()=>moveBlock(b.id,-1));
    down.addEventListener('click',()=>moveBlock(b.id,1));
    remove.addEventListener('click',()=>{state.data.blocks=state.data.blocks.filter(x=>x.id!==b.id);draw();});
    controls.append(up,down,remove);card.append(controls);
    const title=field('タイトル','input',b.title,v=>{b.title=v;preview();},80,b.type==='weekly'?'週間イベントスケジュール':'自己紹介・お知らせなど');
    const content=field('内容','textarea',b.content,v=>{b.content=v;preview();},1800,b.type==='weekly'?'月｜\\n火｜\\n水｜\\n木｜\\n金｜\\n土｜\\n日｜':'自由に文章を入力');
    card.append(...title,...content);
    return card;
  }
  function draw(){
    $('editProfileName').value=state.data.displayName;
    $('editProfileStatement').value=state.data.statement;
    $('editProfileDescription').value=state.data.description;
    const weekly=$('weeklyEditorBlocks'),basic=$('basicEditorBlocks');weekly.replaceChildren();basic.replaceChildren();
    state.data.blocks.forEach((b,i)=>(b.type==='weekly'?weekly:basic).append(makeBlock(b,i)));
    preview();
    $('profileStorageHint').textContent=state.online
      ? '保存するとサーバーへ反映されます。'
      : 'サーバー保存APIが未接続です。現在は端末内の下書きとして保存します。';
  }
  function moveBlock(id,dir){
    const i=state.data.blocks.findIndex(b=>b.id===id);
    if(i<0)return;
    const j=i+dir;if(j<0||j>=state.data.blocks.length||state.data.blocks[j].type!==state.data.blocks[i].type)return;
    [state.data.blocks[i],state.data.blocks[j]]=[state.data.blocks[j],state.data.blocks[i]];draw();
  }
  function addBlock(type){
    if(state.data.blocks.length>=24){setStatus('ブロックは最大24個です。');return;}
    state.data.blocks.push({id:randomId(),type,title:type==='weekly'?'週間イベントスケジュール':'基本ブロック',content:''});
    draw();
    (type==='weekly'?$('weeklyEditorBlocks'):$('basicEditorBlocks')).lastElementChild?.scrollIntoView({block:'nearest'});
  }
  function isValidPayload(p){
    return p.blocks.length<=24&&p.blocks.every(b=>b.title.length<=80&&b.content.length<=1800)&&
      p.displayName.length<=70&&p.statement.length<=160&&p.description.length<=1000;
  }

  async function doSave(){
    if(state.busy)return;
    const p=normalize(state.data);
    if(!isValidPayload(p)){setStatus('入力が長すぎるか、ブロック数の上限を超えています。');return;}
    const draft=JSON.stringify({profile:p,at:new Date().toISOString()});
    if(!state.online){
      setStatus(writeStorage(localStorage,DRAFT_KEY,draft)
        ?'この端末に下書き保存しました。まだ公開されていません。'
        :'下書きを保存できませんでした。');
      renderPublic(p);return;
    }
    state.busy=true;$('profileSave').disabled=true;setStatus('保存中…');
    try{
      const result=await request('/admin/profile',{method:'POST',token:state.token,payload:{profile:p,revision:state.revision}});
      state.revision=result.revision;state.published=clone(p);state.data=clone(p);state.online=true;
      clearStorage(localStorage,DRAFT_KEY);renderPublic(p);draw();setStatus('公開プロフィールを保存しました。');
    }catch(err){
      if(err.status===401){clearStorage(sessionStorage,TOKEN_KEY);state.token='';setStatus('認証が切れました。閉じてから再度ログインしてください。');return;}
      if(err.status===409){setStatus('別の端末から更新されています。画面を再読み込みしてから編集してください。');return;}
      state.online=false;
      writeStorage(localStorage,DRAFT_KEY,draft);
      renderPublic(p);
      draw();
      setStatus('サーバーに保存できませんでした。この端末の下書きのみ保存しました。');
    }finally{state.busy=false;$('profileSave').disabled=false;}
  }
  function exportJson(){
    const blob=new Blob([JSON.stringify({profile:state.data},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=el('a');a.href=url;a.download='yplus-profile.json';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
    setStatus('プロフィールJSONを書き出しました。');
  }

  function showWorkspace(token){
    state.token=token;writeStorage(sessionStorage,TOKEN_KEY,token);
    $('profileLoginForm').hidden=true;$('profileEditorWorkspace').hidden=false;
    state.data=clone(state.published||state.base||normalize({}));
    const draft=readStorage(localStorage,DRAFT_KEY);
    if(draft){
      try{const p=JSON.parse(draft);if(p.profile)state.data=normalize(p.profile);}catch{}
    }
    draw();setStatus(draft?'前回の端末内下書きを読み込みました。':'');
  }
  async function openEditor(){
    const dialog=$('profileEditorDialog');
    if(!dialog.open)dialog.showModal();
    $('profileEditorWorkspace').hidden=true;$('profileLoginForm').hidden=false;setStatus('');
    const saved=readStorage(sessionStorage,TOKEN_KEY);
    if(saved){
      try{
        await request('/admin/state',{token:saved});
        if(dialog.open){showWorkspace(saved);return;}
      }catch{clearStorage(sessionStorage,TOKEN_KEY);}
    }
    $('profilePin').focus();
  }
  async function signIn(event){
    event.preventDefault();if(state.busy)return;
    const pin=$('profilePin').value.replace(/\D/g,'').slice(0,20);
    $('profilePin').value='';
    if(!pin){setStatus('暗証番号を入力してください。');return;}
    state.busy=true;setStatus('認証中…');
    let device=readStorage(localStorage,'yplus.device.v1');
    if(!/^[a-f0-9]{24,64}$/i.test(device)){device=randomId().replaceAll('-','');writeStorage(localStorage,'yplus.device.v1',device);}
    try{
      const login=await request('/login',{method:'POST',payload:{device,pin}});
      await request('/admin/state',{token:login.token});
      await refreshPublished();
      showWorkspace(login.token);
    }catch(err){setStatus(err.name==='AbortError'?'認証サーバーに接続できません。':(err.message||'認証できませんでした。'));}
    finally{state.busy=false;}
  }
  function closeEditor(){
    $('profileEditorDialog').close();
    $('profilePin').value='';state.token='';state.tap=0;setStatus('');
  }
  function setup(){
    const profileTap = () => {
      const now=Date.now();
      if(now-state.lastTap>6000)state.tap=0;
      state.lastTap=now;
      if(++state.tap>=10){state.tap=0;openEditor();}
    };
    $('profileTap').addEventListener('click',profileTap);
    $('profileTitle').setAttribute('role','button');
    $('profileTitle').setAttribute('tabindex','0');
    $('profileTitle').setAttribute('aria-label','プロフィール');
    $('profileTitle').addEventListener('click',profileTap);
    $('profileTitle').addEventListener('keydown',e=>{
      if(e.key==='Enter'||e.key===' '){e.preventDefault();profileTap();}
    });
    $('profileEditorClose').addEventListener('click',closeEditor);
    $('profileEditorDialog').addEventListener('close',()=>{state.tap=0;state.token='';});
    $('profileLoginForm').addEventListener('submit',signIn);
    $('addWeeklyBlock').addEventListener('click',()=>addBlock('weekly'));
    $('addBasicBlock').addEventListener('click',()=>addBlock('basic'));
    $('editProfileName').addEventListener('input',e=>{state.data.displayName=text(e.target.value,70);preview();});
    $('editProfileStatement').addEventListener('input',e=>{state.data.statement=text(e.target.value,160);preview();});
    $('editProfileDescription').addEventListener('input',e=>{state.data.description=text(e.target.value,1000);preview();});
    $('profileSave').addEventListener('click',doSave);
    $('profileExport').addEventListener('click',exportJson);
    document.addEventListener('yplus:profile-base',onBaseLoaded);
    fetch('./site.config.json',{cache:'no-store'}).then(r=>r.json()).then(r=>{if(!state.base)onBaseLoaded({detail:r.profile});}).catch(()=>{if(!state.base)onBaseLoaded({detail:{}});});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup);
  else setup();
})();
