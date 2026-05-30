import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import type { RoomState } from '@buzzer/shared';
import { MAX_DELTA, MIN_DELTA } from '@buzzer/shared';
import { createSocket, type AppSocket } from '../lib/socket.ts';
import { Results } from './Player.tsx';

const DELTAS = Array.from(
  { length: MAX_DELTA - MIN_DELTA + 1 },
  (_, i) => MIN_DELTA + i,
);

/** Compact date + time of a scoring entry, e.g. "30 мая, 12:34:56". */
function formatTime(at: number): string {
  const d = new Date(at);
  const date = d.toLocaleDateString(undefined, { day: '2-digit', month: 'long' });
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return `${date}, ${time}`;
}

export default function Admin() {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  const socketRef = useRef<AppSocket | null>(null);
  const [state, setState] = useState<RoomState | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [resumed, setResumed] = useState<boolean | null>(null);
  // Player selected for an out-of-turn score adjustment.
  const [adjustId, setAdjustId] = useState<string | null>(null);
  // Which score-history row is expanded for editing.
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);

  useEffect(() => {
    const adminToken = localStorage.getItem(`adminToken:${roomId}`);
    if (!adminToken) {
      setResumed(false);
      return;
    }
    const socket = createSocket();
    socketRef.current = socket;
    socket.on('room:state', setState);
    // Re-resume on every (re)connect so a network blip doesn't lose the room.
    socket.on('connect', () => {
      socket.timeout(8000).emit('admin:resume', { roomId, adminToken }, (err, res) => {
        setResumed(!err && !!res?.ok);
      });
    });
    return () => {
      socket.disconnect();
    };
  }, [roomId]);

  if (resumed === false) {
    return (
      <div className="container py-5 text-center">
        <p>Эта игра недоступна с этого устройства (нет прав администратора).</p>
      </div>
    );
  }

  const inviteUrl = `${location.origin}/r/${roomId}`;
  const phase = state?.phase ?? 'IDLE';
  const sorted = [...(state?.players ?? [])].sort((a, b) => b.score - a.score);

  const arm = () => socketRef.current?.emit('admin:arm');
  const pause = () => socketRef.current?.emit('admin:pause');
  const score = (delta: number) => {
    if (state?.winnerId) {
      socketRef.current?.emit('admin:score', { playerId: state.winnerId, delta });
    }
  };
  const adjust = (playerId: string, delta: number) => {
    if (delta !== 0) socketRef.current?.emit('admin:adjust', { playerId, delta });
    setAdjustId(null);
  };
  const editScore = (eventId: string, delta: number) => {
    socketRef.current?.emit('admin:editScore', { eventId, delta });
    setOpenEntryId(null);
  };
  const removeScore = (eventId: string) => {
    if (!confirm('Удалить это начисление?')) return;
    socketRef.current?.emit('admin:removeScore', { eventId });
    setOpenEntryId(null);
  };
  const kick = (playerId: string) => {
    const name = state?.players.find((p) => p.id === playerId)?.name ?? '';
    if (!confirm(`Удалить игрока ${name}?`)) return;
    socketRef.current?.emit('admin:kick', { playerId });
    setAdjustId(null);
  };
  const rename = (playerId: string, currentName: string) => {
    const next = prompt('Имя игрока:', currentName);
    if (next && next.trim()) {
      socketRef.current?.emit('admin:rename', { playerId, name: next.trim() });
    }
    setAdjustId(null);
  };
  // Start a fresh game with the same room and players (scores reset to 0).
  const newGameSameRoom = () => socketRef.current?.emit('admin:resetScores');
  const endGame = () => {
    if (confirm('Завершить игру и показать итоги всем?')) {
      socketRef.current?.emit('admin:endGame');
    }
  };
  const createNewRoom = () => {
    const socket = createSocket();
    socket.timeout(8000).emit('admin:createRoom', (err, res) => {
      if (err || !res || 'error' in res) {
        socket.disconnect();
        alert('Не удалось создать комнату, попробуй ещё раз');
        return;
      }
      localStorage.setItem(`adminToken:${res.roomId}`, res.adminToken);
      socket.disconnect();
      navigate(`/admin/${res.roomId}`);
    });
  };

  const adjustPlayer = state?.players.find((p) => p.id === adjustId);

  return (
    <div className="container py-3" style={{ maxWidth: 640 }}>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h5 className="mb-0">
          Игра <span className="badge bg-dark">{roomId}</span>
        </h5>
        <button
          className="btn btn-outline-primary btn-sm"
          onClick={() => setShowInvite(true)}
        >
          Пригласить
        </button>
      </div>

      <PhaseBanner phase={phase} winnerName={state?.winnerName} />

      {phase === 'FINISHED' ? (
        <>
          <button
            className="btn btn-primary btn-lg w-100 mb-2"
            onClick={newGameSameRoom}
          >
            Новая игра в этой комнате
          </button>
          <button
            className="btn btn-outline-primary w-100 mb-3"
            onClick={createNewRoom}
          >
            Создать новую комнату
          </button>
        </>
      ) : phase === 'ANSWERING' ? (
        <div className="card mb-3">
          <div className="card-body">
            <p className="mb-2">
              Отвечает <strong>{state?.winnerName}</strong>. Начисли очки:
            </p>
            <DeltaButtons onPick={score} />
          </div>
        </div>
      ) : phase === 'ARMED' || phase === 'COLLECTING' ? (
        <button className="btn btn-warning btn-lg w-100 mb-3" onClick={pause}>
          ⏸ Приостановить
        </button>
      ) : (
        <button className="btn btn-primary btn-lg w-100 mb-3" onClick={arm}>
          Разрешить отвечать
        </button>
      )}

      {phase !== 'FINISHED' && (
        <button className="btn btn-outline-danger btn-sm w-100 mb-3" onClick={endGame}>
          Завершить игру
        </button>
      )}

      {phase === 'FINISHED' ? (
        <>
          <Results players={sorted} />
          <button
            className="btn btn-outline-secondary w-100 mt-4"
            onClick={() => {
              if (confirm('Выйти из игры?')) navigate('/');
            }}
          >
            Выйти
          </button>
        </>
      ) : (
        <>
          <p className="text-muted small mb-1">
            Нажми на игрока, чтобы изменить очки или удалить его
          </p>
          <Scoreboard
            players={sorted}
            winnerId={state?.winnerId}
            showScore
            onPlayerClick={(id) => setAdjustId(id)}
          />

          <ScoreHistory
            history={state?.history ?? []}
            openId={openEntryId}
            onToggle={(id) => setOpenEntryId((cur) => (cur === id ? null : id))}
            onEdit={editScore}
            onRemove={removeScore}
          />
        </>
      )}

      {showInvite && (
        <InviteModal url={inviteUrl} onClose={() => setShowInvite(false)} />
      )}

      {adjustPlayer && (
        <AdjustModal
          name={adjustPlayer.name}
          onPick={(d) => adjust(adjustPlayer.id, d)}
          onRename={() => rename(adjustPlayer.id, adjustPlayer.name)}
          onKick={() => kick(adjustPlayer.id)}
          onClose={() => setAdjustId(null)}
        />
      )}
    </div>
  );
}

/** The −3…+3 scoring scale, reused for answer scoring and manual adjustment. */
function DeltaButtons({
  onPick,
  excludeZero,
}: {
  onPick: (delta: number) => void;
  excludeZero?: boolean;
}) {
  return (
    <div className="d-flex flex-wrap gap-2">
      {DELTAS.filter((d) => !(excludeZero && d === 0)).map((d) => (
        <button
          key={d}
          className={`btn ${d > 0 ? 'btn-success' : d < 0 ? 'btn-danger' : 'btn-secondary'}`}
          onClick={() => onPick(d)}
        >
          {d > 0 ? `+${d}` : d}
        </button>
      ))}
    </div>
  );
}

/** Editable scoring history (newest first). Tap a row to change or remove it. */
function ScoreHistory({
  history,
  openId,
  onToggle,
  onEdit,
  onRemove,
}: {
  history: RoomState['history'];
  openId: string | null;
  onToggle: (id: string) => void;
  onEdit: (id: string, delta: number) => void;
  onRemove: (id: string) => void;
}) {
  if (history.length === 0) return null;
  return (
    <div className="mt-3">
      <h6 className="text-muted small mb-1">История начислений</h6>
      <ul className="list-group">
        {history.map((e) => (
          <li key={e.id} className="list-group-item p-0">
            <button
              className="btn w-100 d-flex justify-content-between align-items-center text-start px-3 py-2"
              onClick={() => onToggle(e.id)}
            >
              <span className="d-flex flex-column">
                <span>{e.name}</span>
                <small className="text-muted">{formatTime(e.at)}</small>
              </span>
              <span
                className={`badge ${e.delta > 0 ? 'bg-success' : e.delta < 0 ? 'bg-danger' : 'bg-secondary'}`}
              >
                {e.delta > 0 ? `+${e.delta}` : e.delta}
              </span>
            </button>
            {openId === e.id && (
              <div className="px-3 pb-3 pt-1 border-top">
                <p className="small text-muted mb-2">Изменить очки:</p>
                <DeltaButtons onPick={(d) => onEdit(e.id, d)} />
                <button
                  className="btn btn-outline-danger btn-sm w-100 mt-2"
                  onClick={() => onRemove(e.id)}
                >
                  Удалить начисление
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AdjustModal({
  name,
  onPick,
  onRename,
  onKick,
  onClose,
}: {
  name: string;
  onPick: (delta: number) => void;
  onRename: () => void;
  onKick: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="modal d-block"
      style={{ background: 'rgba(0,0,0,.5)' }}
      onClick={onClose}
    >
      <div
        className="modal-dialog modal-dialog-centered"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">Изменить очки: {name}</h5>
            <button className="btn-close" onClick={onClose} />
          </div>
          <div className="modal-body">
            <DeltaButtons onPick={onPick} excludeZero />
            <hr />
            <button className="btn btn-outline-secondary w-100 mb-2" onClick={onRename}>
              Переименовать
            </button>
            <button className="btn btn-outline-danger w-100" onClick={onKick}>
              Удалить игрока
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PhaseBanner({
  phase,
  winnerName,
}: {
  phase: string;
  winnerName?: string;
}) {
  const map: Record<string, { text: string; cls: string }> = {
    IDLE: { text: 'Кнопки заблокированы', cls: 'secondary' },
    ARMED: { text: 'Кнопки активны — ждём нажатия', cls: 'primary' },
    COLLECTING: { text: 'Кто-то нажал…', cls: 'warning' },
    ANSWERING: { text: `Отвечает ${winnerName ?? ''}`, cls: 'success' },
    FINISHED: { text: 'Игра окончена', cls: 'dark' },
  };
  const m = map[phase] ?? map.IDLE;
  return <div className={`alert alert-${m.cls} text-center py-2`}>{m.text}</div>;
}

function InviteModal({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      className="modal d-block"
      style={{ background: 'rgba(0,0,0,.5)' }}
      onClick={onClose}
    >
      <div className="modal-dialog modal-dialog-centered" onClick={(e) => e.stopPropagation()}>
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">Подключение участников</h5>
            <button className="btn-close" onClick={onClose} />
          </div>
          <div className="modal-body text-center">
            <QRCodeSVG value={url} size={240} marginSize={2} className="mb-3" />
            <div className="input-group">
              <input className="form-control" value={url} readOnly />
              <button
                className="btn btn-outline-secondary"
                onClick={() => navigator.clipboard?.writeText(url)}
              >
                Копировать
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Scoreboard({
  players,
  winnerId,
  showScore,
  onPlayerClick,
}: {
  players: RoomState['players'];
  winnerId?: string;
  showScore?: boolean;
  onPlayerClick?: (playerId: string) => void;
}) {
  return (
    <ul className="list-group">
      {players.map((p) => (
        <li
          key={p.id}
          className={`list-group-item d-flex justify-content-between align-items-center ${p.id === winnerId ? 'list-group-item-success' : ''} ${onPlayerClick ? 'list-group-item-action' : ''}`}
          role={onPlayerClick ? 'button' : undefined}
          onClick={onPlayerClick ? () => onPlayerClick(p.id) : undefined}
        >
          <span className={p.connected ? '' : 'text-muted'}>
            {p.name}
            {!p.connected && ' (отключился)'}
          </span>
          {showScore && <span className="badge bg-primary">{p.score}</span>}
        </li>
      ))}
      {players.length === 0 && (
        <li className="list-group-item text-muted text-center">
          Пока никто не подключился
        </li>
      )}
    </ul>
  );
}
