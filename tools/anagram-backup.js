/* Parser and transactional storage for the existing version-1 JSON backup. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.AnagramBackup=factory();
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const MAX_BYTES=2*1024*1024;
  const segmenter=new Intl.Segmenter('ja',{granularity:'grapheme'});
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const fail=message=>{throw new Error(message);};
  function string(value,label,max,empty=true){
    if(typeof value!=='string'||value.length>max||(!empty&&!value.trim()))fail(label+'を確認してください。');
    return value;
  }
  function integer(value,label,min,max){
    if(!Number.isSafeInteger(value)||value<min||value>max)fail(label+'は'+min+'〜'+max+'の整数にしてください。');
    return value;
  }
  function choice(value,values,label){if(!values.includes(value))fail(label+'を確認してください。');return value;}
  function list(value,label,max){if(!Array.isArray(value)||value.length>max)fail(label+'の形式または件数を確認してください（最大'+max+'件）。');return value;}
  function character(value,label,empty=true){
    const result=string(value,label,64).trim().normalize('NFC');
    if((result||!empty)&&Array.from(segmenter.segment(result)).length!==1)fail(label+'には1文字だけ指定してください。');
    return result;
  }
  function parse(text){
    if(typeof text!=='string'||new TextEncoder().encode(text).length>MAX_BYTES)fail('ファイルは2MB以下のJSONを選んでください。');
    let source;
    try{source=JSON.parse(text.replace(/^\uFEFF/,''));}catch{fail('JSONファイルを読み取れません。「全設定保存」で出力したファイルを選んでください。');}
    if(!object(source)||source.format!=='ypp-anagram-gacha-backup'||source.version!==1||!object(source.settings))fail('対応していないデータ形式です。アナグラムガチャのバージョン1のバックアップを選んでください。');
    const settings=source.settings;
    const diceCharacters=list(settings.diceCharacters,'ダイス',200).map((c,i)=>character(c,'ダイス'+(i+1)));
    const currentPlayerName=string(settings.currentPlayerName??'','名前',500).trim();
    const batchCount=integer(settings.batchCount??10,'連ガチャ回数',1,1000);
    const batchMode=choice(settings.batchMode??'instant',['instant','animated'],'演出設定');
    const maintenance={duplicates:'allow',dupScope:'player',pity:false,pityCount:100,pityScope:'player',pityTarget:''};
    if(settings.maintenance!==undefined){
      const rule=settings.maintenance;
      if(!object(rule))fail('メンテナンス設定を確認してください。');
      maintenance.duplicates=choice(rule.duplicates??'allow',['allow','none'],'被り設定');
      maintenance.dupScope=choice(rule.dupScope??'player',['player','all'],'被りの判定範囲');
      if(rule.pity!==undefined&&typeof rule.pity!=='boolean')fail('天井設定を確認してください。');
      maintenance.pity=rule.pity??false;
      maintenance.pityCount=integer(rule.pityCount??100,'天井回数',1,100000);
      maintenance.pityScope=choice(rule.pityScope??'player',['player','all'],'天井の判定範囲');
      maintenance.pityTarget=string(rule.pityTarget??'','天井文字列',100).trim().normalize('NFC');
    }
    if(maintenance.pity){
      const active=diceCharacters.filter(Boolean);
      const target=Array.from(segmenter.segment(maintenance.pityTarget),part=>part.segment);
      if(!active.length||target.length!==active.length||target.some(c=>!active.includes(c)))fail('天井文字列とダイスの文字・文字数が一致していません。');
    }
    const jackpotWords=new Set();
    const jackpots=list(source.jackpots??[],'大当たり',300).map(item=>{
      if(!object(item))fail('大当たりのデータを確認してください。');
      const word=string(item.word,'大当たり文字列',100,false).trim().normalize('NFC');
      if(jackpotWords.has(word))fail('大当たり文字列が重複しています。');
      jackpotWords.add(word);
      return {word,tier:choice(item.tier,['gold','silver','bronze'],'大当たりの枠')};
    });
    const history=list(source.history??[],'抽選履歴',10000).map((item,index)=>{
      const label='履歴'+(index+1);
      if(!object(item))fail(label+'の形式を確認してください。');
      const word=string(item.word,label+'の結果',12800,false);
      if(Array.from(segmenter.segment(word)).length>200)fail(label+'の結果は200文字までです。');
      const sourceText=string(item.source,label+'のダイス',13000);
      const time=string(item.time,label+'の日時',64,false);
      if(!Number.isFinite(Date.parse(time)))fail(label+'の日時を確認してください。');
      const record={name:string(item.name??'',label+'の名前',500),word,source:sourceText,time};
      if(item.diceSetKey!==undefined){
        if(typeof item.diceSetKey!=='string')fail(label+'のダイス構成を確認してください。');
        let dice;
        try{dice=JSON.parse(item.diceSetKey);}catch{fail(label+'のダイス構成を確認してください。');}
        const chars=list(dice,label+'のダイス構成',200).map(c=>character(c,label+'のダイス文字',false));
        record.diceSetKey=JSON.stringify(chars.sort());
      }
      if(item.pityForced!==undefined){if(typeof item.pityForced!=='boolean')fail(label+'の天井結果を確認してください。');record.pityForced=item.pityForced;}
      return record;
    });
    const players=[...new Set(list(source.players??[],'名前一覧',5000).map(name=>string(name,'名前一覧',500,false).trim()))];
    for(const name of [currentPlayerName,...history.map(item=>item.name.trim())])if(name&&!players.includes(name))players.push(name);
    if(players.length>5000)fail('名前一覧は5000件までです。');
    return {settings:{diceCharacters,currentPlayerName,batchCount,batchMode,maintenance},players,jackpots,history};
  }
  function saveAtomically(storage,entries){
    const previous=entries.map(([key])=>[key,storage.getItem(key)]);
    try{for(const [key,value] of entries)storage.setItem(key,value);}
    catch(error){
      let restored=true;
      // Remove only our own keys first, freeing capacity for the original snapshot.
      for(const [key] of previous){try{storage.removeItem(key);}catch{restored=false;}}
      for(const [key,value] of previous){if(value!==null)try{storage.setItem(key,value);}catch{restored=false;}}
      fail(restored?'ブラウザに保存できなかったため、取り込みを中止しました。元の保存データは維持しています。':'保存に失敗し、元データの復旧も完了できませんでした。画面を閉じず、現在のデータをダウンロードしてください。');
    }
  }
  return Object.freeze({parse,saveAtomically,MAX_BYTES});
});
