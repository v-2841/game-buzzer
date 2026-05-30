import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import confetti from 'canvas-confetti';
import type { RoomState } from '@buzzer/shared';
import { ClockSync, createSocket, type AppSocket } from '../lib/socket.ts';

export default function Player() {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  const socketRef = useRef<AppSocket | null>(null);
  const clockRef = useRef<ClockSync | null>(null);

  const [name, setName] = useState('');
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState<RoomState | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [buzzed, setBuzzed] = useState(false);
  // Transient toast when the admin changes our score. `n` re-triggers the timer.
  const [award, setAward] = useState<{ delta: number; n: number } | null>(null);

  // Report our measured ping so the server can size the buzz window. Only takes
  // effect once we've joined (server keys RTT by playerId), so call it after join.
  const reportRtt = () => {
    const clock = clockRef.current;
    if (clock) socketRef.current?.emit('client:rtt', { rtt: clock.rtt });
  };

  // Connect once; wire up state + clock sync.
  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;
    const clock = new ClockSync(socket);
    clockRef.current = clock;
    socket.on('room:state', setState);

    // Admin changed our score → toast + a short vibration (respecting motion prefs).
    let awardSeq = 0;
    socket.on('score:awarded', ({ delta }) => {
      setAward({ delta, n: ++awardSeq });
      if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        navigator.vibrate?.(40);
      }
    });

    let stopDrift = () => {};
    socket.on('connect', () => {
      void clock.calibrate().then(() => {
        reportRtt(); // no-op until joined, but covers the reconnect case
        stopDrift = clock.startDriftCorrection(15000, reportRtt);
      });
      // Auto-reconnect with stored session token, if any.
      const token = localStorage.getItem(`session:${roomId}`);
      if (token) {
        socket.emit('player:join', { roomId, name: '', sessionToken: token }, (res) => {
          if (res.ok) {
            localStorage.setItem(`session:${roomId}`, res.sessionToken);
            setMyId(res.playerId);
            setJoined(true);
            reportRtt(); // now that we have a playerId, the server stores it
          } else if (res.error === 'kicked') {
            setError('kicked'); // banned from this room — show it on the form
          }
        });
      }
    });

    return () => {
      stopDrift();
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Clear the optimistic "buzzed" lock whenever the round isn't live
  // (IDLE / ARMED / FINISHED) — only COLLECTING/ANSWERING keep it.
  useEffect(() => {
    if (state?.phase !== 'COLLECTING' && state?.phase !== 'ANSWERING') {
      setBuzzed(false);
    }
  }, [state?.phase]);

  // Auto-hide the score toast ~3s after it (re)appears.
  useEffect(() => {
    if (!award) return;
    const t = setTimeout(() => setAward(null), 3000);
    return () => clearTimeout(t);
  }, [award]);

  function join(e: React.FormEvent) {
    e.preventDefault();
    const token = localStorage.getItem(`session:${roomId}`) ?? undefined;
    socketRef.current
      ?.timeout(8000)
      .emit('player:join', { roomId, name, sessionToken: token }, (err, res) => {
        if (err || !res) {
          setError('Сервер не отвечает, попробуй ещё раз');
          return;
        }
        if (res.ok) {
          localStorage.setItem(`session:${roomId}`, res.sessionToken);
          setMyId(res.playerId);
          setJoined(true);
          setError('');
          reportRtt(); // now we have a playerId — feed the adaptive window
        } else {
          setError(res.error);
        }
      });
  }

  function buzz() {
    if (buzzed || state?.phase !== 'ARMED') return;
    const tPressServer = clockRef.current?.toServer(Date.now()) ?? Date.now();
    setBuzzed(true); // optimistic local lock
    socketRef.current?.emit('player:buzz', { tPressServer });
  }

  if (!joined) {
    return (
      <div className="container d-flex flex-column justify-content-center min-dvh-100" style={{ maxWidth: 420 }}>
        <h4 className="text-center mb-4">Игра {roomId}</h4>
        <form onSubmit={join}>
          <input
            className="form-control form-control-lg mb-3"
            placeholder="Твоё имя"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <button className="btn btn-primary btn-lg w-100" disabled={!name.trim()}>
            Войти
          </button>
        </form>
        {error && <p className="text-danger text-center mt-3">{errorText(error)}</p>}
      </div>
    );
  }

  const phase = state?.phase ?? 'IDLE';
  const me = state?.players.find((p) => p.id === myId);
  const iAmWinner = state?.winnerId === myId;
  const sorted = [...(state?.players ?? [])].sort((a, b) => b.score - a.score);

  // The admin removed us from the game (token kept so the soft-ban sticks).
  if (state && myId && !me) {
    return (
      <div className="container d-flex flex-column justify-content-center min-dvh-100 text-center">
        <p className="fs-5">Тебя удалили из игры.</p>
      </div>
    );
  }

  // Game over — everyone sees the final standings, but only first-place
  // players get the confetti (ties included).
  if (phase === 'FINISHED') {
    const topScore = sorted[0]?.score;
    const iWonFirst = !!me && sorted.length > 0 && me.score === topScore;
    return (
      <div className="container py-4" style={{ maxWidth: 480 }}>
        {iWonFirst && <WinnerConfetti />}
        <h3 className="text-center mb-4">🏁 Игра окончена</h3>
        <Results players={sorted} highlightId={myId ?? undefined} />
        <button
          className="btn btn-outline-secondary w-100 mt-4"
          onClick={() => {
            if (confirm('Выйти из игры?')) navigate('/');
          }}
        >
          Выйти
        </button>
      </div>
    );
  }

  return (
    <div className="container py-3 d-flex flex-column" style={{ maxWidth: 480 }}>
      <AwardToast award={award} />
      <div className="d-flex justify-content-between align-items-center mb-3">
        <button
          className="btn btn-link p-0 fw-bold text-decoration-none"
          onClick={() => {
            const next = prompt('Твоё имя:', me?.name ?? '');
            if (next && next.trim()) {
              socketRef.current?.emit('player:rename', { name: next.trim() });
            }
          }}
        >
          {me?.name}
        </button>
        <span className="badge bg-primary fs-6">{me?.score ?? 0}</span>
      </div>

      <div className="d-flex flex-column align-items-center my-3">
        <BuzzerButton
          phase={phase}
          buzzed={buzzed}
          iAmWinner={iAmWinner}
          winnerName={state?.winnerName}
          onBuzz={buzz}
        />
      </div>

      <h6 className="text-muted mt-3">Участники</h6>
      <ul className="list-group">
        {sorted.map((p) => (
          <li
            key={p.id}
            className={`list-group-item d-flex justify-content-between ${p.id === state?.winnerId ? 'list-group-item-success' : ''} ${p.id === myId ? 'fw-bold' : ''}`}
          >
            <span>{p.name}</span>
            <span className="badge bg-primary">{p.score}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BuzzerButton({
  phase,
  buzzed,
  iAmWinner,
  winnerName,
  onBuzz,
}: {
  phase: string;
  buzzed: boolean;
  iAmWinner: boolean;
  winnerName?: string;
  onBuzz: () => void;
}) {
  if (phase === 'ANSWERING' || phase === 'COLLECTING') {
    return (
      <button className={`buzzer btn ${iAmWinner ? 'btn-success' : 'btn-secondary'}`} disabled>
        {iAmWinner ? 'Ты отвечаешь!' : `Отвечает ${winnerName ?? '…'}`}
      </button>
    );
  }
  if (phase !== 'ARMED' || buzzed) {
    return (
      <button className="buzzer btn btn-secondary" disabled>
        {buzzed ? 'Нажал!' : 'Ждём…'}
      </button>
    );
  }
  return (
    // Fire on press-down, not click (release): faster, and captures the real
    // press moment. The buzzed-lock + server dedup make the trailing click a no-op.
    <button className="buzzer btn btn-danger" onPointerDown={onBuzz}>
      ЖМИ!
    </button>
  );
}

/**
 * Continuous full-screen confetti, shown only on the screen of a player who
 * finished first (render it conditionally). Cycles 1s firing / 3s pause while
 * mounted. Skipped if the user prefers reduced motion.
 */
export function WinnerConfetti() {
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    let raf = 0;
    const start = Date.now();
    const frame = () => {
      // 4s cycle: fire during the first second, pause for the next three.
      if ((Date.now() - start) % 4000 < 1000) {
        confetti({ particleCount: 5, angle: 60, spread: 60, startVelocity: 50, origin: { x: 0 } });
        confetti({ particleCount: 5, angle: 120, spread: 60, startVelocity: 50, origin: { x: 1 } });
      }
      raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/** Map server error codes to friendly Russian text. */
function errorText(code: string): string {
  const map: Record<string, string> = {
    room_not_found: 'Игра не найдена — проверь код',
    room_full: 'Комната заполнена',
    name_required: 'Введите имя',
    rate_limited: 'Слишком часто — подожди немного',
    bad_request: 'Не получилось войти, попробуй ещё раз',
    kicked: 'Тебя удалили из этой игры',
  };
  return map[code] ?? code;
}

/** Russian plural of "очко" for a (small) score delta magnitude. */
function pointsWord(n: number): string {
  const a = Math.abs(n);
  if (a === 1) return 'очко';
  if (a >= 2 && a <= 4) return 'очка';
  return 'очков';
}

/** Bottom toast shown for ~1.5s when the admin changes the player's score. */
function AwardToast({ award }: { award: { delta: number; n: number } | null }) {
  if (!award) return null;
  const { delta } = award;
  return (
    <div
      key={award.n}
      className="toast-container position-fixed bottom-0 start-50 translate-middle-x p-3"
      style={{ zIndex: 1090 }}
    >
      <div
        className={`toast show border-0 text-white ${delta > 0 ? 'bg-success' : 'bg-danger'}`}
      >
        <div className="toast-body text-center fs-5 fw-bold">
          {delta > 0 ? `+${delta}` : delta} {pointsWord(delta)}
        </div>
      </div>
    </div>
  );
}

const MEDALS = ['🥇', '🥈', '🥉'];

/** Final standings with competition ranking (ties share a place). */
export function Results({
  players,
  highlightId,
}: {
  players: RoomState['players'];
  highlightId?: string;
}) {
  let place = 0;
  let prevScore = Infinity;
  return (
    <ul className="list-group">
      {players.map((p, i) => {
        if (p.score < prevScore) {
          place = i + 1;
          prevScore = p.score;
        }
        // Everyone sharing first place is a winner (handles ties).
        const isWinner = place === 1;
        const cls = isWinner
          ? 'list-group-item-warning'
          : p.id === highlightId
            ? 'list-group-item-primary'
            : '';
        return (
          <li
            key={p.id}
            className={`list-group-item d-flex justify-content-between align-items-center ${cls} ${p.id === highlightId ? 'fw-bold' : ''}`}
          >
            <span>
              <span className="me-2">{MEDALS[place - 1] ?? `${place}.`}</span>
              {p.name}
            </span>
            <span className="badge bg-primary">{p.score}</span>
          </li>
        );
      })}
    </ul>
  );
}
