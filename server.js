const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('4 Peace Speed Server Running');
});

const wss = new WebSocket.Server({ server });

// ルーム管理
const rooms = {};
// アカウント管理（名前→{rating, wins, losses}）
const accounts = {};

// ─── ユーティリティ ───
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
  if (cards.length === 4 && s.join('') === '1234') return { total: 5, label: 'ストレート +5pt', voice: 'ストレート' };
  if (cards.length === 2 && s[0] === 5 && s[1] === 5) return { total: 1, label: 'ノーボーナス +1pt', voice: '' };
  const freq = {};
  cards.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
  const counts = Object.values(freq);
  if (counts.some(c => c >= 3)) return { total: 4, label: 'スリーカード +4pt', voice: 'スリーカード' };
  if (counts.filter(c => c === 2).length >= 2) return { total: 3, label: 'ツーペア +3pt', voice: 'ツーペア' };
  if (counts.some(c => c === 2)) return { total: 2, label: 'ワンペア +2pt', voice: 'ワンペア' };
  return { total: 1, label: 'ノーボーナス +1pt', voice: '' };
}

function canPlay(v, fieldSum, fieldLen) {
  const filled = fieldLen + 1;
  const ns = fieldSum + v;
  if (filled === 3 && ns < 5) return false;
  if (filled === 4 && ns < 10) return false;
  return true;
}

// ─── Eloレーティング計算 ───
function calcElo(winnerRating, loserRating) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  const change = Math.round(K * (1 - expected));
  // 最小20、最大40に制限
  const clamp = Math.min(40, Math.max(20, change));
  return clamp;
}

function getRank(rating) {
  if (rating >= 2500) return { name: 'ダイヤ', emoji: '👑' };
  if (rating >= 2000) return { name: 'プラチナ', emoji: '💎' };
  if (rating >= 1500) return { name: 'ゴールド', emoji: '🥇' };
  if (rating >= 1000) return { name: 'シルバー', emoji: '🥈' };
  return { name: 'ブロンズ', emoji: '🥉' };
}

function getOrCreateAccount(name) {
  if (!accounts[name]) {
    accounts[name] = { rating: 500, wins: 0, losses: 0 };
  }
  return accounts[name];
}

// ─── WebSocket通信 ───
function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  if (room.host && room.host.readyState === WebSocket.OPEN) room.host.send(data);
  if (room.guest && room.guest.readyState === WebSocket.OPEN) room.guest.send(data);
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ─── ゲーム進行 ───
function startCountdown(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  clearTimers(room);

  // 手札が0枚の時だけ補充（タイマー切れは別途処理）
  const hostAlive = room.state.hostHand.filter(v => v).length;
  const guestAlive = room.state.guestHand.filter(v => v).length;
  if (hostAlive === 0) room.state.hostHand = createDeck();
  if (guestAlive === 0) room.state.guestHand = createDeck();

  room.state.field = [];
  room.state.fieldSum = 0;
  room.state.status = 'countdown';
  room.state.timeLeft = 10;
  room.state.flashMsg = null;
  room.state.burstAnim = false;
  room.state.resetFA = false;
  room.state.comboShow = null;

  send(room.host, { type: 'state', ...getStateForRole(room, 'host'), countdown: 5 });
  send(room.guest, { type: 'state', ...getStateForRole(room, 'guest'), countdown: 5 });

  let c = 5;
  function tick() {
    if (!rooms[roomId]) return;
    broadcast(rooms[roomId], { type: 'countdown', value: c });
    if (c === 0) {
      room.countTimer = setTimeout(() => {
        broadcast(rooms[roomId], { type: 'countdown', value: -1 });
        room.state.status = 'playing';
        startTimer(roomId);
      }, 700);
      return;
    }
    c--;
    room.countTimer = setTimeout(tick, 700);
  }
  tick();
}

function startTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.state.timeLeft = 10;
  broadcast(room, { type: 'timer', value: 10 });

  room.timer = setInterval(() => {
    if (!rooms[roomId]) return;
    room.state.timeLeft--;
    broadcast(room, { type: 'timer', value: room.state.timeLeft });
    if (room.state.timeLeft <= 0) {
      clearInterval(room.timer);
      broadcast(room, { type: 'flash', msg: { text: '⏱ 時間切れ！引き分け（±0pt）', who: null } });
      setTimeout(() => {
        if (!rooms[roomId]) return;
        broadcast(room, { type: 'flash', msg: null });
        // タイマー切れは手札強制リセット
        room.state.hostHand = createDeck();
        room.state.guestHand = createDeck();
        room.state.rNum = (room.state.rNum || 1) + 1;
        startCountdown(roomId);
      }, 1600);
    }
  }, 1000);
}

function clearTimers(room) {
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
  if (room.countTimer) { clearTimeout(room.countTimer); room.countTimer = null; }
}

function getStateForRole(room, role) {
  const s = room.state;
  return {
    myHand: role === 'host' ? s.hostHand : s.guestHand,
    opHandCount: role === 'host' ? s.guestHand.filter(v=>v).length : s.hostHand.filter(v=>v).length,
    field: s.field,
    fieldSum: s.fieldSum,
    myPt: role === 'host' ? s.hostPt : s.guestPt,
    opPt: role === 'host' ? s.guestPt : s.hostPt,
    rNum: s.rNum || 1,
    timeLeft: s.timeLeft,
    status: s.status,
    flashMsg: s.flashMsg,
    burstAnim: s.burstAnim,
    resetFA: s.resetFA,
    comboShow: s.comboShow,
  };
}

function resolvePlay(roomId, role) {
  const room = rooms[roomId];
  if (!room) return;
  const s = room.state;
  const nf = [...s.field];
  const nfValues = nf.map(c => typeof c === 'object' ? c.value : c);
  const ns = s.fieldSum;

  if (ns > 10) {
    clearTimers(room);
    s.status = 'resolving';
    const isHost = role === 'host';
    if (isHost) s.hostPt = Math.max(0, s.hostPt - 2);
    else s.guestPt = Math.max(0, s.guestPt - 2);
    const msg = { text: isHost ? '💥 バースト！あなた-2pt' : '💥 相手バースト！相手-2pt', by: role };
    broadcast(room, { type: 'burst', msg, hostPt: s.hostPt, guestPt: s.guestPt });
    const fin = s.hostPt >= 15 || s.guestPt >= 15;
    setTimeout(() => {
      if (!rooms[roomId]) return;
      if (fin) { finishGame(roomId); return; }
      s.rNum = (s.rNum || 1) + 1;
      startCountdown(roomId);
    }, 1000);
    return;
  }
  if (ns === 10) {
    clearTimers(room);
    s.status = 'resolving';
    const pts = calcPts(nfValues);
    const isHost = role === 'host';
    if (isHost) s.hostPt += pts.total;
    else s.guestPt += pts.total;
    const msg = { text: (isHost ? '🙋 YOU +' : '👤 相手 +') + pts.total + 'pt　' + pts.label, by: role };
    const combo = { text: pts.voice || '10達成！', pts: pts.total, color: isHost ? '#00d4ff' : '#ff2d6e' };
    broadcast(room, { type: 'score', msg, combo, hostPt: s.hostPt, guestPt: s.guestPt, voice: pts.voice });
    const fin2 = s.hostPt >= 15 || s.guestPt >= 15;
    setTimeout(() => { if (rooms[roomId]) broadcast(room, { type: 'comboEnd' }); }, 1200);
    setTimeout(() => {
      if (!rooms[roomId]) return;
      if (fin2) { finishGame(roomId); return; }
      s.rNum = (s.rNum || 1) + 1;
      startCountdown(roomId);
    }, 1400);
    return;
  }
  if (nf.length >= 4) {
    clearTimers(room);
    s.status = 'resolving';
    broadcast(room, { type: 'forceReset' });
    setTimeout(() => {
      if (!rooms[roomId]) return;
      s.rNum = (s.rNum || 1) + 1;
      startCountdown(roomId);
    }, 900);
    return;
  }
  // 通常：場を両者に送る
  broadcast(room, { type: 'field', field: s.field, fieldSum: s.fieldSum });
}

// ─── ゲーム終了・レーティング更新 ───
function finishGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const s = room.state;
  const winner = s.hostPt >= 15 ? 'host' : 'guest';
  const loser = winner === 'host' ? 'guest' : 'host';

  const winnerName = room[winner + 'Name'];
  const loserName = room[loser + 'Name'];
  const winnerAcc = getOrCreateAccount(winnerName);
  const loserAcc = getOrCreateAccount(loserName);

  const change = calcElo(winnerAcc.rating, loserAcc.rating);
  winnerAcc.rating = Math.max(0, winnerAcc.rating + change);
  loserAcc.rating = Math.max(0, loserAcc.rating - change);
  winnerAcc.wins++;
  loserAcc.losses++;

  const winnerRank = getRank(winnerAcc.rating);
  const loserRank = getRank(loserAcc.rating);

  // hostとguestそれぞれに結果を送る
  send(room.host, {
    type: 'finish',
    winner,
    hostPt: s.hostPt,
    guestPt: s.guestPt,
    ratingChange: winner === 'host' ? +change : -change,
    newRating: winner === 'host' ? winnerAcc.rating : loserAcc.rating,
    newRank: winner === 'host' ? winnerRank : loserRank,
  });
  send(room.guest, {
    type: 'finish',
    winner,
    hostPt: s.hostPt,
    guestPt: s.guestPt,
    ratingChange: winner === 'guest' ? +change : -change,
    newRating: winner === 'guest' ? winnerAcc.rating : loserAcc.rating,
    newRank: winner === 'guest' ? winnerRank : loserRank,
  });
}

// ─── WebSocket接続処理 ───
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // アカウント情報取得
    if (msg.type === 'getAccount') {
      const acc = getOrCreateAccount(msg.name);
      const rank = getRank(acc.rating);
      send(ws, { type: 'account', name: msg.name, rating: acc.rating, rank, wins: acc.wins, losses: acc.losses });
    }

    // ルーム作成
    else if (msg.type === 'create') {
      const roomId = Math.floor(1000 + Math.random() * 9000).toString();
      rooms[roomId] = {
        host: ws, guest: null,
        hostName: msg.name || 'ホスト',
        guestName: null,
        state: {
          hostPt: 0, guestPt: 0,
          hostHand: [], guestHand: [],
          field: [], fieldSum: 0,
          status: 'waiting',
          rNum: 1, timeLeft: 10,
          flashMsg: null, burstAnim: false, resetFA: false, comboShow: null,
        },
        timer: null, countTimer: null,
      };
      ws.roomId = roomId;
      ws.role = 'host';
      ws.playerName = msg.name || 'ホスト';
      send(ws, { type: 'created', roomId });
    }

    // ルーム入室
    else if (msg.type === 'join') {
      const room = rooms[msg.roomId];
      if (!room) { send(ws, { type: 'error', msg: 'ルームが見つかりません' }); return; }
      if (room.guest) { send(ws, { type: 'error', msg: 'このルームはすでに開始しています' }); return; }
      room.guest = ws;
      room.guestName = msg.name || 'ゲスト';
      ws.roomId = msg.roomId;
      ws.role = 'guest';
      ws.playerName = msg.name || 'ゲスト';
      send(ws, { type: 'joined', roomId: msg.roomId, opName: room.hostName });
      send(room.host, { type: 'guestJoined', opName: room.guestName });
      room.state.rNum = 1;
      room.state.hostPt = 0;
      room.state.guestPt = 0;
      setTimeout(() => startCountdown(msg.roomId), 500);
    }

    // カードを出す
    else if (msg.type === 'play') {
      const room = rooms[ws.roomId];
      if (!room) return;
      const s = room.state;
      if (s.status !== 'playing') return;
      if (s.timeLeft <= 0) return;
      const role = ws.role;
      const hand = role === 'host' ? s.hostHand : s.guestHand;
      const idx = msg.idx;
      const value = hand[idx];
      if (!value) return;
      if (!canPlay(value, s.fieldSum, s.field.length)) return;

      hand[idx] = 0;
      if (hand.filter(v => v).length === 0) {
        const newDeck = createDeck();
        if (role === 'host') s.hostHand = newDeck;
        else s.guestHand = newDeck;
        send(ws, { type: 'newHand', hand: newDeck });
      } else {
        send(ws, { type: 'handUpdate', idx, hand });
      }

      s.field.push({value, by: role});
      s.fieldSum += value;

      const opWs = role === 'host' ? room.guest : room.host;
      send(ws, { type: 'fieldUpdate', field: s.field, fieldSum: s.fieldSum });
      send(opWs, { type: 'opPlay', value, field: s.field, fieldSum: s.fieldSum });

      resolvePlay(ws.roomId, role);
    }

    // ホームに戻る
    else if (msg.type === 'leave') {
      const room = rooms[ws.roomId];
      if (room) {
        clearTimers(room);
        broadcast(room, { type: 'opLeft' });
        delete rooms[ws.roomId];
      }
    }
  });

  ws.on('close', () => {
    const room = rooms[ws.roomId];
    if (room) {
      clearTimers(room);
      broadcast(room, { type: 'opLeft' });
      delete rooms[ws.roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
