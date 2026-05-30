import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COLLECT_WINDOW_MAX_MS,
  COLLECT_WINDOW_MIN_MS,
  DEFAULT_COLLECT_WINDOW_MS,
  MAX_NAME_LEN,
  MAX_PLAYERS_PER_ROOM,
  MAX_ROOMS,
} from '@buzzer/shared';
import { RoomManager, type Room } from './rooms.ts';

/** A manager whose broadcasts are ignored; tests inspect Room state directly. */
function mgr() {
  return new RoomManager(() => {});
}

let sockSeq = 0;
function joinOk(m: RoomManager, roomId: string, name: string): string {
  const r = m.join(roomId, name, undefined, `sock-${sockSeq++}`);
  if ('error' in r) throw new Error(r.error);
  return r.player.id;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('room lifecycle & join', () => {
  it('creates a room in IDLE with a 5-char code', () => {
    const room = mgr().createRoom();
    expect(room.phase).toBe('IDLE');
    expect(room.id).toMatch(/^[A-Z0-9]{5}$/);
  });

  it('reconnects an existing player by session token', () => {
    const m = mgr();
    const room = m.createRoom();
    const first = m.join(room.id, 'Alice', undefined, 'sock-old');
    if ('error' in first) throw new Error(first.error);
    const token = first.player.sessionToken;
    m.dropConnection(room.id, first.player.id, 'sock-old');

    const again = m.join(room.id, 'Alice2', token, 'sock-new');
    if ('error' in again) throw new Error(again.error);
    expect(again.player.id).toBe(first.player.id); // same player
    expect(again.player.connections.has('sock-new')).toBe(true);
    expect(room.players.size).toBe(1);
  });

  it('rejects joining a missing room', () => {
    expect(mgr().join('NOPE0', 'X', undefined, 'sock-z')).toEqual({ error: 'room_not_found' });
  });
});

describe('buzz flow — earliest press wins regardless of arrival', () => {
  it('collects near-simultaneous buzzes and picks the earliest tPressServer', () => {
    vi.useFakeTimers();
    const m = mgr();
    const room = m.createRoom();
    const bob = joinOk(m, room.id, 'Bob');
    const alice = joinOk(m, room.id, 'Alice');

    m.arm(room.id);
    expect(room.phase).toBe('ARMED');

    // Bob's packet arrives first, but Alice pressed 30ms earlier (realistic
    // press times near 'now' so they survive the server-side plausibility clamp).
    const now = Date.now();
    m.buzz(room.id, bob, now);
    m.buzz(room.id, alice, now - 30);
    expect(room.phase).toBe('COLLECTING');

    vi.advanceTimersByTime(room.collectWindowMs + 1);
    expect(room.phase).toBe('ANSWERING');
    expect(room.winnerId).toBe(alice);
  });

  it('ignores buzzes when not armed', () => {
    const m = mgr();
    const room = m.createRoom();
    const bob = joinOk(m, room.id, 'Bob');
    m.buzz(room.id, bob, 1000); // IDLE
    expect(room.phase).toBe('IDLE');
    expect(room.buzzes).toHaveLength(0);
  });
});

describe('scoring, history edit/remove and manual adjust', () => {
  function answering(m: RoomManager): { room: Room; winner: string } {
    vi.useFakeTimers();
    const room = m.createRoom();
    const bob = joinOk(m, room.id, 'Bob');
    m.arm(room.id);
    m.buzz(room.id, bob, 1000);
    vi.advanceTimersByTime(room.collectWindowMs + 1);
    vi.useRealTimers();
    return { room, winner: bob };
  }

  it('scores the winner and auto-reopens to ARMED', () => {
    const m = mgr();
    const { room, winner } = answering(m);
    m.score(room.id, winner, 2);
    expect(room.players.get(winner)!.score).toBe(2);
    expect(room.phase).toBe('ARMED');
  });

  it('removeScore reverts the points and drops the entry (no phase change)', () => {
    const m = mgr();
    const { room, winner } = answering(m);
    m.score(room.id, winner, 2); // ARMED, history: winner +2
    const id = m.toPublicState(room).history[0].id;
    m.removeScore(room.id, id);
    expect(room.players.get(winner)!.score).toBe(0);
    expect(m.toPublicState(room).history).toHaveLength(0);
    expect(room.phase).toBe('ARMED');
  });

  it('editScore changes a past entry; the score follows the diff', () => {
    const m = mgr();
    const room = m.createRoom();
    const a = joinOk(m, room.id, 'Alice');
    m.adjust(room.id, a, 3);
    const id = m.toPublicState(room).history[0].id;
    m.editScore(room.id, id, -1); // 3 -> -1
    expect(room.players.get(a)!.score).toBe(-1);
    expect(m.toPublicState(room).history[0].delta).toBe(-1);
  });

  it('manual adjust works in any phase', () => {
    const m = mgr();
    const room = m.createRoom();
    const alice = joinOk(m, room.id, 'Alice');
    m.adjust(room.id, alice, 3); // during IDLE
    expect(room.players.get(alice)!.score).toBe(3);
    expect(room.phase).toBe('IDLE');
  });

  it('clamps deltas to the allowed range', () => {
    const m = mgr();
    const room = m.createRoom();
    const a = joinOk(m, room.id, 'A');
    m.adjust(room.id, a, 99);
    expect(room.players.get(a)!.score).toBe(3); // MAX_DELTA
  });
});

describe('roster & game control', () => {
  it('kick removes the player; kicking the answerer reopens buzzers', () => {
    vi.useFakeTimers();
    const m = mgr();
    const room = m.createRoom();
    const bob = joinOk(m, room.id, 'Bob');
    m.arm(room.id);
    m.buzz(room.id, bob, 1000);
    vi.advanceTimersByTime(room.collectWindowMs + 1);
    expect(room.winnerId).toBe(bob);
    m.kick(room.id, bob);
    expect(room.players.has(bob)).toBe(false);
    expect(room.winnerId).toBeUndefined();
    expect(room.phase).toBe('ARMED');
  });

  it('resetScores zeros everyone and returns to IDLE', () => {
    const m = mgr();
    const room = m.createRoom();
    const a = joinOk(m, room.id, 'A');
    m.adjust(room.id, a, 3);
    m.resetScores(room.id);
    expect(room.players.get(a)!.score).toBe(0);
    expect(room.scoreHistory).toHaveLength(0);
    expect(room.phase).toBe('IDLE');
  });

  it('endGame moves to FINISHED', () => {
    const m = mgr();
    const room = m.createRoom();
    m.endGame(room.id);
    expect(room.phase).toBe('FINISHED');
  });
});

describe('adaptive collect window', () => {
  it('defaults when no RTTs are known', () => {
    const m = mgr();
    const room = m.createRoom();
    joinOk(m, room.id, 'A');
    expect(m.collectWindowFor(room)).toBe(DEFAULT_COLLECT_WINDOW_MS);
  });

  it('sizes to the slowest one-way latency plus margin, clamped', () => {
    const m = mgr();
    const room = m.createRoom();
    const a = joinOk(m, room.id, 'A');
    const b = joinOk(m, room.id, 'B');
    m.setRtt(room.id, a, 400); // one-way 200 + margin 80 = 280
    m.setRtt(room.id, b, 100);
    expect(m.collectWindowFor(room)).toBe(280);

    m.setRtt(room.id, a, 4000); // huge -> clamped to MAX
    expect(m.collectWindowFor(room)).toBe(COLLECT_WINDOW_MAX_MS);

    m.setRtt(room.id, a, 10); // tiny -> clamped to MIN
    m.setRtt(room.id, b, 10);
    expect(m.collectWindowFor(room)).toBe(COLLECT_WINDOW_MIN_MS);
  });
});

describe('idle room cleanup', () => {
  it('reaps rooms with no admins or connected players past the grace', () => {
    const m = mgr();
    const room = m.createRoom();
    m.adminConnected(room.id);
    expect(m.sweep(-1)).toHaveLength(0); // admin present

    m.adminDisconnected(room.id);
    room.lastActiveAt = Date.now() - 10_000;
    expect(m.sweep(0)).toEqual([room.id]);
    expect(m.get(room.id)).toBeUndefined();
  });

  it('keeps a room while a player is connected', () => {
    const m = mgr();
    const room = m.createRoom();
    joinOk(m, room.id, 'A');
    room.lastActiveAt = Date.now() - 10_000;
    expect(m.sweep(0)).toHaveLength(0);
  });
});

describe('buzz validation & anti-cheat', () => {
  it('clamps non-finite / forged press times to a finite bounded range and never crashes', () => {
    vi.useFakeTimers();
    const m = mgr();
    const room = m.createRoom();
    const a = joinOk(m, room.id, 'A');
    const b = joinOk(m, room.id, 'B');
    m.arm(room.id);
    m.buzz(room.id, a, Number.NaN);
    m.buzz(room.id, b, -Infinity);
    const now = Date.now();
    for (const z of room.buzzes) {
      expect(Number.isFinite(z.tPressServer)).toBe(true);
      expect(z.tPressServer).toBeLessThanOrEqual(now);
      expect(z.tPressServer).toBeGreaterThan(now - 5000); // not -Infinity
    }
    vi.advanceTimersByTime(room.collectWindowMs + 1);
    expect(room.phase).toBe('ANSWERING'); // resolved without NaN corruption
    expect(room.winnerId === a || room.winnerId === b).toBe(true);
  });

  it('a genuinely earlier finite press still wins', () => {
    vi.useFakeTimers();
    const m = mgr();
    const room = m.createRoom();
    const early = joinOk(m, room.id, 'Early');
    const late = joinOk(m, room.id, 'Late');
    m.arm(room.id);
    const now = Date.now();
    m.buzz(room.id, late, now);
    m.buzz(room.id, early, now - 40); // within the plausible window
    vi.advanceTimersByTime(room.collectWindowMs + 1);
    expect(room.winnerId).toBe(early);
  });

  it('ignores a duplicate buzz from the same player in a round', () => {
    vi.useFakeTimers();
    const m = mgr();
    const room = m.createRoom();
    const a = joinOk(m, room.id, 'A');
    m.arm(room.id);
    m.buzz(room.id, a, Date.now());
    m.buzz(room.id, a, Date.now() - 1000);
    expect(room.buzzes).toHaveLength(1);
  });

  it('clamps a reported rtt to the trusted maximum', () => {
    const m = mgr();
    const room = m.createRoom();
    const a = joinOk(m, room.id, 'A');
    m.setRtt(room.id, a, 999_999);
    expect(m.collectWindowFor(room)).toBeLessThanOrEqual(COLLECT_WINDOW_MAX_MS);
  });
});

describe('kick edge cases', () => {
  it('kicking the sole buzzer during COLLECTING reopens to ARMED without crashing', () => {
    vi.useFakeTimers();
    const m = mgr();
    const room = m.createRoom();
    const bob = joinOk(m, room.id, 'Bob');
    m.arm(room.id);
    m.buzz(room.id, bob, Date.now());
    expect(room.phase).toBe('COLLECTING');
    m.kick(room.id, bob);
    expect(room.phase).toBe('ARMED');
    expect(room.buzzes).toHaveLength(0);
    expect(() => vi.advanceTimersByTime(room.collectWindowMs + 1)).not.toThrow();
    expect(room.phase).toBe('ARMED');
  });

  it('kick drops the kicked player\'s score history', () => {
    vi.useFakeTimers();
    const m = mgr();
    const room = m.createRoom();
    const bob = joinOk(m, room.id, 'Bob');
    m.arm(room.id);
    m.buzz(room.id, bob, Date.now());
    vi.advanceTimersByTime(room.collectWindowMs + 1);
    m.score(room.id, bob, 2);
    expect(m.toPublicState(room).history).toHaveLength(1);
    m.kick(room.id, bob);
    expect(room.scoreHistory).toHaveLength(0);
  });

  it('soft-bans a kicked player from re-joining with the same token', () => {
    const m = mgr();
    const room = m.createRoom();
    const r = m.join(room.id, 'Bob', undefined, 'sock-1');
    if ('error' in r) throw new Error(r.error);
    const token = r.player.sessionToken;
    m.kick(room.id, r.player.id);
    expect(m.join(room.id, 'Bob', token, 'sock-2')).toEqual({ error: 'kicked' });
    // a brand-new session (cleared storage / другое устройство) still gets in.
    expect('player' in m.join(room.id, 'Bob2', undefined, 'sock-3')).toBe(true);
  });
});

describe('resource caps', () => {
  it('rejects joins past the per-room player cap', () => {
    const m = mgr();
    const room = m.createRoom();
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) joinOk(m, room.id, `P${i}`);
    expect(m.join(room.id, 'extra', undefined, 'sock-x')).toEqual({ error: 'room_full' });
  });

  it('caps name length on join', () => {
    const m = mgr();
    const room = m.createRoom();
    const r = m.join(room.id, 'x'.repeat(100), undefined, 'sock-y');
    if ('error' in r) throw new Error(r.error);
    expect(r.player.name.length).toBe(MAX_NAME_LEN);
  });

  it('enforces the global room cap', () => {
    const m = mgr();
    for (let i = 0; i < MAX_ROOMS; i++) m.createRoom();
    expect(m.roomCount).toBe(MAX_ROOMS);
    expect(m.canCreateRoom()).toBe(false);
  });
});

describe('round eligibility & connections', () => {
  it('a player who joins after arm cannot buzz this round', () => {
    vi.useFakeTimers();
    const m = mgr();
    const room = m.createRoom();
    const a = joinOk(m, room.id, 'A');
    m.arm(room.id); // roster locked: {A}
    const late = joinOk(m, room.id, 'Late'); // joined during ARMED
    m.buzz(room.id, late, Date.now()); // not eligible -> ignored
    expect(room.buzzes).toHaveLength(0);
    expect(room.phase).toBe('ARMED');
    m.buzz(room.id, a, Date.now()); // eligible
    expect(room.phase).toBe('COLLECTING');
  });

  it('player stays online while any socket remains, offline when all drop', () => {
    const m = mgr();
    const room = m.createRoom();
    const r = m.join(room.id, 'A', undefined, 'sock-1');
    if ('error' in r) throw new Error(r.error);
    const token = r.player.sessionToken;
    m.join(room.id, 'A', token, 'sock-2'); // second tab, same player
    m.dropConnection(room.id, r.player.id, 'sock-1');
    expect(m.toPublicState(room).players[0].connected).toBe(true); // sock-2 alive
    m.dropConnection(room.id, r.player.id, 'sock-2');
    expect(m.toPublicState(room).players[0].connected).toBe(false);
  });
});

describe('scoring guards', () => {
  it('score only applies to the current winner', () => {
    vi.useFakeTimers();
    const m = mgr();
    const room = m.createRoom();
    const bob = joinOk(m, room.id, 'Bob');
    const al = joinOk(m, room.id, 'Al');
    m.arm(room.id);
    m.buzz(room.id, bob, Date.now());
    vi.advanceTimersByTime(room.collectWindowMs + 1); // winner = bob
    m.score(room.id, al, 2); // not the winner -> ignored
    expect(room.players.get(al)!.score).toBe(0);
    expect(room.phase).toBe('ANSWERING'); // unchanged
    m.score(room.id, bob, 2);
    expect(room.players.get(bob)!.score).toBe(2);
  });

  it('editing history during COLLECTING does not disturb the round', () => {
    vi.useFakeTimers();
    const m = mgr();
    const room = m.createRoom();
    const bob = joinOk(m, room.id, 'Bob');
    m.arm(room.id);
    m.buzz(room.id, bob, Date.now());
    vi.advanceTimersByTime(room.collectWindowMs + 1);
    m.score(room.id, bob, 1); // ARMED, history: bob +1
    const id = m.toPublicState(room).history[0].id;
    m.arm(room.id);
    m.buzz(room.id, bob, Date.now()); // COLLECTING again
    m.editScore(room.id, id, 3); // edit the old entry mid-collection
    expect(room.phase).toBe('COLLECTING'); // round untouched
    expect(room.players.get(bob)!.score).toBe(3);
  });
});

describe('pause (close buzzers)', () => {
  it('pauses from ARMED back to IDLE', () => {
    const m = mgr();
    const room = m.createRoom();
    joinOk(m, room.id, 'A');
    m.arm(room.id);
    expect(room.phase).toBe('ARMED');
    m.pause(room.id);
    expect(room.phase).toBe('IDLE');
  });

  it('pauses mid-collection: clears the live timer, buzzes and round roster', () => {
    vi.useFakeTimers();
    const m = mgr();
    const room = m.createRoom();
    const a = joinOk(m, room.id, 'A');
    m.arm(room.id);
    m.buzz(room.id, a, Date.now());
    expect(room.phase).toBe('COLLECTING');
    m.pause(room.id);
    expect(room.phase).toBe('IDLE');
    expect(room.buzzes).toHaveLength(0);
    // the pending timer must not fire us back into ANSWERING
    expect(() => vi.advanceTimersByTime(room.collectWindowMs + 1)).not.toThrow();
    expect(room.phase).toBe('IDLE');
  });

  it('is a no-op outside ARMED/COLLECTING', () => {
    const m = mgr();
    const room = m.createRoom();
    m.pause(room.id); // IDLE
    expect(room.phase).toBe('IDLE');
  });
});
