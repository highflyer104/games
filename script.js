// 棋盤、電腦棋友及連線功能都在這裡；不需要安裝套件。
const $ = id => document.getElementById(id);
const size = 15;
const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
let board = [], moves = [], turn = 1, finished = false, winning = [];
let mode = 'ai', myColor = 1, thinking = false, aiTask = null;
let startedAt = 0, soundEnabled = true, audio = null, flat = false;
let socket = null, connected = false, subscribed = false, peer = '', role = '', roomTopic = '', gameId = '';
let joinTask = null, heartbeat = null, connectionTask = null, peerSeen = 0, pending = null;
let playerId = makeId();
const cells = [];
function makeId() { return Array.from(crypto.getRandomValues(new Uint32Array(3)), n => n.toString(36)).join(''); }
function note(text) { $('notice').textContent = text; }
function setConnection(text, kind = '') {
  $('mqtt-status').className = kind;
  $('mqtt-status').replaceChildren();
  const dot = document.createElement('i'); dot.className = 'status-dot';
  $('mqtt-status').append(dot, document.createTextNode(text));
}
function chat(text, author = '') {
  const block = document.createElement('div');
  block.className = author ? 'chat-bubble' + (author === '你' ? ' mine' : '') : 'chat-system';
  if (author) {
    const name = document.createElement('span'); name.className = 'chat-author'; name.textContent = author;
    const content = document.createElement('p'); content.textContent = text; block.append(name, content);
  } else block.textContent = text;
  $('messages').append(block);
  // 限制訊息數量，避免長時間聊天占用過多記憶體。
  while ($('messages').children.length > 80) $('messages').firstElementChild.remove();
  $('messages').scrollTop = $('messages').scrollHeight;
}
function createBoard() {
  const lines = document.createElement('div'); lines.className = 'grid-lines'; $('board').append(lines);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const cell = document.createElement('button'); cell.className = 'cell';
      cell.setAttribute('aria-label', `第${row + 1}列，第${col + 1}路，空位`);
      cell.onclick = () => humanMove(row, col);
      $('board').append(cell); cells.push(cell);
    }
  }
}
function draw() {
  cells.forEach((cell, index) => {
    const row = Math.floor(index / size), col = index % size, value = board[row][col];
    const last = moves[moves.length - 1];
    cell.className = 'cell' + ([3, 7, 11].includes(row) && [3, 7, 11].includes(col) ? ' star' : '');
    cell.replaceChildren();
    if (value) {
      cell.classList.add('occupied');
      const stone = document.createElement('span'); stone.className = 'stone ' + (value === 1 ? 'black' : 'white');
      // 只有最後一手使用落子動畫，其餘棋子不重播。
      if (!last || last.row !== row || last.col !== col) stone.style.animation = 'none';
      cell.append(stone);
      if (last && last.row === row && last.col === col) cell.classList.add('last');
      if (winning.some(p => p[0] === row && p[1] === col)) cell.classList.add('winning');
    }
    cell.setAttribute('aria-label', `第${row + 1}列，第${col + 1}路，${value ? value === 1 ? '黑子' : '白子' : '空位'}`);
    cell.disabled = !!value || finished || thinking || !!pending || (mode === 'online' && (!peer || !connected || turn !== myColor));
  });
  $('move-count').textContent = String(moves.length).replace(/\d/g, n => '０１２３４５６７８９'[n]);
  $('turn-dot').className = 'mini-stone ' + (turn === 1 ? 'black' : 'white');
  const message = finished ? (winning.length ? `${turn === 1 ? '黑' : '白'}子連成五子，${turn === myColor ? '你贏了' : '棋友獲勝'}！` : '滿盤和棋，再會一局。') : pending ? '等待悔棋或重開確認' : mode === 'online' && !peer ? '等待棋友入境…' : thinking ? `${$('opponent-name').textContent}，凝神思索…` : turn === myColor ? '輪到你了，請落子' : '棋友落子中，靜候片刻';
  $('turn-text').textContent = message;
  $('game-status').textContent = finished ? '對局結束' : pending ? '等待確認' : thinking ? '電腦思考中' : mode === 'online' && !peer ? '等待棋友' : moves.length ? '對弈進行中' : '等待落子';
  $('undo').disabled = !moves.length || !!pending || (mode === 'online' && (!peer || !connected));
  $('restart').disabled = !!pending || (mode === 'online' && (!peer || !connected));
  $('chat-input').disabled = $('chat-send').disabled = !(mode === 'online' && connected && peer);
}
function resetGame() {
  clearTimeout(aiTask); thinking = false; pending = null;
  board = Array.from({length: size}, () => Array(size).fill(0));
  moves = []; turn = 1; finished = false; winning = []; startedAt = 0;
  draw(); note('執黑先行，從一顆棋子開始。');
}
function inside(row, col) { return row >= 0 && row < size && col >= 0 && col < size; }
function checkWin(row, col, color) {
  for (const [dr, dc] of directions) {
    const line = [[row, col]];
    for (const sign of [-1, 1]) {
      let r = row + dr * sign, c = col + dc * sign;
      while (inside(r, c) && board[r][c] === color) { line.push([r, c]); r += dr * sign; c += dc * sign; }
    }
    if (line.length >= 5) return line;
  }
  return [];
}
function stoneSound() {
  if (!soundEnabled) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(780, audio.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(210, audio.currentTime + .065);
    gain.gain.setValueAtTime(.18, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .12);
    oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + .13);
  } catch { note('此瀏覽器無法播放落子音效，仍可正常對弈。'); }
}
function place(row, col) {
  if (!inside(row, col) || board[row][col] || finished) return false;
  if (!startedAt) startedAt = Date.now();
  board[row][col] = turn; moves.push({row, col, color: turn});
  winning = checkWin(row, col, turn); finished = winning.length > 0 || moves.length === size * size;
  if (!finished) turn = 3 - turn;
  stoneSound(); draw();
  if (finished) note(winning.length ? '勝負已定，山水常在。可重新開局再會棋友。' : '棋逢對手，滿盤和局。');
  return true;
}
function humanMove(row, col) {
  if (finished || thinking || pending || board[row][col] || turn !== myColor) return;
  if (mode === 'online') {
    if (!peer || !connected) return note('請先加入棋室，等候棋友。');
    if (!publish({type: 'move', row, col, count: moves.length, game: gameId})) return;
  }
  place(row, col);
  if (mode === 'ai' && !finished) {
    thinking = true; draw();
    aiTask = setTimeout(() => { const choice = chooseMove(); thinking = false; if (choice) place(choice.row, choice.col); }, 520);
  }
}
// 同時評估自己的連線與對方的威脅，優先完成五連或阻擋五連。
function pointScore(row, col, color) {
  let score = 0;
  board[row][col] = color;
  for (const [dr, dc] of directions) {
    let count = 1, open = 0;
    for (const sign of [-1, 1]) {
      let r = row + dr * sign, c = col + dc * sign;
      while (inside(r, c) && board[r][c] === color) { count++; r += dr * sign; c += dc * sign; }
      if (inside(r, c) && !board[r][c]) open++;
    }
    score += count >= 5 ? 1000000 : open === 0 ? 0 : [0, 4, 35, 500, 16000][count] * (open === 2 ? 5 : 1);
  }
  board[row][col] = 0; return score;
}
// 前三級逐步減少隨機落子；後兩級會預想對手回應，最高級再多想一手。
const computerLevels = {
  beginner: {random: 8, defense: .45, depth: 1, width: 8},
  easy: {random: 3, defense: .65, depth: 1, width: 6},
  normal: {random: 1, defense: .85, depth: 1, width: 6},
  hard: {random: 1, defense: 1, depth: 2, width: 6},
  master: {random: 1, defense: 1.05, depth: 3, width: 7}
};
function possibleMoves(color, defense = 1) {
  const choices = [];
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    if (board[row][col]) continue;
    let nearby = false;
    for (let dr = -2; dr <= 2 && !nearby; dr++) for (let dc = -2; dc <= 2; dc++) {
      if (inside(row + dr, col + dc) && board[row + dr][col + dc]) { nearby = true; break; }
    }
    if (!nearby) continue;
    const attack = pointScore(row, col, color), defend = pointScore(row, col, 3 - color);
    const score = attack >= 1000000 ? 1e9 + attack : defend >= 1000000 ? 1e8 + defend : attack + defend * defense + (14 - Math.abs(7-row) - Math.abs(7-col));
    choices.push({row, col, attack, defend, score});
  }
  choices.sort((a, b) => b.score - a.score);
  return choices;
}
function evaluateBoard() {
  const choices = possibleMoves(2);
  if (!choices.length) return 0;
  const white = choices.map(p => p.attack).sort((a, b) => b - a);
  const black = choices.map(p => p.defend).sort((a, b) => b - a);
  return white[0] + (white[1] || 0) * .25 - black[0] - (black[1] || 0) * .25;
}
function lookAhead(depth, color, width, alpha = -Infinity, beta = Infinity) {
  if (!depth) return evaluateBoard();
  const choices = possibleMoves(color).slice(0, width);
  if (!choices.length) return 0;
  let best = color === 2 ? -Infinity : Infinity;
  for (const p of choices) {
    // 暫放棋子只用來推演，算完立即還原，不影響真正的對局紀錄。
    board[p.row][p.col] = color;
    const value = checkWin(p.row, p.col, color).length ? (color === 2 ? 1 : -1) * (1e10 + depth) : lookAhead(depth - 1, 3 - color, width, alpha, beta);
    board[p.row][p.col] = 0;
    if (color === 2) { best = Math.max(best, value); alpha = Math.max(alpha, best); }
    else { best = Math.min(best, value); beta = Math.min(beta, best); }
    // 後續分支已不可能更好時，就停止計算，避免不必要的等待。
    if (beta <= alpha) break;
  }
  return best;
}
function chooseMove() {
  const level = computerLevels[$('opponent').value] || computerLevels.normal;
  const candidates = possibleMoves(2, level.defense);
  if (!candidates.length) return board[7][7] ? null : {row: 7, col: 7};
  if (candidates[0].score >= 1e8) return candidates[0];
  if (level.depth === 1) return candidates[Math.floor(Math.random() * Math.min(level.random, candidates.length))];
  let best = candidates[0], bestScore = -Infinity;
  for (const p of candidates.slice(0, level.width)) {
    board[p.row][p.col] = 2;
    const score = lookAhead(level.depth - 1, 1, level.width);
    board[p.row][p.col] = 0;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}
function updateComputer() {
  const [name, level] = $('opponent').selectedOptions[0].textContent.split(' · ');
  $('opponent-name').textContent = name;
  $('opponent-detail').textContent = level + ' · 執白後行';
}

function undo() {
  clearTimeout(aiTask);
  // 電腦已回應時退回一整輪；正在思考時只退回玩家剛下的一手。
  const amount = mode === 'ai' && moves.at(-1)?.color === 2 ? 2 : 1;
  thinking = false;
  for (let n = 0; n < amount && moves.length; n++) { const p = moves.pop(); board[p.row][p.col] = 0; }
  turn = moves.length ? 3 - moves.at(-1).color : 1; finished = false; winning = []; if (!moves.length) startedAt = 0;
  draw(); note('已收回落子，重新思量。');
}

// 使用瀏覽器原生安全連線傳送標準訊息封包，離線遊戲不依賴外部程式庫。
const encoder = new TextEncoder(), decoder = new TextDecoder();
function mqttString(text) { const bytes = encoder.encode(text); return [bytes.length >> 8, bytes.length & 255, ...bytes]; }
function packet(header, body) {
  const length = []; let value = body.length;
  do { let digit = value % 128; value = Math.floor(value / 128); if (value) digit |= 128; length.push(digit); } while (value);
  return new Uint8Array([header, ...length, ...body]);
}
function sendPacket(header, body) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try { socket.send(packet(header, body)); return true; } catch { return false; }
}
function publish(data) {
  if (!connected || !subscribed) return false;
  const message = {...data, from: playerId, to: data.to ?? peer, room: roomTopic};
  return sendPacket(0x30, [...mqttString(roomTopic), ...encoder.encode(JSON.stringify(message))]);
}
function clearPending() { pending = null; if ($('request-dialog').open) $('request-dialog').close(); }
function disconnect(show = true) {
  if (connected) { publish({type: 'leave'}); sendPacket(0xe0, []); }
  clearTimeout(joinTask); clearTimeout(connectionTask); clearInterval(heartbeat); clearPending();
  if (socket) { socket.onclose = null; socket.onerror = null; socket.close(); socket = null; }
  connected = subscribed = false; peer = ''; role = ''; gameId = '';
  $('leave').disabled = true; $('connect').disabled = false;
  $('chat-badge').textContent = '靜候棋友'; $('player-online').textContent = '未連線';
  setConnection('尚未連線', 'muted');
  if (mode === 'online') { $('opponent-name').textContent = '遠方棋友'; $('opponent-detail').textContent = '加入棋室，等待相逢'; }
  if (show) { note('已離開棋室。重新加入可開始新局。'); chat('已離開棋室。'); }
  draw();
}
function opponentLeft() {
  peer = ''; clearPending(); $('opponent-detail').textContent = '棋友已離開，等候新棋友';
  $('player-online').textContent = '等待中'; $('chat-badge').textContent = '等待棋友';
  role = 'host'; myColor = 1; updateSide(); draw(); chat('棋友已離開。新棋友加入時會重新開局。'); note('等待新棋友入境。');
}
function updateSide() {
  $('my-color').textContent = myColor === 1 ? '黑' : '白'; $('my-stone').className = 'mini-stone ' + (myColor === 1 ? 'black' : 'white');
}
function paired() {
  peerSeen = Date.now(); clearTimeout(joinTask); $('opponent-name').textContent = '遠方棋友';
  $('opponent-detail').textContent = `棋室「${$('room').value.trim()}」· 執${myColor === 1 ? '白' : '黑'}`;
  $('player-online').textContent = '已入境'; $('chat-badge').textContent = '棋友在線';
  updateSide(); resetGame(); chat(`棋友已入境，你執${myColor === 1 ? '黑先行' : '白後行'}。`);
  note(myColor === 1 ? '棋友已到，請執黑先行。' : '棋友已到，靜候黑子先行。');
}
function hostOffer(target) { publish({type: 'offer', to: target}); }
function handleMessage(msg) {
  if (!msg || msg.from === playerId || msg.room !== roomTopic || typeof msg.from !== 'string' || (msg.to && msg.to !== playerId)) return;
  if (msg.type === 'discover') {
    if (role === 'host' && !peer) hostOffer(msg.from);
    return;
  }
  if (msg.type === 'host') {
    // 同時加入時，使用固定順序決定房主，避免兩人都成為黑子。
    if (!peer && (role !== 'host' || msg.from < playerId)) { clearTimeout(joinTask); role = 'guest'; publish({type: 'accept', to: msg.from}); }
    else if (!peer && role === 'host') hostOffer(msg.from);
    return;
  }
  if (msg.type === 'offer' && !peer && (role !== 'host' || msg.from < playerId)) {
    clearTimeout(joinTask); role = 'guest'; publish({type: 'accept', to: msg.from}); return;
  }
  if (msg.type === 'accept' && role === 'host' && !peer) {
    peer = msg.from; myColor = 1; gameId = makeId();
    publish({type: 'start', game: gameId}); paired(); return;
  }
  if (msg.type === 'start' && role === 'guest' && !peer && typeof msg.game === 'string') {
    peer = msg.from; myColor = 2; gameId = msg.game; paired(); return;
  }
  if (msg.from !== peer) return;
  peerSeen = Date.now();
  if (msg.type === 'leave') return opponentLeft();
  if (msg.type === 'heartbeat') return;
  if (msg.type === 'chat' && typeof msg.text === 'string') return chat(msg.text.slice(0, 200), '棋友');
  if (msg.game !== gameId) return;
  if (msg.type === 'move') {
    if (pending || finished || turn === myColor || msg.count !== moves.length || !Number.isInteger(msg.row) || !Number.isInteger(msg.col) || !inside(msg.row, msg.col) || board[msg.row][msg.col]) return;
    place(msg.row, msg.col);
  }
  if (msg.type === 'request' && ['undo', 'restart'].includes(msg.action) && typeof msg.id === 'string' && msg.count === moves.length) {
    if (pending || (msg.action === 'undo' && !moves.length)) { publish({type:'response', id:msg.id, agree:false, game:gameId}); return; }
    pending = {id: msg.id, action: msg.action, incoming: true, count: moves.length, at: Date.now()};
    $('request-title').textContent = msg.action === 'undo' ? '棋友申請悔棋' : '棋友邀請重開';
    $('request-message').textContent = msg.action === 'undo' ? '是否同意收回棋盤上最後一手？' : '是否同意結束本局，重新執黑先行？';
    $('request-dialog').showModal(); draw();
  }
  if (msg.type === 'response' && pending && !pending.incoming && msg.id === pending.id) {
    const action = pending.action, id = pending.id; clearPending();
    if (msg.agree === true) applyAction(action, id); else { note('棋友婉拒了申請，請繼續對弈。'); draw(); }
  }
}
function applyAction(action, id) {
  if (action === 'undo') undo(); else { gameId = id; resetGame(); chat('雙方同意重新開局。'); }
}
function requestAction(action) {
  if (!peer || !connected || pending) return;
  pending = {id: makeId(), action, incoming: false, count: moves.length, at: Date.now()};
  if (!publish({type: 'request', ...pending, game: gameId})) { clearPending(); return; }
  note(action === 'undo' ? '已向棋友申請收回最後一手。' : '已邀請棋友重新開局。'); draw();
}
function answerRequest(agree) {
  if (!pending?.incoming) return;
  const {action, id} = pending;
  const sent = publish({type: 'response', id, agree, game: gameId}); clearPending();
  if (agree && sent) applyAction(action, id); else { draw(); note('繼續本局對弈。'); }
}
function joinRoom() {
  const room = $('room').value.trim();
  if (!/^[\p{L}\p{N}-]{2,24}$/u.test(room)) return note('請輸入二至二十四字的中文、字母、數字或連字號房號。');
  disconnect(false); resetGame(); roomTopic = 'qijing/v1/' + encodeURIComponent(room);
  $('connect').disabled = true; setConnection('連線中…', 'muted'); note('正在叩響棋室的門…');
  let buffer = new Uint8Array();
  try { socket = new WebSocket('wss://broker.hivemq.com:8884/mqtt', 'mqtt'); }
  catch { disconnect(false); setConnection('連線失敗', 'error'); return note('無法建立訊息連線，請稍後再試。'); }
  socket.binaryType = 'arraybuffer';
  connectionTask = setTimeout(() => { if (!subscribed) { disconnect(false); setConnection('連線逾時', 'error'); note('公共棋室暫時沒有回應，請重試或選擇電腦棋友。'); } }, 14000);
  socket.onopen = () => {
    // 通訊版本、乾淨工作階段與心跳秒數依序放進連線封包。
    sendPacket(0x10, [...mqttString('MQTT'), 4, 2, 0, 30, ...mqttString('qj-' + playerId)]);
  };
  socket.onmessage = event => {
    const data = new Uint8Array(event.data), combined = new Uint8Array(buffer.length + data.length);
    combined.set(buffer); combined.set(data, buffer.length); buffer = combined;
    // 一次網路訊息可能包含多個封包，也可能只有半個封包，須保留未讀完資料。
    while (buffer.length > 1) {
      let length = 0, multiplier = 1, offset = 1, digit;
      do { if (offset >= buffer.length) return; digit = buffer[offset++]; length += (digit & 127) * multiplier; multiplier *= 128; } while (digit & 128 && offset < 5);
      if (digit & 128 || length > 1000000) { socket.close(); return; }
      if (buffer.length < offset + length) return;
      const type = buffer[0] >> 4, body = buffer.slice(offset, offset + length); buffer = buffer.slice(offset + length);
      if (type === 2) {
        if (body.length !== 2 || body[1] !== 0) { socket.close(); return; }
        connected = true; sendPacket(0x82, [0, 1, ...mqttString(roomTopic), 0]);
      } else if (type === 9) {
        if (body.length < 3 || body[2] === 128) { socket.close(); return; }
        subscribed = true; clearTimeout(connectionTask); $('leave').disabled = false;
        setConnection('已連線', ''); $('chat-badge').textContent = '棋室已連線';
        chat(`已加入棋室「${room}」，等待另一位棋友。`); publish({type: 'discover', to: ''});
        joinTask = setTimeout(() => { if (!peer && role !== 'guest') { role = 'host'; myColor = 1; updateSide(); publish({type: 'host', to: ''}); note('棋室已就緒，請朋友加入相同房號。'); } }, 2000);
        heartbeat = setInterval(() => {
          sendPacket(0xc0, []); publish({type: 'heartbeat'});
          if (role === 'host' && !peer) publish({type: 'host', to: ''});
          if (peer && Date.now() - peerSeen > 20000) opponentLeft();
          if (pending && Date.now() - pending.at > 45000) { clearPending(); draw(); note('申請等待逾時，請重新提出。'); }
        }, 5000);
      } else if (type === 3 && body.length > 2) {
        const topicLength = body[0] * 256 + body[1];
        if (decoder.decode(body.slice(2, 2 + topicLength)) !== roomTopic) continue;
        try { handleMessage(JSON.parse(decoder.decode(body.slice(2 + topicLength)))); } catch { /* 忽略不屬於本遊戲的資料。 */ }
      }
    }
  };
  socket.onerror = () => note('棋室連線發生問題，請確認網路或稍後重新加入。');
  socket.onclose = () => { disconnect(false); setConnection('連線中斷', 'error'); note('連線已中斷，本局暫停。重新加入會開始新局。'); chat('連線中斷，請重新加入棋室。'); };
}
function changeMode(next) {
  if (next === mode) return;
  disconnect(false); mode = next; myColor = 1; updateSide();
  $('ai-mode').classList.toggle('active', mode === 'ai'); $('online-mode').classList.toggle('active', mode === 'online');
  $('ai-mode').setAttribute('aria-pressed', String(mode === 'ai')); $('online-mode').setAttribute('aria-pressed', String(mode === 'online'));
  $('room-controls').hidden = mode !== 'online'; $('opponent').hidden = mode !== 'ai';
  $('mode-caption').textContent = mode === 'ai' ? '人機對弈' : '網路對弈';
  $('opponent-name').textContent = mode === 'ai' ? $('opponent').selectedOptions[0].textContent.split(' · ')[0] : '遠方棋友';
  $('opponent-detail').textContent = mode === 'ai' ? '電腦棋友 · 執白後行' : '加入棋室，等待相逢';
  $('player-online').textContent = mode === 'ai' ? '就緒' : '未連線';
  if (mode === 'ai') updateComputer();
  resetGame();
  if (mode === 'online') note('與朋友輸入相同房號，便能相約對弈。');
}
$('ai-mode').onclick = () => changeMode('ai'); $('online-mode').onclick = () => changeMode('online');
$('opponent').onchange = () => { updateComputer(); resetGame(); };
$('restart').onclick = () => mode === 'ai' ? resetGame() : requestAction('restart');
$('undo').onclick = () => mode === 'ai' ? undo() : requestAction('undo');
$('connect').onclick = joinRoom; $('leave').onclick = () => disconnect();
$('room').onkeydown = event => { if (event.key === 'Enter' && !$('connect').disabled) joinRoom(); };
$('sound').onclick = () => { soundEnabled = !soundEnabled; $('sound').textContent = soundEnabled ? '♪ 音效已開' : '♪ 音效已關'; $('sound').setAttribute('aria-pressed', String(soundEnabled)); };
$('view').onclick = () => { flat = !flat; $('board-scene').classList.toggle('flat', flat); $('view').textContent = flat ? '◇ 切換立體' : '◇ 切換俯視'; $('view').setAttribute('aria-pressed', String(flat)); $('view-label').textContent = flat ? '靜觀俯視視角' : '山水立體視角'; $('camera-status').textContent = flat ? '靜觀俯視' : '山水立體'; };
$('chat-form').onsubmit = event => {
  event.preventDefault(); const text = $('chat-input').value.trim();
  if (!text || !peer || !connected) return;
  if (publish({type: 'chat', text})) { chat(text, '你'); $('chat-input').value = ''; }
};
$('accept').onclick = () => answerRequest(true); $('decline').onclick = () => answerRequest(false);
$('request-dialog').addEventListener('cancel', event => { event.preventDefault(); answerRequest(false); });
window.addEventListener('beforeunload', () => { if (connected) publish({type: 'leave'}); });
setInterval(() => {
  const seconds = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  if (!finished) $('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}：${String(seconds % 60).padStart(2, '0')}`.replace(/\d/g, n => '０１２３４５６７８９'[n]);
}, 1000);
createBoard(); updateComputer(); resetGame();
