'use strict';
/* Gomoku · LAN Play — application layer
 * Depends on: logic.js (pure game logic), PeerJS CDN (window.Peer)
 *
 * Networking model:
 * - Whoever creates the room = host = Black in round 1, and is authoritative:
 *   validates every move, owns the full state, broadcasts it to everyone.
 * - The first to join the room takes the other seat; everyone after spectates.
 * - Colors alternate after every finished game (standard match play):
 *   seat holders swap, round++.
 * - Room code is 4 chars; Peer ID is 'gomoku-' + room code.
 *
 * Seat model: state.players.black/white = { name, holder } | null
 *   holder is 'host' or a host-side connection id.
 *
 * Seat robustness:
 * - Host tracks each DataConnection by a unique connection id, not by peer id.
 * - A new connection from an already-seen peer replaces the old one (reconnect).
 * - Heartbeat both directions: connections silent for >20s are treated as dead
 *   and their seats are freed.
 * - When a seat frees up, the earliest spectator is auto-promoted
 *   ("first come, first seated").
 *
 * In-game requests (need the other seat's confirmation):
 *   state.request = { type: 'rematch'|'undo'|'draw', by: 'black'|'white' } | null
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
var conns = new Map();    // host side: connId -> { conn, name, role, lastPong, replaced }
var peerToConn = {};      // host side: peerId -> connId (one live connection per peer)
var state = null;         // local copy of state (authoritative on host side)
var reqSeen = '';         // marker of the request dialog already shown
var reqSeq = 0;           // increments per request so repeated requests always re-show the dialog
var connecting = false;
var netTimer = null;      // join/create deadline timer (covers every silent stall)
var netStage = '';        // 'creating' | 'signaling' | 'connecting' | 'waiting-welcome'
var NET_TIMEOUT_MS = 15000;
/* ICE servers: Google STUN for direct connections plus a public TURN relay
 * as fallback. Without TURN, two phones behind symmetric NATs (common on
 * cellular networks) cannot establish a WebRTC connection at all — the join
 * just times out at the 'connecting' stage. TURN only relays encrypted
 * WebRTC traffic; it cannot read game data. Adding it is strictly additive:
 * if the relay is unreachable, behavior is unchanged. */
var ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};
var hbTimer = null;       // host heartbeat interval
var hostHbTimer = null;   // guest watchdog interval
var lastHostPong = 0;
var cidSeq = 0;

/* ---------------- Helpers ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function clampName(s) {
  return String(s || '').trim().slice(0, 12);
}
function toast(msg, ms) {
  var wrap = $('toast-wrap');
  var d = document.createElement('div');
  d.className = 'toast';
  d.textContent = msg;
  wrap.appendChild(d);
  while (wrap.children.length > 3) wrap.removeChild(wrap.firstChild);
  setTimeout(function () {
    d.classList.add('out');
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 300);
  }, ms || 2200);
}
function vibrate(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms || 15); } catch (e) {}
}
function snapshot(s) { return JSON.parse(JSON.stringify(s)); }

/* Join/create progress: one deadline timer covers the whole flow, so a stall
 * at ANY stage (signaling unreachable, host unreachable, host never replies
 * to hello) ends with a visible, actionable error instead of a dead screen.
 * netStage names the stage so the message can say what actually got stuck. */
function startNetTimer(stage) {
  clearNetTimer();
  netStage = stage;
  netTimer = setTimeout(onNetTimeout, NET_TIMEOUT_MS);
}
function clearNetTimer() {
  if (netTimer) { clearTimeout(netTimer); netTimer = null; }
  netStage = '';
}
function onNetTimeout() {
  var msg =
    netStage === 'creating' ? 'Could not create a room: cannot reach the signaling server. Check your connection and try again.' :
    netStage === 'signaling' ? 'Could not reach the signaling server. Check your connection and try again.' :
    netStage === 'connecting' ? connectingTimeoutMsg() :
    'Connected, but the host did not respond. The host may have locked their phone, left, or lost connection — ask them to recreate the room.';
  toast(msg, 6000);
  cleanupToHome();
}
/* Tailor the 'connecting' timeout: an ICE 'failed' state means the networks
 * could not link the phones (NAT/firewall), while anything else means the
 * host simply never answered. */
function connectingTimeoutMsg() {
  var ice = '';
  try { ice = hostConn && hostConn.peerConnection && hostConn.peerConnection.iceConnectionState; } catch (e) {}
  if (ice === 'failed') return 'Connection failed: the two phones could not link directly or via relay. Try both phones on the same WiFi, with the host page open in the foreground.';
  return 'Connection timed out. The host may not be responding — keep the host page open in the foreground — or the room code may be wrong.';
}
function setJoinBusy(busy) {
  var b = $('btn-join');
  b.disabled = busy;
  b.textContent = busy ? 'Joining…' : 'Join';
}
function setCreateBusy(busy) { $('btn-create').disabled = busy; }
function setJoinStatus(t) { var b = $('join-status'); if (b) b.textContent = t || ''; }

/* Local network info: gather ICE candidates from a throwaway connection and
 * show the device's LAN address, so two players can check they share a WiFi.
 * Modern browsers mask the real LAN address as a .local mDNS name; we say so
 * instead of showing a useless value. */
function probeNetInfo() {
  var boxes = [$('net-info'), $('net-info-home')];
  var setText = function (t) { boxes.forEach(function (b) { if (b) b.textContent = t; }); };
  try {
    if (typeof RTCPeerConnection === 'undefined') return;
    var pc = new RTCPeerConnection({ iceServers: ICE_CONFIG.iceServers });
    var done = false;
    var hostIp = '', pubIp = '';
    var finish = function () {
      if (done) return; done = true;
      try { pc.close(); } catch (e) {}
      setText(netInfoText(hostIp, pubIp));
    };
    pc.onicecandidate = function (e) {
      if (!e.candidate) { finish(); return; }
      var c = String(e.candidate.candidate || '').split(' ');
      if (c[7] === 'host' && !hostIp) hostIp = c[4];
      else if (c[7] === 'srflx' && !pubIp) pubIp = c[4];
    };
    pc.createDataChannel('probe');
    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () { finish(); });
    setTimeout(finish, 4000);
  } catch (e) {}
}
function netInfoText(hostIp, pubIp) {
  if (!hostIp && !pubIp) return '';
  if (hostIp && hostIp.indexOf('.local') >= 0) return 'LAN: ' + hostIp + ' (browser masks the real IP)';
  if (hostIp) return 'LAN: ' + hostIp + (pubIp ? ' · Net: ' + pubIp : '');
  return 'Net: ' + pubIp;
}

/* Screen wake lock: while hosting, keep the phone screen on so the browser
 * is not frozen by lock/backgrounding while the friend joins. Released on
 * leave; re-requested when the tab becomes visible again. */
var wakeLock = null;
function requestWakeLock() {
  try {
    if (navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen').then(function (lock) { wakeLock = lock; }).catch(function () {});
    }
  } catch (e) {}
}
function releaseWakeLock() {
  try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
}
function mySide() {
  return myRole === 'black' ? 'black' : myRole === 'white' ? 'white' : 'spectator';
}
function otherSeat(s) { return s === 'black' ? 'white' : 'black'; }
function nameOf(seat) {
  if (!state || !state.players) return '';
  var p = state.players[seat];
  return p ? p.name : '';
}
function reqName(type) {
  return type === 'rematch' ? 'a rematch' : type === 'undo' ? 'to undo a move' : 'a draw';
}
function makeCode() {
  var abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  var s = '';
  for (var i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}
function connIdOf(conn) {
  if (!conn._cid) conn._cid = conn.connectionId || ('c' + (++cidSeq) + '_' + conn.peer);
  return conn._cid;
}
/* Which seat does the host currently hold? The host always holds exactly one. */
function hostSeat() {
  if (state && state.players.black && state.players.black.holder === 'host') return 'black';
  if (state && state.players.white && state.players.white.holder === 'host') return 'white';
  return 'black';
}
/* Is a seat currently held by someone live? */
function seatLive(seat) {
  var p = state.players[seat];
  if (!p) return false;
  return p.holder === 'host' || conns.has(p.holder);
}
function freeSeat() {
  if (!seatLive('black')) return 'black';
  if (!seatLive('white')) return 'white';
  return null;
}
function uniqueName(name, selfConnId) {
  var taken = {};
  ['black', 'white'].forEach(function (s) {
    var p = state.players[s];
    if (p && seatLive(s) && p.holder !== selfConnId) taken[p.name] = true;
  });
  (state.spectators || []).forEach(function (sp) {
    if (sp.id !== selfConnId) taken[sp.name] = true;
  });
  if (!taken[name]) return name;
  var i = 2;
  while (taken[name + ' ' + i]) i++;
  return name + ' ' + i;
}
function creditWin(seat) {
  var n = nameOf(seat);
  if (!n) return;
  state.score[n] = (state.score[n] || 0) + 1;
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
  resetNetState();
  connecting = true;
  mode = 'host';
  roomCode = makeCode();
  setCreateBusy(true);
  startNetTimer('creating');
  setJoinStatus('Creating room…');
  openHostPeer();
}

function resetNetState() {
  try { if (peer) peer.destroy(); } catch (e) {}
  peer = null;
  hostConn = null;
  conns.clear();
  peerToConn = {};
  stopHeartbeat();
  stopHostWatchdog();
}

function openHostPeer() {
  peer = new Peer('gomoku-' + roomCode, { config: ICE_CONFIG });
  peer.on('open', function () {
    connecting = false;
    clearNetTimer();
    state = newWaitingState(myName);
    state.players.black.holder = 'host';
    myRole = 'black';
    myColor = BLACK;
    setNetDot(true);
    enterRoom();
    startHeartbeat();
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
  var id = connIdOf(conn);
  // Register immediately on 'connection' — do NOT wait for 'open'.
  // The guest sends its hello as soon as its side opens, which can win the
  // race; a hello arriving before our 'open' must not be dropped.
  // A new connection from an already-seen peer replaces the old one
  // (handles re-join / duplicate connections without ghost seats).
  var oldId = peerToConn[conn.peer];
  if (oldId && oldId !== id) {
    var oldRec = conns.get(oldId);
    if (oldRec) {
      oldRec.replaced = true;
      conns.delete(oldId);
      try { oldRec.conn.close(); } catch (e) {}
    }
  }
  conns.set(id, { conn: conn, name: '', role: '', lastPong: Date.now(), replaced: false });
  peerToConn[conn.peer] = id;
  conn.on('data', function (msg) { handleGuestMessage(conn, msg || {}); });
  conn.on('close', function () { onGuestLeft(conn); });
  conn.on('error', function () { onGuestLeft(conn); });
}

/* Reply with the welcome packet (and the following broadcast) as soon as the
 * channel is actually open; PeerJS may drop sends issued before 'open'. */
function sendWelcome(rec, conn) {
  var id = connIdOf(conn);
  var doIt = function () {
    var r = conns.get(id);
    if (!r || r.replaced) return;
    sendTo(r, { t: 'welcome', role: r.role, state: state });
    broadcastState();
  };
  if (conn.open) doIt();
  else conn.on('open', doIt);
}

function sendTo(rec, msg) {
  try { rec.conn.send(snapshot(msg)); } catch (e) {}
}

function broadcastState() {
  var snap = snapshot({ t: 'state', state: state });
  conns.forEach(function (rec) {
    if (!rec.conn.open) return; // not ready yet; they get full state via welcome
    try { rec.conn.send(snap); } catch (e) {}
  });
  renderAll();
}

function handleGuestMessage(conn, msg) {
  var id = connIdOf(conn);
  var rec = conns.get(id);
  if (!rec || rec.replaced) return;

  if (msg.t === 'ping') { sendTo(rec, { t: 'pong' }); return; }
  if (msg.t === 'pong') { rec.lastPong = Date.now(); if (state) renderRoster(); return; }

  if (msg.t === 'hello') {
    if (rec.role) { sendWelcome(rec, conn); return; }
    var name = uniqueName(clampName(msg.name) || 'Player', id);
    rec.name = name;
    var seat = freeSeat();
    if (seat) {
      rec.role = seat;
      state.players[seat] = { name: name, holder: id };
      if (state.status === 'waiting' && state.players.black && state.players.white) {
        state.status = 'playing';
        state.notice = '';
      }
      toast(name + ' took the ' + (seat === 'black' ? 'Black' : 'White') + ' seat');
    } else {
      rec.role = 'spectator';
      state.spectators.push({ id: id, name: name });
      toast(name + ' joined as spectator');
    }
    sendWelcome(rec, conn);
    return;
  }

  if (msg.t === 'move') {
    var turnSeat = state.turn === BLACK ? 'black' : 'white';
    if (rec.role !== turnSeat) {
      sendTo(rec, { t: 'error', msg: rec.role ? 'Not your turn' : 'Spectators cannot place stones' });
      return;
    }
    var color = state.turn;
    state.notice = '';
    var r = applyMove(state, msg.x | 0, msg.y | 0, color);
    if (!r.ok) { sendTo(rec, { t: 'error', msg: r.error }); return; }
    state.history.push({ x: msg.x | 0, y: msg.y | 0, color: color });
    if (r.winLine) creditWin(turnSeat);
    vibrate();
    broadcastState();
    return;
  }

  if (msg.t === 'resign') {
    if ((rec.role !== 'black' && rec.role !== 'white') || state.status !== 'playing') return;
    endByResign(rec.role);
    return;
  }

  if (msg.t === 'request') {
    if (!validRequest(rec.role, msg.type)) return;
    state.request = { type: msg.type, by: rec.role, seq: ++reqSeq };
    broadcastState();
    return;
  }

  if (msg.t === 'request-accept') {
    var rq = state.request;
    if (!rq) return;
    if (rec.role !== otherSeat(rq.by)) return; // only the other seat can accept
    applyRequest();
    return;
  }

  if (msg.t === 'request-decline') {
    var rq2 = state.request;
    if (!rq2) return;
    if (rec.role !== otherSeat(rq2.by)) return;
    state.request = null;
    state.notice = nameOf(rec.role) + ' declined ' + reqName(rq2.type);
    broadcastState();
    return;
  }
}

function validRequest(seat, type) {
  if (state.request) return false;
  if (seat !== 'black' && seat !== 'white') return false;
  if (type === 'rematch') return state.status === 'over';
  if (type === 'draw') return state.status === 'playing';
  if (type === 'undo') return state.status === 'playing' && state.history.length > 0;
  return false;
}

/* Apply an accepted request (host side). */
function applyRequest() {
  var rq = state.request;
  if (!rq) return;
  if (rq.type === 'rematch') {
    var b = state.players.black, w = state.players.white;
    if (b && w) {
      // Standard match play: swap colors, next round.
      state.players.black = w;
      state.players.white = b;
      state.round++;
      state.notice = 'Round ' + state.round + ' — colors swapped';
    } else {
      state.notice = '';
    }
    state.request = null;
    resetBoard(state);
    if (!state.players.black || !state.players.white) state.status = 'waiting';
    syncRoles();
  } else if (rq.type === 'undo') {
    var last = state.history.pop();
    if (last) {
      state.board[last.y][last.x] = EMPTY;
      state.moveCount--;
      state.turn = last.color;
      var prev = state.history[state.history.length - 1];
      state.lastMove = prev ? { x: prev.x, y: prev.y, color: prev.color } : null;
    }
    state.request = null;
    state.notice = '';
  } else if (rq.type === 'draw') {
    state.status = 'over';
    state.winner = 0;
    state.turn = 0;
    state.request = null;
    state.notice = '';
  }
  broadcastState();
}

/* After seats change hands: refresh host role + tell seated guests their role. */
function syncRoles() {
  myRole = hostSeat();
  myColor = myRole === 'black' ? BLACK : WHITE;
  var badge = $('role-badge');
  badge.textContent = myRole === 'black' ? 'Black · First' : 'White · Second';
  badge.className = 'role-badge ' + myRole;
  ['black', 'white'].forEach(function (seat) {
    var p = state.players[seat];
    if (p && p.holder && p.holder !== 'host') {
      var rec = conns.get(p.holder);
      if (rec) {
        rec.role = seat;
        sendTo(rec, { t: 'welcome', role: seat, state: state });
      }
    }
  });
}

function onGuestLeft(conn) {
  var id = connIdOf(conn);
  var rec = conns.get(id);
  if (!rec) return;
  conns.delete(id);
  if (peerToConn[conn.peer] === id) delete peerToConn[conn.peer];
  if (rec.replaced) return; // superseded by a newer connection; the seat stays
  var seat = (rec.role === 'black' || rec.role === 'white') ? rec.role : null;
  if (seat && state.players[seat] && state.players[seat].holder === id) {
    var name = state.players[seat].name;
    state.players[seat] = null;
    state.request = null;
    if (state.status === 'playing') {
      state.board = createBoard();
      state.turn = BLACK;
      state.status = 'waiting';
      state.winner = 0;
      state.winLine = null;
      state.lastMove = null;
      state.moveCount = 0;
      state.history = [];
    }
    state.notice = name + ' left the room';
    toast(name + ' left the room');
    promoteSpectator(seat);
    if (state.status === 'waiting' && state.players.black && state.players.white) {
      state.status = 'playing';
      state.notice = '';
    }
  } else if (rec.role === 'spectator') {
    state.spectators = state.spectators.filter(function (s) { return s.id !== id; });
    toast(rec.name + ' stopped spectating');
  }
  broadcastState();
}

/* First spectator in line takes the freed seat ("first come, first seated"). */
function promoteSpectator(seat) {
  var sp = state.spectators;
  if (!sp.length) return;
  var next = sp.shift();
  var rec = conns.get(next.id);
  if (!rec || rec.replaced) { promoteSpectator(seat); return; }
  rec.role = seat;
  state.players[seat] = { name: rec.name, holder: next.id };
  sendTo(rec, { t: 'welcome', role: seat, state: state });
  toast(rec.name + ' took the ' + (seat === 'black' ? 'Black' : 'White') + ' seat');
}

/* Host heartbeat: reap connections silent for >20s (ghost peers). */
function startHeartbeat() {
  stopHeartbeat();
  hbTimer = setInterval(function () {
    if (mode !== 'host') return;
    var now = Date.now();
    conns.forEach(function (rec, id) {
      if (rec.replaced) { conns.delete(id); return; }
      if (now - rec.lastPong > 20000) {
        try { rec.conn.close(); } catch (e) {}
        onGuestLeft(rec.conn);
      } else {
        try { rec.conn.send({ t: 'ping' }); } catch (e) {}
      }
    });
    if (state) renderRoster();
  }, 8000);
}
function stopHeartbeat() {
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
}

/* Host (local player) actions */
function hostMove(x, y) {
  var turnSeat = state.turn === BLACK ? 'black' : 'white';
  if (hostSeat() !== turnSeat) { toast('Not your turn'); return; }
  var color = state.turn;
  state.notice = '';
  var r = applyMove(state, x, y, color);
  if (!r.ok) { toast(r.error); return; }
  state.history.push({ x: x, y: y, color: color });
  if (r.winLine) creditWin(turnSeat);
  vibrate();
  broadcastState();
}
function endByResign(seat) {
  if (state.status !== 'playing') return;
  var winnerSeat = otherSeat(seat);
  state.status = 'over';
  state.winner = winnerSeat === 'black' ? BLACK : WHITE;
  state.turn = 0;
  state.request = null;
  state.notice = nameOf(seat) + ' resigned';
  creditWin(winnerSeat);
  broadcastState();
}
function sendRequest(type) {
  if (mode === 'host') {
    if (!validRequest(hostSeat(), type)) return;
    state.request = { type: type, by: hostSeat(), seq: ++reqSeq };
    broadcastState();
  } else if (hostConn) {
    hostConn.send({ t: 'request', type: type });
  }
}
function acceptRequest() {
  hideModal();
  if (mode === 'host') applyRequest();
  else if (hostConn) hostConn.send({ t: 'request-accept' });
}
function declineRequest() {
  hideModal();
  if (mode === 'host') {
    var rq = state.request;
    if (!rq) return;
    state.request = null;
    state.notice = nameOf(hostSeat()) + ' declined ' + reqName(rq.type);
    broadcastState();
  } else if (hostConn) {
    hostConn.send({ t: 'request-decline' });
  }
}
function onResign() {
  showConfirm('Resign the game?', function () {
    hideModal();
    if (mode === 'host') endByResign(hostSeat());
    else if (hostConn) hostConn.send({ t: 'resign' });
  }, hideModal);
}

/* ---------------- Guest (seated player / spectator) ---------------- */
function joinRoom(code) {
  if (typeof Peer === 'undefined') { toast('Failed to load network module. Check your connection and refresh.'); return; }
  resetNetState();
  connecting = true;
  mode = 'guest';
  roomCode = code;
  setJoinBusy(true);
  startNetTimer('signaling');
  setJoinStatus('Connecting to signaling server…');
  peer = new Peer({ config: ICE_CONFIG }); // random ID
  peer.on('open', function () {
    netStage = 'connecting';
    setJoinStatus('Contacting host…');
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
      toast('Room not found. Check the room code.', 6000);
    } else {
      toast('Failed to join: ' + errTypeText(err), 6000);
    }
    cleanupToHome();
  });
}

function wireHostConn() {
  hostConn.on('open', function () {
    connecting = false;
    netStage = 'waiting-welcome';
    setJoinStatus('Waiting for host reply…');
    setNetDot(true);
    lastHostPong = Date.now();
    startHostWatchdog();
    hostConn.send({ t: 'hello', name: myName });
  });
  hostConn.on('data', function (msg) { onHostMessage(msg || {}); });
  hostConn.on('close', function () {
    stopHostWatchdog();
    if (mode === 'guest') {
      toast('The host left the room');
      cleanupToHome();
    }
  });
  hostConn.on('error', function () {});
}

/* Guest watchdog: if the host goes silent for >20s, leave the room. */
function startHostWatchdog() {
  stopHostWatchdog();
  hostHbTimer = setInterval(function () {
    if (mode !== 'guest' || !hostConn) return;
    if (Date.now() - lastHostPong > 20000) {
      stopHostWatchdog();
      toast('Lost connection to host');
      cleanupToHome();
      return;
    }
    try { hostConn.send({ t: 'ping' }); } catch (e) {}
    if (state) renderRoster();
  }, 8000);
}
function stopHostWatchdog() {
  if (hostHbTimer) { clearInterval(hostHbTimer); hostHbTimer = null; }
}

function onHostMessage(msg) {
  if (msg.t === 'ping') { try { hostConn.send({ t: 'pong' }); } catch (e) {} return; }
  if (msg.t === 'pong') { lastHostPong = Date.now(); if (state) renderRoster(); return; }
  if (msg.t === 'welcome') {
    clearNetTimer();
    myRole = msg.role;
    myColor = msg.role === 'black' ? BLACK : msg.role === 'white' ? WHITE : 0;
    state = msg.state;
    enterRoom();
    toast(
      msg.role === 'black' ? 'You are now Black (first move)' :
      msg.role === 'white' ? 'Seated! You are White (second move)' :
      'You are now spectating'
    );
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
  reqSeen = '';
  setJoinBusy(false);
  setCreateBusy(false);
  setJoinStatus('');
  probeNetInfo();
  if (mode === 'host') requestWakeLock();
  hideModal();
  $('room-code').textContent = roomCode;
  var badge = $('role-badge');
  badge.textContent = myRole === 'black' ? 'Black · First' : myRole === 'white' ? 'White · Second' : 'Spectating';
  badge.className = 'role-badge ' + myRole;
  showScreen('screen-room');
  renderAll();
}

function cleanupToHome() {
  clearNetTimer();
  releaseWakeLock();
  setJoinBusy(false);
  setCreateBusy(false);
  setJoinStatus('');
  // Clear state BEFORE closing connections, so the close handlers fired by
  // those closes see a torn-down room and stay quiet (no duplicate toasts,
  // no re-entrant cleanup, no seat shuffling on a room being left).
  var hc = hostConn;
  var all = [];
  conns.forEach(function (rec) { all.push(rec.conn); });
  conns.clear();
  peerToConn = {};
  mode = null; myRole = null; myColor = 0; roomCode = '';
  state = null; connecting = false; reqSeen = '';
  try { if (hc) hc.close(); } catch (e) {}
  all.forEach(function (c) { try { c.close(); } catch (e) {} });
  stopHeartbeat();
  stopHostWatchdog();
  resetNetState();
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
  if (!state) return;
  if (state.status === 'waiting') { toast('Waiting for opponent to join'); return; }
  if (state.status !== 'playing') return;
  if (myRole !== 'black' && myRole !== 'white') { toast('Spectators cannot move'); return; }
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
  var g = ctx.createLinearGradient(0, 0, s, s);
  g.addColorStop(0, '#e2b968');
  g.addColorStop(1, '#d0a24e');
  ctx.fillStyle = g;
  roundRect(ctx, 0, 0, s, s, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(74,52,28,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (var i = 0; i < BOARD_SIZE; i++) {
    var p = pad + i * cell;
    ctx.moveTo(pad, p); ctx.lineTo(s - pad, p);
    ctx.moveTo(p, pad); ctx.lineTo(p, s - pad);
  }
  ctx.stroke();
  ctx.lineWidth = 2.5;
  ctx.strokeRect(pad, pad, s - pad * 2, s - pad * 2);
  var stars = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];
  ctx.fillStyle = 'rgba(74,52,28,0.95)';
  stars.forEach(function (pt) {
    ctx.beginPath();
    ctx.arc(pad + pt[0] * cell, pad + pt[1] * cell, Math.max(2.5, cell * 0.09), 0, Math.PI * 2);
    ctx.fill();
  });
  for (var y = 0; y < BOARD_SIZE; y++)
    for (var x = 0; x < BOARD_SIZE; x++) {
      var v = state.board[y][x];
      if (v !== EMPTY) drawStone(x, y, v);
    }
  if (state.winLine) {
    ctx.strokeStyle = '#e23c3c';
    ctx.lineWidth = Math.max(2, cell * 0.08);
    state.winLine.forEach(function (pt) {
      ctx.beginPath();
      ctx.arc(pad + pt[0] * cell, pad + pt[1] * cell, cell * 0.46, 0, Math.PI * 2);
      ctx.stroke();
    });
  }
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
  c.arcTo(x, y, x + w, y, r);
  c.arcTo(x + w, y + h, x, y, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* ---------------- Rendering: match / status / roster / buttons ---------------- */
function renderAll() {
  if (!state) return;
  drawBoard();
  renderMatchLine();
  renderStatus();
  renderRoster();
  renderActions();
  var rq = state.request;
  var iPlayer = myRole === 'black' || myRole === 'white';
  var needDialog = !!(rq && iPlayer && rq.by !== myRole);
  if (!rq) reqSeen = '';
  var key = rq ? (rq.type + ':' + rq.by + ':' + rq.seq) : '';
  if (needDialog && reqSeen !== key) {
    reqSeen = key;
    showConfirm(nameOf(rq.by) + ' requests ' + reqName(rq.type) + '. Accept?', acceptRequest, declineRequest);
  } else if (!needDialog) {
    hideModal();
  }
}

function renderMatchLine() {
  var el = $('match-line');
  var b = state.players.black, w = state.players.white;
  var bn = b ? b.name : '—', wn = w ? w.name : '—';
  var bs = b ? (state.score[b.name] || 0) : 0;
  var ws = w ? (state.score[w.name] || 0) : 0;
  el.textContent = 'Game ' + state.round + '  ·  ' + bn + ' ' + bs + ' : ' + ws + ' ' + wn;
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
  if (state.request) {
    sub = nameOf(state.request.by) + ' requests ' + reqName(state.request.type) + '…';
  } else if (state.notice) {
    sub = state.notice;
  }
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

function linkStatus(side) {
  var p = state.players[side];
  if (!p) return null;
  if (mode === 'host') {
    if (p.holder === 'host') return 'self';
    var rec = conns.get(p.holder);
    if (!rec) return 'gone';
    return (Date.now() - rec.lastPong < 12000) ? 'online' : 'weak';
  }
  if (p.holder === 'host') {
    if (!lastHostPong) return 'gone';
    return (Date.now() - lastHostPong < 12000) ? 'online' : 'weak';
  }
  if ((side === 'black' && myRole === 'black') || (side === 'white' && myRole === 'white')) return 'self';
  return null;
}

function playerCard(side, color) {
  var p = state.players[side];
  var isTurn = state.status === 'playing' && state.turn === color;
  var isMe = (side === 'black' && myRole === 'black') || (side === 'white' && myRole === 'white');
  var wins = p ? (state.score[p.name] || 0) : 0;
  var ls = linkStatus(side);
  var linkHtml = ls === 'online' ? '<span class="plink on">● Online</span>' :
    ls === 'weak' ? '<span class="plink weak">● Connection weak</span>' :
    ls === 'gone' ? '<span class="plink off">● Offline</span>' : '';
  return '<div class="player-card' + (isTurn ? ' turn' : '') + '">' +
    '<span class="stone-dot ' + (color === BLACK ? 'b' : 'w') + '"></span>' +
    '<span class="pinfo"><span class="pname">' + esc(p ? p.name : 'Waiting…') +
    (isMe ? ' (you)' : '') + '</span>' +
    '<span class="pside">' + (color === BLACK ? 'Black · First move' : 'White') +
    (p ? ' · ' + wins + (wins === 1 ? ' win' : ' wins') : '') + '</span>' + linkHtml + '</span>' +
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
  if (iPlayer && state.status === 'playing') {
    var pending = !!state.request;
    mk('Undo', 'btn-secondary', function () { sendRequest('undo'); }, pending || state.history.length === 0);
    mk('Draw', 'btn-secondary', function () { sendRequest('draw'); }, pending);
    mk('Resign', 'btn-danger', onResign, pending);
  }
  if (iPlayer && state.status === 'over') {
    var rq = state.request;
    if (rq && rq.by === myRole) mk('Waiting…', 'btn-primary', null, true);
    else mk('Rematch', 'btn-primary', function () { sendRequest('rematch'); }, !!rq);
  }
  mk('Leave room', 'btn-ghost', onLeave);
}

/* ---------------- Boot ---------------- */
document.addEventListener('DOMContentLoaded', function () {
  initHome();
  initBoard();
  $('room-code').addEventListener('click', copyRoomCode);
  probeNetInfo();
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && mode === 'host') requestWakeLock();
  });
});
