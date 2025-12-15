/**
 * rooms: roomId -> { 
 *   aId, bId, 
 *   timers: { offer?:Timeout, answer?:Timeout },
 *   fakeSkip?: { on:boolean, actorId?:string }
 * }
 */

// ===== Allowlist simple (puedes mover a .env y split(',') ) =====
const ADMIN_EMAILS = new Set([
  'christophergomez6903@gmail.com',
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
const RECENT_PEERS_MAX = 20;          // memoria más larga para NO repetir si hay más gente

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
// ==== Helpers para sala SIDE (modo cupido) ====
function otherOfSide(room, meId) { return otherOf(room, meId); }

// Saca un candidato de la cola para el admin (evitando repetir y excluyendo su par principal)
function dequeueForCupid(adminId, excludeIds = new Set()) {
  const q = queues.any;
  const A = clients.get(adminId);
  const now = Date.now();
  for (let i = 0; i < q.length; i++) {
    const bId = q[i];
    if (excludeIds.has(bId)) continue;
    const B = clients.get(bId);
    if (!B || B.state !== "waiting" || !A) continue;

    // Relaja recentPeers si B lleva esperando > 6s (anti-atasco)
    const waitedMs = now - (B.joinTs || 0);
    const recentBlocked = (A.sideRecentPeers?.has(bId) || B.recentPeers?.has(adminId));
    if (recentBlocked && waitedMs < 6000) continue;

    // quítalo de la cola (y marca que ya no está en cola)
    q.splice(i, 1);
    B.inQueue = false;
    return bId;
  }
  return null;
}
// --- NUEVO: helpers para grupo (match de 3) ---

// saca a un id de la cola 'any' si está
function removeFromAnyQueue(id) {
  const q = queues.any;
  const i = q.indexOf(id);
  if (i !== -1) {
    q.splice(i, 1);
    const c = clients.get(id);
    if (c) c.inQueue = false;
  }
}

// intenta sacar 2 usuarios libres distintos al admin y a una exclusión
function dequeueTwoForGroup(adminId, exclude = new Set()) {
  const q = queues.any;
  const picked = [];

  for (let i = 0; i < q.length && picked.length < 2; i++) {
    const uid = q[i];
    if (uid === adminId || exclude.has(uid)) continue;
    const C = clients.get(uid);
    if (!C || C.state !== 'waiting') continue;
    picked.push(uid);
  }

  if (picked.length < 2) return null;

  // sácalos físicamente de la cola
  removeFromAnyQueue(picked[0]);
  removeFromAnyQueue(picked[1]);
  return picked; // [userAId, userBId]
}

function addSideRecentPeer(adminId, bId) {
  const A = clients.get(adminId);
  const B = clients.get(bId);
  if (!A || !B) return;

  A.sideRecentPeers.add(bId);
  if (A.sideRecentPeers.size > RECENT_PEERS_MAX) {
    A.sideRecentPeers.delete(A.sideRecentPeers.values().next().value);
  }

  B.recentPeers.add(adminId);
  if (B.recentPeers.size > RECENT_PEERS_MAX) {
    B.recentPeers.delete(B.recentPeers.values().next().value);
  }
}

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
  const c = clients.get(id);
  if (!c) return;
  if (c.state !== "waiting") return;
  if (c.inQueue) return;
  c.inQueue = true;
  q.push(id);
}
function compactQueueInPlace(key = "any") {
  const q = queues[key];
  let w = 0;
  for (let r = 0; r < q.length; r++) {
    const id = q[r];
    const c = clients.get(id);
    if (c && c.state === "waiting") {
      c.inQueue = true;
      q[w++] = id; // mantiene relativos
    } else {
      if (c) c.inQueue = false;
    }
  }
  q.length = w;
}

// Busca una pareja válida sin O(n²):
function dequeueValidPair(key = "any") {
  const q = queues[key];
  // ⚠️ Importante: NO cortar toda la ronda si el primer A no puede emparejar.
  // Si cortas aquí, puedes dejar gente esperando aunque existan parejas posibles.
  const rotations = q.length; // límite para evitar bucles infinitos
  for (let rot = 0; rot < rotations && q.length >= 2; rot++) {
    const aId = q.shift();
    const A = clients.get(aId);
    // Siempre que salga de la cola, marca inQueue=false (aunque cambie de estado entre ticks)
    if (A) A.inQueue = false;
    if (!A || A.state !== "waiting") continue;

    let bIdx = -1;
    let firstWaitingIdx = -1;
    let waitingCount = 0;

    const waitedTooLong = (Date.now() - (A.joinTs || 0)) > MAX_WAIT_MS;

    for (let i = 0; i < q.length; i++) {
      const bId = q[i];
      const B = clients.get(bId);
      if (!B || B.state !== "waiting") continue;

      waitingCount++;
      if (firstWaitingIdx === -1) firstWaitingIdx = i;

      const skipRecent =
        (!waitedTooLong) && (A.recentPeers?.has(bId) || B.recentPeers?.has(aId));
      if (skipRecent) continue;

      bIdx = i;
      break;
    }

    if (bIdx === -1) {
      // ✅ No hay opción NO-reciente.
      // - Si solo hay 1 candidato esperando (poca gente), empareja igual para que sea "al momento".
      // - Si A ya esperó mucho, también relaja.
      if (firstWaitingIdx !== -1 && (waitingCount <= 1 || waitedTooLong)) {
        bIdx = firstWaitingIdx;
      } else {
        // Re-cola A al final y sigue intentando con otros (no frenes el match global)
        enqueue(aId, key);
        continue;
      }
    }

    const bId = q.splice(bIdx, 1)[0];
    const B = clients.get(bId);
    if (B) B.inQueue = false;
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
function createSideRoomAndNotify(adminId, bId) {
  const A = getClient(adminId);
  const B = getClient(bId);
  if (!A || !B) return;

  const roomId = uuid();
  rooms.set(roomId, { aId: adminId, bId, timers: {} });

  // Admin mantiene su sala principal; esta es la SIDE
  A.sideRoomId = roomId;
  A.sideState = "in-room";

  // El B entra en-room (su única sala)
  setRoom(bId, roomId);
  setState(bId, "in-room");

  addSideRecentPeer(adminId, bId);

  console.log("[MATCH-SIDE]", adminId, "(offer)  <->", bId, "(answer) ->", roomId);

  // Admin SIEMPRE hace offer en la SIDE (simplifica)
  safeSend(A.ws, { type: "matched-side", roomId, role: "offer",
    peer: { id: bId, name: B.name || "—", isAdmin: !!B.isAdmin, isPro: !!B.isPro } });

  safeSend(B.ws, { type: "matched-side", roomId, role: "answer",
    peer: { id: adminId, name: A.name || "—", isAdmin: !!A.isAdmin, isPro: !!A.isPro } });

  // Timeouts igual que principal
  const r = rooms.get(roomId);
  if (r) {
    r.timers.offer = setTimeout(() => {
      const still = rooms.get(roomId); if (!still) return;
      console.log("[TIMEOUT SIDE] offer room:", roomId);
      teardownSideRoom(adminId, "offer-timeout");
    }, MATCH_OFFER_TIMEOUT_MS);

    r.timers.answer = setTimeout(() => {
      const still = rooms.get(roomId); if (!still) return;
      console.log("[TIMEOUT SIDE] answer room:", roomId);
      teardownSideRoom(adminId, "answer-timeout");
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
function teardownSideRoom(adminId, reason = "teardown-side") {
  const A = getClient(adminId);
  if (!A?.sideRoomId) return;

  const roomId = A.sideRoomId;
  const room = rooms.get(roomId);
  if (!room) {
    A.sideRoomId = null;
    A.sideState = "idle";
    return;
  }

  const { aId, bId, timers } = room;
  if (timers?.offer) clearTimeout(timers.offer);
  if (timers?.answer) clearTimeout(timers.answer);

  rooms.delete(roomId);

  // El otro usuario vuelve a la cola
  const otherId = otherOfSide(room, adminId);
  const B = getClient(otherId);
  if (B) {
    safeSend(B.ws, { type: "peer-left-side", reason });
    setRoom(otherId, null);
    if (B.state !== "idle") {
      B.state = "waiting";
      B.joinTs = Date.now();
      enqueue(otherId);
    }
  }

  // Admin limpia la side
  A.sideRoomId = null;
  A.sideState = "idle";

  // 🔁 Auto-rebuscar si sigue Cupido ON
  if (A.isCupidOn) {
    const exclude = new Set();
    // Evitar emparejar contra su par principal actual (si lo tiene)
    if (A.roomId) {
      const main = rooms.get(A.roomId);
      if (main) exclude.add(otherOf(main, adminId));
    }
    const bId2 = dequeueForCupid(adminId, exclude);
    if (bId2) createSideRoomAndNotify(adminId, bId2);
    else safeSend(A.ws, { type: "matched-side", roomId: null, role: null, pending: true });
  }

  scheduleMatch();
}

function forwardSignal(meId, payload) {
  const me = getClient(meId);
  if (!me) return;

  // Elegir sala principal o side según flag
  const toSide = !!payload.side;
  const roomId = toSide ? me.sideRoomId : me.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  if (payload.type === "offer" && room.timers?.offer) {
    clearTimeout(room.timers.offer); room.timers.offer = null;
  }
  if (payload.type === "answer" && room.timers?.answer) {
    clearTimeout(room.timers.answer); room.timers.answer = null;
  }

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
    id,                   // 👈 guarda id para usar como me.id
    ws,
    gender: null,
    name: null,
    email: null,          // 👈 útil para logs
    state: "idle",
    inQueue: false,        // 👈 evita O(n) con includes() y duplicados en cola
    roomId: null,
    joinTs: 0,
    recentPeers: new Set(),
    lastFindTs: 0,
    isAlive: true,
    isAdmin: false,
    isPro: false,
    // ===== MODO CUPIDO (lado secundario y bandera) =====
    isCupidOn: false,       // admin con modo cupido activo
    sideRoomId: null,       // sala secundaria (derecha del admin)
    sideState: "idle",      // 'idle' | 'waiting' | 'in-room'
    sideJoinTs: 0,
    sideRecentPeers: new Set(),
    lastFindSideTs: 0,
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
  me.name  = msg.displayName || me.name || "—";
  me.email = email; // 👈 guarda email
  const allowed = ADMIN_EMAILS.has(email);
  me.isAdmin = allowed;
  me.isPro   = allowed;  // mismo set para PRO
  safeSend(me.ws, { type: "role", isAdmin: me.isAdmin, isPro: me.isPro });
  break;
}

        
      case "find": {
        const now = Date.now();
        if (now - me.lastFindTs < REQUEUE_COOLDOWN_MS) return; // anti-spam
        me.lastFindTs = now;

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


      case "cupid-on": {
  if (!me.isAdmin) break;
  me.isCupidOn = true;
  console.log("[CUPID] ON by", me.id, me.email || "(no-email)", "roomId:", me.roomId);

  // Arranca búsqueda SIDE de inmediato (aunque no tengas sala principal)
  const exclude = new Set();
  if (me.roomId) {
    const main = rooms.get(me.roomId);
    if (main) exclude.add(otherOf(main, me.id));
  }
  const bId = dequeueForCupid(me.id, exclude);
  if (bId) createSideRoomAndNotify(me.id, bId);
  else safeSend(me.ws, { type: "matched-side", roomId: null, role: null, pending: true });
  break;
}

case "cupid-off": {
  if (!me.isAdmin) break;
  me.isCupidOn = false;
  if (me.sideRoomId) teardownSideRoom(me.id, "cupid-off");
  break;
}

case "cupid-find": {  // por si quieres forzar desde cliente (PC o móvil)
  if (!me.isAdmin || !me.isCupidOn) break;
  const exclude = new Set();
  if (me.roomId) {
    const main = rooms.get(me.roomId);
    if (main) exclude.add(otherOf(main, me.id));
  }
  const bId = dequeueForCupid(me.id, exclude);
  if (bId) createSideRoomAndNotify(me.id, bId);
  else safeSend(me.ws, { type: "matched-side", roomId: null, role: null, pending: true });
  break;
}
case "cupid-find-group": {
  // Solo admins pueden iniciar el match de 3
  if (!me.isAdmin) break;

  // Evitar que el admin sea matcheado en 1:1 mientras arma el grupo
  // (no cambiamos su roomId: el grupo es pura señalización P2P)
  me.state = "in-room";

  // Evita elegir a su pareja principal actual (si está en 1:1)
  const exclude = new Set();
  if (me.roomId) {
    const main = rooms.get(me.roomId);
    if (main) exclude.add(otherOf(main, me.id));
  }

  // Saca 2 usuarios de la cola para el grupo
  const pair = dequeueTwoForGroup(me.id, exclude);
  if (!pair) {
    // si no hay dos libres, aquí no rompemos nada: el cliente puede reintentar
    safeSend(me.ws, { type: "group-init", group: true, peers: [], pending: true });
    break;
  }

  const [userAId, userBId] = pair;
  const A = getClient(userAId);
  const B = getClient(userBId);

  // Márcalos como "ocupados" para que el emparejador 1:1 no los toque
  if (A) A.state = "in-room";
  if (B) B.state = "in-room";

  // Enviamos a cada uno la lista de sus dos peers
  // (mensaje NUEVO que el cliente usará para abrir 2 PeerConnections)
  safeSend(me.ws, { 
    type: "group-init", group: true, 
    peers: [{ id: userAId }, { id: userBId }]
  });
  if (A) safeSend(A.ws, { 
    type: "group-init", group: true, 
    peers: [{ id: me.id }, { id: userBId }]
  });
  if (B) safeSend(B.ws, { 
    type: "group-init", group: true, 
    peers: [{ id: me.id }, { id: userAId }]
  });

  // Nota: no creamos rooms aquí; el grupo usa solo señalización dirigida.
  // Mantén tu 1:1 intacto para el resto del sistema.
  break;
}
// ====== NUEVO: señales dirigidas para grupo (3 participantes) ======
case "group-offer":
case "group-answer":
case "group-ice": {
  // Esperamos: { type:'group-offer'|'group-answer'|'group-ice', group:true, to, sdp|candidate }
  if (!msg.group || !msg.to) break;

  const dst = getClient(msg.to);
  if (!dst) break;

  // reenviamos al destinatario con 'from'
  safeSend(dst.ws, {
    type: (msg.type === 'group-offer' ? 'offer'
         : msg.type === 'group-answer' ? 'answer'
         : 'ice'),
    group: true,
    from: id,                 // quien envía
    sdp: msg.sdp,
    candidate: msg.candidate
  });
  break;
}


// Bypass de señales con side:true
case "offer":
case "answer":
case "ice": {
  forwardSignal(id, { type: msg.type, sdp: msg.sdp, candidate: msg.candidate, side: !!msg.side });
  break;
}

case "next-main": { // botón Siguiente izquierda (admin)
  if (!me.roomId) break;
  const r = rooms.get(me.roomId);
  if (r) teardownRoom(me.roomId, "next-main");
  break;
}

case "next-side": { // botón Siguiente derecha (admin)
  if (!me.sideRoomId) {
    // si no hay side viva, intenta encontrar una
    if (me.isCupidOn) {
      const exclude = new Set();
      if (me.roomId) {
        const main = rooms.get(me.roomId);
        if (main) exclude.add(otherOf(main, me.id));
      }
      const bId = dequeueForCupid(me.id, exclude);
      if (bId) createSideRoomAndNotify(me.id, bId);
      else safeSend(me.ws, { type: "matched-side", roomId: null, role: null, pending: true });
    }
    break;
  }
  teardownSideRoom(me.id, "next-side");
  break;
}

case "leave-side": {
  if (!me.isAdmin) break;
  teardownSideRoom(me.id, "leave-side");
  break;
} 
case "group-release": {
  // Marca al cliente como disponible de nuevo
  me.state = "waiting";
  me.joinTs = Date.now();
  enqueue(id);
  scheduleMatch();
  break;
}


      case "leave": {
        //sala que en realidad es la SIDE de algún admin?
  if (me.roomId) {
    let sideHandled = false;
    for (const [aid, acli] of clients) {
      if (acli?.isAdmin && acli.sideRoomId === me.roomId) {
        teardownSideRoom(aid, "peer-leave-side");  // 👈 notifica peer-left-side y reencola al otro
        me.roomId = null;
        me.state = "idle";
        scheduleMatch();
        sideHandled = true;
        break;
      }
    }
    if (sideHandled) break;
  }

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


      default:
        break;
    }
  });

  ws.on("close", () => {
    const me = getClient(id);
    if (!me) return;
    // Si el que se va es ADMIN y tiene SIDE viva, derríbala y reencola al otro
  if (me.isAdmin && me.sideRoomId) {
    teardownSideRoom(me.id, "admin-disconnect-side");
  }
       // ¿El desconectado estaba en una sala que es la SIDE de un admin?
  if (me?.roomId) {
    let sideHandled = false;
    for (const [aid, acli] of clients) {
      if (acli?.isAdmin && acli.sideRoomId === me.roomId) {
        teardownSideRoom(aid, "disconnect-side");   // 👈 notifica peer-left-side, reencola, etc.
        sideHandled = true;
        break;
      }
    }
    if (sideHandled) {

      // Fallback: si estaba en modo grupo (sin roomId/sideRoomId) y quedó en "in-room", libéralo
if (!me.roomId && !me.sideRoomId && me.state === "in-room") {
  me.state = "waiting";
  me.joinTs = Date.now();
  enqueue(id);
  scheduleMatch();
}

      // No sigas con la lógica de sala principal para este caso
      clients.delete(id);
      console.log("[WS] closed (side):", id);
      scheduleMatch();
      return;
    }
  }

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
  // Si es admin con SIDE activo, ciérrala primero
  if (c?.isAdmin && c?.sideRoomId) {
    teardownSideRoom(id, "pong-timeout-admin-side");
  }

  clients.delete(id);

  if (c.roomId) {
    let sideHandled = false;
    for (const [aid, acli] of clients) {
      if (acli?.isAdmin && acli.sideRoomId === c.roomId) {
        teardownSideRoom(aid, "pong-timeout-side");  // 👈 side
        sideHandled = true;
        break;
      }
    }
    if (!sideHandled) {
      teardownRoom(c.roomId, "pong-timeout");        // 👈 principal
    }
  }

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
