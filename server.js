'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/health', (_req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, perMessageDeflate: false });

const PORT = process.env.PORT || 3000;

/** Admin config */
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || 'christophergomez6903@gmail.com')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

// Password for Kristoff admin login
const KRISTOFF_PASSWORD = process.env.KRISTOFF_PASSWORD || 'diazcanelsingao';

/** Solo match config */
const MAX_RECENT = 50;
const RELAX_WAIT_MS = 20_000;     // after this we relax "recent" restrictions
const FORCE_MATCH_WAIT_MS = 60_000;

/** Cupid config */
const CUPID_RELAX_WAIT_MS = 25_000;
const MAX_CUPID_RECENT = 60;

/** In-memory state */
const clients = new Map(); // id -> client object

const soloQueue = [];      // array of ids
const rooms = new Map();   // roomId -> {a,b, createdAt, fakeSkipOn}

const cupidQueue = [];     // array of ids waiting for cupid

let soloMatchScheduled = false;
let cupidFillScheduled = false;

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function capSetAdd(set, value, maxSize) {
  if (!set || !value) return;
  if (set.has(value)) return;
  set.add(value);
  // If too big, delete oldest-ish by iterating
  if (set.size > maxSize) {
    const first = set.values().next().value;
    set.delete(first);
  }
}

function getClient(id) {
  return id ? clients.get(id) : null;
}

function removeFromArray(arr, value) {
  const idx = arr.indexOf(value);
  if (idx >= 0) arr.splice(idx, 1);
}

/** -----------------------------
 *  SOLO MATCHMAKER
 *  ----------------------------- */

function canSoloMatch(a, b) {
  if (!a || !b) return false;
  if (a.id === b.id) return false;
  if (a.state !== 'waiting' || b.state !== 'waiting') return false;

  const now = Date.now();
  const waitedA = now - (a.joinTs || now);
  const waitedB = now - (b.joinTs || now);
  const relax = (waitedA > RELAX_WAIT_MS) || (waitedB > RELAX_WAIT_MS);

  if (!relax) {
    if (a.recentPeers.has(b.id)) return false;
    if (b.recentPeers.has(a.id)) return false;
  }
  return true;
}

function pickSoloPair() {
  // Clean queue from dead/non-waiting
  for (let i = soloQueue.length - 1; i >= 0; i--) {
    const id = soloQueue[i];
    const c = getClient(id);
    if (!c || c.state !== 'waiting' || !c.inQueue) {
      soloQueue.splice(i, 1);
    }
  }

  // Try best match avoiding recent
  for (let i = 0; i < soloQueue.length; i++) {
    const a = getClient(soloQueue[i]);
    if (!a || a.state !== 'waiting') continue;
    for (let j = i + 1; j < soloQueue.length; j++) {
      const b = getClient(soloQueue[j]);
      if (!b || b.state !== 'waiting') continue;
      if (canSoloMatch(a, b)) return [a.id, b.id];
    }
  }

  // Force match if someone waited too long
  const now = Date.now();
  const longWaiters = soloQueue
    .map(id => getClient(id))
    .filter(Boolean)
    .filter(c => c.state === 'waiting')
    .sort((x, y) => (x.joinTs || now) - (y.joinTs || now));

  if (longWaiters.length >= 2) {
    const first = longWaiters[0];
    const waited = now - (first.joinTs || now);
    if (waited > FORCE_MATCH_WAIT_MS) {
      return [longWaiters[0].id, longWaiters[1].id];
    }
  }

  return null;
}

function scheduleSoloMatch() {
  if (soloMatchScheduled) return;
  soloMatchScheduled = true;
  setImmediate(() => {
    soloMatchScheduled = false;
    runSoloMatch();
  });
}

function runSoloMatch() {
  while (true) {
    const pair = pickSoloPair();
    if (!pair) break;
    const [aId, bId] = pair;
    const a = getClient(aId);
    const b = getClient(bId);
    if (!a || !b) continue;
    if (!canSoloMatch(a, b)) continue;

    // Remove from queue
    removeFromArray(soloQueue, aId);
    removeFromArray(soloQueue, bId);
    a.inQueue = false;
    b.inQueue = false;

    // Create room
    const roomId = uuidv4();
    rooms.set(roomId, { a: aId, b: bId, createdAt: Date.now(), fakeSkipOn: false });

    a.state = 'in-room';
    b.state = 'in-room';
    a.roomId = roomId;
    b.roomId = roomId;

    capSetAdd(a.recentPeers, bId, MAX_RECENT);
    capSetAdd(b.recentPeers, aId, MAX_RECENT);

    safeSend(a.ws, { type: 'matched', roomId, role: 'offer', peer: { id: b.id, name: b.name, age: b.age, gender: b.gender } });
    safeSend(b.ws, { type: 'matched', roomId, role: 'answer', peer: { id: a.id, name: a.name, age: a.age, gender: a.gender } });
  }
}

function leaveSolo(id, reason = 'leave') {
  const me = getClient(id);
  if (!me) return;

  // remove from queue
  if (me.inQueue) {
    me.inQueue = false;
    removeFromArray(soloQueue, id);
  }

  // teardown room
  if (me.roomId) {
    teardownRoom(me.roomId, id, reason);
  }

  me.state = 'idle';
  me.roomId = null;
}

function teardownRoom(roomId, leaverId, reason) {
  const room = rooms.get(roomId);
  if (!room) return;

  const otherId = (room.a === leaverId) ? room.b : room.a;
  rooms.delete(roomId);

  const other = getClient(otherId);
  const leaver = getClient(leaverId);

  if (other) {
    other.roomId = null;
    other.state = 'idle';
    safeSend(other.ws, { type: 'peer-left', reason });
  }
  if (leaver) {
    leaver.roomId = null;
    leaver.state = 'idle';
  }
}

/** Forward solo signalling */
function forwardSoloSignal(fromId, payloadType, data) {
  const from = getClient(fromId);
  if (!from || !from.roomId) return;
  const room = rooms.get(from.roomId);
  if (!room) return;
  const toId = (room.a === fromId) ? room.b : room.a;
  const to = getClient(toId);
  if (!to) return;

  safeSend(to.ws, { type: payloadType, ...data });
}

/** Fake skip (solo only) */
function toggleFakeSkip(fromId) {
  const from = getClient(fromId);
  if (!from || !from.roomId) return;
  const room = rooms.get(from.roomId);
  if (!room) return;

  room.fakeSkipOn = !room.fakeSkipOn;

  const a = getClient(room.a);
  const b = getClient(room.b);
  if (a) safeSend(a.ws, { type: 'fake-skip', on: room.fakeSkipOn, role: a.isAdmin ? 'admin' : 'user' });
  if (b) safeSend(b.ws, { type: 'fake-skip', on: room.fakeSkipOn, role: b.isAdmin ? 'admin' : 'user' });
}

/** -----------------------------
 *  CUPID (GROUP OF 3)
 *  Host (admin) + up to 2 participants
 *  ----------------------------- */

function setCupidOff(me) {
  if (!me) return;
  me.cupidEnabled = false;
  me.cupidState = 'off';
  me.cupidInQueue = false;
  me.cupidJoinTs = 0;
  me.cupidHostId = null;
  me.cupidSeat = null;
  me.cupidSessionId = null;
  removeFromArray(cupidQueue, me.id);
}

function enqueueCupid(id) {
  const me = getClient(id);
  if (!me) return;
  if (!me.cupidEnabled || me.cupidState !== 'waiting') return;
  if (me.cupidInQueue) return;

  me.cupidInQueue = true;
  me.cupidJoinTs = Date.now();
  cupidQueue.push(id);
}

function removeFromCupidQueue(id) {
  removeFromArray(cupidQueue, id);
  const me = getClient(id);
  if (me) me.cupidInQueue = false;
}

function isAdminEmail(email) {
  if (!email) return false;
  return ADMIN_EMAILS.has(String(email).toLowerCase());
}

function canKristoffLogin(email, password) {
  if (!email || !password) return false;
  if (!isAdminEmail(email)) return false;
  return String(password) === String(KRISTOFF_PASSWORD);
}

function getActiveCupidHosts() {
  const out = [];
  for (const c of clients.values()) {
    if (c.isAdmin && c.cupidHostActive && c.ws && c.ws.readyState === 1) out.push(c);
  }
  return out;
}

function scheduleCupidFill() {
  if (cupidFillScheduled) return;
  cupidFillScheduled = true;
  setImmediate(() => {
    cupidFillScheduled = false;
    fillAllCupidHosts();
  });
}

function dequeueCupidCandidate(host, otherParticipantId = null) {
  const now = Date.now();

  // 1) Strict pass: avoid repeats
  for (let i = 0; i < cupidQueue.length; i++) {
    const id = cupidQueue[i];
    const u = getClient(id);
    if (!u) continue;
    if (!u.cupidEnabled || u.cupidState !== 'waiting') continue;
    if (id === host.id) continue;
    if (otherParticipantId && id === otherParticipantId) continue;

    const waited = now - (u.cupidJoinTs || now);
    const relax = waited > CUPID_RELAX_WAIT_MS || cupidQueue.length <= 2;

    if (!relax) {
      if (host.cupidRecentPeers.has(id)) continue;
      if (otherParticipantId) {
        const other = getClient(otherParticipantId);
        if (other && other.cupidRecentPeers.has(id)) continue;
        if (u.cupidRecentPeers.has(otherParticipantId)) continue;
      }
    }

    // remove and return
    cupidQueue.splice(i, 1);
    u.cupidInQueue = false;
    return u;
  }

  // 2) Relax pass: first eligible
  for (let i = 0; i < cupidQueue.length; i++) {
    const id = cupidQueue[i];
    const u = getClient(id);
    if (!u) continue;
    if (!u.cupidEnabled || u.cupidState !== 'waiting') continue;
    if (id === host.id) continue;
    if (otherParticipantId && id === otherParticipantId) continue;

    cupidQueue.splice(i, 1);
    u.cupidInQueue = false;
    return u;
  }

  return null;
}

function cupidRemember(a, b) {
  if (!a || !b) return;
  capSetAdd(a.cupidRecentPeers, b.id, MAX_CUPID_RECENT);
}

function startCupidHost(me) {
  if (!me) return;
  me.cupidHostActive = true;
  me.cupidHostSessionId = uuidv4();
  me.cupidHostSessionStarted = false;
  me.cupidSeats = [null, null];
  // ensure sets
  if (!me.cupidRecentPeers) me.cupidRecentPeers = new Set();
  safeSend(me.ws, { type: 'role', isAdmin: me.isAdmin, isPro: me.isPro });
  scheduleCupidFill();
}

function stopCupidHost(me, reason = 'host-off') {
  if (!me) return;
  const sessionId = me.cupidHostSessionId;
  const seatIds = Array.isArray(me.cupidSeats) ? [...me.cupidSeats] : [null, null];

  // notify participants to close
  for (const pid of seatIds) {
    const p = getClient(pid);
    if (!p) continue;

    safeSend(p.ws, { type: 'group-close', group: true, sessionId, reason });
    // Put them back into cupid waiting (if they didn't leave)
    if (p.cupidEnabled) {
      p.cupidState = 'waiting';
      p.cupidHostId = null;
      p.cupidSeat = null;
      p.cupidSessionId = null;
      enqueueCupid(p.id);
    } else {
      setCupidOff(p);
    }
  }

  // notify host client too
  safeSend(me.ws, { type: 'group-close', group: true, sessionId, reason });

  me.cupidHostActive = false;
  me.cupidHostSessionId = null;
  me.cupidHostSessionStarted = false;
  me.cupidSeats = [null, null];

  scheduleCupidFill();
}

function hostKickBoth(me, reason = 'host-next') {
  if (!me || !me.cupidHostActive) return;
  const sessionId = me.cupidHostSessionId;
  const seatIds = [...me.cupidSeats];

  for (const pid of seatIds) {
    const p = getClient(pid);
    if (!p) continue;
    safeSend(p.ws, { type: 'group-close', group: true, sessionId, reason });
    // requeue them (still in cupid)
    if (p.cupidEnabled) {
      p.cupidState = 'waiting';
      p.cupidHostId = null;
      p.cupidSeat = null;
      p.cupidSessionId = null;
      enqueueCupid(p.id);
    }
  }

  // reset host session to avoid stale signals
  safeSend(me.ws, { type: 'group-close', group: true, sessionId, reason });

  me.cupidHostSessionId = uuidv4();
  me.cupidHostSessionStarted = false;
  me.cupidSeats = [null, null];

  scheduleCupidFill();
}

function fillAllCupidHosts() {
  // clean cupid queue from invalid
  for (let i = cupidQueue.length - 1; i >= 0; i--) {
    const id = cupidQueue[i];
    const u = getClient(id);
    if (!u || !u.cupidEnabled || u.cupidState !== 'waiting') {
      cupidQueue.splice(i, 1);
      if (u) u.cupidInQueue = false;
    }
  }

  const hosts = getActiveCupidHosts();
  if (hosts.length === 0) return;

  for (const host of hosts) {
    fillHostSeats(host);
  }
}

function fillHostSeats(host) {
  if (!host || !host.cupidHostActive) return;
  if (!host.cupidSeats) host.cupidSeats = [null, null];
  if (!host.cupidRecentPeers) host.cupidRecentPeers = new Set();

  // Seat 0 first
  if (!host.cupidSeats[0]) {
    const candidate0 = dequeueCupidCandidate(host, host.cupidSeats[1]);
    if (candidate0) {
      assignParticipantToHostSeat(host, candidate0, 0);
    }
  }

  // Then seat 1
  if (!host.cupidSeats[1]) {
    const candidate1 = dequeueCupidCandidate(host, host.cupidSeats[0]);
    if (candidate1) {
      assignParticipantToHostSeat(host, candidate1, 1);
    }
  }
}

function assignParticipantToHostSeat(host, participant, seatIndex) {
  if (!host || !participant) return;
  const sessionId = host.cupidHostSessionId;
  const otherSeatIndex = seatIndex === 0 ? 1 : 0;
  const otherId = host.cupidSeats[otherSeatIndex];
  const other = getClient(otherId);

  host.cupidSeats[seatIndex] = participant.id;

  // Update participant state
  participant.cupidEnabled = true;
  participant.cupidState = 'in-group';
  participant.cupidHostId = host.id;
  participant.cupidSeat = seatIndex;
  participant.cupidSessionId = sessionId;
  participant.cupidInQueue = false;

  // Remember (avoid repeats later)
  cupidRemember(host, participant);
  cupidRemember(participant, host);
  if (other) {
    cupidRemember(other, participant);
    cupidRemember(participant, other);
  }

  // Messaging (init/add)
  if (!host.cupidHostSessionStarted) {
    // Start session with current filled seats (1 or 2)
    const peersForHost = [];
    if (host.cupidSeats[0]) peersForHost.push({ id: host.cupidSeats[0], name: getClient(host.cupidSeats[0])?.name || null });
    if (host.cupidSeats[1]) peersForHost.push({ id: host.cupidSeats[1], name: getClient(host.cupidSeats[1])?.name || null });

    safeSend(host.ws, { type: 'group-init', group: true, sessionId, peers: peersForHost });

    // For participant: host + maybe other
    const peersForParticipant = [{ id: host.id, name: host.name || 'Kristoff' }];
    if (other) peersForParticipant.push({ id: other.id, name: other.name || null });

    safeSend(participant.ws, { type: 'group-init', group: true, sessionId, peers: peersForParticipant });

    // If this is the second participant arriving after session started=false, we also need to init the other participant with "other user"
    // But in this branch sessionStarted is false only the first time we assign. The second assignment might happen immediately after and still be false.
    // To keep it correct, we mark session started now and subsequent assigns use group-add flow.
    host.cupidHostSessionStarted = true;

    // If we already have both seats filled, we must ensure the "other participant" receives the other peer too.
    const p0 = getClient(host.cupidSeats[0]);
    const p1 = getClient(host.cupidSeats[1]);
    if (p0 && p1) {
      // p0 should see [host, p1]
      safeSend(p0.ws, { type: 'group-init', group: true, sessionId, peers: [{ id: host.id, name: host.name || 'Kristoff' }, { id: p1.id, name: p1.name || null }] });
      // p1 should see [host, p0]
      safeSend(p1.ws, { type: 'group-init', group: true, sessionId, peers: [{ id: host.id, name: host.name || 'Kristoff' }, { id: p0.id, name: p0.name || null }] });
    }

    return;
  }

  // Session already started -> dynamic add
  safeSend(host.ws, {
    type: 'group-add',
    group: true,
    sessionId,
    slot: seatIndex,
    peer: { id: participant.id, name: participant.name || null }
  });

  if (other) {
    safeSend(other.ws, {
      type: 'group-add',
      group: true,
      sessionId,
      slot: 1, // for non-hosts, "the other user" is always slot 1
      peer: { id: participant.id, name: participant.name || null }
    });
  }

  // New participant must init with host + (other if present)
  const peersForNew = [{ id: host.id, name: host.name || 'Kristoff' }];
  if (other) peersForNew.push({ id: other.id, name: other.name || null });

  safeSend(participant.ws, { type: 'group-init', group: true, sessionId, peers: peersForNew });
}

function participantLeaveCupidGroup(participant, { requeue = false, reason = 'leave' } = {}) {
  if (!participant || participant.cupidState !== 'in-group') return;
  const host = getClient(participant.cupidHostId);
  const seatIndex = participant.cupidSeat;
  const sessionId = participant.cupidSessionId;

  // remove from host seat
  if (host && host.cupidSeats && host.cupidSeats[seatIndex] === participant.id) {
    host.cupidSeats[seatIndex] = null;
  }

  // notify host / other participant
  if (host) {
    safeSend(host.ws, { type: 'group-remove', group: true, sessionId: host.cupidHostSessionId, peerId: participant.id, slot: seatIndex });
    const otherId = host.cupidSeats ? host.cupidSeats[seatIndex === 0 ? 1 : 0] : null;
    const other = getClient(otherId);
    if (other) {
      safeSend(other.ws, { type: 'group-remove', group: true, sessionId: host.cupidHostSessionId, peerId: participant.id, slot: 1 });
    }
  }

  // update participant
  participant.cupidHostId = null;
  participant.cupidSeat = null;
  participant.cupidSessionId = null;
  participant.cupidState = participant.cupidEnabled ? 'waiting' : 'off';

  if (requeue && participant.cupidEnabled) {
    enqueueCupid(participant.id);
  } else {
    // if leaving cupid entirely, cupidEnabled must be false already
    removeFromCupidQueue(participant.id);
  }

  scheduleCupidFill();
}

/** Validate group signaling routes */
function cupidPeerAllowed(sender, toId, sessionId) {
  if (!sender || !toId || !sessionId) return false;

  // If sender is host
  if (sender.cupidHostActive && sender.cupidHostSessionId === sessionId) {
    return sender.cupidSeats && (sender.cupidSeats[0] === toId || sender.cupidSeats[1] === toId);
  }

  // If sender is participant
  if (sender.cupidState === 'in-group' && sender.cupidSessionId === sessionId) {
    const host = getClient(sender.cupidHostId);
    if (!host || host.cupidHostSessionId !== sessionId) return false;
    const otherId = (sender.cupidSeat === 0) ? host.cupidSeats[1] : host.cupidSeats[0];
    return (toId === host.id) || (otherId && toId === otherId);
  }

  return false;
}

/** -----------------------------
 *  WebSocket handlers
 *  ----------------------------- */

wss.on('connection', (ws) => {
  const id = uuidv4();

  const client = {
    id,
    ws,
    isAlive: true,

    email: null,
    name: null,
    age: null,
    gender: null,

    isAdmin: false,
    isPro: false,

    // solo
    state: 'idle',
    inQueue: false,
    roomId: null,
    joinTs: 0,
    recentPeers: new Set(),
    lastFindTs: 0,

    // cupid participant
    cupidEnabled: false,
    cupidState: 'off',
    cupidInQueue: false,
    cupidJoinTs: 0,
    cupidHostId: null,
    cupidSeat: null,
    cupidSessionId: null,
    cupidRecentPeers: new Set(),

    // cupid host
    cupidHostActive: false,
    cupidHostSessionId: null,
    cupidHostSessionStarted: false,
    cupidSeats: [null, null]
  };

  clients.set(id, client);
  safeSend(ws, { type: 'welcome', id });

  ws.on('pong', () => {
    const me = getClient(id);
    if (me) me.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const me = getClient(id);
    if (!me) return;

    switch (msg.type) {
      case 'identify': {
        const email = (msg.email || '').toLowerCase().trim();
        me.email = email || null;
        me.name = msg.displayName || me.name;
        me.isAdmin = isAdminEmail(email);
        me.isPro = me.isAdmin;
        safeSend(me.ws, { type: 'role', isAdmin: me.isAdmin, isPro: me.isPro });
        break;
      }

      case 'kristoff-login': {
        const email = (msg.email || '').toLowerCase().trim();
        const password = msg.password || '';
        const ok = canKristoffLogin(email, password);
        if (ok) {
          me.email = email;
          me.isAdmin = true;
          me.isPro = true;
          me.name = msg.displayName || me.name || 'Kristoff';
          safeSend(me.ws, { type: 'kristoff-login-result', ok: true });
          safeSend(me.ws, { type: 'role', isAdmin: true, isPro: true });
        } else {
          safeSend(me.ws, { type: 'kristoff-login-result', ok: false, reason: 'Email o contraseña incorrectos.' });
          safeSend(me.ws, { type: 'role', isAdmin: me.isAdmin, isPro: me.isPro });
        }
        break;
      }

      /** SOLO */
      case 'find': {
        // leave cupid if in cupid
        if (me.cupidHostActive) stopCupidHost(me, 'switch-mode');
        if (me.cupidEnabled) {
          if (me.cupidState === 'in-group') participantLeaveCupidGroup(me, { requeue: false, reason: 'switch-mode' });
          setCupidOff(me);
        }

        // update profile
        me.name = msg.displayName || me.name;
        me.age = msg.age || me.age;
        me.gender = msg.gender || me.gender;

        // enqueue solo
        if (me.state === 'in-room') {
          leaveSolo(me.id, 'requeue');
        }
        me.state = 'waiting';
        me.joinTs = Date.now();
        if (!me.inQueue) {
          me.inQueue = true;
          soloQueue.push(me.id);
        }
        scheduleSoloMatch();
        break;
      }

      case 'leave': {
        // leave solo
        leaveSolo(me.id, 'leave');
        // also stop cupid if somehow active
        if (me.cupidHostActive) stopCupidHost(me, 'leave');
        if (me.cupidEnabled) {
          if (me.cupidState === 'in-group') participantLeaveCupidGroup(me, { requeue: false, reason: 'leave' });
          setCupidOff(me);
        }
        scheduleSoloMatch();
        scheduleCupidFill();
        break;
      }

      case 'offer':
        forwardSoloSignal(me.id, 'offer', { sdp: msg.sdp });
        break;
      case 'answer':
        forwardSoloSignal(me.id, 'answer', { sdp: msg.sdp });
        break;
      case 'ice':
        forwardSoloSignal(me.id, 'ice', { candidate: msg.candidate });
        break;

      case 'fake-skip-toggle':
        if (me.isAdmin) toggleFakeSkip(me.id);
        break;

      /** CUPID (guest joins queue) */
      case 'cupid-join': {
        // leave solo
        leaveSolo(me.id, 'switch-to-cupid');

        // if host active, turn off (host should use cupid-host-on)
        if (me.cupidHostActive) stopCupidHost(me, 'switch-mode');

        // update profile
        me.name = msg.displayName || me.name;
        me.age = msg.age || me.age;
        me.gender = msg.gender || me.gender;

        me.cupidEnabled = true;
        me.cupidState = 'waiting';
        me.cupidHostId = null;
        me.cupidSeat = null;
        me.cupidSessionId = null;

        enqueueCupid(me.id);
        scheduleCupidFill();
        break;
      }

      case 'cupid-leave': {
        // leave cupid entirely
        if (me.cupidState === 'in-group') {
          me.cupidEnabled = false;
          participantLeaveCupidGroup(me, { requeue: false, reason: 'leave' });
        }
        setCupidOff(me);
        scheduleCupidFill();
        break;
      }

      case 'cupid-skip': {
        // skip current cupid group but stay in cupid
        if (me.cupidEnabled) {
          if (me.cupidState === 'in-group') {
            participantLeaveCupidGroup(me, { requeue: true, reason: 'skip' });
          } else if (me.cupidState === 'waiting') {
            // already waiting
          } else {
            me.cupidState = 'waiting';
            enqueueCupid(me.id);
          }
        }
        scheduleCupidFill();
        break;
      }

      /** CUPID HOST (admin) */
      case 'cupid-host-on': {
        if (!me.isAdmin) {
          safeSend(me.ws, { type: 'role', isAdmin: me.isAdmin, isPro: me.isPro });
          break;
        }

        // leave solo + cupid as participant if any
        leaveSolo(me.id, 'switch-to-host');
        if (me.cupidEnabled && me.cupidState === 'in-group') participantLeaveCupidGroup(me, { requeue: false, reason: 'switch-to-host' });
        setCupidOff(me);

        me.name = msg.displayName || me.name || 'Kristoff';
        startCupidHost(me);
        break;
      }

      case 'cupid-host-off': {
        if (me.isAdmin && me.cupidHostActive) {
          stopCupidHost(me, 'host-off');
        }
        break;
      }

      case 'cupid-next': {
        if (me.isAdmin && me.cupidHostActive) {
          hostKickBoth(me, 'host-next');
        }
        break;
      }

      /** GROUP SIGNALING (Cupido) */
      case 'group-offer':
      case 'group-answer':
      case 'group-ice': {
        const sessionId = msg.sessionId;
        const toId = msg.to;
        if (!cupidPeerAllowed(me, toId, sessionId)) break;

        const to = getClient(toId);
        if (!to) break;

        safeSend(to.ws, {
          type: msg.type,
          group: true,
          sessionId,
          from: me.id,
          sdp: msg.sdp,
          candidate: msg.candidate
        });
        break;
      }

      case 'group-close': {
        // Client requested close with a specific peer in cupid session.
        // We forward it only if allowed (same session + peer relation).
        const sessionId = msg.sessionId;
        const toId = msg.to;
        if (!cupidPeerAllowed(me, toId, sessionId)) break;

        const to = getClient(toId);
        if (!to) break;
        safeSend(to.ws, { type: 'group-close', group: true, sessionId, from: me.id, reason: 'peer-close' });
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const me = getClient(id);
    if (!me) return;

    // Solo cleanup
    leaveSolo(me.id, 'disconnect');

    // Cupid cleanup
    removeFromCupidQueue(me.id);

    if (me.cupidHostActive) {
      stopCupidHost(me, 'host-disconnect');
    } else if (me.cupidState === 'in-group') {
      // remove from host seats
      participantLeaveCupidGroup(me, { requeue: false, reason: 'disconnect' });
    } else {
      setCupidOff(me);
    }

    clients.delete(me.id);

    scheduleSoloMatch();
    scheduleCupidFill();
  });
});

/** Ping keepalive */
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.ws || c.ws.readyState !== 1) continue;
    if (!c.isAlive) {
      try { c.ws.terminate(); } catch {}
      continue;
    }
    c.isAlive = false;
    try { c.ws.ping(); } catch {}
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
  console.log(`Admin emails: ${Array.from(ADMIN_EMAILS).join(', ')}`);
});
