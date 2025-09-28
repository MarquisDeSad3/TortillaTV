// server.js
require("dotenv").config();
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { v4: uuid } = require("uuid");

const PORT = process.env.PORT || 8080;
const app = express();

// Log de cada request HTTP (verás GET /instant.html)
app.use((req,res,next)=>{ console.log("[HTTP]", req.method, req.url); next(); });

// Sirve /public
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map(); // id -> { ws, gender, name, roomId }
let waiting = [];          // [{ id, gender, name }]

function safeSend(ws, obj){ try{ ws.send(JSON.stringify(obj)); }catch(e){ console.log("WS send error:", e.message); } }
function broadcastRoom(roomId, fromId, payload){
  for (const [id,info] of clients) {
    if (id!==fromId && info.roomId===roomId) {
      safeSend(info.ws, payload);
    }
  }
}
function matchRandom(){
  if (waiting.length < 2) return;
  waiting.sort(()=>Math.random()-0.5);
  while (waiting.length >= 2) {
    const a = waiting.shift();
    const b = waiting.shift();
    const roomId = uuid();
    const A = clients.get(a.id); const B = clients.get(b.id);
    if (!A || !B) continue;
    A.roomId = roomId; B.roomId = roomId;
    console.log("[MATCH]", a.id, "<>", b.id, "->", roomId);
    safeSend(A.ws, { type:"matched", roomId, role:"offer",  peer:{ id:b.id, name:b.name } });
    safeSend(B.ws, { type:"matched", roomId, role:"answer", peer:{ id:a.id, name:a.name } });
  }
}

wss.on("connection", (ws)=>{
  const id = uuid();
  clients.set(id, { ws, gender:null, name:null, roomId:null });
  console.log("[WS] client connected:", id);
  safeSend(ws, { type:"welcome", id });

  ws.on("message", (raw)=>{
    let msg={}; try{ msg = JSON.parse(raw.toString()); }catch{ return; }
    const me = clients.get(id); if(!me) return;

    if (msg.type==="find") {
      me.gender = msg.gender || "Hombre";
      me.name   = msg.displayName || "—";
      me.roomId = null;
      waiting = waiting.filter(x=>x.id!==id);
      waiting.push({ id, gender: me.gender, name: me.name });
      console.log("[WS] find -> waiting:", waiting.length);
      matchRandom();
    } else if (msg.type==="offer" || msg.type==="answer" || msg.type==="ice") {
      if (!me.roomId) return;
      broadcastRoom(me.roomId, id, { type: msg.type, sdp: msg.sdp, candidate: msg.candidate });
    } else if (msg.type==="leave") {
      waiting = waiting.filter(x=>x.id!==id);
      if (me.roomId) { broadcastRoom(me.roomId, id, { type:"peer-left" }); }
      me.roomId = null;
    }
  });

  ws.on("close", ()=>{
    const me = clients.get(id);
    if (!me) return;
    waiting = waiting.filter(x=>x.id!==id);
    if (me.roomId) { broadcastRoom(me.roomId, id, { type:"peer-left" }); }
    clients.delete(id);
    console.log("[WS] client closed:", id);
  });
});

server.listen(PORT, ()=>{
  console.log(`Signalling server running on :${PORT}`);
});
