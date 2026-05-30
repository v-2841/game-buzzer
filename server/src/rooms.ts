import { randomUUID } from 'node:crypto';
import {
  COLLECT_WINDOW_MARGIN_MS,
  COLLECT_WINDOW_MAX_MS,
  COLLECT_WINDOW_MIN_MS,
  DEFAULT_COLLECT_WINDOW_MS,
  MAX_DELTA,
  MAX_NAME_LEN,
  MAX_PLAYERS_PER_ROOM,
  MAX_ROOMS,
  MAX_RTT_MS,
  MIN_DELTA,
  type Phase,
  type PublicPlayer,
  type RoomState,
} from '@buzzer/shared';

/** Trim, cap length, and reject empty — one rule for join and rename. */
export function sanitizeName(name: unknown): string {
  return typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LEN) : '';
}

/** Jitter / clock-sync tolerance (ms) when bounding a reported press time. */
const BUZZ_SLACK_MS = 150;
/**
 * Largest one-way latency the press-time clamp will allow, as a FIXED server
 * constant — deliberately NOT the client-reported RTT, so a player can't widen
 * their own plausible-press window by lying about their ping.
 */
const MAX_CLAMP_ONE_WAY_MS = 400;

interface Player {
  id: string;
  name: string;
  score: number;
  sessionToken: string;
  /** Set of live socket ids. Online iff non-empty (handles multi-tab/reconnect). */
  connections: Set<string>;
  /** Last measured round-trip time (ms), reported by the client. */
  rtt?: number;
}

/** A player is online while at least one of their sockets is connected. */
const isOnline = (p: Player): boolean => p.connections.size > 0;

interface Buzz {
  playerId: string;
  tPressServer: number;
}

interface ScoreEvent {
  id: string;
  playerId: string;
  delta: number;
  at: number;
}

export interface Room {
  id: string;
  adminToken: string;
  phase: Phase;
  players: Map<string, Player>;
  buzzes: Buzz[];
  winnerId?: string;
  scoreHistory: ScoreEvent[];
  collectWindowMs: number;
  collectTimer?: NodeJS.Timeout;
  /** Players eligible to buzz in the current round (snapshot taken at arm()). */
  roundPlayers?: Set<string>;
  /** Session tokens of kicked players — soft-blocked from re-joining. */
  bannedTokens: Set<string>;
  /** Number of currently-connected admin sockets for this room. */
  adminConnections: number;
  /** Timestamp (ms) of the last state change; used to expire idle rooms. */
  lastActiveAt: number;
}

/** How long a room with no live admins or players is kept before removal. */
export const DEFAULT_ROOM_GRACE_MS = 5 * 60 * 1000;

/** Generates a short, human-friendly, unambiguous room code. */
function makeRoomCode(taken: (code: string) => boolean): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  } while (taken(code));
  return code;
}

export class RoomManager {
  private rooms = new Map<string, Room>();

  /** Called whenever a room's state changes so the caller can broadcast it. */
  constructor(private onChange: (room: Room) => void) {}

  /** Bump activity timestamp and broadcast the new state. */
  private emit(room: Room): void {
    room.lastActiveAt = Date.now();
    this.onChange(room);
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** Current number of live rooms (used to enforce the global cap). */
  get roomCount(): number {
    return this.rooms.size;
  }

  /** Whether a new room may be created (global memory-abuse cap). */
  canCreateRoom(): boolean {
    return this.rooms.size < MAX_ROOMS;
  }

  createRoom(): Room {
    const id = makeRoomCode((c) => this.rooms.has(c));
    const room: Room = {
      id,
      adminToken: randomUUID(),
      phase: 'IDLE',
      players: new Map(),
      buzzes: [],
      scoreHistory: [],
      collectWindowMs: DEFAULT_COLLECT_WINDOW_MS,
      bannedTokens: new Set(),
      adminConnections: 0,
      lastActiveAt: Date.now(),
    };
    this.rooms.set(id, room);
    return room;
  }

  /** Track admin socket presence so rooms aren't reaped while an admin watches. */
  adminConnected(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.adminConnections++;
    this.emit(room);
  }

  adminDisconnected(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.adminConnections = Math.max(0, room.adminConnections - 1);
    this.emit(room);
  }

  /** Remove rooms with no live admins/players idle past the grace period. */
  sweep(graceMs = DEFAULT_ROOM_GRACE_MS): string[] {
    const now = Date.now();
    const removed: string[] = [];
    for (const [id, room] of this.rooms) {
      const hasPlayers = [...room.players.values()].some(isOnline);
      if (
        room.adminConnections === 0 &&
        !hasPlayers &&
        now - room.lastActiveAt > graceMs
      ) {
        clearTimeout(room.collectTimer);
        this.rooms.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  /** Start the periodic idle-room sweep. Returns the interval handle. */
  startCleanup(intervalMs = 60_000, graceMs = DEFAULT_ROOM_GRACE_MS): NodeJS.Timeout {
    const timer = setInterval(() => this.sweep(graceMs), intervalMs);
    timer.unref?.();
    return timer;
  }

  /** Join or reconnect. Returns the player + a session token for reconnection. */
  join(
    roomId: string,
    name: string,
    sessionToken: string | undefined,
    socketId: string,
  ): { player: Player } | { error: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { error: 'room_not_found' };

    // Soft-ban: a kicked player's session token can't re-enter this room.
    if (sessionToken && room.bannedTokens.has(sessionToken)) {
      return { error: 'kicked' };
    }

    // Reconnect path: known token wins, name is refreshed.
    if (sessionToken) {
      const existing = [...room.players.values()].find(
        (p) => p.sessionToken === sessionToken,
      );
      if (existing) {
        existing.connections.add(socketId);
        const renamed = sanitizeName(name);
        if (renamed) existing.name = renamed;
        this.emit(room);
        return { player: existing };
      }
    }

    const trimmed = sanitizeName(name);
    if (!trimmed) return { error: 'name_required' };
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) return { error: 'room_full' };

    const player: Player = {
      id: randomUUID(),
      name: trimmed,
      score: 0,
      sessionToken: randomUUID(),
      connections: new Set([socketId]),
    };
    room.players.set(player.id, player);
    this.emit(room);
    return { player };
  }

  /** A socket for this player dropped. The player stays online while any other
   *  socket (another tab, or a freshly-reconnected one) remains. */
  dropConnection(roomId: string, playerId: string, socketId: string): void {
    const room = this.rooms.get(roomId);
    const player = room?.players.get(playerId);
    if (!room || !player) return;
    player.connections.delete(socketId);
    this.emit(room);
  }

  /** Record a player's measured round-trip time, clamped to a trusted range. */
  setRtt(roomId: string, playerId: string, rtt: number): void {
    const player = this.rooms.get(roomId)?.players.get(playerId);
    if (player && Number.isFinite(rtt)) {
      player.rtt = Math.min(MAX_RTT_MS, Math.max(0, rtt));
    }
  }

  /**
   * Size the collect window to real network conditions: it must outlast the
   * spread in packet arrival between simultaneous pressers, which is bounded by
   * the slowest player's one-way latency (≈ rtt / 2), plus a safety margin.
   */
  collectWindowFor(room: Room): number {
    const rtts = [...room.players.values()]
      .filter((p) => isOnline(p) && typeof p.rtt === 'number')
      .map((p) => p.rtt as number);
    if (rtts.length === 0) return DEFAULT_COLLECT_WINDOW_MS;
    const slowestOneWay = Math.max(...rtts) / 2;
    return Math.min(
      COLLECT_WINDOW_MAX_MS,
      Math.max(COLLECT_WINDOW_MIN_MS, Math.round(slowestOneWay + COLLECT_WINDOW_MARGIN_MS)),
    );
  }

  /** Admin opens the buzzers. Valid from any phase except mid-collection. */
  arm(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.phase === 'COLLECTING') return; // don't interrupt collection
    clearTimeout(room.collectTimer);
    // Size this round's window to the players currently in the room.
    room.collectWindowMs = this.collectWindowFor(room);
    // Lock the eligible roster: only players present when buzzers opened may
    // buzz this round (a late joiner can't slip into a collection in progress).
    room.roundPlayers = new Set(
      [...room.players.values()].filter(isOnline).map((p) => p.id),
    );
    room.phase = 'ARMED';
    room.buzzes = [];
    room.winnerId = undefined;
    this.emit(room);
  }

  /** Pause: close the buzzers (from ARMED or mid-collection) back to IDLE. */
  pause(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.phase !== 'ARMED' && room.phase !== 'COLLECTING') return;
    clearTimeout(room.collectTimer);
    room.phase = 'IDLE';
    room.buzzes = [];
    room.winnerId = undefined;
    room.roundPlayers = undefined;
    this.emit(room);
  }

  /**
   * A player presses their buzzer. The client-reported press time is advisory:
   * the server anchors it to packet arrival so nobody can claim a press that is
   * physically impossible (earlier than the packet could have travelled, or in
   * the future). This keeps "earliest press wins" fair and uncheatable, and is
   * immune to NaN/Infinity/forged values.
   */
  buzz(roomId: string, playerId: string, tPressServer: number): void {
    const room = this.rooms.get(roomId);
    const player = room?.players.get(playerId);
    if (!room || !player) return;
    if (room.phase !== 'ARMED' && room.phase !== 'COLLECTING') return;
    // Only players who were present when buzzers opened may buzz this round.
    if (room.roundPlayers && !room.roundPlayers.has(playerId)) return;
    // Ignore duplicate buzzes from the same player in this round.
    if (room.buzzes.some((b) => b.playerId === playerId)) return;

    const tRecv = Date.now();
    // A press is at most ~one network trip old plus jitter slack, and can never
    // be in the future. Clamp the client value into [earliest, tRecv] so a
    // forged/garbage timestamp (0, -Infinity, NaN) can't win by an impossible
    // margin. The bound is a FIXED server constant, NOT the client-reported RTT,
    // so a player can't widen this window by lying about their ping.
    const earliest = tRecv - MAX_CLAMP_ONE_WAY_MS - BUZZ_SLACK_MS;
    const claimed = Number.isFinite(tPressServer) ? tPressServer : tRecv;
    const tPress = Math.min(tRecv, Math.max(earliest, claimed));

    room.buzzes.push({ playerId, tPressServer: tPress });

    if (room.phase === 'ARMED') {
      // First buzz opens the collection window.
      room.phase = 'COLLECTING';
      room.collectTimer = setTimeout(
        () => this.closeCollection(roomId),
        room.collectWindowMs,
      );
      this.emit(room);
    }
  }

  /** Window closed: pick the earliest real press time as the winner. */
  private closeCollection(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.phase !== 'COLLECTING') return;
    // No buzzes left (e.g. the sole presser was kicked) — reopen, don't crash.
    if (room.buzzes.length === 0) {
      room.phase = 'ARMED';
      this.emit(room);
      return;
    }
    const winner = room.buzzes.reduce((a, b) =>
      b.tPressServer < a.tPressServer ? b : a,
    );
    room.winnerId = winner.playerId;
    room.phase = 'ANSWERING';
    this.emit(room);
  }

  /** Admin scores the current answerer, then buzzers auto-reopen (ARMED). */
  score(roomId: string, playerId: string, delta: number): void {
    const room = this.rooms.get(roomId);
    if (!room || room.phase !== 'ANSWERING') return;
    // An answer score belongs to the current answerer only.
    if (playerId !== room.winnerId) return;
    const player = room.players.get(playerId);
    if (!player) return;
    const clamped = Math.max(MIN_DELTA, Math.min(MAX_DELTA, Math.round(delta)));
    player.score += clamped;
    room.scoreHistory.push({ id: randomUUID(), playerId, delta: clamped, at: Date.now() });
    // Auto-reopen for the next answer on the same question.
    clearTimeout(room.collectTimer);
    room.phase = 'ARMED';
    room.buzzes = [];
    room.winnerId = undefined;
    this.emit(room);
  }

  /** Out-of-turn adjustment: admin adds/removes points for any player, any phase. */
  adjust(roomId: string, playerId: string, delta: number): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(playerId);
    if (!player) return;
    const clamped = Math.max(MIN_DELTA, Math.min(MAX_DELTA, Math.round(delta)));
    if (clamped === 0) return;
    player.score += clamped;
    room.scoreHistory.push({ id: randomUUID(), playerId, delta: clamped, at: Date.now() });
    this.emit(room);
  }

  /** Change a past scoring entry's delta; the player's score follows the diff. */
  editScore(roomId: string, eventId: string, delta: number): void {
    const room = this.rooms.get(roomId);
    const event = room?.scoreHistory.find((e) => e.id === eventId);
    if (!room || !event) return;
    const clamped = Math.max(MIN_DELTA, Math.min(MAX_DELTA, Math.round(delta)));
    const player = room.players.get(event.playerId);
    if (player) player.score += clamped - event.delta;
    event.delta = clamped;
    this.emit(room);
  }

  /** Remove a past scoring entry and revert its points. */
  removeScore(roomId: string, eventId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const idx = room.scoreHistory.findIndex((e) => e.id === eventId);
    if (idx === -1) return;
    const [event] = room.scoreHistory.splice(idx, 1);
    const player = room.players.get(event.playerId);
    if (player) player.score -= event.delta;
    this.emit(room);
  }

  /** Rename a player (used by the player themselves and by the admin). */
  rename(roomId: string, playerId: string, name: string): void {
    const room = this.rooms.get(roomId);
    const player = room?.players.get(playerId);
    if (!room || !player) return;
    const trimmed = sanitizeName(name);
    if (!trimmed) return;
    player.name = trimmed;
    this.emit(room);
  }

  /** Remove a player from the room entirely and soft-ban them from re-joining. */
  kick(roomId: string, playerId: string): void {
    const room = this.rooms.get(roomId);
    const player = room?.players.get(playerId);
    if (!room || !player || !room.players.delete(playerId)) return;
    // Block this session token from re-entering the room.
    room.bannedTokens.add(player.sessionToken);
    room.buzzes = room.buzzes.filter((b) => b.playerId !== playerId);
    // Drop the kicked player's scoring history so a later undo can't touch them.
    room.scoreHistory = room.scoreHistory.filter((e) => e.playerId !== playerId);
    // If the kicked player was answering, or was the sole presser mid-collection,
    // reopen the buzzers rather than stranding the room (or crashing the timer).
    const wasWinner = room.winnerId === playerId;
    if (wasWinner || (room.phase === 'COLLECTING' && room.buzzes.length === 0)) {
      clearTimeout(room.collectTimer);
      room.winnerId = undefined;
      if (room.phase === 'ANSWERING' || room.phase === 'COLLECTING') {
        room.phase = 'ARMED';
      }
    }
    this.emit(room);
  }

  /** Zero all scores and start fresh (also clears undo history). */
  resetScores(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const p of room.players.values()) p.score = 0;
    room.scoreHistory = [];
    room.buzzes = [];
    room.winnerId = undefined;
    clearTimeout(room.collectTimer);
    room.phase = 'IDLE';
    this.emit(room);
  }

  /** End the game: lock buzzers and show final results to everyone. */
  endGame(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    clearTimeout(room.collectTimer);
    room.buzzes = [];
    room.winnerId = undefined;
    room.phase = 'FINISHED';
    this.emit(room);
  }

  toPublicState(room: Room): RoomState {
    const players: PublicPlayer[] = [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: isOnline(p),
    }));
    const winner = room.winnerId
      ? room.players.get(room.winnerId)
      : undefined;
    // Newest first; names resolved live so renames reflect in the history.
    const history = [...room.scoreHistory]
      .reverse()
      .map((e) => ({
        id: e.id,
        playerId: e.playerId,
        name: room.players.get(e.playerId)?.name ?? '—',
        delta: e.delta,
        at: e.at,
      }));
    return {
      roomId: room.id,
      phase: room.phase,
      players,
      winnerId: room.winnerId,
      winnerName: winner?.name,
      history,
    };
  }
}
