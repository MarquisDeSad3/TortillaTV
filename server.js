require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuid } = require('uuid');

const PORT = process.env.PORT || 8080;

const ADMIN_EMAILS = new Set([
  'christophergomez6903@gmail.com',
  'fajardomiguelangel50@gmail.com',
  'marquisdesade3141@gmail.com',
]);

const REQUEUE_COOLDOWN_MS = 500;
const MATCH_OFFER_TIMEOUT_MS = 5000;
const MATCH_ANSWER_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 15000;
const CUPID_SELECTION_TTL_MS = 45_000;

const app = express();
app.use((req, _res, next) => { console.log('[HTTP]', req.method, req.url); next(); });
const PUBLIC_DIR = path.join(process.cwd(), 'public');
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));
app.use(express.static(process.cwd()));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, perMessageDeflate: false });

const clients = new Map();
const soloRooms = new Map();
const groupRooms = new Map();
const queues = {
  solo: [],
  cupid: [],
};
const cupidSelections = new Map();
const sessionIndex = new Map();
const reconnectTimers = new Map();

const GROUP_RECONNECT_GRACE_MS = 15_000;

let soloMatchScheduled = false;

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.warn('[WS] send error:', err.message || err);
  }
}

function getClient(id) {
  return clients.get(id) || null;
}

function nowMs() {
  return Date.now();
}

function removeFromArray(arr, id) {
  const idx = arr.indexOf(id);
  if (idx !== -1) arr.splice(idx, 1);
}

function removeFromQueues(id) {
  removeFromArray(queues.solo, id);
  removeFromArray(queues.cupid, id);
  const client = getClient(id);
  if (client) client.inQueue = false;
}

function enqueue(queueName, id) {
  const client = getClient(id);
  if (!client) return;
  if (client.state !== 'waiting') return;
  removeFromQueues(id);
  client.inQueue = true;
  queues[queueName].push(id);
}

function compactQueue(queueName) {
  const arr = queues[queueName];
  let write = 0;
  for (let read = 0; read < arr.length; read += 1) {
    const id = arr[read];
    const client = getClient(id);
    const valid = !!client
      && client.state === 'waiting'
      && ((queueName === 'solo' && client.matchMode === 'solo')
        || (queueName === 'cupid' && client.matchMode === 'cupid'));
    if (valid) {
      client.inQueue = true;
      arr[write++] = id;
    } else if (client) {
      client.inQueue = false;
    }
  }
  arr.length = write;
}

function serializeUser(client) {
  if (!client) return null;
  return {
    id: client.id,
    name: client.name || '—',
    email: client.email || '',
    gender: client.gender || '',
    age: client.age || '—',
    joinedAt: client.joinTs || nowMs(),
    isAdmin: !!client.isAdmin,
    isPro: !!client.isPro,
  };
}

function isAdminCupidDashboard(client) {
  return !!client && !!client.isAdmin && client.matchMode === 'cupid-host' && client.state === 'idle';
}

function getCupidSelection(adminId) {
  const base = cupidSelections.get(adminId);
  return {
    leftId: base?.leftId || null,
    rightId: base?.rightId || null,
    updatedAt: base?.updatedAt || 0,
  };
}

function setCupidSelection(adminId, next) {
  cupidSelections.set(adminId, {
    leftId: next.leftId || null,
    rightId: next.rightId || null,
    updatedAt: nowMs(),
  });
}

function clearCupidSelection(adminId, slot = null) {
  if (!cupidSelections.has(adminId)) return false;
  if (!slot) {
    cupidSelections.delete(adminId);
    return true;
  }

  const current = getCupidSelection(adminId);
  if (slot === 'left') current.leftId = null;
  if (slot === 'right') current.rightId = null;

  if (!current.leftId && !current.rightId) {
    cupidSelections.delete(adminId);
  } else {
    current.updatedAt = nowMs();
    cupidSelections.set(adminId, current);
  }
  return true;
}

function dropUserFromSelections(userId) {
  let changed = false;
  for (const [adminId, sel] of cupidSelections.entries()) {
    let dirty = false;
    if (sel.leftId === userId) {
      sel.leftId = null;
      dirty = true;
    }
    if (sel.rightId === userId) {
      sel.rightId = null;
      dirty = true;
    }
    if (!dirty) continue;
    changed = true;
    if (!sel.leftId && !sel.rightId) cupidSelections.delete(adminId);
    else cupidSelections.set(adminId, { ...sel, updatedAt: nowMs() });
  }
  return changed;
}

function reservedByAdmin(userId) {
  for (const [adminId, sel] of cupidSelections.entries()) {
    if (sel.leftId === userId || sel.rightId === userId) return adminId;
  }
  return null;
}

function isReservedByOtherAdmin(userId, adminId) {
  const owner = reservedByAdmin(userId);
  return !!owner && owner !== adminId;
}

function pruneCupidSelections() {
  const now = nowMs();
  for (const [adminId, sel] of cupidSelections.entries()) {
    const admin = getClient(adminId);
    if (!admin || !isAdminCupidDashboard(admin) || now - (sel.updatedAt || 0) > CUPID_SELECTION_TTL_MS) {
      cupidSelections.delete(adminId);
      continue;
    }

    const next = { ...sel };
    const left = getClient(next.leftId);
    const right = getClient(next.rightId);

    if (!left || left.state !== 'waiting' || left.matchMode !== 'cupid') next.leftId = null;
    if (!right || right.state !== 'waiting' || right.matchMode !== 'cupid') next.rightId = null;

    if (!next.leftId && !next.rightId) {
      cupidSelections.delete(adminId);
    } else if (next.leftId !== sel.leftId || next.rightId !== sel.rightId) {
      next.updatedAt = now;
      cupidSelections.set(adminId, next);
    }
  }
}

function sendCupidAdminState(adminId) {
  pruneCupidSelections();
  const admin = getClient(adminId);
  if (!isAdminCupidDashboard(admin)) return;

  compactQueue('cupid');
  const selection = getCupidSelection(adminId);
  const queue = queues.cupid
    .map((id) => getClient(id))
    .filter((client) => client && client.state === 'waiting' && client.matchMode === 'cupid')
    .filter((client) => client.id !== selection.leftId && client.id !== selection.rightId)
    .filter((client) => !isReservedByOtherAdmin(client.id, adminId))
    .map(serializeUser);

  safeSend(admin.ws, {
    type: 'cupid-admin-state',
    queue,
    selected: {
      left: serializeUser(getClient(selection.leftId)),
      right: serializeUser(getClient(selection.rightId)),
    },
  });
}

function broadcastCupidAdminStates() {
  pruneCupidSelections();
  for (const [id, client] of clients.entries()) {
    if (isAdminCupidDashboard(client)) sendCupidAdminState(id);
  }
}

function clearReconnectTimer(id) {
  const timer = reconnectTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(id);
  }
}

function buildGroupPayload(room) {
  if (!room) return null;
  const host = getClient(room.hostId);
  const left = getClient(room.leftId);
  const right = getClient(room.rightId);
  return {
    roomId: room.roomId,
    hostId: room.hostId,
    peers: [
      { ...serializeUser(host), role: 'host' },
      { ...serializeUser(left), role: 'user' },
      { ...serializeUser(right), role: 'user' },
    ],
  };
}

function sendGroupResume(client) {
  if (!client?.groupRoomId) return;
  const room = groupRooms.get(client.groupRoomId);
  if (!room) return;
  const payload = buildGroupPayload(room);
  if (!payload) return;
  safeSend(client.ws, { type: 'group-resume', resumed: true, ...payload });
}

function notifyGroupPeerReconnected(roomId, peerId) {
  const room = groupRooms.get(roomId);
  if (!room) return;

  for (const id of [room.hostId, room.leftId, room.rightId]) {
    if (id === peerId) continue;
    const client = getClient(id);
    if (!client?.ws) continue;
    safeSend(client.ws, { type: 'group-peer-reconnected', roomId, peerId });
  }
}

function attachSessionToConnection(sessionKey, tempClientId, ws) {
  const tempClient = getClient(tempClientId);
  if (!tempClient) return null;

  const existingId = sessionIndex.get(sessionKey);
  if (!existingId || existingId === tempClientId) {
    if (tempClient.sessionKey && sessionIndex.get(tempClient.sessionKey) === tempClientId) {
      sessionIndex.delete(tempClient.sessionKey);
    }
    tempClient.sessionKey = sessionKey;
    sessionIndex.set(sessionKey, tempClientId);
    return tempClient;
  }

  const existing = getClient(existingId);
  if (!existing) {
    sessionIndex.delete(sessionKey);
    tempClient.sessionKey = sessionKey;
    sessionIndex.set(sessionKey, tempClientId);
    return tempClient;
  }

  clearReconnectTimer(existingId);

  if (existing.ws && existing.ws !== ws) {
    try { existing.ws.close(); } catch {}
  }

  existing.ws = ws;
  existing.isAlive = true;
  existing.sessionKey = sessionKey;

  if (existing.groupRoomId) existing.state = 'in-group';
  else if (existing.roomId) existing.state = 'in-room';
  else if (existing.inQueue) existing.state = 'waiting';
  else existing.state = existing.matchMode === 'cupid-host' ? 'idle' : (existing.state || 'idle');

  clients.delete(tempClientId);
  sessionIndex.set(sessionKey, existingId);

  safeSend(existing.ws, { type: 'welcome', id: existing.id, isAdmin: existing.isAdmin, isPro: existing.isPro, resumed: true });

  return existing;
}

function scheduleSoloMatcher() {
  if (soloMatchScheduled) return;
  soloMatchScheduled = true;
  setImmediate(() => {
    soloMatchScheduled = false;
    runSoloMatcher();
  });
}

function dequeueSoloPair() {
  compactQueue('solo');
  if (queues.solo.length < 2) return null;

  const aId = queues.solo.shift();
  const a = getClient(aId);
  if (a) a.inQueue = false;
  if (!a || a.state !== 'waiting' || a.matchMode !== 'solo') return dequeueSoloPair();

  const bIndex = queues.solo.findIndex((id) => {
    const client = getClient(id);
    return !!client && client.state === 'waiting' && client.matchMode === 'solo';
  });

  if (bIndex === -1) {
    enqueue('solo', aId);
    return null;
  }

  const [bId] = queues.solo.splice(bIndex, 1);
  const b = getClient(bId);
  if (b) b.inQueue = false;
  if (!b || b.state !== 'waiting' || b.matchMode !== 'solo') {
    enqueue('solo', aId);
    return dequeueSoloPair();
  }

  return [aId, bId];
}

function createSoloRoom(aId, bId) {
  const a = getClient(aId);
  const b = getClient(bId);
  if (!a || !b) return;

  const roomId = uuid();
  const room = { aId, bId, timers: {}, fakeSkip: { on: false, actorId: null } };
  soloRooms.set(roomId, room);

  a.state = 'in-room';
  b.state = 'in-room';
  a.roomId = roomId;
  b.roomId = roomId;
  a.inQueue = false;
  b.inQueue = false;

  const aWait = nowMs() - (a.joinTs || 0);
  const bWait = nowMs() - (b.joinTs || 0);
  const aIsOffer = aWait >= bWait;
  const offerId = aIsOffer ? aId : bId;
  const answerId = aIsOffer ? bId : aId;

  const offerClient = getClient(offerId);
  const answerClient = getClient(answerId);
  if (!offerClient || !answerClient) {
    teardownSoloRoom(roomId, 'match-invalid');
    return;
  }

  safeSend(offerClient.ws, {
    type: 'matched',
    roomId,
    role: 'offer',
    peer: serializeUser(answerClient),
  });
  safeSend(answerClient.ws, {
    type: 'matched',
    roomId,
    role: 'answer',
    peer: serializeUser(offerClient),
  });

  room.timers.offer = setTimeout(() => {
    if (!soloRooms.has(roomId)) return;
    teardownSoloRoom(roomId, 'offer-timeout');
  }, MATCH_OFFER_TIMEOUT_MS);

  room.timers.answer = setTimeout(() => {
    if (!soloRooms.has(roomId)) return;
    teardownSoloRoom(roomId, 'answer-timeout');
  }, MATCH_OFFER_TIMEOUT_MS + MATCH_ANSWER_TIMEOUT_MS);

  console.log('[SOLO MATCH]', offerId, '<->', answerId, '->', roomId);
}

function runSoloMatcher() {
  compactQueue('solo');
  while (true) {
    const pair = dequeueSoloPair();
    if (!pair) break;
    createSoloRoom(pair[0], pair[1]);
  }
}

function broadcastFakeSkip(roomId, on, actorId) {
  const room = soloRooms.get(roomId);
  if (!room) return;
  const ids = [room.aId, room.bId];
  for (const id of ids) {
    const client = getClient(id);
    if (!client) continue;
    safeSend(client.ws, {
      type: 'fake-skip',
      on,
      role: id === actorId ? 'admin-view' : 'remote-view',
    });
  }
}

function teardownSoloRoom(roomId, reason = 'teardown', leaverId = null) {
  const room = soloRooms.get(roomId);
  if (!room) return;

  if (room.fakeSkip?.on) {
    try {
      broadcastFakeSkip(roomId, false, room.fakeSkip.actorId || room.aId);
    } catch {}
  }

  if (room.timers.offer) clearTimeout(room.timers.offer);
  if (room.timers.answer) clearTimeout(room.timers.answer);
  soloRooms.delete(roomId);

  for (const id of [room.aId, room.bId]) {
    const client = getClient(id);
    if (!client) continue;
    client.roomId = null;

    if (id !== leaverId) {
      safeSend(client.ws, { type: 'peer-left', reason });
      if (client.matchMode === 'solo') {
        client.state = 'waiting';
        client.joinTs = nowMs();
        enqueue('solo', id);
      } else {
        client.state = 'idle';
        client.inQueue = false;
        client.joinTs = 0;
      }
    } else {
      client.state = 'idle';
      client.inQueue = false;
      client.joinTs = 0;
    }
  }

  scheduleSoloMatcher();
}

function createGroupRoom(hostId, leftId, rightId) {
  const host = getClient(hostId);
  const left = getClient(leftId);
  const right = getClient(rightId);
  if (!host || !left || !right) return false;
  if (!host.isAdmin || host.matchMode !== 'cupid-host') return false;
  if (left.state !== 'waiting' || right.state !== 'waiting') return false;
  if (left.matchMode !== 'cupid' || right.matchMode !== 'cupid') return false;
  if (leftId === rightId) return false;

  clearReconnectTimer(hostId);
  clearReconnectTimer(leftId);
  clearReconnectTimer(rightId);

  removeFromQueues(leftId);
  removeFromQueues(rightId);
  clearCupidSelection(hostId);

  const roomId = uuid();
  const room = { roomId, hostId, leftId, rightId };
  groupRooms.set(roomId, room);

  for (const client of [host, left, right]) {
    client.groupRoomId = roomId;
    client.roomId = null;
    client.state = 'in-group';
    client.inQueue = false;
  }

  const payload = buildGroupPayload(room);

  safeSend(host.ws, { type: 'group-matched', ...payload });
  safeSend(left.ws, { type: 'group-matched', ...payload });
  safeSend(right.ws, { type: 'group-matched', ...payload });

  broadcastCupidAdminStates();
  console.log('[CUPID MATCH]', hostId, '<->', leftId, '<->', rightId, '->', roomId);
  return true;
}

function teardownGroupRoom(roomId, reason = 'group-teardown', leaverId = null) {
  const room = groupRooms.get(roomId);
  if (!room) return;
  groupRooms.delete(roomId);

  const ids = [room.hostId, room.leftId, room.rightId];
  for (const id of ids) {
    clearReconnectTimer(id);
  }

  for (const id of ids) {
    if (id === leaverId) continue;
    const client = getClient(id);
    if (!client) continue;
    safeSend(client.ws, { type: 'group-peer-left', roomId, reason, leaverId });
  }

  for (const id of ids) {
    const client = getClient(id);
    if (!client) continue;
    client.groupRoomId = null;

    if (id === room.hostId) {
      client.state = 'idle';
      client.inQueue = false;
      client.joinTs = 0;
      continue;
    }

    if (id === leaverId) {
      client.state = 'idle';
      client.inQueue = false;
      client.joinTs = 0;
      continue;
    }

    client.state = 'waiting';
    client.joinTs = nowMs();
    enqueue('cupid', id);
  }

  broadcastCupidAdminStates();
}

function startCupidGroupFromSelection(adminId) {
  const selection = getCupidSelection(adminId);
  if (!selection.leftId || !selection.rightId) return false;
  if (selection.leftId === selection.rightId) {
    clearCupidSelection(adminId);
    return false;
  }

  const host = getClient(adminId);
  const left = getClient(selection.leftId);
  const right = getClient(selection.rightId);
  if (!host || !left || !right) {
    clearCupidSelection(adminId);
    broadcastCupidAdminStates();
    return false;
  }

  const ok = createGroupRoom(adminId, selection.leftId, selection.rightId);
  if (!ok) {
    clearCupidSelection(adminId);
    broadcastCupidAdminStates();
  }
  return ok;
}

function relaySoloSignal(senderId, payload) {
  const sender = getClient(senderId);
  if (!sender?.roomId) return;

  const room = soloRooms.get(sender.roomId);
  if (!room) return;

  if (payload.type === 'offer' && room.timers.offer) {
    clearTimeout(room.timers.offer);
    room.timers.offer = null;
  }
  if (payload.type === 'answer' && room.timers.answer) {
    clearTimeout(room.timers.answer);
    room.timers.answer = null;
  }

  const otherId = room.aId === senderId ? room.bId : room.aId;
  const other = getClient(otherId);
  if (!other) return;

  const out = { type: payload.type };
  if (payload.sdp) out.sdp = payload.sdp;
  if (payload.candidate) out.candidate = payload.candidate;
  safeSend(other.ws, out);
}

function relayGroupSignal(senderId, payload) {
  const sender = getClient(senderId);
  if (!sender || !sender.groupRoomId) return;
  if (!payload.to || !payload.roomId || payload.roomId !== sender.groupRoomId) return;

  const room = groupRooms.get(payload.roomId);
  if (!room) return;
  const validIds = new Set([room.hostId, room.leftId, room.rightId]);
  if (!validIds.has(senderId) || !validIds.has(payload.to)) return;

  const target = getClient(payload.to);
  if (!target) return;

  safeSend(target.ws, {
    type: payload.type,
    from: senderId,
    roomId: payload.roomId,
    sdp: payload.sdp,
    candidate: payload.candidate,
  });
}

function makeClient(id, ws) {
  return {
    id,
    ws,
    sessionKey: null,
    name: null,
    email: null,
    gender: null,
    age: null,
    matchMode: 'solo',
    state: 'idle',
    roomId: null,
    groupRoomId: null,
    inQueue: false,
    joinTs: 0,
    lastFindTs: 0,
    isAlive: true,
    isAdmin: false,
    isPro: false,
  };
}

function resetClientToIdle(client) {
  if (!client) return;
  removeFromQueues(client.id);
  dropUserFromSelections(client.id);
  client.state = 'idle';
  client.roomId = null;
  client.groupRoomId = null;
  client.inQueue = false;
  client.joinTs = 0;
}

function finalizeDisconnect(id, reason = 'disconnect') {
  const client = getClient(id);
  if (!client) return;

  clearReconnectTimer(id);

  const wasCupidRelated = client.matchMode === 'cupid' || client.matchMode === 'cupid-host' || client.groupRoomId || queues.cupid.includes(id) || !!reservedByAdmin(id);
  removeFromQueues(id);
  const selectionsChanged = dropUserFromSelections(id) || clearCupidSelection(id);

  if (client.groupRoomId) {
    teardownGroupRoom(client.groupRoomId, reason, id);
  }
  if (client.roomId) {
    teardownSoloRoom(client.roomId, reason, id);
  }

  if (client.sessionKey && sessionIndex.get(client.sessionKey) === id) {
    sessionIndex.delete(client.sessionKey);
  }

  clients.delete(id);
  if (selectionsChanged || wasCupidRelated) broadcastCupidAdminStates();
}

function handleDisconnect(id, reason = 'disconnect') {
  const client = getClient(id);
  if (!client) return;

  client.ws = null;
  client.isAlive = false;

  if (client.groupRoomId) {
    if (!reconnectTimers.has(id)) {
      client.state = 'reconnecting';
      const expectedRoomId = client.groupRoomId;
      reconnectTimers.set(id, setTimeout(() => {
        reconnectTimers.delete(id);
        const current = getClient(id);
        if (!current) return;
        if (current.ws) return;
        if (current.groupRoomId !== expectedRoomId) return;
        finalizeDisconnect(id, reason);
      }, GROUP_RECONNECT_GRACE_MS));
    }
    return;
  }

  finalizeDisconnect(id, reason);
}

wss.on('connection', (ws) => {
  const initialId = uuid();
  let socketClientId = initialId;
  const client = makeClient(initialId, ws);
  clients.set(initialId, client);
  console.log('[WS] connected:', initialId);

  safeSend(ws, { type: 'welcome', id: initialId, isAdmin: false, isPro: false });

  ws.on('pong', () => {
    const current = getClient(socketClientId);
    if (current && current.ws === ws) current.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    let me = getClient(socketClientId);
    if (!me || me.ws !== ws) return;

    switch (msg.type) {
      case 'identify': {
        const sessionKey = String(msg.sessionKey || '').trim();
        if (sessionKey) {
          const attached = attachSessionToConnection(sessionKey, socketClientId, ws);
          if (attached) {
            socketClientId = attached.id;
            me = attached;
          }
        }

        const email = String(msg.email || '').trim().toLowerCase();
        me.name = msg.displayName || me.name || '—';
        me.email = email || '';
        me.isAdmin = ADMIN_EMAILS.has(email);
        me.isPro = me.isAdmin;
        me.isAlive = true;

        safeSend(me.ws, { type: 'role', isAdmin: me.isAdmin, isPro: me.isPro });

        if (me.groupRoomId) {
          sendGroupResume(me);
          notifyGroupPeerReconnected(me.groupRoomId, me.id);
        } else if (isAdminCupidDashboard(me)) {
          sendCupidAdminState(me.id);
        }
        break;
      }

      case 'find': {
        const id = me.id;
        const now = nowMs();
        if (now - me.lastFindTs < REQUEUE_COOLDOWN_MS) break;
        me.lastFindTs = now;
        const wasCupidRelated = me.matchMode === 'cupid' || me.matchMode === 'cupid-host' || me.groupRoomId || queues.cupid.includes(id) || !!reservedByAdmin(id);
        me.name = msg.displayName || me.name || '—';
        me.gender = msg.gender || me.gender || 'Hombre';
        me.age = msg.age || me.age || '—';

        clearReconnectTimer(id);
        if (me.groupRoomId) teardownGroupRoom(me.groupRoomId, 'requeue', id);
        if (me.roomId) teardownSoloRoom(me.roomId, 'requeue', id);
        removeFromQueues(id);
        dropUserFromSelections(id);
        clearCupidSelection(id);

        const reqMode = String(msg.mode || 'solo');
        if (reqMode === 'cupid-host' && me.isAdmin) {
          me.matchMode = 'cupid-host';
          me.state = 'idle';
          me.joinTs = 0;
          me.inQueue = false;
          sendCupidAdminState(id);
          if (wasCupidRelated) broadcastCupidAdminStates();
          break;
        }

        me.matchMode = reqMode === 'cupid' ? 'cupid' : 'solo';
        me.state = 'waiting';
        me.joinTs = nowMs();
        enqueue(me.matchMode === 'solo' ? 'solo' : 'cupid', id);

        if (me.matchMode === 'solo') {
          scheduleSoloMatcher();
          if (wasCupidRelated) broadcastCupidAdminStates();
        } else {
          broadcastCupidAdminStates();
        }
        break;
      }

      case 'cupid-admin-open': {
        const id = me.id;
        if (!me.isAdmin) break;
        me.name = msg.displayName || me.name || 'Kristoff';
        me.gender = msg.gender || me.gender || 'Hombre';
        me.age = msg.age || me.age || '—';

        clearReconnectTimer(id);
        if (me.groupRoomId) teardownGroupRoom(me.groupRoomId, 'admin-refresh', id);
        if (me.roomId) teardownSoloRoom(me.roomId, 'admin-refresh', id);

        removeFromQueues(id);
        clearCupidSelection(id);
        me.matchMode = 'cupid-host';
        me.state = 'idle';
        me.joinTs = 0;
        sendCupidAdminState(id);
        break;
      }

      case 'cupid-clear-all': {
        if (!me.isAdmin) break;
        const changed = clearCupidSelection(me.id);
        if (changed) broadcastCupidAdminStates();
        break;
      }

      case 'cupid-clear-slot': {
        if (!me.isAdmin) break;
        const slot = msg.slot === 'right' ? 'right' : 'left';
        const changed = clearCupidSelection(me.id, slot);
        if (changed) broadcastCupidAdminStates();
        break;
      }

      case 'cupid-select-slot': {
        const id = me.id;
        if (!me.isAdmin || me.matchMode !== 'cupid-host') {
          safeSend(me.ws, { type: 'cupid-error', message: 'No eres el administrador de Cupido.' });
          break;
        }

        const slot = msg.slot === 'right' ? 'right' : 'left';
        const targetId = String(msg.targetId || '');
        const target = getClient(targetId);
        if (!target || target.state !== 'waiting' || target.matchMode !== 'cupid') {
          safeSend(me.ws, { type: 'cupid-error', message: 'Ese participante ya no está disponible.' });
          broadcastCupidAdminStates();
          break;
        }
        if (isReservedByOtherAdmin(targetId, id)) {
          safeSend(me.ws, { type: 'cupid-error', message: 'Ese participante ya lo está usando otro admin.' });
          broadcastCupidAdminStates();
          break;
        }

        const current = getCupidSelection(id);
        const otherSlotId = slot === 'left' ? current.rightId : current.leftId;
        if (otherSlotId && otherSlotId === targetId) {
          safeSend(me.ws, { type: 'cupid-error', message: 'No puedes poner a la misma persona en ambos lados.' });
          break;
        }

        current[slot === 'left' ? 'leftId' : 'rightId'] = targetId;
        setCupidSelection(id, current);
        broadcastCupidAdminStates();

        if (msg.autoStart && current.leftId && current.rightId) {
          const started = startCupidGroupFromSelection(id);
          if (!started) {
            safeSend(me.ws, {
              type: 'cupid-error',
              message: 'No se pudo iniciar el trío. Alguno ya salió de la cola.',
            });
            broadcastCupidAdminStates();
          }
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice': {
        relaySoloSignal(me.id, msg);
        break;
      }

      case 'group-offer':
      case 'group-answer':
      case 'group-ice': {
        relayGroupSignal(me.id, msg);
        break;
      }

      case 'group-close': {
        relayGroupSignal(me.id, { ...msg, type: 'group-close' });
        break;
      }

      case 'clearRecent': {
        break;
      }

      case 'fake-skip-toggle': {
        if (!me.isAdmin || !me.roomId) break;
        const room = soloRooms.get(me.roomId);
        if (!room) break;
        const nextOn = !(room.fakeSkip?.on);
        room.fakeSkip = { on: nextOn, actorId: me.id };
        broadcastFakeSkip(me.roomId, nextOn, me.id);
        break;
      }

      case 'leave': {
        const id = me.id;
        const wasCupidRelated = me.matchMode === 'cupid' || me.matchMode === 'cupid-host' || me.groupRoomId || queues.cupid.includes(id) || !!reservedByAdmin(id);
        clearReconnectTimer(id);
        removeFromQueues(id);
        const changed = dropUserFromSelections(id) || clearCupidSelection(id);

        if (me.groupRoomId) {
          teardownGroupRoom(me.groupRoomId, 'peer-leave', id);
        }
        if (me.roomId) {
          teardownSoloRoom(me.roomId, 'peer-leave', id);
        }

        me.state = 'idle';
        me.joinTs = 0;
        me.inQueue = false;
        me.roomId = null;
        me.groupRoomId = null;
        if (changed || wasCupidRelated) broadcastCupidAdminStates();
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const current = getClient(socketClientId);
    if (current && current.ws !== ws) return;
    console.log('[WS] closed:', socketClientId);
    handleDisconnect(socketClientId, 'disconnect');
  });
});

const keepAlive = setInterval(() => {
  for (const [id, client] of clients.entries()) {
    if (!client.ws) continue;

    if (!client.isAlive) {
      try { client.ws.terminate(); } catch {}
      console.log('[WS] terminated dead client:', id);
      handleDisconnect(id, 'pong-timeout');
      continue;
    }
    client.isAlive = false;
    try { client.ws.ping(); } catch {}
  }
}, PING_INTERVAL_MS);

wss.on('close', () => clearInterval(keepAlive));

server.listen(PORT, () => {
  console.log(`Signalling server running on :${PORT}`);
});
