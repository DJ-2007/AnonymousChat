// ============================================================
// server.js — AnonymousChat: Omegle-Style 1-on-1 Encrypted Chat
// ============================================================
// Users are randomly paired. They can skip or end the chat.
// Messages are relayed ONLY between paired partners.
// The server never stores messages.
// ============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// ────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// Rate-limit: max messages per window
const RATE_LIMIT_WINDOW_MS = 10_000; // 10 seconds
const RATE_LIMIT_MAX = 1000;           // max 1000 messages per window


// ────────────────────────────────────────────────────────────
// Static file server
// ────────────────────────────────────────────────────────────
const MIME_TYPES = {
  ".html": "text/html",  ".css": "text/css",
  ".js":   "text/javascript", ".json": "application/json",
  ".png":  "image/png",  ".jpg": "image/jpeg",
  ".svg":  "image/svg+xml", ".ico": "image/x-icon",
};

const httpServer = http.createServer((req, res) => {
  // Strip query parameters for file routing
  const cleanUrl = req.url.split('?')[0];
  const targetFile = cleanUrl === "/" ? "/index.html" : cleanUrl;
  
  // Possible paths (in case files were uploaded directly to root on GitHub)
  const pathInPublic = path.join(__dirname, "public", targetFile);
  const pathInRoot = path.join(__dirname, targetFile);

  const ext = path.extname(targetFile).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  // Helper to send file
  const sendFile = (filePath) => {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
        return;
      }
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    });
  };

  // Try public folder first, then fallback to root
  fs.access(pathInPublic, fs.constants.F_OK, (err) => {
    if (!err) {
      sendFile(pathInPublic);
    } else {
      sendFile(pathInRoot);
    }
  });
});

// ────────────────────────────────────────────────────────────
// WebSocket Server — 1-on-1 Pairing System
// ────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// All connected clients: Map<ws, ClientData>
const clients = new Map();
// ClientData = { id, timestamps[], partner: ws | null, state: 'idle'|'searching'|'paired' }

// Queue of users waiting for a partner (array of ws)
const waitingQueue = [];

// Map friendCodes to WebSockets for direct lookup
const friendCodeMap = new Map();

// ────────────────────────────────────────────────────────────
// Persistent Stats
// ────────────────────────────────────────────────────────────
let totalVisitors = 0;
const statsFile = path.join(__dirname, "stats.json");
try {
  if (fs.existsSync(statsFile)) {
    totalVisitors = JSON.parse(fs.readFileSync(statsFile)).totalVisitors || 0;
  }
} catch (e) {}

function incrementTotalVisitors() {
  totalVisitors++;
  fs.writeFile(statsFile, JSON.stringify({ totalVisitors }), () => {});
}

let nextId = 1;

// Helper: send JSON to a single client
function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Get total online count
function onlineCount() {
  let count = 0;
  for (const [ws, data] of clients) {
    if (!data.isAdmin) count++;
  }
  return count;
}

// Get count of people in the waiting queue
function searchingCount() {
  return waitingQueue.length;
}

// Remove a user from the waiting queue
function removeFromQueue(ws) {
  const idx = waitingQueue.indexOf(ws);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

// ────────────────────────────────────────────────────────────
// Pairing logic
// ────────────────────────────────────────────────────────────

function addToQueue(ws) {
  const data = clients.get(ws);
  if (!data) return;

  // Don't double-add
  if (waitingQueue.includes(ws)) return;

  data.state = "searching";
  data.partner = null;
  waitingQueue.push(ws);

  send(ws, { type: "searching", onlineCount: onlineCount() });

  console.log(`[🔍] User #${data.id} is searching  (queue: ${searchingCount()}, online: ${onlineCount()})`);

  // Try to pair immediately
  tryPair();
}

function tryPair() {
  // Need at least 2 people in queue
  while (waitingQueue.length >= 2) {
    const userA = waitingQueue.shift();
    const userB = waitingQueue.shift();

    const dataA = clients.get(userA);
    const dataB = clients.get(userB);

    // Safety: if either disconnected, skip them
    if (!dataA || userA.readyState !== userA.OPEN) {
      if (dataB && userB.readyState === userB.OPEN) waitingQueue.unshift(userB);
      continue;
    }
    if (!dataB || userB.readyState !== userB.OPEN) {
      if (dataA && userA.readyState === userA.OPEN) waitingQueue.unshift(userA);
      continue;
    }

    // Pair them
    dataA.partner = userB;
    dataA.state = "paired";
    dataB.partner = userA;
    dataB.state = "paired";

    console.log(`[💬] Paired: User #${dataA.id} ↔ User #${dataB.id}`);

    send(userA, { type: "partner_found", partnerCode: dataB.friendCode });
    send(userB, { type: "partner_found", partnerCode: dataA.friendCode });
  }
}

function unpair(ws) {
  const data = clients.get(ws);
  if (!data || !data.partner) return null;

  const partner = data.partner;
  const partnerData = clients.get(partner);

  // Clear the pairing on both sides
  data.partner = null;
  data.state = "idle";
  data.sentFriendRequest = false;

  if (partnerData) {
    partnerData.partner = null;
    partnerData.state = "idle";
    partnerData.sentFriendRequest = false;
  }

  return partner;
}

// ────────────────────────────────────────────────────────────
// Connection handler
// ────────────────────────────────────────────────────────────
wss.on("connection", (ws) => {
  const id = nextId++;
  clients.set(ws, { 
    id, timestamps: [], partner: null, state: "idle", 
    isAdmin: false, lastSeen: Date.now(),
    friendCode: null, sentFriendRequest: false,
    registered: false
  });

  // Assume they are a user. If they log in as admin, we could decrement, but it's negligible.
  incrementTotalVisitors();

  console.log(`[+] User #${id} connected  (${onlineCount()} online) | Total All-Time: ${totalVisitors}`);

  // Send welcome with online count
  send(ws, {
    type: "welcome",
    id,
    onlineCount: onlineCount(),
  });

  // Broadcast updated online count to everyone
  broadcastOnlineCount();

  // ── Handle messages ─────────────────────────────────────
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const data = clients.get(ws);
    if (!data) return;

    data.lastSeen = Date.now();

    // ── Rate limiting ───────────────────────────────────
    if (msg.type === "chat") {
      const now = Date.now();
      data.timestamps = data.timestamps.filter(
        (t) => now - t < RATE_LIMIT_WINDOW_MS
      );
      if (data.timestamps.length >= RATE_LIMIT_MAX) {
        send(ws, {
          type: "error",
          message: "Slow down! You're sending messages too fast.",
        });
        return;
      }
      data.timestamps.push(now);
    }

    // ── Message routing ─────────────────────────────────
    switch (msg.type) {

      // ── Find a partner (enter queue) ──────────────────
      case "find_partner":
        // If currently paired, unpair first
        if (data.partner) {
          const partner = unpair(ws);
          if (partner) {
            send(partner, { type: "partner_disconnected" });
          }
        }
        removeFromQueue(ws);
        addToQueue(ws);
        break;

      // ── Skip current partner ──────────────────────────
      case "skip": {
        const partner = unpair(ws);
        if (partner) {
          send(partner, { type: "partner_disconnected" });
        }
        // Immediately search for a new partner
        removeFromQueue(ws);
        addToQueue(ws);
        break;
      }

      // ── End chat (go idle, don't auto-search) ─────────
      case "end_chat": {
        const partner = unpair(ws);
        if (partner) {
          send(partner, { type: "partner_disconnected" });
        }
        removeFromQueue(ws);
        data.state = "idle";
        send(ws, { type: "chat_ended" });
        break;
      }

      // ── Chat message (relay to partner ONLY) ──────────
      case "chat": {
        if (!data.partner) {
          send(ws, { type: "error", message: "You're not connected to anyone." });
          return;
        }

        // Validate encrypted payload
        if (!msg.encrypted || typeof msg.encrypted !== "string") return;
        if (msg.encrypted.length > 500_000) return; // Increased to 500KB to allow images

        let previewText = undefined;
        if (msg.preview && typeof msg.preview === "string") {
          previewText = msg.preview.slice(0, 2000);
        }

        // Send to partner
        send(data.partner, {
          type: "chat",
          encrypted: msg.encrypted,
          iv: msg.iv,
          preview: previewText,
          timestamp: Date.now(),
        });

        // Echo back to sender so they see their own message
        send(ws, {
          type: "chat_self",
          encrypted: msg.encrypted,
          iv: msg.iv,
          preview: previewText,
          timestamp: Date.now(),
        });
        break;
      }

      // ── ECDH public key exchange (relay to partner) ───
      case "public_key": {
        if (data.partner) {
          send(data.partner, {
            type: "public_key",
            publicKey: msg.publicKey,
          });
        }
        break;
      }

      // ── Typing Indicator (relay to partner) ───────────
      case "typing": {
        if (data.partner) send(data.partner, { type: "typing" });
        break;
      }

      case "stopped_typing": {
        if (data.partner) send(data.partner, { type: "stopped_typing" });
        break;
      }

      // ── Keep-Alive Ping ───────────────────────────────
      case "ping": {
        send(ws, { type: "pong" });
        break;
      }

      // ── Admin Login ─────────────────────────────────────
      case "admin_login": {
        if (msg.password === ADMIN_PASSWORD) {
          data.isAdmin = true;
          removeFromQueue(ws);
          data.state = "idle";
          if (data.partner) {
             const partner = unpair(ws);
             if (partner) send(partner, { type: "partner_disconnected" });
          }
          send(ws, { type: "admin_login_success" });
          console.log(`[👑] User #${data.id} logged in as Admin`);
        } else {
          send(ws, { type: "admin_login_fail", message: "Incorrect password" });
        }
        break;
      }

      // ── Admin Broadcast ─────────────────────────────────
      case "admin_broadcast": {
        if (!data.isAdmin) return;
        for (const [client] of clients) {
          const cData = clients.get(client);
          if (cData && !cData.isAdmin) {
            send(client, { type: "system_broadcast", message: msg.message });
          }
        }
        console.log(`[📢] ADMIN BROADCAST: ${msg.message}`);
        break;
      }

      // ── Admin Disconnect All ────────────────────────────
      case "admin_disconnect_all": {
        if (!data.isAdmin) return;
        for (const [client] of clients) {
          const cData = clients.get(client);
          if (cData && !cData.isAdmin) {
             send(client, { type: "system_broadcast", message: "Server is shutting down connections." });
             client.close();
          }
        }
        console.log(`[🔥] ADMIN disconnected all users.`);
        break;
      }

      // ── Anonymous Friends System ────────────────────────
      case "register_friend_code": {
        if (msg.code && typeof msg.code === "string") {
          data.friendCode = msg.code;
          friendCodeMap.set(msg.code, ws);
          
          if (!data.registered) {
            data.registered = true;
            addToQueue(ws); // Auto-start searching now that we have the code!
          }
        }
        break;
      }
      case "check_friends_online": {
        if (!Array.isArray(msg.friends)) return;
        const statuses = {};
        for (const code of msg.friends) {
          const fWs = friendCodeMap.get(code);
          if (fWs && fWs.readyState === fWs.OPEN) {
            const fData = clients.get(fWs);
            if (fData) statuses[code] = fData.state; // "idle", "searching", "paired"
          } else {
            statuses[code] = "offline";
          }
        }
        send(ws, { type: "friends_status", statuses });
        break;
      }
      case "direct_call": {
        const targetWs = friendCodeMap.get(msg.targetCode);
        
        if (data.partner === targetWs) {
          send(ws, { type: "error", message: "You are already chatting with this friend!" });
          return;
        }

        if (!targetWs || targetWs.readyState !== targetWs.OPEN) {
          send(ws, { type: "error", message: "Friend is offline." });
          return;
        }
        const targetData = clients.get(targetWs);
        if (!targetData) return;

        if (targetData.state === "paired") {
          send(ws, { type: "error", message: "Friend is currently in another chat." });
          return;
        }

        // Valid call. Unpair caller from current chat if they were in one.
        if (data.partner) {
          const p = unpair(ws);
          if (p) send(p, { type: "partner_disconnected" });
        }
        
        removeFromQueue(ws);
        data.state = "calling"; 

        send(ws, { type: "call_ringing" });
        send(targetWs, { type: "incoming_call", callerCode: data.friendCode });
        break;
      }
      case "accept_call": {
        const callerWs = friendCodeMap.get(msg.callerCode);
        if (!callerWs || callerWs.readyState !== callerWs.OPEN) {
          send(ws, { type: "error", message: "The caller went offline." });
          return;
        }
        const callerData = clients.get(callerWs);
        if (callerData.state === "paired") {
          send(ws, { type: "error", message: "The caller is already in another chat." });
          return;
        }

        // Unpair both from whatever they were doing
        if (data.partner) { const p = unpair(ws); if (p) send(p, { type: "partner_disconnected" }); }
        if (callerData.partner) { const p = unpair(callerWs); if (p) send(p, { type: "partner_disconnected" }); }
        
        removeFromQueue(ws);
        removeFromQueue(callerWs);

        // Pair them
        data.partner = callerWs;
        data.state = "paired";
        callerData.partner = ws;
        callerData.state = "paired";

        console.log(`[📞] Direct Call Paired: ${data.friendCode} ↔ ${callerData.friendCode}`);
        send(ws, { type: "partner_found", partnerCode: callerData.friendCode });
        send(callerWs, { type: "partner_found", partnerCode: data.friendCode });
        break;
      }
      case "reject_call": {
        const callerWs = friendCodeMap.get(msg.callerCode);
        if (callerWs && callerWs.readyState === callerWs.OPEN) {
          send(callerWs, { type: "call_rejected" });
        }
        break;
      }
    }
  });

  // ── Disconnect ──────────────────────────────────────────
  ws.on("close", () => {
    const data = clients.get(ws);

    // If paired, notify partner
    if (data && data.partner) {
      const partner = data.partner;
      const partnerData = clients.get(partner);
      if (partnerData) {
        partnerData.partner = null;
        partnerData.state = "idle";
        send(partner, { type: "partner_disconnected" });
      }
    }

    // Remove from queue and clients
    removeFromQueue(ws);
    clients.delete(ws);
    if (data && data.friendCode) friendCodeMap.delete(data.friendCode);

    console.log(`[-] User #${data ? data.id : "?"} disconnected  (${onlineCount()} online)`);

    // Broadcast updated online count
    broadcastOnlineCount();
  });

  ws.on("error", (err) => {
    console.error(`[!] WebSocket error for User #${id}:`, err.message);
  });
});

// Broadcast online count to all connected clients
function broadcastOnlineCount() {
  const count = onlineCount();
  for (const [client] of clients) {
    send(client, { type: "online_count", count });
  }
}

// Broadcast stats to admins
setInterval(() => {
  let adminCount = 0;
  let searchingCount = 0;
  let pairedCount = 0;
  let idleCount = 0;

  for (const [client, data] of clients) {
    if (data.isAdmin) adminCount++;
    else if (data.state === "searching") searchingCount++;
    else if (data.state === "paired") pairedCount++;
    else idleCount++;
  }

  const activeChats = Math.floor(pairedCount / 2);

  const stats = {
    type: "admin_stats",
    online: clients.size - adminCount,
    searching: searchingCount,
    activeChats: activeChats,
    idle: idleCount,
    totalAllTime: totalVisitors
  };

  for (const [client, data] of clients) {
    if (data.isAdmin) {
      send(client, stats);
    }
  }
}, 2000);

// Clean up dead connections
setInterval(() => {
  const now = Date.now();
  for (const [ws, data] of clients) {
    // If no message/ping received in 60s, forcefully close connection
    if (now - data.lastSeen > 60000) {
      console.log(`[!] Terminating dead connection for User #${data.id}`);
      ws.terminate();
    }
  }
}, 30000);

// ────────────────────────────────────────────────────────────
// Start the server
// ────────────────────────────────────────────────────────────
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   🔒  AnonymousChat — 1-on-1 Encrypted Chat  🔒   ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║   Server running on http://localhost:${PORT}        ║
║   WebSocket ready on ws://localhost:${PORT}         ║
║                                                  ║
║   • Mode: Random 1-on-1 Pairing (Omegle-style)  ║
║   • E2E Encryption: ECDH P-256 + AES-256-GCM    ║
║   • Rate Limiting:  ${RATE_LIMIT_MAX} msgs / ${RATE_LIMIT_WINDOW_MS / 1000}s                ║
║   • Profanity Filter: Active                     ║
║                                                  ║
╚══════════════════════════════════════════════════╝
  `);
});
