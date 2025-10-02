// server.js (matchmaker robusto)
require("dotenv").config();
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { v4: uuid } = require("uuid");

const PORT = process.env.PORT || 8080;
const MATCH_OFFER_TIMEOUT_MS = 8000;  // tiempo para que el 'offer' llegue
const MATCH_ANSWER_TIMEOUT_MS = 8000; // tiempo para que el 'answer' llegue
const PING_INTERVAL_MS = 15000;       // ping para limpiar clientes muertos
const RECENT_PEERS_MAX = 5;           // memoria corta para no repetir
const REQUEUE_COOLDOWN_MS = 250;      // anti-spam de find()

const app = express();
app.use((req,res,next)=>{ console.log("[HTTP]", req.method, req.url); next(); });
app.use(express.static("public"));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** Estructuras **/
/**
 * clients: id -> {
 *   ws, name, gender,
 *   state: 'idle' | 'waiting' | 'in-room',
 *   roomId: string|null,
 *   recentPeers: Set<string>,
 *   lastFindTs: number,
 *   isAlive: boolean
 * }
 */
const clients = new Map();

/**
 * waiting: Array<string>  (IDs en orden FIFO)
 */
let waiting = [];

/**
 * rooms: roomId -> { aId, bId, timers: { offer?:NodeJS.Timeout, answer?:NodeJS.Timeout } }
 */
const rooms = new Map();

let matchingInProgress = false;

/** Utils **/
function safeSend(ws, obj){
  try { ws.send(JSON.stringify(obj)); } catch(e){ console.log("WS send error:", e.message); }
}
function getClient(id){ return clients.get(id); }
function inArray(arr, id){ return arr.indexOf(id) !== -1; }
function removeFromWaiting(id){ waiting = waiting.filter(x => x !== id); }
function setState(id, state){ const c=getClient(id); if(c) c.state = state; }
function setRoom(id, roomId){ const c=getClient(id); if(c) c.roomId = roomId; }
function addRecentPeer(aId, bId){
  const A=getClient(aId), B=getClient(bId);
  if(!A || !B) return;
  if(!A.recentPeers) A.recentPeers = new Set();
  if(!B.recentPeers) B.recentPeers = new Set();
  A.recentPeers.add(bId); B.recentPeers.add(aId);
  // Limitar tamaño aproximado
  if (A.recentPeers.size > RECENT_PEERS_MAX) {
    const first = A.recentPeers.values().next().value; A.recentPeers.delete(first);
  }
  if (B.recentPeers.size > RECENT_PEERS_MAX) {
    const first = B.recentPeers.values().next().value; B.recentPeers.delete(first);
  }
}
function clearRecentPeer(id, peerId){
  const c=getClient(id);
  if (c?.recentPeers?.has(peerId)) c.recentPeers.delete(peerId);
}
function otherOf(room, meId){ return room.aId === meId ? room.bId : room.aId; }
function broadcastToRoom(roomId, fromId, payload){
  const room = rooms.get(roomId);
  if(!room) return;
  const otherId = otherOf(room, fromId);
  const other = getClient(otherId);
  if(other) safeSend(other.ws, payload);
}

/** Matchmaker FIFO con exclusiones recientes **/
async function runMatcher(){
  if (matchingInProgress) return;
  matchingInProgress = true;

  try{
    // Limpia a cualquiera que ya no esté en estado waiting
    waiting = waiting.filter(id => getClient(id)?.state === 'waiting');

    if (waiting.length < 2) return;

    const matched = new Set(); // ids que ya emparejamos en esta ronda
    const nextWaiting = [];

    // Iteramos en FIFO tratando de buscar la primera pareja válida para cada uno
    for (let i = 0; i < waiting.length; i++){
      const aId = waiting[i];
      if (matched.has(aId)) continue;
      const A = getClient(aId);
      if (!A || A.state !== 'waiting') continue;

      let found = null;
      for (let j = i + 1; j < waiting.length; j++){
        const bId = waiting[j];
        if (matched.has(bId)) continue;
        const B = getClient(bId);
        if (!B || B.state !== 'waiting') continue;

        // Evitar emparejar con el mismo de inmediato
        const aBlock = A.recentPeers?.has(bId);
        const bBlock = B.recentPeers?.has(aId);
        if (aBlock || bBlock) continue;

        // (Aquí podrías meter filtros de género/región/intereses si quisieras)

        found = bId;
        break;
      }

      if (found){
        const a = A;
        const b = getClient(found);

        // Sacar de waiting + marcar
        matched.add(aId); matched.add(found);

        // Crear sala
        const roomId = uuid();
        rooms.set(roomId, { aId: aId, bId: found, timers: {} });
        setRoom(aId, roomId);
        setRoom(found, roomId);
        setState(aId, 'in-room');
        setState(found, 'in-room');

        addRecentPeer(aId, found); // memoria de "acaban de verse"

        console.log("[MATCH] FIFO", aId, "<>", found, "->", roomId);

        // Asignamos roles: el que más tiempo estuvo primero será "offer" (determinista)
        safeSend(a.ws, { type:"matched", roomId, role:"offer",  peer:{ id:found, name:b.name || "—" } });
        safeSend(b.ws, { type:"matched", roomId, role:"answer", peer:{ id:aId,   name:a.name || "—" } });

        // Timeouts de oferta/respuesta para romper salas zombie
        const r = rooms.get(roomId);
        if (r){
          r.timers.offer = setTimeout(()=>{
            // Si aún no llegó un 'offer', cancelamos
            const still = rooms.get(roomId);
            if (!still) return;
            console.log("[TIMEOUT] offer room:", roomId);
            teardownRoom(roomId, "offer-timeout");
          }, MATCH_OFFER_TIMEOUT_MS);

          r.timers.answer = setTimeout(()=>{
            const still = rooms.get(roomId);
            if (!still) return;
            console.log("[TIMEOUT] answer room:", roomId);
            teardownRoom(roomId, "answer-timeout");
          }, MATCH_OFFER_TIMEOUT_MS + MATCH_ANSWER_TIMEOUT_MS);
        }
      } else {
        // No hubo pareja válida para 'a' → queda esperando
        nextWaiting.push(aId);
      }
    }

    // Añadimos los que no se emparejaron ni fueron emparejados por otros
    for (const id of waiting){
      if (!matched.has(id) && !inArray(nextWaiting, id)) {
        const c = getClient(id);
        if (c?.state === 'waiting') nextWaiting.push(id);
      }
    }

    waiting = nextWaiting;
  } finally {
    matchingInProgress = false;
  }
}

/** Romper sala y reencolar (opcional) **/
function teardownRoom(roomId, reason = "teardown"){
  const room = rooms.get(roomId);
  if (!room) return;
  const { aId, bId, timers } = room;

  // limpiar timers
  if (timers?.offer)  clearTimeout(timers.offer);
  if (timers?.answer) clearTimeout(timers.answer);

  rooms.delete(roomId);

  // Notificar a ambos
  const A = getClient(aId), B = getClient(bId);
  if (A) {
    safeSend(A.ws, { type:"peer-left", reason });
    setRoom(aId, null);
    // Devuelve a espera solo si el cliente seguía conectado
    if (A.state !== 'idle') { A.state = 'waiting'; if (!inArray(waiting, aId)) waiting.push(aId); }
  }
  if (B) {
    safeSend(B.ws, { type:"peer-left", reason });
    setRoom(bId, null);
    if (B.state !== 'idle') { B.state = 'waiting'; if (!inArray(waiting, bId)) waiting.push(bId); }
  }

  // Relanzar el emparejador
  setImmediate(runMatcher);
}

/** Señalización directa por sala **/
function forwardSignal(meId, payload){
  const me = getClient(meId);
  if (!me?.roomId) return;
  const room = rooms.get(me.roomId);
  if (!room) return;

  // Una vez que llega 'offer' o 'answer', levantamos timeouts correspondientes
  if (payload.type === "offer" && room.timers?.offer) {
    clearTimeout(room.timers.offer);
    room.timers.offer = null;
  }
  if (payload.type === "answer" && room.timers?.answer) {
    clearTimeout(room.timers.answer);
    room.timers.answer = null;
  }

  const otherId = otherOf(room, meId);
  const other = getClient(otherId);
  if (other) safeSend(other.ws, payload);
}

/** WebSocket **/
wss.on("connection", (ws)=>{
  const id = uuid();
  clients.set(id, {
    ws, gender:null, name:null,
    state: 'idle',
    roomId: null,
    recentPeers: new Set(),
    lastFindTs: 0,
    isAlive: true
  });
  console.log("[WS] client connected:", id);
  safeSend(ws, { type:"welcome", id });

  ws.on("pong", ()=>{ const c=getClient(id); if(c) c.isAlive = true; });

  ws.on("message", (raw)=>{
    let msg={}; try{ msg = JSON.parse(raw.toString()); }catch{ return; }
    const me = getClient(id); if(!me) return;

    switch(msg.type){
      case "find": {
        const now = Date.now();
        if (now - me.lastFindTs < REQUEUE_COOLDOWN_MS) return; // antispam
        me.lastFindTs = now;

        me.gender = msg.gender || "Hombre";
        me.name   = msg.displayName || "—";

        // Si venía de una sala, desasociar
        if (me.roomId) {
          const room = rooms.get(me.roomId);
          if (room) teardownRoom(me.roomId, "requeue");
          me.roomId = null;
        }

        // Estado -> waiting
        me.state = "waiting";
        removeFromWaiting(id);
        waiting.push(id);

        console.log("[WS] find -> waiting:", waiting.length);
        runMatcher();
        break;
      }
      case "offer":
      case "answer":
      case "ice": {
        forwardSignal(id, { type: msg.type, sdp: msg.sdp, candidate: msg.candidate });
        break;
      }
      case "leave": {
        // deja la sala si la hay
        if (me.roomId){
          const r = rooms.get(me.roomId);
          if (r) {
            // Notificamos al otro y reencolamos solo al otro (quien dejó queda idle)
            const otherId = otherOf(r, id);
            const other = getClient(otherId);
            if (other){
              safeSend(other.ws, { type:"peer-left", reason: "peer-leave" });
              setRoom(otherId, null);
              if (other.state !== 'idle') { other.state = 'waiting'; if (!inArray(waiting, otherId)) waiting.push(otherId); }
            }
            // limpiar sala
            if (r.timers?.offer)  clearTimeout(r.timers.offer);
            if (r.timers?.answer) clearTimeout(r.timers.answer);
            rooms.delete(me.roomId);
          }
          me.roomId = null;
        }
        // el que llama 'leave' pasa a idle (no reencolar automáticamente)
        me.state = 'idle';
        removeFromWaiting(id);
        // Importante: recuerda al último peer para no repetir inmediato si hace 'find' de nuevo
        if (msg.lastPeerId) {
          me.recentPeers.add(msg.lastPeerId);
          if (me.recentPeers.size > RECENT_PEERS_MAX) {
            const first = me.recentPeers.values().next().value; me.recentPeers.delete(first);
          }
        }
        break;
      }
      case "clearRecent": {
        // opcional: permitir que el cliente olvidé a 1 peer concreto
        if (msg.peerId) clearRecentPeer(id, msg.peerId);
        break;
      }
      default: break;
    }
  });

  ws.on("close", ()=>{
    const me = getClient(id);
    if (!me) return;
    removeFromWaiting(id);

    if (me.roomId) {
      // Notificar al otro y reencolarlo
      const r = rooms.get(me.roomId);
      if (r) {
        const otherId = otherOf(r, id);
        const other = getClient(otherId);
        if (other){
          safeSend(other.ws, { type:"peer-left", reason: "disconnect" });
          setRoom(otherId, null);
          if (other.state !== 'idle') { other.state = 'waiting'; if (!inArray(waiting, otherId)) waiting.push(otherId); }
        }
        if (r.timers?.offer)  clearTimeout(r.timers.offer);
        if (r.timers?.answer) clearTimeout(r.timers.answer);
        rooms.delete(me.roomId);
      }
    }

    clients.delete(id);
    console.log("[WS] client closed:", id);
    setImmediate(runMatcher);
  });
});

/** Ping/pong keepalive **/
const interval = setInterval(()=>{
  for (const [id,c] of clients){
    if (!c.isAlive) {
      try { c.ws.terminate(); } catch {}
      clients.delete(id);
      removeFromWaiting(id);
      if (c.roomId) teardownRoom(c.roomId, "pong-timeout");
      console.log("[WS] terminated dead client:", id);
      continue;
    }
    c.isAlive = false;
    try { c.ws.ping(); } catch {}
  }
}, PING_INTERVAL_MS);

wss.on("close", ()=> clearInterval(interval));

server.listen(PORT, ()=>{ console.log(`Signalling server running on :${PORT}`); });
