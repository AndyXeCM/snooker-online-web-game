import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 5173);

const clients = new Map();
const rooms = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: clients.size }));
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, normalized);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

function makeId() {
  return crypto.randomBytes(6).toString("hex");
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return rooms.has(code) ? makeRoomCode() : code;
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    mode: room.mode,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      host: player.id === room.hostId,
      connectedAt: player.connectedAt,
    })),
  };
}

function encodeFrame(text) {
  const payload = Buffer.from(text);
  const length = payload.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), payload]);
  }
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function send(client, type, payload = {}, requestId = null) {
  if (!client.socket.writable) return;
  if (type === "game:snapshot" && client.socket.writableLength > 256 * 1024) return;
  client.socket.write(encodeFrame(JSON.stringify({ type, payload, requestId })));
}

function reply(client, requestId, payload) {
  send(client, "reply", payload, requestId);
}

function broadcast(room, type, payload, exceptId = null) {
  for (const player of room.players) {
    if (player.id === exceptId) continue;
    const client = clients.get(player.id);
    if (client) send(client, type, payload);
  }
}

function emitRoom(room) {
  broadcast(room, "room:update", publicRoom(room));
}

function leaveCurrentRoom(client) {
  if (!client.roomCode) return;
  const room = rooms.get(client.roomCode);
  client.roomCode = null;
  if (!room) return;

  room.players = room.players.filter((player) => player.id !== client.id);
  if (!room.players.length) {
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === client.id) {
    room.hostId = room.players[0].id;
    const host = clients.get(room.hostId);
    if (host) send(host, "room:host", {});
  }
  emitRoom(room);
}

function handleMessage(client, message) {
  const { type, payload = {}, requestId = null } = message || {};

  if (type === "room:create") {
    leaveCurrentRoom(client);
    const code = makeRoomCode();
    const room = {
      code,
      hostId: client.id,
      mode: payload.mode || "eight",
      players: [
        {
          id: client.id,
          name: String(payload.name || "房主").trim().slice(0, 16) || "房主",
          connectedAt: Date.now(),
        },
      ],
    };
    rooms.set(code, room);
    client.roomCode = code;
    reply(client, requestId, { ok: true, room: publicRoom(room), socketId: client.id });
    emitRoom(room);
    return;
  }

  if (type === "room:join") {
    const code = String(payload.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      reply(client, requestId, { ok: false, error: "没有找到这个房间" });
      return;
    }
    if (room.players.length >= 2) {
      reply(client, requestId, { ok: false, error: "房间已满" });
      return;
    }

    leaveCurrentRoom(client);
    room.players.push({
      id: client.id,
      name: String(payload.name || "客人").trim().slice(0, 16) || "客人",
      connectedAt: Date.now(),
    });
    client.roomCode = code;
    reply(client, requestId, { ok: true, room: publicRoom(room), socketId: client.id });
    emitRoom(room);
    return;
  }

  if (type === "room:leave") {
    leaveCurrentRoom(client);
    return;
  }

  const room = rooms.get(client.roomCode);
  if (!room) return;

  if (type === "room:mode") {
    if (room.hostId !== client.id || typeof payload.mode !== "string") return;
    room.mode = payload.mode;
    emitRoom(room);
    return;
  }

  if (type === "game:shot") {
    const host = clients.get(room.hostId);
    if (host && payload.shot) {
      send(host, "game:remote-shot", { playerId: client.id, shot: payload.shot });
    }
    return;
  }

  if (type === "game:snapshot") {
    if (room.hostId !== client.id || !payload.snapshot) return;
    broadcast(room, "game:snapshot", payload.snapshot, client.id);
  }
}

function decodeFrames(client) {
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (client.buffer.length < 10) return;
      length = Number(client.buffer.readBigUInt64BE(2));
      offset = 10;
    }

    const maskOffset = offset;
    if (masked) offset += 4;
    if (client.buffer.length < offset + length) return;

    const raw = client.buffer.subarray(offset, offset + length);
    let payload = raw;
    if (masked) {
      const mask = client.buffer.subarray(maskOffset, maskOffset + 4);
      payload = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) {
        payload[i] = raw[i] ^ mask[i % 4];
      }
    }
    client.buffer = client.buffer.subarray(offset + length);

    if (opcode === 0x8) {
      client.socket.end();
      return;
    }
    if (opcode === 0x9) {
      client.socket.write(Buffer.from([0x8a, 0x00]));
      continue;
    }
    if (opcode !== 0x1) continue;

    try {
      handleMessage(client, JSON.parse(payload.toString("utf8")));
    } catch {
      send(client, "room:error", { error: "消息格式错误" });
    }
  }
}

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30000);

  const client = {
    id: makeId(),
    socket,
    buffer: Buffer.alloc(0),
    roomCode: null,
  };
  clients.set(client.id, client);
  send(client, "hello", { socketId: client.id });

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    decodeFrames(client);
  });

  const cleanup = () => {
    leaveCurrentRoom(client);
    clients.delete(client.id);
  };
  socket.on("close", cleanup);
  socket.on("end", cleanup);
  socket.on("error", cleanup);
});

server.listen(port, () => {
  console.log(`Snooker web game listening on http://localhost:${port}`);
});
