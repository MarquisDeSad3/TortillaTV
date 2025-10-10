/**
 * rooms: roomId -> { 
 *   aId, bId, 
 *   timers: { offer?:Timeout, answer?:Timeout },
 *   fakeSkip?: { on:boolean, actorId?:string }
 * }
 */

// ===== Allowlist simple (puedes mover a .env y split(',') ) =====
const ADMIN_EMAILS = new Set([
  'fajardomiguelangel50@gmail.com',
  'marquisdesade3141@gmail.com',
  'christophergomez6903@gmail.com',
]);

// server.js — Signalling + Matchmaker veloz (O(n) + batching)
// -----------------------------------------------------------
// Mejoras clave:
// - Emparejador O(n) con colas FIFO (sin doble bucle O(n^2))
// - Batching: un solo "tick" de runMatcher por tanda de eventos
// - WebSocket sin compresión (menos CPU y latencia)
// - Timeouts agresivos para salas zombie
// - Anti-starvation: si alguien espera demasiado, ignora recentPeers una ronda
// - Limpieza/ping eficiente y reencolado seguro

require("dotenv").config();
const http = require("http");
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const { v4: uuid } = require("uuid");

// ===== Config =====
const PORT = process.env.PORT || 8080;

// Señalización / matchmaking
const MATCH_OFFER_TIMEOUT_MS = 5000;  // esperar offer
const MATCH_ANSWER_TIMEOUT_MS = 5000; // esperar answer
const REQUEUE_COOLDOWN_MS = 500;      // anti-spam 'find'
const MAX_WAIT_MS = 10_000;           // anti-starvation (ignora recentPeers temporalmente)
const RECENT_PEERS_MAX = 5;           // memoria corta para no repetir inmediato

// Keepalive
const PING_INTERVAL_MS = 15_000;

// ===== HTTP + Static =====
const app = express();
app.use((req, _res, next) => { console.log("[HTTP]", req.method, req.url); next(); });
// Sirve tu front desde ./public (ajusta si usas otra carpeta)
app.use(express.static(path.join(process.cwd(), "public")));

const server = http.createServer(app);

// ===== WSS (sin compresión para menor latencia/CPU) =====
const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
});

// ===== Estado en memoria =====
/**
 * clients: id -> {
 *   ws, name, gender,
 *   state: 'idle' | 'waiting' | 'in-room',
 *   roomId: string|null,
 *   joinTs: number,              // cuando entró a la cola (para anti-starvation)
 *   recentPeers: Set<string>,    // para no repetir inmediato
 *   lastFindTs: number,          // anti-spam
 *   isAlive: boolean,            // ping/pong
 *   isAdmin: boolean,            // <<< nuevo
 *   isPro: boolean               // <<< nuevo
 * }
 */
const clients = new Map();

/**
 * rooms: roomId -> { aId, bId, timers: { offer?:Timeout, answer?:Timeout } }
 */
const rooms = new Map();
// AdminId -> { leftRoomId, leftPeerId, rightRoomId?:string, rightPeerId?:string }
const cupidoMeta = new Map();

function otherOfRoom(room, meId){
  return room.aId === meId ? room.bId : room.aId;
}

/**
 * Colas de emparejamiento por “bucket”.
 * Si luego quieres separar por género/región, crea más claves.
 */
const queues = {
  any: [], // cola FIFO principal
};

// ===== Utilidades =====
function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) { console.log("WS send error:", e.message); }
}
function getClient(id) { return clients.get(id); }
function setState(id, state) { const c = clients.get(id); if (c) c.state = state; }
function setRoom(id, roomId) { const c = clients.get(id); if (c) c.roomId = roomId; }

function addRecentPeer(aId, bId) {
  const A = getClient(aId), B = getClient(bId);
  if (!A || !B) return;
  A.recentPeers.add(bId);
  if (A.recentPeers.size > RECENT_PEERS_MAX) A.recentPeers.delete(A.recentPeers.values().next().value);
  B.recentPeers.add(aId);
  if (B.recentPeers.size > RECENT_PEERS_MAX) B.recentPeers.delete(B.recentPeers.values().next().value);
}
function clearRecentPeer(id, peerId) {
  const c = getClient(id);
  if (c?.recentPeers?.has(peerId)) c.recentPeers.delete(peerId);
}
function otherOf(room, meId) { return room.aId === meId ? room.bId : room.aId; }
// ===== Fake Skip broadcast helper =====
function broadcastFakeSkip(roomId, on, actorId){
  const room = rooms.get(roomId);
  if (!room) return;

  // actor (admin que activó)
  const actor = getClient(actorId);
  if (actor) {
    safeSend(actor.ws, { type: 'fake-skip', on, role: 'admin-view' });
  }

  // otro participante
  const otherId = otherOf(room, actorId);
  const other = getClient(otherId);
  if (other) {
    safeSend(other.ws, { type: 'fake-skip', on, role: 'remote-view' });
  }
}


// ===== Cola FIFO (O(n)) =====
function enqueue(id, key = "any") {
  const q = queues[key];
  if (!q.includes(id)) q.push(id);
}
function compactQueueInPlace(key = "any") {
  const q = queues[key];
  let w = 0;
  for (let r = 0; r < q.length; r++) {
    const id = q[r];
    const c = clients.get(id);
    if (c && c.state === "waiting") q[w++] = id; // mantiene relativos
  }
  q.length = w;
}

// Busca una pareja válida sin O(n²):
function dequeueValidPair(key = "any") {
  const q = queues[key];
  while (q.length >= 2) {
    const aId = q.shift();
    const A = clients.get(aId);
    if (!A || A.state !== "waiting") continue;

    let bIdx = -1;
    const waitedTooLong = (Date.now() - (A.joinTs || 0)) > MAX_WAIT_MS;

    for (let i = 0; i < q.length; i++) {
      const bId = q[i];
      const B = clients.get(bId);
      if (!B || B.state !== "waiting") continue;

      const skipRecent =
        (!waitedTooLong) && (A.recentPeers?.has(bId) || B.recentPeers?.has(aId));
      if (skipRecent) continue;

      bIdx = i; break;
    }

    if (bIdx === -1) {
      // No encontramos pareja válida ahora → re-cola A al final y cortamos esta ronda.
      q.push(aId);
      return null;
    }

    const bId = q.splice(bIdx, 1)[0];
    return [aId, bId];
  }
  return null;
}

// ===== Batching del emparejador =====
let matchingInProgress = false;
let matchTickScheduled = false;

function scheduleMatch() {
  if (matchTickScheduled) return;
  matchTickScheduled = true;
  setImmediate(() => {
    matchTickScheduled = false;
    runMatcher();
  });
}

function createRoomAndNotify(aId, bId) {
  const A = getClient(aId), B = getClient(bId);
  if (!A || !B) return;

  const roomId = uuid();
  rooms.set(roomId, { aId, bId, timers: {} });
  setRoom(aId, roomId);
  setRoom(bId, roomId);
  setState(aId, "in-room");
  setState(bId, "in-room");

  addRecentPeer(aId, bId);

  // Rol determinista: el que más esperó ofrece
  const aWait = Date.now() - (A.joinTs || 0);
  const bWait = Date.now() - (B.joinTs || 0);
  const aIsOffer = aWait >= bWait;

  const offerId = aIsOffer ? aId : bId;
  const answerId = aIsOffer ? bId : aId;

  const OfferC = getClient(offerId);
  const AnswerC = getClient(answerId);

  console.log("[MATCH]", offerId, "(offer)  <->", answerId, "(answer) ->", roomId);

  // (mejora) incluye flags del peer
  safeSend(OfferC.ws,  { type: "matched", roomId, role: "offer",
    peer: { id: answerId, name: AnswerC.name || "—", isAdmin: !!AnswerC.isAdmin, isPro: !!AnswerC.isPro } });
  safeSend(AnswerC.ws, { type: "matched", roomId, role: "answer",
    peer: { id: offerId,  name: OfferC.name  || "—", isAdmin: !!OfferC.isAdmin, isPro: !!OfferC.isPro } });

  // Timeouts para evitar salas zombie
  const r = rooms.get(roomId);
  if (r) {
    r.timers.offer = setTimeout(() => {
      const still = rooms.get(roomId);
      if (!still) return;
      console.log("[TIMEOUT] offer room:", roomId);
      teardownRoom(roomId, "offer-timeout");
    }, MATCH_OFFER_TIMEOUT_MS);

    r.timers.answer = setTimeout(() => {
      const still = rooms.get(roomId);
      if (!still) return;
      console.log("[TIMEOUT] answer room:", roomId);
      teardownRoom(roomId, "answer-timeout");
    }, MATCH_OFFER_TIMEOUT_MS + MATCH_ANSWER_TIMEOUT_MS);
  }
}

async function runMatcher() {
  if (matchingInProgress) return;
  matchingInProgress = true;
  try {
    // Compactar colas sin copiar arrays gigantes
    for (const key of Object.keys(queues)) compactQueueInPlace(key);

    // Consumir parejas hasta que no haya más
    for (const key of Object.keys(queues)) {
      while (true) {
        const pair = dequeueValidPair(key);
        if (!pair) break;
        const [aId, bId] = pair;
        createRoomAndNotify(aId, bId);
      }
    }
  } finally {
    matchingInProgress = false;
  }
}

// ===== Teardown sala =====
function teardownRoom(roomId, reason = "teardown") {
  const room = rooms.get(roomId);
  if (!room) return;
// si estaba activo, apágalo y notifica "off" por si acaso
try {
  if (room.fakeSkip?.on) {
    const actorId = room.fakeSkip.actorId || room.aId;
    broadcastFakeSkip(roomId, false, actorId);
  }
} catch {}

  const { aId, bId, timers } = room;
  // Limpia timers
  if (timers?.offer)  clearTimeout(timers.offer);
  if (timers?.answer) clearTimeout(timers.answer);

  rooms.delete(roomId);

  const A = getClient(aId);
  const B = getClient(bId);

  if (A) {
    safeSend(A.ws, { type: "peer-left", reason });
    setRoom(aId, null);
    if (A.state !== "idle") {
      A.state = "waiting";
      A.joinTs = Date.now();
      enqueue(aId);
    }
  }
  if (B) {
    safeSend(B.ws, { type: "peer-left", reason });
    setRoom(bId, null);
    if (B.state !== "idle") {
      B.state = "waiting";
      B.joinTs = Date.now();
      enqueue(bId);
    }
  }

  scheduleMatch();
}
function teardownRightRoom(roomIdR, reason = 'teardownR'){
  const r = rooms.get(roomIdR);
  if (!r) return;

  const { aId, bId, timers } = r;
  if (timers?.offer)  clearTimeout(timers.offer);
  if (timers?.answer) clearTimeout(timers.answer);

  rooms.delete(roomIdR);

  const A = getClient(aId);
  const B = getClient(bId);

  // Determinar quién es el admin por flags del cliente
  const adminIsA = !!A?.isAdmin;
  const adminId  = adminIsA ? aId : (B?.isAdmin ? bId : null);
  const userId   = adminIsA ? bId : aId;

  const adminC = adminId ? getClient(adminId) : null;
  const userC  = userId ? getClient(userId) : null;

  // Limpia puntero roomIdR del admin
  if (adminC && adminC.roomIdR === roomIdR) adminC.roomIdR = null;

  // Notifica al admin que la derecha se fue/liberó
  if (adminC) safeSend(adminC.ws, { type:'cupido-right-left', reason });

  // Al usuario derecho: peer se fue y re-encólalo si procede
  if (userC) {
    safeSend(userC.ws, { type:'peer-left', reason });
    setRoom(userId, null);
    if (userC.state !== 'idle') {
      userC.state = 'waiting';
      userC.joinTs = Date.now();
      enqueue(userId);
    }
  }

  scheduleMatch();
}
// ===== Señalización directa =====
function forwardSignal(meId, payload) {
  const me = getClient(meId);
  if (!me?.roomId) return;

  const room = rooms.get(me.roomId);
  if (!room) return;

  // Si llegó offer/answer, levanta su timeout
  if (payload.type === "offer" && room.timers?.offer) {
    clearTimeout(room.timers.offer);
    room.timers.offer = null;
  }
  if (payload.type === "answer" && room.timers?.answer) {
    clearTimeout(room.timers.answer);
    room.timers.answer = null;
  }

  // Limpia campos undefined para payload más chico
  const out = {};
  if (payload.type) out.type = payload.type;
  if (payload.sdp) out.sdp = payload.sdp;
  if (payload.candidate) out.candidate = payload.candidate;

  const otherId = otherOf(room, meId);
  const other = getClient(otherId);
  if (other) safeSend(other.ws, out);
}

// ===== WebSocket lifecycle =====
wss.on("connection", (ws) => {
  const id = uuid();

  clients.set(id, {
    ws,
    gender: null,
    name: null,
    state: "idle",
    roomId: null,
    joinTs: 0,
    recentPeers: new Set(),
    lastFindTs: 0,
    isAlive: true,
    isAdmin: false, // <<< nuevo
    isPro: false,   // <<< nuevo
    roomIdR: null, // <<< sala derecha (Cupido)
  });

  const me = getClient(id);
  console.log("[WS] connected:", id);

  // Enviar welcome con flags
  safeSend(ws, { type: "welcome", id, isAdmin: me.isAdmin, isPro: me.isPro });

  ws.on("pong", () => {
    const c = getClient(id);
    if (c) c.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg = {};
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const me = getClient(id);
    if (!me) return;

    switch (msg.type) {
      case "identify": {
        const email = String(msg.email || "").toLowerCase();
        me.name = msg.displayName || me.name || "—";
        const allowed = ADMIN_EMAILS.has(email);
        me.isAdmin = allowed;
        me.isPro   = allowed;  // mismo set para PRO
        // confirmar al cliente sus flags actuales
        safeSend(me.ws, { type: "role", isAdmin: me.isAdmin, isPro: me.isPro });
        break;
      }

      case "find": {
        const now = Date.now();
        if (now - me.lastFindTs < REQUEUE_COOLDOWN_MS) return; // anti-spam
        me.lastFindTs = now;
            // Si es admin y ya tiene sala IZQ activa, permitir; si además tiene DERECHA activa, no lo metas en cola
if (me.isAdmin && me.roomId && me.roomIdR) {
  // ya está en doble sala, ignora find
  break;
}

        me.gender = msg.gender || "Hombre";
        me.name   = msg.displayName || "—";

        // Si estaba en sala, romperla
        if (me.roomId) {
          const r = rooms.get(me.roomId);
          if (r) teardownRoom(me.roomId, "requeue");
          me.roomId = null;
        }

        me.state = "waiting";
        me.joinTs = Date.now();
        enqueue(id);
        console.log("[WS] find -> queued");

        scheduleMatch();
        break;
      }

      case "offer":
      case "answer":
      case "ice": {
        forwardSignal(id, { type: msg.type, sdp: msg.sdp, candidate: msg.candidate });
        break;
      }

      case "leave": {
        // Sale de la sala si existe
        if (me.roomId) {
          const r = rooms.get(me.roomId);
          if (r) {
            const otherId = otherOf(r, id);
            const other = getClient(otherId);
            if (other) {
              safeSend(other.ws, { type: "peer-left", reason: "peer-leave" });
              setRoom(otherId, null);
              if (other.state !== "idle") {
                other.state = "waiting";
                other.joinTs = Date.now();
                enqueue(otherId);
              }
            }
            if (r.timers?.offer)  clearTimeout(r.timers.offer);
            if (r.timers?.answer) clearTimeout(r.timers.answer);
            rooms.delete(me.roomId);
          }
          me.roomId = null;
        }
        // El que llama leave queda idle (no se reencola)
        me.state = "idle";
        if (msg.lastPeerId) {
          me.recentPeers.add(msg.lastPeerId);
          if (me.recentPeers.size > RECENT_PEERS_MAX) {
            me.recentPeers.delete(me.recentPeers.values().next().value);
          }
        }
        scheduleMatch();
        // Si este cliente además tiene sala derecha, ciérrala también
if (me.roomIdR) {
  teardownRightRoom(me.roomIdR, "peer-leave");
}

        break;
      }

      case "clearRecent": {
        if (msg.peerId) clearRecentPeer(id, msg.peerId);
        break;
      }
      case "fake-skip-toggle": {
  const me = getClient(id);
  // Debe estar en una sala y ser admin
  if (!me?.roomId || !me.isAdmin) break;

  const room = rooms.get(me.roomId);
  if (!room) break;

  const nextOn = !(room.fakeSkip?.on);
  room.fakeSkip = { on: nextOn, actorId: id };

  broadcastFakeSkip(me.roomId, nextOn, id);
  break;
}
      case 'cupido-toggle': {
  const me = getClient(id);
  if (!me?.isAdmin) break;
  if (!me?.roomId) break; // debe estar ya en 1:1

  const r = rooms.get(me.roomId);
  if (!r) break;

  const leftPeerId = otherOf(r, id);
  cupidoMeta.set(id, {
    leftRoomId: me.roomId,
    leftPeerId,
    rightRoomId: null,
    rightPeerId: null
  });

  // confirma flags (opcional)
  safeSend(me.ws, { type:'role', isAdmin: me.isAdmin, isPro: me.isPro });
  break;
}
case 'cupido-next': {
  const me = getClient(id);
  if (!me?.isAdmin) break;

  const meta = cupidoMeta.get(id);
  if (!meta?.leftRoomId) break;     // requiere toggle previo
  if (me.roomIdR) break;            // ya hay una derecha activa

  // Saca un candidato de la cola principal que esté "waiting", no sea el admin y no sea su peer izquierdo actual
  let candId = null;
  for (let i = 0; i < queues.any.length; i++) {
    const tryId = queues.any[i];
    const C = getClient(tryId);
    if (!C || C.state !== 'waiting') continue;
    if (tryId === id) continue;
    if (tryId === meta.leftPeerId) continue;

    candId = tryId;
    queues.any.splice(i,1);
    break;
  }
  if (!candId) {
    // no hay candidatos ahora mismo
    break;
  }

  const C = getClient(candId);
  // C y admin crean sala nueva (derecha)
  const roomIdR = uuid();
  rooms.set(roomIdR, { aId: id, bId: candId, timers: {} });

  // No cambiamos el estado del admin (sigue en-room por su sala izquierda)
  me.roomIdR = roomIdR;

  // El candidato entra "in-room" (normal)
  C.roomId = roomIdR;
  C.state = 'in-room';

  // Roles: el que más esperó ofrece
  const aWait = 0; // no usamos joinTs del admin porque no está en cola para R
  const bWait = Date.now() - (C.joinTs || 0);
  const adminIsOffer = aWait >= bWait;

  const offerId = adminIsOffer ? id : candId;
  const answerId = adminIsOffer ? candId : id;

  // Notifica al admin con evento especial cupido-matched (lado R)
  const OfferC = getClient(offerId);
  const AnswerC = getClient(answerId);
  safeSend(me.ws, {
    type: 'cupido-matched',
    roomIdR,
    role: (offerId === id) ? 'offer' : 'answer',
    side: 'R',
    peer: { id: candId, name: C.name || '—', isAdmin: !!C.isAdmin, isPro: !!C.isPro }
  });

  // Notifica al candidato como un "matched" normal (para que su cliente no tenga que saber de R)
  safeSend(C.ws, {
    type: 'matched',
    roomId: roomIdR,
    role: (offerId === candId) ? 'offer' : 'answer',
    peer: { id, name: me.name || '—', isAdmin: !!me.isAdmin, isPro: !!me.isPro }
  });

  // Timers anti-zombie para la sala derecha
  const r = rooms.get(roomIdR);
  if (r) {
    r.timers.offer = setTimeout(()=> {
      const still = rooms.get(roomIdR); if (!still) return;
      teardownRightRoom(roomIdR, 'offer-timeout');
    }, MATCH_OFFER_TIMEOUT_MS);

    r.timers.answer = setTimeout(()=> {
      const still = rooms.get(roomIdR); if (!still) return;
      teardownRightRoom(roomIdR, 'answer-timeout');
    }, MATCH_OFFER_TIMEOUT_MS + MATCH_ANSWER_TIMEOUT_MS);
  }

  break;
}
case 'offerR':
case 'answerR':
case 'iceR': {
  const me = getClient(id);
  if (!me?.roomIdR) break;           // debe existir sala derecha
  const room = rooms.get(me.roomIdR);
  if (!room) break;

  // levantar timers
  if (msg.type === 'offerR' && room.timers?.offer){ clearTimeout(room.timers.offer); room.timers.offer = null; }
  if (msg.type === 'answerR' && room.timers?.answer){ clearTimeout(room.timers.answer); room.timers.answer = null; }

  const otherId = otherOfRoom(room, id);
  const other = getClient(otherId);
  if (!other) break;

  const out = {};
  if (msg.type === 'offerR')  out.type = 'offerR';
  if (msg.type === 'answerR') out.type = 'answerR';
  if (msg.type === 'iceR')    out.type = 'iceR';
  if (msg.sdp) out.sdp = msg.sdp;
  if (msg.candidate) out.candidate = msg.candidate;

  safeSend(other.ws, out);
  break;
}

      default:
        break;
    }
  });

  ws.on("close", () => {
    const me = getClient(id);
    if (!me) return;

    // Si estaba en sala, notificar y reencolar al otro
    if (me.roomId) {
      const r = rooms.get(me.roomId);
      if (r) {
        const otherId = otherOf(r, id);
        const other = getClient(otherId);
        if (other) {
          safeSend(other.ws, { type: "peer-left", reason: "disconnect" });
          setRoom(otherId, null);
          if (other.state !== "idle") {
            other.state = "waiting";
            other.joinTs = Date.now();
            enqueue(otherId);
          }
        }
        if (r.timers?.offer)  clearTimeout(r.timers.offer);
        if (r.timers?.answer) clearTimeout(r.timers.answer);
        rooms.delete(me.roomId);
      }
    }
      // Si tenía sala derecha, ciérrala
if (me.roomIdR) {
  teardownRightRoom(me.roomIdR, "disconnect");
}
    clients.delete(id);
    console.log("[WS] closed:", id);
    scheduleMatch();
  });
});

// ===== Keepalive (ping/pong) =====
const interval = setInterval(() => {
  for (const [id, c] of clients) {
    if (!c.isAlive) {
      try { c.ws.terminate(); } catch {}
      clients.delete(id);
      if (c.roomId) teardownRoom(c.roomId, "pong-timeout");
      if (c.roomIdR) teardownRightRoom(c.roomIdR, "pong-timeout");
      console.log("[WS] terminated dead client:", id);
      

      continue;
    }
    c.isAlive = false;
    try { c.ws.ping(); } catch {}
  }
}, PING_INTERVAL_MS);

wss.on("close", () => clearInterval(interval));

// ===== Start =====
server.listen(PORT, () => {
  console.log(`Signalling server running on :${PORT}`);
});
