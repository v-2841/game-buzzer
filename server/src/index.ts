import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '@buzzer/shared';
import { RoomManager, type Room } from './rooms.js';
import {
  createRateLimiter,
  isFiniteNum,
  isFn,
  isObj,
  isStr,
} from './validation.js';

const PORT = Number(process.env.PORT) || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Room codes are uppercase; accept any casing from links/clients. */
const normalizeRoomId = (id: string) => id.trim().toUpperCase();

const app = express();
const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: true },
});

// Broadcast authoritative state to everyone in the room on any change.
const rooms = new RoomManager((room: Room) => {
  io.to(room.id).emit('room:state', rooms.toPublicState(room));
});

/** Per-connection identity. */
interface SocketCtx {
  roomId?: string;
  playerId?: string;
  isAdmin?: boolean;
}

io.on('connection', (socket) => {
  const ctx: SocketCtx = {};
  const allow = createRateLimiter();

  const sendState = (roomId: string) => {
    const room = rooms.get(roomId);
    if (room) socket.emit('room:state', rooms.toPublicState(room));
  };

  // Count this socket as an admin exactly once, however many times resume fires.
  const markAdmin = () => {
    if (ctx.isAdmin || !ctx.roomId) return;
    ctx.isAdmin = true;
    rooms.adminConnected(ctx.roomId);
  };

  socket.on('admin:createRoom', (cb) => {
    if (!isFn(cb)) return;
    if (!allow('create', 5, 0.5)) {
      cb({ error: 'rate_limited' });
      return;
    }
    if (!rooms.canCreateRoom()) {
      cb({ error: 'too_many_rooms' });
      return;
    }
    const room = rooms.createRoom();
    ctx.roomId = room.id;
    markAdmin();
    socket.join(room.id);
    cb({ roomId: room.id, adminToken: room.adminToken });
    sendState(room.id);
  });

  socket.on('admin:resume', (data, cb) => {
    if (!isFn(cb)) return;
    if (!isObj(data) || !isStr(data.roomId) || !isStr(data.adminToken)) {
      cb({ ok: false });
      return;
    }
    const roomId = normalizeRoomId(data.roomId);
    const room = rooms.get(roomId);
    if (!room || room.adminToken !== data.adminToken) {
      cb({ ok: false });
      return;
    }
    ctx.roomId = room.id;
    markAdmin();
    socket.join(room.id);
    cb({ ok: true });
    sendState(room.id);
  });

  socket.on('player:join', (data, cb) => {
    if (!isFn(cb)) return;
    if (!allow('join', 10, 1)) {
      cb({ ok: false, error: 'rate_limited' });
      return;
    }
    if (!isObj(data) || !isStr(data.roomId) || !isStr(data.name)) {
      cb({ ok: false, error: 'bad_request' });
      return;
    }
    const roomId = normalizeRoomId(data.roomId);
    const sessionToken = isStr(data.sessionToken) ? data.sessionToken : undefined;
    const result = rooms.join(roomId, data.name, sessionToken, socket.id);
    if ('error' in result) {
      cb({ ok: false, error: result.error });
      return;
    }
    ctx.roomId = roomId;
    ctx.playerId = result.player.id;
    socket.join(roomId);
    cb({
      ok: true,
      playerId: result.player.id,
      sessionToken: result.player.sessionToken,
    });
    sendState(roomId);
  });

  socket.on('clock:ping', (data, cb) => {
    if (!isFn(cb) || !allow('ping', 30, 10)) return;
    const t0 = isObj(data) && isFiniteNum(data.t0) ? data.t0 : 0;
    cb({ t0, tServer: Date.now() });
  });

  socket.on('admin:arm', () => {
    if (ctx.isAdmin && ctx.roomId) rooms.arm(ctx.roomId);
  });

  socket.on('admin:pause', () => {
    if (ctx.isAdmin && ctx.roomId) rooms.pause(ctx.roomId);
  });

  socket.on('player:buzz', (data) => {
    if (!ctx.roomId || !ctx.playerId) return;
    if (!allow('buzz', 10, 5)) return;
    // tPressServer is validated/clamped inside rooms.buzz (handles non-finite).
    const tPressServer = isObj(data) && isFiniteNum(data.tPressServer) ? data.tPressServer : NaN;
    rooms.buzz(ctx.roomId, ctx.playerId, tPressServer);
  });

  socket.on('admin:score', (data) => {
    if (!ctx.isAdmin || !ctx.roomId) return;
    if (isObj(data) && isStr(data.playerId) && isFiniteNum(data.delta)) {
      rooms.score(ctx.roomId, data.playerId, data.delta);
    }
  });

  socket.on('admin:adjust', (data) => {
    if (!ctx.isAdmin || !ctx.roomId) return;
    if (isObj(data) && isStr(data.playerId) && isFiniteNum(data.delta)) {
      rooms.adjust(ctx.roomId, data.playerId, data.delta);
    }
  });

  socket.on('admin:editScore', (data) => {
    if (ctx.isAdmin && ctx.roomId && isObj(data) && isStr(data.eventId) && isFiniteNum(data.delta)) {
      rooms.editScore(ctx.roomId, data.eventId, data.delta);
    }
  });

  socket.on('admin:removeScore', (data) => {
    if (ctx.isAdmin && ctx.roomId && isObj(data) && isStr(data.eventId)) {
      rooms.removeScore(ctx.roomId, data.eventId);
    }
  });

  socket.on('player:rename', (data) => {
    if (ctx.roomId && ctx.playerId && isObj(data) && isStr(data.name)) {
      rooms.rename(ctx.roomId, ctx.playerId, data.name);
    }
  });

  socket.on('admin:kick', (data) => {
    if (ctx.isAdmin && ctx.roomId && isObj(data) && isStr(data.playerId)) {
      rooms.kick(ctx.roomId, data.playerId);
    }
  });

  socket.on('admin:rename', (data) => {
    if (ctx.isAdmin && ctx.roomId && isObj(data) && isStr(data.playerId) && isStr(data.name)) {
      rooms.rename(ctx.roomId, data.playerId, data.name);
    }
  });

  socket.on('admin:resetScores', () => {
    if (ctx.isAdmin && ctx.roomId) rooms.resetScores(ctx.roomId);
  });

  socket.on('admin:endGame', () => {
    if (ctx.isAdmin && ctx.roomId) rooms.endGame(ctx.roomId);
  });

  socket.on('client:rtt', (data) => {
    if (!ctx.roomId || !ctx.playerId || !allow('rtt', 10, 2)) return;
    if (isObj(data) && isFiniteNum(data.rtt)) {
      rooms.setRtt(ctx.roomId, ctx.playerId, data.rtt);
    }
  });

  socket.on('disconnect', () => {
    if (ctx.roomId && ctx.playerId) {
      rooms.dropConnection(ctx.roomId, ctx.playerId, socket.id);
    }
    if (ctx.isAdmin && ctx.roomId) {
      rooms.adminDisconnected(ctx.roomId);
    }
  });
});

// Periodically reap rooms abandoned by everyone (no admin, no connected players).
rooms.startCleanup();

// In production we serve the built client as static files from this same process.
const clientDist =
  process.env.CLIENT_DIST ?? path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

httpServer.listen(PORT, () => {
  console.log(`buzzer server listening on :${PORT}`);
});
