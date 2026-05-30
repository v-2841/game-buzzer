// Shared contract between server and client.
// Both sides import these types so the WebSocket protocol can never drift.

/** Game phases — the core state machine. */
export type Phase =
  | 'IDLE' // buzzers disabled, waiting for admin to arm
  | 'ARMED' // buzzers active, anyone can press
  | 'COLLECTING' // first buzz received, collecting near-simultaneous presses
  | 'ANSWERING' // winner chosen, only winner active, admin scoring
  | 'FINISHED'; // game over, final results shown to everyone

/** Min/max score delta the admin can apply per answer. */
export const MIN_DELTA = -3;
export const MAX_DELTA = 3;

/** Collect-window bounds (ms). The window adapts to players' real pings but is
 *  always clamped between these. MARGIN is added on top of the slowest one-way
 *  latency so genuinely simultaneous presses are all gathered. */
export const DEFAULT_COLLECT_WINDOW_MS = 200;
export const COLLECT_WINDOW_MIN_MS = 120;
export const COLLECT_WINDOW_MAX_MS = 700;
export const COLLECT_WINDOW_MARGIN_MS = 80;

/** Max name length (applied identically at join and rename). */
export const MAX_NAME_LEN = 40;
/** Largest client-reported round-trip time the server will trust (ms). */
export const MAX_RTT_MS = 2000;
/** Resource caps to bound memory/abuse. */
export const MAX_ROOMS = 1000;
export const MAX_PLAYERS_PER_ROOM = 50;

/** A player as seen by everyone (public info). */
export interface PublicPlayer {
  id: string;
  name: string;
  score: number;
  connected: boolean;
}

/** One scoring action, shown in the admin's editable history. */
export interface ScoreEntry {
  id: string;
  playerId: string;
  name: string;
  delta: number;
  /** When the entry was created (epoch ms, server clock). */
  at: number;
}

/** Full authoritative room state broadcast to clients. */
export interface RoomState {
  roomId: string;
  phase: Phase;
  players: PublicPlayer[];
  /** Set during COLLECTING/ANSWERING — who is answering. */
  winnerId?: string;
  winnerName?: string;
  /** Scoring history, newest first — the admin can edit/remove each entry. */
  history: ScoreEntry[];
}

// ---------------------------------------------------------------------------
// Client -> Server events
// ---------------------------------------------------------------------------
export interface ClientToServerEvents {
  'admin:createRoom': (
    cb: (
      res: { roomId: string; adminToken: string } | { error: string },
    ) => void,
  ) => void;

  'admin:resume': (
    data: { roomId: string; adminToken: string },
    cb: (res: { ok: boolean }) => void,
  ) => void;

  'player:join': (
    data: { roomId: string; name: string; sessionToken?: string },
    cb: (
      res:
        | { ok: true; playerId: string; sessionToken: string }
        | { ok: false; error: string },
    ) => void,
  ) => void;

  /** Clock sync: client sends its t0, server replies with t0 + server time. */
  'clock:ping': (
    data: { t0: number },
    cb: (res: { t0: number; tServer: number }) => void,
  ) => void;

  'admin:arm': () => void;
  /** Pause: close the buzzers and return the room to IDLE. */
  'admin:pause': () => void;
  'player:buzz': (data: { tPressServer: number }) => void;
  'admin:score': (data: { playerId: string; delta: number }) => void;
  /** Out-of-turn adjustment for any player, independent of the buzz flow. */
  'admin:adjust': (data: { playerId: string; delta: number }) => void;
  /** Edit a past scoring entry's delta, or remove it (history list). */
  'admin:editScore': (data: { eventId: string; delta: number }) => void;
  'admin:removeScore': (data: { eventId: string }) => void;
  /** A player renames themselves. */
  'player:rename': (data: { name: string }) => void;
  /** Roster / game control. */
  'admin:kick': (data: { playerId: string }) => void;
  'admin:rename': (data: { playerId: string; name: string }) => void;
  'admin:resetScores': () => void;
  'admin:endGame': () => void;
  /** Client reports its measured round-trip time so the server can size the
   *  buzz collection window to real network conditions. */
  'client:rtt': (data: { rtt: number }) => void;
}

// ---------------------------------------------------------------------------
// Server -> Client events
// ---------------------------------------------------------------------------
export interface ServerToClientEvents {
  'room:state': (state: RoomState) => void;
  /** Sent only to a player whose score the admin just changed (toast). */
  'score:awarded': (data: { delta: number }) => void;
}
