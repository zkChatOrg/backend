import { createServer } from "http";
import { WebSocketServer } from "ws";
import { randomBytes } from "crypto";
import pg from "pg";

const { Pool } = pg;

const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.DATABASE_URL || "";

/* ============================================================
   1. UTILITIES
============================================================ */

function generateId() {
  return randomBytes(16).toString("hex");
}

function getClientIp(req) {
  const xfwd = req.headers["x-forwarded-for"];
  if (typeof xfwd === "string" && xfwd.length > 0) {
    return xfwd.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

/* ============================================================
   2. METRICS (Postgres-backed, totals only)
   - zkchat_metrics_totals: id, rooms_created, otm_created, files_created
============================================================ */

let dbPool = null;

async function initMetrics() {
  if (!DATABASE_URL) {
    console.log("[metrics] No DATABASE_URL set – metrics disabled.");
    return;
  }

  dbPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    // Create table if it doesn't exist
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS zkchat_metrics_totals (
        id SERIAL PRIMARY KEY,
        rooms_created BIGINT NOT NULL DEFAULT 0,
        otm_created BIGINT NOT NULL DEFAULT 0,
        files_created BIGINT NOT NULL DEFAULT 0
      );
    `);

    // Add new columns if they don't exist (migration for existing tables)
    await dbPool.query(`
      ALTER TABLE zkchat_metrics_totals
      ADD COLUMN IF NOT EXISTS chat_invites_created BIGINT NOT NULL DEFAULT 0;
    `);
    await dbPool.query(`
      ALTER TABLE zkchat_metrics_totals
      ADD COLUMN IF NOT EXISTS chat_messages_sent BIGINT NOT NULL DEFAULT 0;
    `);

    await dbPool.query(`
      INSERT INTO zkchat_metrics_totals (id, rooms_created, otm_created, files_created, chat_invites_created, chat_messages_sent)
      VALUES (1, 0, 0, 0, 0, 0)
      ON CONFLICT (id) DO NOTHING;
    `);

    console.log("[metrics] Postgres metrics initialized.");
  } catch (err) {
    console.error("[metrics] Failed to initialize Postgres:", err);
    dbPool = null;
  }
}

initMetrics().catch((err) => {
  console.error("[metrics] init error:", err);
});

function incrementMetric(field) {
  if (!dbPool) return;
  const allowed = ["rooms_created", "otm_created", "files_created", "chat_invites_created", "chat_messages_sent"];
  if (!allowed.includes(field)) return;

  const sql = `
    UPDATE zkchat_metrics_totals
    SET ${field} = ${field} + 1
    WHERE id = 1;
  `;

  dbPool.query(sql).catch((err) => {
    console.error(`[metrics] Failed to increment ${field}:`, err);
  });
}

function readMetrics(res) {
  if (!dbPool) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "metrics_disabled" }));
    return;
  }

  dbPool
    .query(
      "SELECT rooms_created, otm_created, files_created, chat_invites_created, chat_messages_sent FROM zkchat_metrics_totals WHERE id = 1;"
    )
    .then(({ rows }) => {
      const row =
        rows[0] || { rooms_created: 0, otm_created: 0, files_created: 0, chat_invites_created: 0, chat_messages_sent: 0 };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          roomsCreated: Number(row.rooms_created || 0),
          otmCreated: Number(row.otm_created || 0),
          filesCreated: Number(row.files_created || 0),
          chatInvitesCreated: Number(row.chat_invites_created || 0),
          chatMessagesSent: Number(row.chat_messages_sent || 0),
        })
      );
    })
    .catch((err) => {
      console.error("[metrics] read error:", err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "metrics_read_failed" }));
    });
}

/* ============================================================
   3. ONE-TIME MESSAGE STORE (JSON-BASED)
============================================================ */

const otmStore = new Map();
const OTM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function generateOtmId() {
  return randomBytes(16).toString("hex");
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of otmStore.entries()) {
    if (now - entry.createdAt > OTM_TTL_MS) {
      otmStore.delete(id);
    }
  }
}, 60 * 1000);

/* ============================================================
   4. FILEDROP STORE — BINARY SUPPORT
============================================================ */

const fileStore = new Map();
const FILE_TTL_MS = 24 * 60 * 60 * 1000;

function generateFileId() {
  return randomBytes(16).toString("hex");
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of fileStore.entries()) {
    if (now - entry.createdAt > FILE_TTL_MS) {
      fileStore.delete(id);
    }
  }
}, 60 * 1000);

/* ============================================================
   4b. CHAT INVITE STORE — One-time invites for permanent chat
============================================================ */

const chatInviteStore = new Map();
const CHAT_INVITE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Cleanup expired invites
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of chatInviteStore.entries()) {
    if (now - entry.createdAt > CHAT_INVITE_TTL_MS) {
      chatInviteStore.delete(id);
    }
  }
}, 60 * 1000);

/* ============================================================
   4c. CHAT MESSAGE STORE — Pending messages for offline users

   Messages are E2E encrypted with Signal Protocol (X3DH + Double Ratchet).
   The server cannot see message content. Payload can contain:
   - Text messages
   - Image/audio/file data
   - Reply-to metadata (messageId, senderName, preview)
   - Emoji reactions (targetMessageId, emoji, action: add/remove)

   All content types use the same endpoint - the server just stores
   and forwards the encrypted payload without interpretation.
============================================================ */

const chatMessageStore = new Map(); // fingerprint -> [{ id, from, payload, timestamp }]
const CHAT_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Cleanup expired messages
setInterval(() => {
  const now = Date.now();
  for (const [fingerprint, messages] of chatMessageStore.entries()) {
    const remaining = messages.filter(m => now - m.timestamp < CHAT_MESSAGE_TTL_MS);
    if (remaining.length === 0) {
      chatMessageStore.delete(fingerprint);
    } else {
      chatMessageStore.set(fingerprint, remaining);
    }
  }
}, 60 * 1000);

// WebSocket connections for real-time chat (fingerprint -> ws)
const chatConnections = new Map();

/* ============================================================
   5. RATE LIMITERS
============================================================ */

const RATE_WINDOW_MS = 60 * 1000;
const MAX_POST_OTM_PER_WINDOW = 30;
const MAX_GET_OTM_PER_WINDOW = 60;

const rateBuckets = new Map();

function checkRateLimit(req, type) {
  const ip = getClientIp(req);
  const now = Date.now();
  let bucket = rateBuckets.get(ip);

  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    bucket = { windowStart: now, postCount: 0, getCount: 0 };
    rateBuckets.set(ip, bucket);
  }

  if (type === "post-otm") {
    bucket.postCount++;
    if (bucket.postCount > MAX_POST_OTM_PER_WINDOW) return false;
  }
  if (type === "get-otm") {
    bucket.getCount++;
    if (bucket.getCount > MAX_GET_OTM_PER_WINDOW) return false;
  }

  return true;
}

// File drop rate limiting
const FILE_RATE_WINDOW_MS = 60 * 1000;
const MAX_POST_FILE_PER_WINDOW = 10;
const MAX_GET_FILE_PER_WINDOW = 30;

const fileRateBuckets = new Map();

function checkFileRateLimit(req, type) {
  const ip = getClientIp(req);
  const now = Date.now();
  let bucket = fileRateBuckets.get(ip);

  if (!bucket || now - bucket.windowStart > FILE_RATE_WINDOW_MS) {
    bucket = { windowStart: now, uploadCount: 0, downloadCount: 0 };
    fileRateBuckets.set(ip, bucket);
  }

  if (type === "upload") {
    bucket.uploadCount++;
    if (bucket.uploadCount > MAX_POST_FILE_PER_WINDOW) return false;
  }
  if (type === "download") {
    bucket.downloadCount++;
    if (bucket.downloadCount > MAX_GET_FILE_PER_WINDOW) return false;
  }

  return true;
}

// Chat rate limiting
const CHAT_RATE_WINDOW_MS = 60 * 1000;
const MAX_CHAT_INVITE_PER_WINDOW = 10;
const MAX_CHAT_MESSAGE_PER_WINDOW = 60;

const chatRateBuckets = new Map();

function checkChatRateLimit(req, type) {
  const ip = getClientIp(req);
  const now = Date.now();
  let bucket = chatRateBuckets.get(ip);

  if (!bucket || now - bucket.windowStart > CHAT_RATE_WINDOW_MS) {
    bucket = { windowStart: now, inviteCount: 0, messageCount: 0 };
    chatRateBuckets.set(ip, bucket);
  }

  if (type === "invite") {
    bucket.inviteCount++;
    if (bucket.inviteCount > MAX_CHAT_INVITE_PER_WINDOW) return false;
  }
  if (type === "message") {
    bucket.messageCount++;
    if (bucket.messageCount > MAX_CHAT_MESSAGE_PER_WINDOW) return false;
  }

  return true;
}

/* ============================================================
   6. WEBSOCKET ROOMS
============================================================ */

const rooms = new Map();
const burnedRooms = new Set();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { clients: new Set(), timer: null });
  }
  return rooms.get(roomId);
}

function scheduleDestruction(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.timer = setTimeout(() => {
    rooms.delete(roomId);
  }, 5000);
}

function broadcastPresence(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const msg = JSON.stringify({
    type: "presence",
    roomId,
    count: room.clients.size,
  });

  for (const client of room.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

/* ============================================================
   7. HTTP SERVER
============================================================ */

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const urlObj = new URL(req.url || "/", "http://localhost");
  const pathname = urlObj.pathname;

  // Basic health
  if (pathname === "/health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ status: "ok" }));
  }

  // Global usage metrics
  if (pathname === "/metrics" && req.method === "GET") {
    return readMetrics(res);
  }

  /* ============================================================
     OTM CREATE (JSON)
  ============================================================ */

  if (pathname === "/otm" && req.method === "POST") {
    if (!checkRateLimit(req, "post-otm")) {
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Rate limit exceeded" }));
    }

    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });

    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        if (!parsed.ciphertext) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ error: "Missing ciphertext" }));
        }

        const id = generateOtmId();
        otmStore.set(id, { ciphertext: parsed.ciphertext, createdAt: Date.now() });

        incrementMetric("otm_created");

        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ id }));
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });

    return;
  }

  /* ============================================================
     OTM READ (ONE-TIME)
  ============================================================ */

  if (pathname.startsWith("/otm/") && req.method === "GET") {
    if (!checkRateLimit(req, "get-otm")) {
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Rate limit exceeded" }));
    }

    const id = pathname.split("/")[2];
    const entry = otmStore.get(id);

    if (!entry) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ used: true }));
    }

    if (Date.now() - entry.createdAt > OTM_TTL_MS) {
      otmStore.delete(id);
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ used: true }));
    }

    otmStore.delete(id);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ciphertext: entry.ciphertext }));
  }

  /* ============================================================
     FILE UPLOAD — BINARY
  ============================================================ */

  if (pathname === "/file" && req.method === "POST") {
    if (!checkFileRateLimit(req, "upload")) {
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Rate limit exceeded" }));
    }

    const chunks = [];
    let total = 0;
    const MAX_SIZE = 12 * 1024 * 1024;

    req.on("data", (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total > MAX_SIZE) req.destroy();
    });

    req.on("end", () => {
      const ciphertext = Buffer.concat(chunks);
      const id = generateFileId();

      fileStore.set(id, {
        ciphertext,
        createdAt: Date.now(),
      });

      incrementMetric("files_created");

      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ id }));
    });

    return;
  }

  /* ============================================================
     FILE DOWNLOAD — BINARY (ONE-TIME)
  ============================================================ */

  if (pathname.startsWith("/file/") && req.method === "GET") {
    if (!checkFileRateLimit(req, "download")) {
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Rate limit exceeded" }));
    }

    const id = pathname.split("/")[2];
    const entry = fileStore.get(id);

    if (!entry) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ used: true }));
    }

    if (Date.now() - entry.createdAt > FILE_TTL_MS) {
      fileStore.delete(id);
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ used: true }));
    }

    const ciphertext = entry.ciphertext;
    fileStore.delete(id);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/octet-stream");
    return res.end(ciphertext);
  }

  /* ============================================================
     CHAT INVITE CREATE
  ============================================================ */

  if (pathname === "/chat/invite" && req.method === "POST") {
    if (!checkChatRateLimit(req, "invite")) {
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Rate limit exceeded" }));
    }

    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 100_000) req.destroy();
    });

    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const { inviteId, publicKeyBundle, expiresAt } = parsed;

        if (!inviteId || !publicKeyBundle) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ error: "Missing inviteId or publicKeyBundle" }));
        }

        // Check if invite ID already exists
        if (chatInviteStore.has(inviteId)) {
          res.statusCode = 409;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ error: "Invite ID already exists" }));
        }

        chatInviteStore.set(inviteId, {
          publicKeyBundle,
          expiresAt: expiresAt ? new Date(expiresAt).getTime() : Date.now() + CHAT_INVITE_TTL_MS,
          createdAt: Date.now(),
          claimed: false,
          claimerBundle: null,
        });

        incrementMetric("chat_invites_created");

        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ success: true, inviteId }));
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });

    return;
  }

  /* ============================================================
     CHAT INVITE GET — Fetch invite details
  ============================================================ */

  if (pathname.match(/^\/chat\/invite\/[^/]+$/) && req.method === "GET") {
    const inviteId = pathname.split("/")[3];
    const entry = chatInviteStore.get(inviteId);

    if (!entry) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Invite not found" }));
    }

    // Check expiry
    if (Date.now() > entry.expiresAt) {
      chatInviteStore.delete(inviteId);
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Invite expired" }));
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      inviteId,
      publicKeyBundle: entry.publicKeyBundle,
      claimed: entry.claimed,
      claimerBundle: entry.claimerBundle,
    }));
  }

  /* ============================================================
     CHAT INVITE CLAIM — Second party claims the invite
  ============================================================ */

  if (pathname.match(/^\/chat\/invite\/[^/]+\/claim$/) && req.method === "POST") {
    if (!checkChatRateLimit(req, "invite")) {
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Rate limit exceeded" }));
    }

    const inviteId = pathname.split("/")[3];

    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 100_000) req.destroy();
    });

    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const { claimerBundle } = parsed;

        if (!claimerBundle) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ error: "Missing claimerBundle" }));
        }

        const entry = chatInviteStore.get(inviteId);

        if (!entry) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ error: "Invite not found" }));
        }

        // Check expiry
        if (Date.now() > entry.expiresAt) {
          chatInviteStore.delete(inviteId);
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ error: "Invite expired" }));
        }

        // Check if already claimed
        if (entry.claimed) {
          res.statusCode = 409;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ error: "Invite already claimed" }));
        }

        // Mark as claimed and store claimer's bundle
        entry.claimed = true;
        entry.claimerBundle = claimerBundle;

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({
          success: true,
          creatorBundle: entry.publicKeyBundle,
        }));
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });

    return;
  }

  /* ============================================================
     CHAT MESSAGE SEND — Store message for recipient
  ============================================================ */

  if (pathname === "/chat/message" && req.method === "POST") {
    if (!checkChatRateLimit(req, "message")) {
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Rate limit exceeded" }));
    }

    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 500_000) req.destroy(); // 500KB max for encrypted message
    });

    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const { to, from, encryptedMessage, messageId } = parsed;

        if (!to || !encryptedMessage || !messageId) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ error: "Missing to, encryptedMessage, or messageId" }));
        }

        // Get or create message queue for recipient
        if (!chatMessageStore.has(to)) {
          chatMessageStore.set(to, []);
        }

        const messages = chatMessageStore.get(to);

        // Check for duplicate message ID
        if (messages.some(m => m.id === messageId)) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ success: true, duplicate: true }));
        }

        // Add message to queue
        messages.push({
          id: messageId,
          from: from || "unknown",
          payload: encryptedMessage,
          timestamp: Date.now(),
        });

        incrementMetric("chat_messages_sent");

        // Try to deliver via WebSocket if recipient is connected
        const recipientWs = chatConnections.get(to);
        if (recipientWs && recipientWs.readyState === 1) {
          recipientWs.send(JSON.stringify({
            type: "newMessage",
            message: {
              id: messageId,
              from: from || "unknown",
              payload: encryptedMessage,
            },
          }));
        }

        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ success: true }));
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });

    return;
  }

  /* ============================================================
     CHAT MESSAGES FETCH — Get pending messages for a fingerprint
  ============================================================ */

  if (pathname.match(/^\/chat\/messages\/[^/]+$/) && req.method === "GET") {
    const fingerprint = pathname.split("/")[3];

    const messages = chatMessageStore.get(fingerprint) || [];

    // Filter out expired messages
    const now = Date.now();
    const validMessages = messages.filter(m => now - m.timestamp < CHAT_MESSAGE_TTL_MS);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      messages: validMessages.map(m => ({
        id: m.id,
        from: m.from,
        payload: m.payload,
        timestamp: m.timestamp,
      })),
    }));
  }

  /* ============================================================
     CHAT MESSAGES ACKNOWLEDGE — Remove delivered messages
  ============================================================ */

  if (pathname === "/chat/messages/ack" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 50_000) req.destroy();
    });

    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const { fingerprint, messageIds } = parsed;

        if (!fingerprint || !Array.isArray(messageIds)) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ error: "Missing fingerprint or messageIds" }));
        }

        const messages = chatMessageStore.get(fingerprint);
        if (messages) {
          const remaining = messages.filter(m => !messageIds.includes(m.id));
          if (remaining.length === 0) {
            chatMessageStore.delete(fingerprint);
          } else {
            chatMessageStore.set(fingerprint, remaining);
          }
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ success: true }));
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });

    return;
  }

  // Default response
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain");
  res.end("zkChat relay running");
});

/* ============================================================
   8. WEBSOCKETS (TEXT + BINARY SAFE)
============================================================ */

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const roomId = url.searchParams.get("roomId");
    const chatFingerprint = url.searchParams.get("chatFingerprint");

    // Handle permanent chat WebSocket connections
    if (chatFingerprint) {
      // Register this connection for real-time message delivery
      chatConnections.set(chatFingerprint, ws);

      ws.send(JSON.stringify({ type: "connected", fingerprint: chatFingerprint }));

      ws.on("message", (data) => {
        // Chat WebSocket is primarily for receiving, but can handle acks
        try {
          const text = typeof data === "string" ? data : data.toString("utf8");
          const parsed = JSON.parse(text);

          if (parsed.type === "ack" && Array.isArray(parsed.messageIds)) {
            // Acknowledge messages
            const messages = chatMessageStore.get(chatFingerprint);
            if (messages) {
              const remaining = messages.filter(m => !parsed.messageIds.includes(m.id));
              if (remaining.length === 0) {
                chatMessageStore.delete(chatFingerprint);
              } else {
                chatMessageStore.set(chatFingerprint, remaining);
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
      });

      ws.on("close", () => {
        // Only remove if this is still the active connection for this fingerprint
        if (chatConnections.get(chatFingerprint) === ws) {
          chatConnections.delete(chatFingerprint);
        }
      });

      return;
    }

    // Handle room WebSocket connections (existing functionality)
    if (!roomId) return ws.close();

    if (burnedRooms.has(roomId)) {
      ws.send(JSON.stringify({ type: "roomDestroyed", roomId }));
      return ws.close();
    }

    const isNewRoom = !rooms.has(roomId);
    const room = getRoom(roomId);

    if (isNewRoom) {
      incrementMetric("rooms_created");
    }

    room.clients.add(ws);

    if (room.timer) clearTimeout(room.timer);

    broadcastPresence(roomId);

    ws.on("message", (data, isBinary) => {
      // If this is a binary frame (e.g. encrypted audio),
      // we NEVER attempt to parse or inspect it.
      if (isBinary) {
        const r = rooms.get(roomId);
        if (!r) return;

        for (const client of r.clients) {
          if (client !== ws && client.readyState === 1) {
            client.send(data, { binary: true });
          }
        }
        return;
      }

      // Text frames (JSON for control + encrypted text messages)
      const text =
        typeof data === "string" ? data : data.toString("utf8");

      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Opaque encrypted payload that just happens to be stringifiable
        // → treat as normal message.
      }

      // Handle control frames (burnRoom)
      if (
        parsed &&
        parsed.type === "control" &&
        parsed.action === "burnRoom" &&
        parsed.roomId === roomId
      ) {
        burnedRooms.add(roomId);

        const destroyMsg = JSON.stringify({ type: "roomDestroyed", roomId });

        const r = rooms.get(roomId);
        if (r) {
          for (const client of r.clients) {
            if (client.readyState === 1) client.send(destroyMsg);
            client.close();
          }
          rooms.delete(roomId);
        } else {
          ws.send(destroyMsg);
          ws.close();
        }

        return;
      }

      // Broadcast normal text messages (encrypted JSON blobs) to others
      const r = rooms.get(roomId);
      if (!r) return;

      for (const client of r.clients) {
        if (client !== ws && client.readyState === 1) {
          client.send(text);
        }
      }
    });

    ws.on("close", () => {
      const room = rooms.get(roomId);
      if (!room) return;

      room.clients.delete(ws);
      if (room.clients.size === 0) scheduleDestruction(roomId);
      else broadcastPresence(roomId);
    });
  } catch {
    ws.close();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("WebSocket relay running on " + PORT);
});
