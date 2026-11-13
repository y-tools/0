/* Y++STADIO quiz — no passwords or session tokens stored in the browser. */
(() => {
  'use strict';
  if (location.hostname === 'y-tools.github.io') {
    location.replace('https://153-127-64-17.sslip.io/quiz/' + location.search);
    return;
  }
  const $ = id => document.getElementById(id);
  const view = ['host', 'player'].includes(new URLSearchParams(location.search).get('view')) ? new URLSearchParams(location.search).get('view') : 'listener';
  const phases = {lobby: '待機中', question: 'スタート待ち', answering: '回答受付中', timeup: '回答受付終了', answer: '正解発表'};
  let state = null, offset = 0, polling = false, accountKey = '', questionKey = '', mediaKey = '', delegateKey = '', round = null, boardKey = '', busy = 0, draftImages = [];
  document.querySelector(`[data-view="${view}"]`).setAttribute('aria-current', 'page');
  function node(tag, className, content) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (content !== undefined) e.textContent = content;
    return e;
  }
  function message(value, error = false) { $('notice').textContent = value; $('notice').classList.toggle('error', error); }
  async function api(path, data) {
    const response = await fetch('/quiz/api/' + path, {method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: data === undefined ? {} : {'Content-Type': 'application/json'}, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(20000)});
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || '接続できませんでした。'); error.status = response.status; throw error; }
    return result;
  }
  async function work(task, success) {
    if (busy) return;
    busy++;
    document.body.setAttribute('aria-busy', 'true');
    try { await task(); if (success) message(success); await refresh(); }
    catch (error) { message(error.message || '接続できませんでした。', true); if (error.status === 401) await refresh(); }
    finally { busy--; document.body.removeAttribute('aria-busy'); }
  }
  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      let next;
      if (view === 'host') {
        try { next = await api('host'); }
        catch (error) { if (![401, 403].includes(error.status)) throw error; next = await api('state'); }
      } else next = await api('state');
      offset = next.serverTimeMs - Date.now();
      state = next;
      $('connection').textContent = '● 接続中'; $('connection').classList.remove('offline');
      render();
    } catch (error) {
      $('connection').textContent = '再接続中'; $('connection').classList.add('offline');
      $('answer-submit').disabled = true;
      ['start', 'reveal', 'show-question', 'lobby'].forEach(id => $(id).disabled = true);
    } finally { polling = false; }
  }
  function remaining() { return state?.game.deadlineMs ? Math.max(0, (state.game.deadlineMs - Date.now() - offset) / 1000) : 0; }
  function tick() {
    if (!state) return;
    const active = state.game.phase === 'answering';
    const seconds = Math.ceil(remaining());
    $('countdown').textContent = active ? String(seconds).padStart(2, '0') : '';
    $('countdown').classList.toggle('urgent', active && seconds <= 5);
    if (view === 'player') $('answer-submit').disabled = !active || seconds <= 0 || !state.me || state.me.role !== 'player' || $('connection').classList.contains('offline');
    if (active && seconds <= 0 && state.game.screen !== 'timeup') {
      // Close the answering UI at the deadline, without waiting for the next poll.
      renderStage('timeup');
      $('board-phase').textContent = phases.timeup;
    }
  }
  function avatar(player) {
    if (player.avatar) { const img = node('img', 'avatar'); img.src = player.avatar; img.alt = ''; return img; }
    return node('div', 'avatar', player.id ? player.id.slice(0, 1) : String(player.slot));
  }
  function renderStage(forcedScreen) {
    const screen = forcedScreen || state.game.screen;
    const q = state.question;
    const key = JSON.stringify([screen, q, state.game.image]);
    if (key === boardKey) return;
    boardKey = key;
    const stage = $('stage'); stage.replaceChildren(); stage.className = 'stage';
    if (screen === 'image' && state.game.image) {
      stage.classList.add('image-stage'); const img = node('img'); img.src = state.game.image; img.alt = q?.prompt || 'ゲームマスターが選択した画像'; stage.append(img);
    } else if (screen === 'timeup') {
      stage.classList.add('timeup'); stage.append(node('p', 'stage-kicker', 'PENS DOWN'), node('h2', '', 'TIME UP'), node('p', 'sub', '回答を締め切りました。正解発表をお待ちください。'));
    } else if (screen === 'answer' && q?.correctAnswer !== undefined) {
      stage.classList.add('answer-stage'); stage.append(node('h2', '', '正解'), node('p', 'prompt', q.correctAnswer));
    } else if (screen === 'question' && q) {
      stage.append(node('p', 'stage-kicker', q.label), node('p', 'prompt', q.prompt || '問題画像を確認してください。'));
    } else {
      stage.append(node('p', 'stage-kicker', 'READY TO PLAY?'), node('h2', '', 'みんなで漢字'), node('p', 'sub', 'ゲームマスターの出題をお待ちください。'));
    }
  }
  function render() {
    const {game, me} = state;
    const isHost = !!state.questions;
    const revealed = game.screen === 'answer' && game.phase === 'answer';
    $('board-label').textContent = state.question?.label || 'みんなで漢字';
    $('board-phase').textContent = phases[game.phase];
    $('board').classList.toggle('revealed', revealed);
    renderStage();
    $('players').replaceChildren(...state.players.map(p => {
      const tile = node('div', 'player-tile' + (p.submitted ? ' submitted' : '') + (revealed ? (p.correct === true ? ' correct' : ' incorrect') : ''));
      const detail = node('div');
      const answer = node('p', 'player-answer', revealed ? (p.answer || (p.id ? '未回答' : '参加待ち')) : (p.submitted ? '回答済み ✓' : p.id ? '考え中' : '参加待ち'));
      if (revealed) {
        const length = Array.from(p.answer || '').length;
        answer.classList.add(length > 80 ? 'answer-long' : length > 24 ? 'answer-medium' : length > 8 ? 'answer-short' : 'answer-large');
      }
      detail.append(node('p', 'player-id', p.id || `PLAYER ${p.slot}`), answer);
      if (revealed) detail.append(node('span', 'verdict', !p.id ? '参加待ち' : !p.answer ? '未回答' : p.correct === true ? '○ 正解' : '× 不正解'));
      tile.append(avatar(p), detail); return tile;
    }));
    const needsLogin = view !== 'listener' && !(view === 'host' ? isHost : me?.role === 'player');
    $('login-panel').hidden = !needsLogin;
    $('player-panel').hidden = view !== 'player' || me?.role !== 'player';
    $('host-panel').hidden = view !== 'host' || !isHost;
    $('login-heading').textContent = view === 'host' ? 'ゲームマスターログイン' : '回答者ログイン';
    $('login-help').textContent = me && needsLogin ? `現在は ${me.id} でログイン中です。対応するIDでログインし直してください。` : view === 'host' ? 'オーナー、または委任されたIDでログインしてください。' : 'ゲームマスターから受け取ったIDとパスワードを入力してください。';
    if (view === 'player' && me?.role === 'player') {
      $('player-name').textContent = me.id + ' さんの回答';
      if (round !== game.roundId) { round = game.roundId; $('answer-input').value = ''; }
      const own = state.players.find(p => p.slot === me.slot);
      $('answer-guide').textContent = game.phase === 'answering' ? '回答を受付中です。残り時間内に送信してください。' : game.phase === 'question' ? 'ゲームマスターのスタートをお待ちください。' : game.phase === 'lobby' ? '次の出題をお待ちください。' : '回答の受付は終了しました。';
      $('last-answer').textContent = own?.answer ? '送信済み：' + own.answer : '';
      $('answer-input').disabled = game.phase !== 'answering';
    }
    if (isHost && view === 'host') renderHost();
    tick();
  }
  function button(label, fn, secondary = false) { const b = node('button', secondary ? 'secondary' : '', label); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function action(actionName, extra = {}) {
    return work(async () => { await api('admin/action', {action: actionName, expectedRevision: state.game.revision, ...extra}); }, '画面を更新しました。');
  }
  function renderHost() {
    const {game, me} = state;
    $('host-name').textContent = '進行コントロール / ' + me.id;
    $('host-phase').textContent = phases[game.phase];
    const current = state.questions.find(q => q.id === game.questionId);
    $('current-question').textContent = current ? '出題中：' + current.label : '問題一覧から「出題」を押してください。';
    if ($('timer-seconds').dataset.question !== game.roundId) { $('timer-seconds').value = game.duration; $('timer-seconds').dataset.question = game.roundId; }
    $('start').disabled = game.phase !== 'question';
    $('reveal').disabled = !['timeup', 'answer'].includes(game.phase);
    $('show-question').disabled = !current || game.phase === 'lobby';
    $('lobby').disabled = game.phase === 'lobby' && game.screen === 'lobby';
    $('host-answers').replaceChildren(...state.players.map(p => { const card = node('div', 'host-answer'); card.append(node('h3', '', p.id || `PLAYER ${p.slot}`), node('p', '', p.answer || '未回答')); return card; }));
    const qkey = JSON.stringify([state.questions, game.questionId, game.phase]);
    if (qkey !== questionKey) {
      questionKey = qkey;
      $('question-list').replaceChildren(...state.questions.map(q => {
        const row = node('div', 'question-row' + (q.id === game.questionId ? ' current' : ''));
        const info = node('div', 'question-info'); info.append(node('strong', '', q.label), node('small', '', `${q.duration}秒 / 画像${q.imageIds.length}枚`));
        row.append(info, button('編集', () => editQuestion(q), true), button('出題', () => {
          if (game.phase === 'answering' && !confirm('回答受付中です。現在の回答を締め切って次の出題に進みますか？')) return;
          action('present', {questionId: q.id});
        })); return row;
      }));
      if (!state.questions.length) $('question-list').append(node('p', 'muted', 'まずは右のフォームから問題を作ってください。'));
    }
    const mkey = JSON.stringify(state.media);
    if (mkey !== mediaKey) {
      draftImages = [...$('question-images').querySelectorAll('input:checked')].map(e => e.value).concat(draftImages);
      mediaKey = mkey;
      $('media-list').replaceChildren(...state.media.map(m => {
        const b = button('', () => action('show_image', {mediaId: m.id})); b.className = 'media-card'; const img = node('img'); img.src = m.url; img.alt = ''; b.append(img, node('span', '', m.label)); b.setAttribute('aria-label', m.label + ' を全員に表示'); return b;
      }));
      $('question-images').replaceChildren(...state.media.map(m => { const label = node('label'); const input = node('input'); input.type = 'checkbox'; input.value = m.id; input.checked = draftImages.includes(m.id); const img = node('img'); img.src = m.url; img.alt = ''; label.append(input, img, node('span', '', m.label)); return label; }));
      if (!state.media.length) { $('media-list').append(node('p', 'muted', '画像を追加すると、ここに並びます。')); $('question-images').append(node('p', 'muted', '「画面用の画像」から先に追加してください。')); }
      draftImages = [];
    }
    // Rebuild account forms only after our own save, never while another field is being edited.
    if (!accountKey) buildAccounts();
    $('delegation-panel').hidden = me.role !== 'owner';
    const dkey = JSON.stringify(state.delegates || []);
    if (dkey !== delegateKey) {
      delegateKey = dkey;
      $('delegate-list').replaceChildren(...(state.delegates || []).map(d => { const row = node('div', 'delegate-row'); row.append(node('span', '', d.id + ' / ' + new Date(d.expiresMs).toLocaleString('ja-JP') + ' まで'), button('委任を解除', () => work(async () => { if (confirm(d.id + ' の委任を解除しますか？')) await api('admin/delegate', {action: 'revoke', id: d.id}); }, '委任を更新しました。'), true)); return row; }));
    }
  }
  function editQuestion(q = null) {
    $('question-form').reset(); $('question-id').value = q?.id || ''; $('question-label').value = q?.label || ''; $('question-prompt').value = q?.prompt || ''; $('question-correct').value = q?.correctAnswer || ''; $('question-duration').value = q?.duration || 30;
    $('question-images').querySelectorAll('input').forEach(input => input.checked = !!q?.imageIds.includes(input.value));
    $('question-heading').textContent = q ? '問題を編集' : '問題を作る';
    $('question-heading').scrollIntoView({behavior: 'smooth', block: 'center'});
  }
  function password() { return Array.from(crypto.getRandomValues(new Uint8Array(12)), x => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'[x % 55]).join(''); }
  async function upload(file, kind) {
    if (file.size > 6_000_000) throw new Error(file.name + ' は6MB未満にしてください。');
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('画像を読み込めませんでした。')); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file); });
    return api('admin/upload', {kind, label: file.name.slice(0, 100), data});
  }
  function buildAccounts() {
    accountKey = 'built';
    $('account-list').replaceChildren(...[1, 2, 3, 4].map(slot => {
      const account = state.accounts.find(a => a.slot === slot);
      const form = node('form', 'account-form'); form.dataset.slot = slot;
      const top = node('div', 'account-top'); const av = account?.avatar ? node('img') : node('div', 'avatar-placeholder', String(slot)); if (account?.avatar) { av.src = account.avatar; av.alt = ''; } top.append(av, node('h3', '', `PLAYER ${slot}`));
      const idLabel = node('label', '', 'ID'); const id = node('input'); id.value = account?.id || ''; id.required = true; id.maxLength = 40; id.autocomplete = 'off'; id.name = 'player-id'; idLabel.append(id);
      const pwLabel = node('label', '', 'パスワード'); const pwRow = node('div', 'password-row'); const pw = node('input'); pw.placeholder = account ? '空欄で現在の設定を保持' : '空欄で自動生成'; pw.minLength = 6; pw.maxLength = 128; pw.autocomplete = 'new-password'; pw.name = 'player-password'; pwRow.append(pw, button('自動生成', () => { pw.value = password(); }, true)); pwLabel.append(pwRow);
      const fileLabel = node('label', '', 'アイコン（中央を正方形に切り抜き）'); const file = node('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp'; fileLabel.append(file);
      const enabledLabel = node('label', 'checkbox-label'); const enabled = node('input'); enabled.type = 'checkbox'; enabled.checked = account?.enabled ?? true; enabledLabel.append(enabled, document.createTextNode('参加を有効にする'));
      const submit = node('button', '', '参加者を保存'); submit.type = 'submit'; const result = node('output', 'credential-result');
      form.append(top, idLabel, pwLabel, fileLabel, enabledLabel, submit, result);
      form.addEventListener('submit', event => { event.preventDefault(); work(async () => {
        const media = file.files[0] ? await upload(file.files[0], 'avatar') : null;
        const data = {slot, id: id.value.trim(), password: pw.value, enabled: enabled.checked};
        if (media) data.avatarId = media.id;
        const saved = await api('admin/player', data);
        const created = saved.generatedPassword || pw.value;
        result.textContent = created ? `ID：${data.id}\nパスワード：${created}\n参加者への共有用です。控えてから画面を閉じてください。` : '設定を保存しました。';
        pw.value = ''; file.value = '';
        if (media) { const image = node('img'); image.src = media.url; image.alt = ''; top.firstChild.replaceWith(image); }
      }, '参加者を保存しました。'); });
      return form;
    }));
  }
  $('login-form').addEventListener('submit', event => { event.preventDefault(); work(async () => { const result = await api('login', {id: $('login-id').value, password: $('login-password').value}); $('login-password').value = ''; accountKey = ''; if ((view === 'host' && result.role === 'player') || (view === 'player' && result.role !== 'player')) throw new Error('この画面に対応するIDでログインしてください。'); }, 'ログインしました。'); });
  document.querySelectorAll('.logout').forEach(b => b.addEventListener('click', () => work(async () => { await api('logout', {}); accountKey = ''; $('account-list').replaceChildren(); $('delegate-result').textContent = ''; $('question-form').reset(); }, 'ログアウトしました。')));
  $('answer-form').addEventListener('submit', event => { event.preventDefault(); const roundId = state?.game.roundId; work(async () => { if (remaining() <= 0) throw new Error('回答受付は終了しました。'); await api('answer', {roundId, answer: $('answer-input').value}); }, '回答を送信しました。受付中は再送信できます。'); });
  $('start').addEventListener('click', () => action('start', {duration: Number($('timer-seconds').value)}));
  $('reveal').addEventListener('click', () => action('reveal'));
  $('show-question').addEventListener('click', () => action('show_question'));
  $('lobby').addEventListener('click', () => { if (state.game.phase !== 'answering' || confirm('回答受付を終了して待機画面に戻しますか？')) action('lobby'); });
  $('new-question').addEventListener('click', () => editQuestion());
  $('question-form').addEventListener('submit', event => { event.preventDefault(); work(async () => { const result = await api('admin/question', {id: $('question-id').value || undefined, label: $('question-label').value, prompt: $('question-prompt').value, correctAnswer: $('question-correct').value, duration: Number($('question-duration').value), imageIds: [...$('question-images').querySelectorAll('input:checked')].map(input => input.value)}); $('question-id').value = result.id; $('question-heading').textContent = '問題を編集'; }, '問題を保存しました。'); });
  $('screen-upload').addEventListener('change', () => { const files = [...$('screen-upload').files]; work(async () => { let completed = 0; try { for (const file of files) { await upload(file, 'screen'); completed++; } } catch (error) { error.message = `${completed}枚を保存しました。` + error.message; throw error; } finally { $('screen-upload').value = ''; } }, files.length + '枚の画像を追加しました。'); });
  $('delegate-form').addEventListener('submit', event => { event.preventDefault(); work(async () => { const result = await api('admin/delegate', {id: $('delegate-id').value, password: $('delegate-password').value, hours: Number($('delegate-hours').value)}); $('delegate-result').textContent = `ID：${result.id}\nパスワード：${result.password}\n期限：${new Date(result.expiresMs).toLocaleString('ja-JP')}\n委任先への共有用です。控えてから画面を閉じてください。`; $('delegate-password').value = ''; }, '委任IDを発行しました。'); });
  $('fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else if ($('board').requestFullscreen) await $('board').requestFullscreen(); else message('この端末では、横向き表示でゲーム画面を大きくできます。'); } catch { message('横向き表示でもゲーム画面を大きくできます。'); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  refresh(); setInterval(refresh, 1000); setInterval(tick, 200);
})();
