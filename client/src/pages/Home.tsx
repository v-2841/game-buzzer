import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createSocket } from '../lib/socket.ts';

export default function Home() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const room = code.trim().toUpperCase();

  function createGame() {
    setBusy(true);
    setError('');
    const socket = createSocket();
    // Time out the ack so a dropped connection can't leave the button stuck.
    socket.timeout(8000).emit('admin:createRoom', (timeoutErr, res) => {
      if (timeoutErr || !res || 'error' in res) {
        setBusy(false);
        setError(
          timeoutErr ? 'Сервер не отвечает, попробуй ещё раз' : 'Не удалось создать игру',
        );
        socket.disconnect();
        return;
      }
      // Persist the admin token so the admin can reconnect to this room.
      localStorage.setItem(`adminToken:${res.roomId}`, res.adminToken);
      socket.disconnect();
      navigate(`/admin/${res.roomId}`);
    });
  }

  function enter(e: React.FormEvent) {
    e.preventDefault();
    if (!room) return;
    // Hold an admin token for this room? Go to the admin view (the server
    // validates the token); otherwise join as a participant.
    if (localStorage.getItem(`adminToken:${room}`)) {
      navigate(`/admin/${room}`);
    } else {
      navigate(`/r/${room}`);
    }
  }

  return (
    <div
      className="container d-flex flex-column justify-content-center min-dvh-100"
      style={{ maxWidth: 420 }}
    >
      <h1 className="text-center mb-4">🔔 Buzzer</h1>

      <button
        className="btn btn-primary btn-lg w-100 mb-4"
        onClick={createGame}
        disabled={busy}
      >
        {busy ? 'Создаём…' : 'Создать игру'}
      </button>

      {error && <p className="text-danger text-center">{error}</p>}

      <div className="text-center text-muted mb-3">— или вернуться в игру —</div>

      <form onSubmit={enter}>
        <input
          className="form-control form-control-lg text-center mb-3"
          placeholder="Код игры"
          value={code}
          maxLength={5}
          autoCapitalize="characters"
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <button className="btn btn-success btn-lg w-100" disabled={!room}>
          Войти
        </button>
      </form>
    </div>
  );
}
