/* Restore backups locally; uploaded content is never sent to a server. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const dialog=$('anagramImportDialog'),fileInput=$('anagramImportFile'),apply=$('anagramImportApply');
  let pending=null,request=0;
  function status(message,error=false){$('anagramImportStatus').textContent=message;$('anagramImportStatus').dataset.error=String(error);}
  function close(){dialog.close();}
  $('anagramUploadBtn').addEventListener('click',()=>{if(!anagramRolling)fileInput.click();});
  $('anagramImportClose').addEventListener('click',close);
  $('anagramImportCancel').addEventListener('click',close);
  dialog.addEventListener('close',()=>{request++;pending=null;fileInput.value='';apply.disabled=true;$('anagramImportSummary').replaceChildren();status('');});
  fileInput.addEventListener('change',async()=>{
    const file=fileInput.files[0];if(!file)return;
    if(anagramRolling){fileInput.value='';return;}
    const token=++request;pending=null;apply.disabled=true;$('anagramImportSummary').replaceChildren();
    $('anagramImportFilename').textContent=file.name;status('データを確認しています…');dialog.showModal();
    try{
      if(!file.size||file.size>AnagramBackup.MAX_BYTES)throw new Error('2MB以下のJSONバックアップを選んでください。');
      const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
      if(token!==request||!dialog.open)return;
      const data=AnagramBackup.parse(text);
      pending=data;
      const rows=[['ダイス',data.settings.diceCharacters.length+'個'],['現在の名前',data.settings.currentPlayerName||'未設定'],['名前一覧',data.players.length+'人'],['抽選履歴',data.history.length+'件'],['大当たり',data.jackpots.length+'件'],['連ガチャ',data.settings.batchCount+'回 / '+(data.settings.batchMode==='animated'?'演出あり':'演出なし')],['被り設定',data.settings.maintenance.duplicates==='none'?'被りなし':'被りあり'],['天井',data.settings.maintenance.pity?data.settings.maintenance.pityCount+'回 / '+data.settings.maintenance.pityTarget:'なし']];
      for(const [label,value] of rows){const row=document.createElement('div');const title=document.createElement('dt');title.textContent=label;const detail=document.createElement('dd');detail.textContent=value;row.append(title,detail);$('anagramImportSummary').append(row);}
      status('内容を確認して「このデータを取り込む」を押してください。');apply.disabled=false;
    }catch(error){if(token===request&&dialog.open)status(error instanceof TypeError?'UTF-8のJSONバックアップを選んでください。':error.message,true);}
  });
  $('anagramImportBackup').addEventListener('click',()=>{
    try{downloadAnagramBackup(Array.from(anagramInputs.querySelectorAll('input'),input=>input.value.trim()),anagramPlayerName.value.trim(),Number(anagramBatchCountInput.value));status('現在のデータのダウンロードを開始しました。');}
    catch{status('ダウンロードを開始できませんでした。',true);}
  });
  apply.addEventListener('click',()=>{
    if(!pending||anagramRolling)return;
    const data=pending,s=data.settings;apply.disabled=true;
    const entries=[
      [anagramDiceKey,JSON.stringify(s.diceCharacters)],[anagramCurrentPlayerKey,s.currentPlayerName],
      [anagramBatchCountKey,String(s.batchCount)],[anagramBatchModeKey,s.batchMode],
      [anagramPlayersKey,JSON.stringify(data.players)],[anagramHistoryKey,JSON.stringify(data.history)],
      [anagramJackpotsKey,JSON.stringify(data.jackpots)],[anagramMaintKey,JSON.stringify(s.maintenance)]
    ];
    try{AnagramBackup.saveAtomically(localStorage,entries);}
    catch(error){status(error.message,true);apply.disabled=false;return;}
    clearAnagramResult();anagramEditingItem=null;
    anagramPlayers=data.players;anagramHistory=data.history;anagramJackpots=data.jackpots;anagramMaint=s.maintenance;
    anagramInputs.replaceChildren();s.diceCharacters.forEach(char=>addAnagramField(false,char,false));updateAnagramStatus();
    anagramPlayerName.value=s.currentPlayerName;renderAnagramPlayers();anagramPlayerSelect.value=data.players.includes(s.currentPlayerName)?s.currentPlayerName:'';
    anagramBatchCountInput.value=String(s.batchCount);anagramBatchMode=s.batchMode;updateAnagramBatchLabel();updateAnagramBatchModeButtons();
    resetAnagramJackpotForm();renderAnagramJackpots();renderAnagramHistory();anagramDiceDirty=false;
    anagramError.hidden=true;anagramSaveFeedback.dataset.state='saved';anagramSaveFeedback.textContent='データを取り込み、ブラウザに保存しました。履歴 '+data.history.length+'件を復元しました。';
    dialog.close();
  });
})();
