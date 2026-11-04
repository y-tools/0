'use strict';
(() => {
  const modes = {
    timer: {label:'タイマー', view:null},
    order: {label:'順序整理', view:null},
    dice: {label:'ダイス', trigger:'diceOpenBtn', view:'diceView'},
    anagram: {label:'任意文字アナグラムガチャ', trigger:'anagramOpenBtn', view:'anagramView'},
    chinchiro: {label:'チンチロ', trigger:'chinchiroOpenBtn', view:'chinchiroView'},
    stream: {label:'配信歴起算', trigger:'streamCalcOpenBtn', view:'streamCalcView'}
  };
  const mode = new URLSearchParams(location.search).get('tool');
  const current = modes[mode] ? mode : 'timer';
  document.body.classList.add('portal-tool','portal-' + current);
  document.title = modes[current].label + ' | Y++';
  const $ = id => document.getElementById(id);
  const home = () => { location.assign('../#tools'); };
  const header = document.createElement('div');
  header.className = 'portal-tools-header';
  const back = document.createElement('a');
  back.className='portal-back';
  back.href='../#tools';
  back.textContent='← Y++';
  const title = document.createElement('strong');
  title.textContent=modes[current].label;
  const caption = document.createElement('span');
  caption.className='portal-tools-count';
  caption.textContent=String(['timer','order','dice','anagram','chinchiro','stream'].indexOf(current)+3).padStart(2,'0')+' / 08';
  header.append(back,title,caption);
  document.body.prepend(header);

  if(current==='order'){
    $('orderModeBtn')?.click();
    const panel=$('orderPanel');
    panel?.classList.add('active');
    const instructions=document.createElement('p');
    instructions.className='portal-description';
    instructions.textContent='参加順を整理して、配信用コメントを作成できます。';
    panel?.before(instructions);
  } else if(current==='timer'){
    const timer=$('.unused');
    const section=document.querySelector('.timer-section');
    if(section){
      const chooser=document.createElement('div');
      chooser.className='portal-timer-modes';
      const regular=document.createElement('button');
      regular.type='button';regular.className='portal-mode-selected';regular.textContent='通常タイマー';
      const countdown=document.createElement('button');
      countdown.type='button';countdown.textContent='カウントダウン表示';
      chooser.append(regular,countdown);
      section.prepend(chooser);
      regular.addEventListener('click',()=>{
        $('quizTimerView')?.classList.remove('open');
        document.body.classList.remove('portal-quiz-active');
        regular.classList.add('portal-mode-selected');
        countdown.classList.remove('portal-mode-selected');
      });
      countdown.addEventListener('click',()=>{
        $('quizTimerOpenBtn')?.click();
        document.body.classList.add('portal-quiz-active');
        countdown.classList.add('portal-mode-selected');
        regular.classList.remove('portal-mode-selected');
      });
      $('quizBackBtn')?.addEventListener('click',()=>{
        document.body.classList.remove('portal-quiz-active');
        regular.classList.add('portal-mode-selected');
        countdown.classList.remove('portal-mode-selected');
      });
    }
  } else {
    const item=modes[current];
    $(item.trigger)?.click();
    // Return to the portal when leaving a standalone tool.
    const backBtn=$(item.view)?.querySelector('.tool-back-btn');
    backBtn?.addEventListener('click', home);
  }
  document.querySelectorAll('.tool-overlay').forEach(node => {
    if(node.id !== modes[current].view && !(current==='timer' && node.id==='quizTimerView')){
      node.setAttribute('aria-hidden','true');
    }
  });
})();