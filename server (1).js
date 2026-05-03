const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('4 Peace Speed Server Running');
});

const wss = new WebSocket.Server({ server });

const rooms = {};
const accounts = {};
const TICK_MS = 50;

// ── ユーティリティ ──
function createDeck() {
  const cards = [];
  while (cards.length < 10) {
    const v = Math.floor(Math.random() * 5) + 1;
    if (cards.filter(x => x === v).length < 3) cards.push(v);
  }
  return cards.sort(() => Math.random() - 0.5);
}

function calcPts(cards) {
  const s = [...cards].sort((a, b) => a - b);
  if (cards.length === 4 && s.join('') === '1234') return { total: 5, voice: 'ストレート', label: 'ストレート +5pt' };
  if (cards.length === 2 && s[0] === 5 && s[1] === 5) return { total: 1, voice: 'ノーボーナス', label: 'ノーボーナス +1pt' };
  const freq = {};
  cards.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
  const counts = Object.values(freq);
  if (counts.some(c => c >= 3)) return { total: 4, voice: 'スリーカード', label: 'スリーカード +4pt' };
  if (counts.filter(c => c === 2).length >= 2) return { total: 3, voice: 'ツーペア', label: 'ツーペア +3pt' };
  if (counts.some(c => c === 2)) return { total: 2, voice: 'ワンペア', label: 'ワンペア +2pt' };
  return { total: 1, voice: 'ノーボーナス', label: 'ノーボーナス +1pt' };
}

function canPlay(v, fieldSum, fieldLen) {
  if (fieldLen >= 4) return false;
  const filled = fieldLen + 1;
  const ns = fieldSum + v;
  if (filled === 3 && ns < 5) return false;
  if (filled === 4 && ns < 10) return false;
  return true;
}

function getRank(rating) {
  if (rating >= 2500) return { name: 'ダイヤ', emoji: '👑' };
  if (rating >= 2000) return { name: 'プラチナ', emoji: '💎' };
  if (rating >= 1500) return { name: 'ゴールド', emoji: '🥇' };
  if (rating >= 1000) return { name: 'シルバー', emoji: '🥈' };
  return { name: 'ブロンズ', emoji: '🥉' };
}

function getOrCreateAccount(name) {
  if (!accounts[name]) accounts[name] = { rating: 500, wins: 0, losses: 0 };
  return accounts[name];
}

function calcElo(winnerRating, loserRating) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  const change = Math.round(K * (1 - expected));
  return Math.min(40, Math.max(20, change));
}

// ── 通信 ──
function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  if (room.host && room.host.readyState === WebSocket.OPEN) room.host.send(data);
  if (room.guest && room.guest.readyState === WebSocket.OPEN) room.guest.send(data);
}

// ── ゲームループ ──
function startGameLoop(roomId) {
  const room = rooms[roomId];
  if (!room || room.tickInterval) return;

  room.tickInterval = setInterval(() => {
    const room = rooms[roomId];
    if (!room) return;

    // 入力キューを処理
    while (room.inputQueue.length > 0) {
      const input = room.inputQueue.shift();
      processInput(roomId, input);
    }

    // フェーズ管理
    const now = Date.now();

    if (room.state.phase === 'countdown') {
      const elapsed = now - room.state.phaseStartAt;
      const count = Math.max(0, 5 - Math.floor(elapsed / 700));
      room.state.countdown = count;
      if (elapsed >= 700 * 6) {
        room.state.phase = 'playing';
        room.state.phaseStartAt = now;
        room.state.timeLeft = 10;
      }
    }

    if (room.state.phase === 'playing') {
      const elapsed = now - room.state.phaseStartAt;
      const timeLeft = Math.max(0, 10 - Math.floor(elapsed / 1000));
      room.state.timeLeft = timeLeft;
      if (timeLeft <= 0 && !room.state.resolving) {
        room.state.resolving = true;
        room.state.phase = 'timeup';
        room.state.phaseStartAt = now;
        // 時間切れ：手札リセット
        room.state.hostHand = createDeck();
        room.state.guestHand = createDeck();
      }
    }

    if (room.state.phase === 'timeup') {
      const elapsed = now - room.state.phaseStartAt;
      if (elapsed >= 1600) {
        startNextRound(roomId);
      }
    }

    if (room.state.phase === 'resolving') {
      const elapsed = now - room.state.phaseStartAt;
      const duration = room.state.resolveDuration || 1400;
      if (elapsed >= duration) {
        if (room.state.hostPt >= 15 || room.state.guestPt >= 15) {
          finishGame(roomId);
          return;
        }
        startNextRound(roomId);
      }
    }

    // 状態をbroadcast
    broadcastState(roomId);

  }, TICK_MS);
}

function stopGameLoop(room) {
  if (room.tickInterval) {
    clearInterval(room.tickInterval);
    room.tickInterval = null;
  }
}

function broadcastState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const s = room.state;

  const base = {
    type: 'tick',
    phase: s.phase,
    countdown: s.countdown,
    timeLeft: s.timeLeft,
    field: s.field,
    fieldSum: s.fieldSum,
    // ── 追加: 誰が出したかを配列で送る ──
    // クライアントは自分のrole('host'/'guest')と照合して 'player'/'dealer' に変換する
    fieldOwners: s.fieldOwners,
    hostPt: s.hostPt,
    guestPt: s.guestPt,
    rNum: s.rNum,
    flashMsg: s.flashMsg,
    comboShow: s.comboShow,
    burstAnim: s.burstAnim,
    resetAnim: s.resetAnim,
    resolving: s.resolving,
  };

  send(room.host, {
    ...base,
    myHand: s.hostHand,
    opHandCount: s.guestHand.filter(v => v).length,
    role: 'host',
  });

  send(room.guest, {
    ...base,
    myHand: s.guestHand,
    opHandCount: s.hostHand.filter(v => v).length,
    role: 'guest',
  });
}

function processInput(roomId, input) {
  const room = rooms[roomId];
  if (!room) return;
  const s = room.state;
  if (s.phase !== 'playing' || s.resolving) return;

  const { role, idx, value } = input;
  const hand = role === 'host' ? s.hostHand : s.guestHand;

  if (!hand[idx] || hand[idx] !== value) return;
  if (!canPlay(value, s.fieldSum, s.field.length)) return;

  hand[idx] = 0;

  // 手札が0になったら補充
  if (hand.filter(v => v).length === 0) {
    const newDeck = createDeck();
    if (role === 'host') s.hostHand = newDeck;
    else s.guestHand = newDeck;
  }

  s.field.push(value);
  s.fieldOwners.push(role); // ── 追加: 出したロールを記録 ──
  s.fieldSum += value;
  s.lastPlayRole = role;

  // バースト
  if (s.fieldSum > 10) {
    s.resolving = true;
    s.phase = 'resolving';
    s.phaseStartAt = Date.now();
    s.resolveDuration = 1000;
    if (role === 'host') s.hostPt = Math.max(0, s.hostPt - 2);
    else s.guestPt = Math.max(0, s.guestPt - 2);
    s.burstAnim = true;
    s.flashMsg = { text: role === 'host' ? '💥 バースト！ホスト-2pt' : '💥 バースト！ゲスト-2pt', by: role };
    setTimeout(() => { if (rooms[roomId]) s.burstAnim = false; }, 700);
    return;
  }

  // 10達成
  if (s.fieldSum === 10) {
    s.resolving = true;
    s.phase = 'resolving';
    s.phaseStartAt = Date.now();
    s.resolveDuration = 1400;
    const pts = calcPts(s.field);
    if (role === 'host') s.hostPt += pts.total;
    else s.guestPt += pts.total;
    s.resetAnim = true;
    s.comboShow = { text: pts.voice || '10達成！', pts: pts.total, color: role === 'host' ? '#00d4ff' : '#ff2d6e' };
    s.flashMsg = { text: (role === 'host' ? '🙋 ホスト +' : '👤 ゲスト +') + pts.total + 'pt　' + pts.label, by: role, voice: pts.voice };
    setTimeout(() => { if (rooms[roomId]) { s.comboShow = null; s.resetAnim = false; } }, 1200);
    return;
  }

  // 4枚強制リセット
  if (s.field.length >= 4) {
    s.resolving = true;
    s.phase = 'resolving';
    s.phaseStartAt = Date.now();
    s.resolveDuration = 900;
    s.resetAnim = true;
    s.flashMsg = { text: '4枚！強制リセット', by: null };
    setTimeout(() => { if (rooms[roomId]) s.resetAnim = false; }, 700);
  }
}

function startNextRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const s = room.state;
  s.field = [];
  s.fieldOwners = []; // ── 追加: ラウンド開始時にクリア ──
  s.fieldSum = 0;
  s.resolving = false;
  s.flashMsg = null;
  s.comboShow = null;
  s.burstAnim = false;
  s.resetAnim = false;
  s.lastPlayRole = null;
  s.rNum = (s.rNum || 1) + 1;
  s.phase = 'countdown';
  s.phaseStartAt = Date.now();
  s.countdown = 5;
  s.timeLeft = 10;

  // 手札補充
  if (!s.hostHand || s.hostHand.filter(v => v).length === 0) s.hostHand = createDeck();
  if (!s.guestHand || s.guestHand.filter(v => v).length === 0) s.guestHand = createDeck();
}

function finishGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  stopGameLoop(room);
  const s = room.state;
  const winner = s.hostPt >= 15 ? 'host' : 'guest';

  const winnerAcc = getOrCreateAccount(room[winner + 'Name']);
  const loserAcc = getOrCreateAccount(room[(winner === 'host' ? 'guest' : 'host') + 'Name']);
  const change = calcElo(winnerAcc.rating, loserAcc.rating);
  winnerAcc.rating += change; winnerAcc.wins++;
  loserAcc.rating = Math.max(0, loserAcc.rating - change); loserAcc.losses++;

  send(room.host, { type: 'finish', winner, hostPt: s.hostPt, guestPt: s.guestPt, ratingChange: winner === 'host' ? +change : -change, newRating: winner === 'host' ? winnerAcc.rating : loserAcc.rating, newRank: getRank(winner === 'host' ? winnerAcc.rating : loserAcc.rating) });
  send(room.guest, { type: 'finish', winner, hostPt: s.hostPt, guestPt: s.guestPt, ratingChange: winner === 'guest' ? +change : -change, newRating: winner === 'guest' ? winnerAcc.rating : loserAcc.rating, newRank: getRank(winner === 'guest' ? winnerAcc.rating : loserAcc.rating) });

  delete rooms[roomId];
}

// ── WebSocket接続 ──
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      const roomId = Math.floor(1000 + Math.random() * 9000).toString();
      rooms[roomId] = {
        host: ws, guest: null,
        hostName: msg.name || 'ホスト',
        guestName: null,
        inputQueue: [],
        tickInterval: null,
        state: {
          phase: 'waiting',
          countdown: 5,
          timeLeft: 10,
          hostPt: 0, guestPt: 0,
          hostHand: [], guestHand: [],
          field: [], fieldOwners: [], // ── 追加: 初期化 ──
          fieldSum: 0,
          rNum: 1,
          resolving: false,
          flashMsg: null, comboShow: null,
          burstAnim: false, resetAnim: false,
          phaseStartAt: Date.now(),
          resolveDuration: 1400,
          lastPlayRole: null,
        },
      };
      ws.roomId = roomId;
      ws.role = 'host';
      send(ws, { type: 'created', roomId });
    }

    else if (msg.type === 'join') {
      const room = rooms[msg.roomId];
      if (!room) { send(ws, { type: 'error', msg: 'ルームが見つかりません' }); return; }
      if (room.guest) { send(ws, { type: 'error', msg: 'このルームはすでに開始しています' }); return; }
      room.guest = ws;
      room.guestName = msg.name || 'ゲスト';
      ws.roomId = msg.roomId;
      ws.role = 'guest';
      send(ws, { type: 'joined', roomId: msg.roomId });
      send(room.host, { type: 'guestJoined' });

      // ゲーム開始
      room.state.hostHand = createDeck();
      room.state.guestHand = createDeck();
      room.state.phase = 'countdown';
      room.state.phaseStartAt = Date.now();
      room.state.countdown = 5;
      startGameLoop(msg.roomId);
    }

    else if (msg.type === 'play') {
      const room = rooms[ws.roomId];
      if (!room) return;
      room.inputQueue.push({ role: ws.role, idx: msg.idx, value: msg.value });
    }

    else if (msg.type === 'leave') {
      const room = rooms[ws.roomId];
      if (room) {
        stopGameLoop(room);
        broadcast(room, { type: 'opLeft' });
        delete rooms[ws.roomId];
      }
    }
  });

  ws.on('close', () => {
    const room = rooms[ws.roomId];
    if (room) {
      stopGameLoop(room);
      broadcast(room, { type: 'opLeft' });
      delete rooms[ws.roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port ' + PORT));
