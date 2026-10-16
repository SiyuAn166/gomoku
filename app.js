'use strict';
/* Gomoku · LAN Play — application layer
 * Depends on: logic.js (pure game logic), PeerJS CDN (window.Peer)
 *
 * Networking model:
 * - Whoever creates the room = host = Black (first move), and is authoritative:
 *   validates every move, owns the full state, broadcasts it to everyone.
 * - The first to join the room = White (second move); sends move requests to host.
 * - Everyone joining after that = spectator; receives state only, cannot move.
 * - Room code is 4 chars; Peer ID is 'gomoku-' + room code.
 */

var $ = function (id) { return document.getElementById(id); };

/* ---------------- Global state ---------------- */
var mode = null;          // 'host' | 'guest'
var myRole = null;        // 'black' | 'white' | 'spectator'
var myColor = 0;          // 1=black 2=white 0=spectator
var myName = '';
var roomCode = '';
var peer = null;
var hostConn = null;      // guest side: connection to the host
var conns = new Map();    // host side: peerId -> { conn, name, role }
var state = null;         // local copy of state (authoritative on host side)
var rematchSeen = '';     // marker of the rematch dialog already shown
var connecting = false;

/* ---------------- Helpers ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function clampName(s) {
  return String(s || '').trim().slice(0, 12);
}
function toast(msg) {
  var wrap = $('toast-wrap');
  var d = document.createElement('div');
  d.className = 'toast';
  d.textContent = msg;
  wrap.appendChild(d);
  while (wrap.children.length > 3) wrap.removeChild(wrap.firstChild);
  setTimeout(function () {
    d.classList.add('out');
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 300);
  }, 2200);
}
function vibrate(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms || 15); } catch (e) {}
}
function snapshot(s) { return JSON.parse(JSON.stringify(s)); }
function mySide() {
  return myRole === 'black' ? 'black' : myRole === 'white' ? 'white' : 'spectator';
}
function nameOf(side) {
  if (!state || !state.players) return '';
  var p = state.players[side];
  return p ? p.name : '';
}
function makeCode() {
  var abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  var s = '';
  for (var i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

/* ---------------- Screens ---------------- */
function showScreen(id) {
  ['screen-home', 'screen-room'].forEach(function (s) {
    $(s).classList.toggle('hidden', s !== id);
  });
  if (id === 'screen-room') requestAnimationFrame(resizeBoard);
}

/* ---------------- Home: create / join ---------------- */
function initHome() {
  $('btn-create').addEventListener('click', function () {
    if (connecting) return;
    myName = clampName($('input-name').value) || ('Player' + Math.floor(Math.random() * 900 + 100));
    createRoom();
  });
  $('btn-join').addEventListener('click', function () {
    if (connecting) return;
    myName = clampName($('input-name').value) || ('Player' + Math.floor(Math.random() * 900 + 100));
    var code = $('input-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (code.length !== 4) { toast('Enter the 4-character room code'); return; }
    joinRoom(code);
  });
  $('input-code').addEventListener('input', function () {
    this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });
}

function setNetDot(on) {
  var d = $('net-dot');
  d.classList.toggle('on', !!on);
  d.title = on ? 'Connected' : 'Disconnected';
}

/* ---------------- Host ---------------- */
function createRoom() {
  if (typeof Peer === 'undefined') { toast('Failed to load network module. Check your connection and refresh.'); return; }
  connecting = true;
  mode = 'host';
  roomCode = makeCode();
  openHostPeer();
}

function openHostPeer() {
  peer = new Peer('gomoku-' + roomCode);
  peer.on('open', function () {
    connecting = false;
    myRole = 'black';
    myColor = BLACK;
    state = newWaitingState(myName);
    setNetDot(true);
    enterRoom();
    toast('Room created — share the code with your friend!');
  });
  peer.on('connection', onGuestConnected);
  peer.on('disconnected', function () {
    setNetDot(false);
    toast('Lost connection to signaling server, reconnecting…');
    try { peer.reconnect(); } catch (e) {}
  });
  peer.on('error', function (err) {
    if (err && err.type === 'unavailable-id') {
      // Extremely rare code collision: retry with a new code
      roomCode = makeCode();
      try { peer.destroy(); } catch (e) {}
      openHostPeer();
      return;
    }
    connecting = false;
    setNetDot(false);
    toast('Failed to create room: ' + errTypeText(err));
  });
}

function onGuestConnected(conn) {
  conn.on('open', function () {
    conns.set(conn.peer, { conn: conn, name: '', role: '' });
  });
  conn.on('data', function (msg) { handleGuestMessage(conn, msg || {}); });
  conn.on('close', function () { onGuestLeft(conn.peer); });
  conn.on('error', function () { onGuestLeft(conn.peer); });
}

function sendTo(rec, msg) {
  try { rec.conn.send(snapshot(msg)); } catch (e) {}
}

function broadcastState() {
  var snap = snapshot({ t: 'state', state: state });
  conns.forEach(function (rec) {
    try { rec.conn.send(snap); } catch (e) {}
  });
  renderAll();
}

function handleGuestMessage(conn, msg) {
  var rec = conns.get(conn.peer);
  if (!rec) return;

  if (msg.t === 'hello') {
    if (rec.role) { // duplicate hello: resend welcome packet
      sendTo(rec, { t: 'welcome', role: rec.role, state: state });
      return;
    }
    var name = clampName(msg.name) || 'Player';
    rec.name = name;
    if (!state.players.white) {
      rec.role = 'white';
      state.players.white = { name: name };
      if (state.status === 'waiting') { state.status = 'playing'; state.notice = ''; }
      toast(name + ' took the White seat');
    } else {
      rec.role = 'spectator';
      state.spectators.push({ id: conn.peer, name: name });
      toast(name + ' joined as spectator');
    }
    sendTo(rec, { t: 'welcome', role: rec.role, state: state });
    broadcastState();
    return;
  }

  if (msg.t === 'move') {
    if (rec.role !== 'white') { sendTo(rec, { t: 'error', msg: 'Spectators cannot place stones' }); return; }
    state.notice = '';
    var r = applyMove(state, msg.x | 0, msg.y | 0, WHITE);
    if (!r.ok) { sendTo(rec, { t: 'error', msg: r.error }); return; }
    vibrate();
    broadcastState();
    return;
  }

  if (msg.t === 'resign') {
    if (rec.role !== 'white' || state.status !== 'playing') return;
    state.status = 'over';
    state.winner = BLACK;
    state.turn = 0;
    state.rematchBy = null;
    state.notice = rec.name + ' resigned';
    toast(state.notice);
    broadcastState();
    return;
  }

  if (msg.t === 'rematch') {
    if (rec.role !== 'white' || state.status !== 'over') return;
    state.rematchBy = 'white';
    state.notice = '';
    broadcastState(); // host UI will pop the confirm dialog
    return;
  }

  if (msg.t === 'rematch-accept') {
    if (rec.role !== 'white' || state.rematchBy !== 'white') return;
    resetBoard(state);
    toast('Rematch!');
    broadcastState();
    return;
  }

  if (msg.t === 'rematch-decline') {
    if (rec.role !== 'white' || state.rematchBy !== 'white') return;
    state.rematchBy = null;
    state.notice = rec.name + ' declined the rematch';
    broadcastState();
    return;
  }
}

function onGuestLeft(peerId) {
  var rec = conns.get(peerId);
  conns.delete(peerId);
  if (!rec || !rec.role) return;
  if (rec.role === 'white') {
    state.players.white = null;
    state.rematchBy = null;
    if (state.status === 'playing') {
      // White left mid-game: clear the board and wait for a new challenger
      state.board = createBoard();
      state.turn = BLACK;
      state.status = 'waiting';
      state.winner = 0;
      state.winLine = null;
      state.lastMove = null;
      state.moveCount = 0;
      state.notice = rec.name + ' left. Waiting for a new challenger.';
    } else {
      state.notice = rec.name + ' left';
    }
    toast(rec.name + ' left the room');
  } else {
    state.spectators = state.spectators.filter(function (s) { return s.id !== peerId; });
    toast(rec.name + ' stopped spectating');
  }
  broadcastState();
}

/* Host (Black) own actions */
function hostMove(x, y) {
  state.notice = '';
  var r = applyMove(state, x, y, BLACK);
  if (!r.ok) { toast(r.error); return; }
  vibrate();
  broadcastState();
}
function hostResign() {
  if (state.status !== 'playing') return;
  state.status = 'over';
  state.winner = WHITE;
  state.turn = 0;
  state.rematchBy = null;
  state.notice = 'You resigned';
  broadcastState();
}
function hostRequestRematch() {
  if (state.status !== 'over') return;
  state.rematchBy = 'black';
  state.notice = '';
  broadcastState();
}
function hostAcceptRematch() {
  resetBoard(state);
  toast('Rematch!');
  broadcastState();
}
function hostDeclineRematch() {
  state.rematchBy = null;
  state.notice = 'You declined the rematch';
  broadcastState();
}

/* ---------------- Guest (White / spectator) ---------------- */
function joinRoom(code) {
  if (typeof Peer === 'undefined') { toast('Failed to load network module. Check your connection and refresh.'); return; }
  connecting = true;
  mode = 'guest';
  roomCode = code;
  peer = new Peer(); // random ID
  peer.on('open', function () {
    hostConn = peer.connect('gomoku-' + roomCode, { reliable: true });
    wireHostConn();
  });
  peer.on('disconnected', function () {
    setNetDot(false);
    try { peer.reconnect(); } catch (e) {}
  });
  peer.on('error', function (err) {
    connecting = false;
    setNetDot(false);
    if (err && err.type === 'peer-unavailable') {
      toast('Room not found. Check the room code.');
    } else {
      toast('Failed to join: ' + errTypeText(err));
    }
    cleanupToHome();
  });
}

function wireHostConn() {
  var connTimer = setTimeout(function () {
    if (connecting) { toast('Connection timed out. Make sure the host is online and the code is correct.'); cleanupToHome(); }
  }, 12000);
  hostConn.on('open', function () {
    clearTimeout(connTimer);
    connecting = false;
    setNetDot(true);
    hostConn.send({ t: 'hello', name: myName });
  });
  hostConn.on('data', function (msg) { onHostMessage(msg || {}); });
  hostConn.on('close', function () {
    clearTimeout(connTimer);
    if (mode === 'guest') {
      toast('The host left the room');
      cleanupToHome();
    }
  });
  hostConn.on('error', function () {
    clearTimeout(connTimer);
  });
}

function onHostMessage(msg) {
  if (msg.t === 'welcome') {
    myRole = msg.role;
    myColor = msg.role === 'black' ? BLACK : msg.role === 'white' ? WHITE : 0;
    state = msg.state;
    enterRoom();
    toast(msg.role === 'white' ? 'Seated! You are White (second move)' : 'You are now spectating');
    return;
  }
  if (msg.t === 'state') {
    state = msg.state;
    renderAll();
    return;
  }
  if (msg.t === 'error') {
    toast(msg.msg);
    return;
  }
}

function errTypeText(err) {
  var map = {
    'browser-incompatible': 'Browser not supported',
    'network': 'Network error',
    'server-error': 'Signaling server error',
    'socket-error': 'Connection error',
    'socket-closed': 'Connection closed',
    'peer-unavailable': 'Peer offline'
  };
  return (err && map[err.type]) || 'Unknown error';
}

/* ---------------- Shared: enter / leave ---------------- */
function enterRoom() {
  rematchSeen = '';
  hideModal();
  $('room-code').textContent = roomCode;
  var badge = $('role-badge');
  badge.textContent = myRole === 'black' ? 'Black · First' : myRole === 'white' ? 'White · Second' : 'Spectating';
  badge.className = 'role-badge ' + myRole;
  showScreen('screen-room');
  renderAll();
}

function cleanupToHome() {
  try { if (hostConn) hostConn.close(); } catch (e) {}
  conns.forEach(function (rec) { try { rec.conn.close(); } catch (e) {} });
  conns.clear();
  hostConn = null;
  try { if (peer) peer.destroy(); } catch (e) {}
  peer = null;
  mode = null; myRole = null; myColor = 0; roomCode = '';
  state = null; connecting = false; rematchSeen = '';
  hideModal();
  setNetDot(false);
  $('input-code').value = '';
  showScreen('screen-home');
}

function onLeave() { cleanupToHome(); }

function copyRoomCode() {
  var done = function () { toast('Room code copied'); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(roomCode).then(done, function () { fallbackCopy(done); });
  } else fallbackCopy(done);
}
function fallbackCopy(done) {
  var ta = document.createElement('textarea');
  ta.value = roomCode;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed. Room code: ' + roomCode); }
  document.body.removeChild(ta);
}

/* ---------------- Rematch ---------------- */
function onRematch() {
  if (!state || state.status !== 'over' || state.rematchBy) return;
  if (mode === 'host') hostRequestRematch();
  else if (hostConn) hostConn.send({ t: 'rematch' });
}
function acceptRematch() {
  hideModal();
  if (mode === 'host') hostAcceptRematch();
  else if (hostConn) hostConn.send({ t: 'rematch-accept' });
}
function declineRematch() {
  hideModal();
  if (mode === 'host') hostDeclineRematch();
  else if (hostConn) hostConn.send({ t: 'rematch-decline' });
}
function onResign() {
  showConfirm('Resign the game?', function () {
    hideModal();
    if (mode === 'host') hostResign();
    else if (hostConn) hostConn.send({ t: 'resign' });
  }, hideModal);
}

/* ---------------- Dialog ---------------- */
function showConfirm(text, onOk, onCancel) {
  $('modal-text').textContent = text;
  $('modal-ok').onclick = onOk;
  $('modal-cancel').onclick = onCancel;
  $('modal').classList.remove('hidden');
}
function hideModal() { $('modal').classList.add('hidden'); }

/* ---------------- Board rendering ---------------- */
var canvas, ctx, boardSize = 0, pad = 0, cell = 0;

function initBoard() {
  canvas = $('board');
  ctx = canvas.getContext('2d');
  canvas.addEventListener('pointerdown', onBoardTap);
  window.addEventListener('resize', resizeBoard);
}

function resizeBoard() {
  if (!canvas || $('screen-room').classList.contains('hidden')) return;
  var wrap = $('board-wrap');
  var size = Math.floor(Math.min(wrap.clientWidth, 560));
  if (size <= 0) return;
  var dpr = window.devicePixelRatio || 1;
  boardSize = size;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pad = size * 0.075;
  cell = (size - pad * 2) / (BOARD_SIZE - 1);
  drawBoard();
}

function onBoardTap(e) {
  if (!state || state.status !== 'playing') return;
  if (myRole !== 'black' && myRole !== 'white') return; // spectators cannot move
  if (state.turn !== myColor) { toast('Not your turn'); return; }
  var rect = canvas.getBoundingClientRect();
  var px = e.clientX - rect.left, py = e.clientY - rect.top;
  var x = Math.round((px - pad) / cell), y = Math.round((py - pad) / cell);
  if (x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) return;
  if (state.board[y][x] !== EMPTY) return;
  if (mode === 'host') hostMove(x, y);
  else if (hostConn) hostConn.send({ t: 'move', x: x, y: y });
}

function drawBoard() {
  if (!state) return;
  var s = boardSize;
  // board background
  var g = ctx.createLinearGradient(0, 0, s, s);
  g.addColorStop(0, '#e2b968');
  g.addColorStop(1, '#d0a24e');
  ctx.fillStyle = g;
  roundRect(ctx, 0, 0, s, s, 14);
  ctx.fill();
  // grid
  ctx.strokeStyle = 'rgba(74,52,28,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (var i = 0; i < BOARD_SIZE; i++) {
    var p = pad + i * cell;
    ctx.moveTo(pad, p); ctx.lineTo(s - pad, p);
    ctx.moveTo(p, pad); ctx.lineTo(p, s - pad);
  }
  ctx.stroke();
  // thicker border
  ctx.lineWidth = 2.5;
  ctx.strokeRect(pad, pad, s - pad * 2, s - pad * 2);
  // star points
  var stars = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];
  ctx.fillStyle = 'rgba(74,52,28,0.95)';
  stars.forEach(function (pt) {
    ctx.beginPath();
    ctx.arc(pad + pt[0] * cell, pad + pt[1] * cell, Math.max(2.5, cell * 0.09), 0, Math.PI * 2);
    ctx.fill();
  });
  // stones
  for (var y = 0; y < BOARD_SIZE; y++)
    for (var x = 0; x < BOARD_SIZE; x++) {
      var v = state.board[y][x];
      if (v !== EMPTY) drawStone(x, y, v);
    }
  // winning line highlight
  if (state.winLine) {
    ctx.strokeStyle = '#e23c3c';
    ctx.lineWidth = Math.max(2, cell * 0.08);
    state.winLine.forEach(function (pt) {
      ctx.beginPath();
      ctx.arc(pad + pt[0] * cell, pad + pt[1] * cell, cell * 0.46, 0, Math.PI * 2);
      ctx.stroke();
    });
  }
  // last move marker
  if (state.lastMove) {
    var lm = state.lastMove;
    ctx.fillStyle = '#e23c3c';
    ctx.beginPath();
    ctx.arc(pad + lm.x * cell, pad + lm.y * cell, Math.max(2.5, cell * 0.1), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawStone(x, y, color) {
  var cx = pad + x * cell, cy = pad + y * cell, r = cell * 0.46;
  var g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.12, cx, cy, r);
  if (color === BLACK) {
    g.addColorStop(0, '#6b7280');
    g.addColorStop(0.6, '#2b2f36');
    g.addColorStop(1, '#0b0d10');
  } else {
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.7, '#eef1f5');
    g.addColorStop(1, '#c3c9d2');
  }
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* ---------------- Rendering: status / roster / buttons ---------------- */
function renderAll() {
  if (!state) return;
  drawBoard();
  renderStatus();
  renderRoster();
  renderActions();
  // Opponent requested a rematch → show confirm dialog (once)
  var needDialog = state.status === 'over' && state.rematchBy &&
    state.rematchBy !== mySide() && (myRole === 'black' || myRole === 'white');
  var key = state.rematchBy + ':' + state.moveCount;
  if (needDialog && rematchSeen !== key) {
    rematchSeen = key;
    showConfirm(nameOf(state.rematchBy) + ' wants a rematch. Accept?', acceptRematch, declineRematch);
  } else if (!needDialog) {
    hideModal();
  }
}

function renderStatus() {
  var bar = $('status-bar');
  var main = '', sub = '';
  if (state.status === 'waiting') {
    main = 'Waiting for opponent…';
    sub = 'Share room code ' + roomCode + ' with a friend on the same WiFi';
  } else if (state.status === 'playing') {
    var tname = state.turn === BLACK ? nameOf('black') : nameOf('white');
    var tcolor = state.turn === BLACK ? 'Black' : 'White';
    if (myRole === 'spectator') main = tname + ' (' + tcolor + ') to move…';
    else if (state.turn === myColor) main = 'Your move (' + tcolor + ')';
    else main = 'Waiting for ' + tname + '…';
  } else {
    if (state.winner === 0) main = "It's a draw!";
    else if (state.winner === myColor) main = 'You win! 🎉';
    else main = nameOf(state.winner === BLACK ? 'black' : 'white') + ' wins';
  }
  if (state.notice) sub = state.notice;
  bar.innerHTML = '<div class="main">' + esc(main) + '</div>' +
    (sub ? '<div class="sub">' + esc(sub) + '</div>' : '');
}

function renderRoster() {
  var box = $('roster');
  var html = '';
  html += playerCard('black', BLACK);
  html += '<div class="vs">VS</div>';
  html += playerCard('white', WHITE);
  var sp = state.spectators || [];
  html += '<div class="spectators">' +
    (sp.length ? 'Spectators (' + sp.length + '): ' + esc(sp.map(function (s) { return s.name; }).join(', ')) : 'No spectators') +
    '</div>';
  box.innerHTML = html;
}

function playerCard(side, color) {
  var p = state.players[side];
  var isTurn = state.status === 'playing' && state.turn === color;
  var isMe = (side === 'black' && myRole === 'black') || (side === 'white' && myRole === 'white');
  return '<div class="player-card' + (isTurn ? ' turn' : '') + '">' +
    '<span class="stone-dot ' + (color === BLACK ? 'b' : 'w') + '"></span>' +
    '<span class="pinfo"><span class="pname">' + esc(p ? p.name : 'Waiting…') +
    (isMe ? ' (you)' : '') + '</span>' +
    '<span class="pside">' + (color === BLACK ? 'Black · First move' : 'White') + '</span></span>' +
    (isTurn ? '<span class="turn-dot"></span>' : '') +
    '</div>';
}

function renderActions() {
  var box = $('actions');
  box.innerHTML = '';
  var iPlayer = myRole === 'black' || myRole === 'white';
  var mk = function (text, cls, fn, disabled) {
    var b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = text;
    if (disabled) b.disabled = true;
    else b.addEventListener('click', fn);
    box.appendChild(b);
  };
  if (iPlayer && state.status === 'playing') mk('Resign', 'btn-danger', onResign);
  if (iPlayer && state.status === 'over') {
    if (state.rematchBy === mySide()) mk('Request sent, waiting…', 'btn-primary', null, true);
    else if (state.rematchBy) mk('Rematch', 'btn-primary', null, true);
    else mk('Rematch', 'btn-primary', onRematch);
  }
  mk('Leave room', 'btn-ghost', onLeave);
}

/* ---------------- Boot ---------------- */
document.addEventListener('DOMContentLoaded', function () {
  initHome();
  initBoard();
  $('room-code').addEventListener('click', copyRoomCode);
});
