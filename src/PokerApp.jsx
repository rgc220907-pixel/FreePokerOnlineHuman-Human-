import { useState, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import {
  SUITS,
  STARTING_CHIPS,
  SMALL_BLIND,
  BIG_BLIND,
  MAX_PLAYERS,
  generateCode,
  canAct,
  dealHand,
  applyAction,
  startNextHand,
} from './engine.js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_KEY
);

async function persist(code, patch) {
  patch.updated_at = new Date().toISOString();
  await supabase.from('poker_rooms').update(patch).eq('code', code);
}

// ============================================================================
// MAIN APP COMPONENT
// ============================================================================
export default function PokerApp() {
  const [screen, setScreen] = useState('landing');
  const [playerName, setPlayerName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [room, setRoom] = useState(null);
  const [playerId] = useState(() => {
    let id = localStorage.getItem('pokerId');
    if (!id) {
      id = 'p_' + Math.random().toString(36).substring(2, 9);
      localStorage.setItem('pokerId', id);
    }
    return id;
  });
  const realtimeRef = useRef(null);

  // Persist a state patch AND apply it locally right away. The optimistic local
  // update is what keeps the acting player's turn in sync immediately, instead
  // of waiting for the Supabase Realtime echo to come back (which could be
  // delayed and make it look like the turn "stays" on the same player).
  const commit = useCallback((code, patch) => {
    if (!patch || Object.keys(patch).length === 0) return Promise.resolve();
    setRoom((prev) => (prev ? { ...prev, ...patch } : prev));
    return persist(code, patch);
  }, []);

  const subscribeToRoom = useCallback((code) => {
    if (realtimeRef.current) supabase.removeChannel(realtimeRef.current);

    const channel = supabase
      .channel(`poker:${code}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'poker_rooms', filter: `code=eq.${code}` },
        (payload) => {
          const next = payload.new;
          if (!next) return;
          setRoom(next);
          setScreen(next.status === 'playing' || next.status === 'finished' ? 'game' : 'lobby');
        }
      )
      .subscribe();

    realtimeRef.current = channel;

    supabase
      .from('poker_rooms')
      .select('*')
      .eq('code', code)
      .single()
      .then(({ data }) => {
        if (data) {
          setRoom(data);
          setScreen(data.status === 'playing' || data.status === 'finished' ? 'game' : 'lobby');
        }
      });
  }, []);

  const createRoom = async () => {
    if (!playerName.trim()) return;
    const code = generateCode();
    const { data } = await supabase
      .from('poker_rooms')
      .insert([
        {
          code,
          host_id: playerId,
          host_name: playerName.trim(),
          mode: 'standard',
          small_blind: SMALL_BLIND,
          big_blind: BIG_BLIND,
          players: [
            {
              id: playerId,
              name: playerName.trim(),
              chips: STARTING_CHIPS,
              hole: [],
              folded: false,
              bet: 0,
              acted: false,
              allIn: false,
              eliminated: false,
            },
          ],
        },
      ])
      .select()
      .single();

    if (data) {
      setRoomCode(code);
      subscribeToRoom(code);
      setScreen('lobby');
    }
  };

  const joinRoom = async (e) => {
    e.preventDefault();
    if (!playerName.trim() || !roomCode.trim()) return;
    const code = roomCode.toUpperCase();

    const { data: existing, error } = await supabase
      .from('poker_rooms')
      .select('*')
      .eq('code', code)
      .single();

    if (error || !existing) return alert('Sala no encontrada');
    if (existing.status !== 'waiting') return alert('La partida ya ha comenzado');
    if (existing.players.length >= MAX_PLAYERS) return alert('Sala llena');
    if (existing.players.some((p) => p.id === playerId)) {
      subscribeToRoom(code);
      return setScreen('lobby');
    }

    const updatedPlayers = [
      ...existing.players,
      {
        id: playerId,
        name: playerName.trim(),
        chips: STARTING_CHIPS,
        hole: [],
        folded: false,
        bet: 0,
        acted: false,
        allIn: false,
        eliminated: false,
      },
    ];
    await persist(code, { players: updatedPlayers });
    subscribeToRoom(code);
    setScreen('lobby');
  };

  const leaveRoom = () => {
    if (realtimeRef.current) supabase.removeChannel(realtimeRef.current);
    realtimeRef.current = null;
    setRoom(null);
    setScreen('landing');
  };

  // ===== LANDING =====
  if (screen === 'landing') {
    return (
      <Shell>
        <div className="w-full max-w-sm mx-auto">
          <div className="mb-10 text-center">
            <h1 className="text-6xl font-bold tracking-tight">Hold'em</h1>
            <p className="text-zinc-500 mt-2">Texas Hold'em · Torneo</p>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (playerName.trim()) setScreen('join');
            }}
            className="space-y-3"
          >
            <input
              type="text"
              placeholder="Tu nombre"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              maxLength={20}
              className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-lg placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition"
            />
            <PrimaryButton type="submit" disabled={!playerName.trim()}>
              Continuar
            </PrimaryButton>
          </form>
        </div>
      </Shell>
    );
  }

  // ===== JOIN / CREATE =====
  if (screen === 'join') {
    return (
      <Shell>
        <div className="w-full max-w-sm mx-auto">
          <h2 className="text-3xl font-bold mb-8 text-center">Mesa de Póker</h2>
          <PrimaryButton onClick={createRoom}>Crear Mesa</PrimaryButton>
          <div className="flex items-center gap-3 my-6">
            <div className="flex-1 h-px bg-zinc-800" />
            <span className="text-zinc-600 text-sm">o únete</span>
            <div className="flex-1 h-px bg-zinc-800" />
          </div>
          <form onSubmit={joinRoom} className="space-y-3">
            <input
              type="text"
              placeholder="CÓDIGO"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              maxLength={8}
              className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-lg placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition uppercase text-center text-lg font-mono tracking-widest"
            />
            <SecondaryButton type="submit">Unirse</SecondaryButton>
          </form>
          <button
            onClick={() => setScreen('landing')}
            className="w-full py-3 text-zinc-600 hover:text-zinc-400 transition mt-4"
          >
            Atrás
          </button>
        </div>
      </Shell>
    );
  }

  // ===== LOBBY =====
  if (screen === 'lobby' && room) {
    return <Lobby room={room} playerId={playerId} commit={commit} onLeave={leaveRoom} />;
  }

  // ===== GAME =====
  if (screen === 'game' && room) {
    return <GameTable room={room} playerId={playerId} commit={commit} onExit={leaveRoom} />;
  }

  return null;
}

// ============================================================================
// LOBBY
// ============================================================================
function Lobby({ room, playerId, commit, onLeave }) {
  const isHost = room.host_id === playerId;

  const startGame = async () => {
    if (room.players.length < 2) return;
    await commit(room.code, {
      status: 'playing',
      ...dealHand(room.players, room.button_position || 0),
      hands_played: 1,
    });
  };

  return (
    <Shell align="start">
      <div className="max-w-2xl mx-auto w-full">
        <div className="mb-8">
          <p className="text-zinc-500 text-sm uppercase tracking-widest mb-1">Código de mesa</p>
          <h1 className="text-5xl font-bold font-mono tracking-tight">{room.code}</h1>
          <p className="text-zinc-500 mt-2">
            {room.players.length} / {MAX_PLAYERS} jugadores · {STARTING_CHIPS} fichas · ciegas{' '}
            {room.small_blind}/{room.big_blind}
          </p>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-6">
          <h3 className="text-xs uppercase tracking-widest text-zinc-500 mb-4 font-semibold">
            Jugadores
          </h3>
          <div className="space-y-2">
            {room.players.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between px-4 py-3 bg-zinc-800/40 rounded-lg border border-zinc-800"
              >
                <span className="font-medium">
                  {p.name}
                  {p.id === room.host_id && (
                    <span className="ml-2 text-xs text-zinc-500">anfitrión</span>
                  )}
                  {p.id === playerId && (
                    <span className="ml-2 text-xs text-zinc-400">(tú)</span>
                  )}
                </span>
                <span className="text-zinc-400 tabular-nums">{p.chips}</span>
              </div>
            ))}
          </div>
        </div>

        {isHost ? (
          <PrimaryButton onClick={startGame} disabled={room.players.length < 2}>
            {room.players.length < 2 ? 'Esperando jugadores…' : 'Iniciar Torneo'}
          </PrimaryButton>
        ) : (
          <p className="text-center text-zinc-500 py-3">Esperando a que el anfitrión inicie…</p>
        )}

        <button
          onClick={onLeave}
          className="w-full py-3 text-zinc-600 hover:text-zinc-400 transition mt-3"
        >
          Salir
        </button>
      </div>
    </Shell>
  );
}

// ============================================================================
// GAME TABLE
// ============================================================================
function GameTable({ room, playerId, commit, onExit }) {
  const [busy, setBusy] = useState(false);
  const [confirmFold, setConfirmFold] = useState(false);
  const [raise, setRaise] = useState({ key: null, value: 0 });

  const players = room.players || [];
  const myPlayer = players.find((p) => p.id === playerId);
  const current = players[room.current_player];
  const isShowdown = room.current_phase === 'showdown';
  const isFinished = room.status === 'finished';
  const isHost = room.host_id === playerId;

  const myBet = myPlayer?.bet || 0;
  const currentBet = room.current_bet || 0;
  const toCall = Math.max(0, currentBet - myBet);
  const minRaiseTo = currentBet + room.big_blind;
  const maxRaiseTo = myPlayer ? myBet + myPlayer.chips : 0;
  const canRaise = myPlayer && maxRaiseTo > currentBet;

  const amIActive =
    !isShowdown &&
    !isFinished &&
    current?.id === playerId &&
    myPlayer &&
    canAct(myPlayer);

  // Reset the raise slider to the minimum legal raise at the start of each turn.
  // Adjusting state during render (rather than in an effect) is the recommended
  // React pattern for "derive state from a changing input".
  const turnKey = `${room.current_phase}:${room.current_player}`;
  let raiseTo = raise.value;
  if (amIActive && raise.key !== turnKey) {
    raiseTo = Math.min(Math.max(minRaiseTo, currentBet + 1), maxRaiseTo);
    setRaise({ key: turnKey, value: raiseTo });
  }
  const setRaiseTo = (value) => setRaise({ key: turnKey, value });

  const act = async (action, amount) => {
    if (busy || !amIActive) return;
    setBusy(true);
    setConfirmFold(false);
    try {
      await commit(room.code, applyAction(room, playerId, action, amount));
    } finally {
      setBusy(false);
    }
  };

  const nextHand = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await commit(room.code, startNextHand(room));
    } finally {
      setBusy(false);
    }
  };

  // ===== Tournament finished =====
  if (isFinished) {
    const champion = room.last_result?.name;
    return (
      <Shell>
        <div className="text-center max-w-sm mx-auto">
          <p className="text-zinc-500 uppercase tracking-widest text-sm mb-3">Torneo finalizado</p>
          <h1 className="text-5xl font-bold mb-2">🏆</h1>
          <h2 className="text-3xl font-bold mb-8">{champion}</h2>
          <PrimaryButton onClick={onExit}>Volver al inicio</PrimaryButton>
        </div>
      </Shell>
    );
  }

  return (
    <div className="min-h-screen bg-black flex flex-col no-select p-3 sm:p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-lg font-bold font-mono tracking-wide">{room.code}</h1>
          <p className="text-zinc-500 text-xs uppercase tracking-widest">
            {phaseLabel(room.current_phase)} · ciegas {room.small_blind}/{room.big_blind}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-zinc-500 uppercase tracking-widest">Bote</p>
          <p className="text-xl font-bold tabular-nums">{room.pot || 0}</p>
        </div>
        <button onClick={onExit} className="text-zinc-600 hover:text-zinc-400 text-sm ml-4">
          Salir
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-4xl bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 sm:p-6">
          {/* Opponents */}
          <div className="flex flex-wrap justify-center gap-2 mb-5">
            {players
              .filter((p) => p.id !== playerId)
              .map((p) => (
                <Seat
                  key={p.id}
                  player={p}
                  isCurrent={current?.id === p.id && !isShowdown}
                  isButton={players[room.button_position]?.id === p.id}
                  reveal={isShowdown ? findReveal(room, p.name) : null}
                />
              ))}
          </div>

          {/* Community cards */}
          <div className="flex gap-2 justify-center my-6">
            {[0, 1, 2, 3, 4].map((i) => {
              const card = room.community_cards?.[i];
              return card ? <Card key={i} card={card} /> : <CardSlot key={i} />;
            })}
          </div>

          {/* Showdown banner */}
          {isShowdown && room.last_result && (
            <ResultBanner result={room.last_result} />
          )}
        </div>
      </div>

      {/* My hand + controls */}
      <div className="mt-3 bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex gap-2">
            {myPlayer?.hole?.length ? (
              myPlayer.hole.map((c, i) => <Card key={i} card={c} large />)
            ) : (
              <p className="text-zinc-600 text-sm py-6">Eliminado · sin cartas</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-xs text-zinc-500 uppercase tracking-widest">Tus fichas</p>
            <p className="text-2xl font-bold tabular-nums">{myPlayer?.chips ?? 0}</p>
            {myBet > 0 && <p className="text-xs text-zinc-500">apostado: {myBet}</p>}
          </div>
        </div>

        {/* Showdown → next hand */}
        {isShowdown ? (
          isHost ? (
            <PrimaryButton onClick={nextHand} disabled={busy}>
              Repartir siguiente mano
            </PrimaryButton>
          ) : (
            <p className="text-center text-zinc-500 py-2 text-sm">
              Esperando al anfitrión para la siguiente mano…
            </p>
          )
        ) : amIActive ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <SecondaryButton onClick={() => setConfirmFold(true)} disabled={busy}>
                Fold
              </SecondaryButton>
              <PrimaryButton onClick={() => act('call')} disabled={busy}>
                {toCall > 0 ? `Call ${toCall}` : 'Check'}
              </PrimaryButton>
            </div>

            {canRaise && (
              <div className="bg-zinc-800/50 border border-zinc-800 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-zinc-400">Subir a</span>
                  <span className="text-lg font-bold tabular-nums">{raiseTo}</span>
                </div>
                <input
                  type="range"
                  min={Math.min(minRaiseTo, maxRaiseTo)}
                  max={maxRaiseTo}
                  step={room.small_blind}
                  value={raiseTo}
                  onChange={(e) => setRaiseTo(Number(e.target.value))}
                  className="w-full mb-3"
                />
                <div className="flex gap-2">
                  <SecondaryButton onClick={() => act('raise', raiseTo)} disabled={busy}>
                    {raiseTo >= maxRaiseTo ? 'All-in' : `Subir a ${raiseTo}`}
                  </SecondaryButton>
                  <SecondaryButton onClick={() => act('raise', maxRaiseTo)} disabled={busy}>
                    All-in ({maxRaiseTo})
                  </SecondaryButton>
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-center text-zinc-500 py-3 text-sm">
            {!myPlayer || myPlayer.eliminated
              ? 'Has sido eliminado'
              : myPlayer.folded
              ? 'Te has retirado de esta mano'
              : myPlayer.allIn
              ? 'All-in · esperando…'
              : `Turno de ${current?.name || '…'}`}
          </p>
        )}
      </div>

      {/* Fold confirm */}
      {confirmFold && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 max-w-xs w-full">
            <p className="mb-6">¿Retirarte de esta mano?</p>
            <div className="flex gap-2">
              <PrimaryButton onClick={() => setConfirmFold(false)}>Cancelar</PrimaryButton>
              <SecondaryButton onClick={() => act('fold')}>Fold</SecondaryButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// PRESENTATIONAL COMPONENTS
// ============================================================================
function Shell({ children, align = 'center' }) {
  return (
    <div
      className={`min-h-screen bg-black flex ${
        align === 'center' ? 'items-center' : 'items-start'
      } justify-center px-4 py-8`}
    >
      {children}
    </div>
  );
}

function PrimaryButton({ children, className = '', ...props }) {
  return (
    <button
      {...props}
      className={`flex-1 w-full py-3 bg-white text-black font-semibold rounded-lg hover:bg-zinc-200 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition ${className}`}
    >
      {children}
    </button>
  );
}

function SecondaryButton({ children, className = '', ...props }) {
  return (
    <button
      {...props}
      className={`flex-1 w-full py-3 bg-zinc-800 text-white font-semibold rounded-lg border border-zinc-700 hover:bg-zinc-700 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition ${className}`}
    >
      {children}
    </button>
  );
}

function Card({ card, large = false }) {
  if (!card) return null;
  const isRed = card.suit === 'h' || card.suit === 'd';
  const dims = large ? { width: '3.5rem', height: '5rem' } : { width: '2.75rem', height: '4rem' };
  return (
    <div
      style={dims}
      className={`bg-white rounded-md border border-zinc-300 flex flex-col items-start justify-between font-bold leading-none px-1.5 py-1 ${
        large ? 'text-2xl' : 'text-base'
      }`}
    >
      <span className={isRed ? 'text-red-600' : 'text-zinc-900'}>{card.rank}</span>
      <span className={`self-end ${isRed ? 'text-red-600' : 'text-zinc-900'}`}>
        {SUITS[card.suit]}
      </span>
    </div>
  );
}

function CardSlot() {
  return (
    <div
      style={{ width: '2.75rem', height: '4rem' }}
      className="rounded-md border border-dashed border-zinc-700/60"
    />
  );
}

function Seat({ player, isCurrent, isButton, reveal }) {
  return (
    <div
      className={`rounded-lg px-3 py-2 min-w-[96px] text-center border transition ${
        isCurrent
          ? 'bg-zinc-100 text-black border-white'
          : player.folded || player.eliminated
          ? 'bg-zinc-900 border-zinc-800 opacity-40'
          : 'bg-zinc-800/70 border-zinc-700'
      }`}
    >
      <div className="flex items-center justify-center gap-1">
        <p className="font-semibold text-sm truncate max-w-[80px]">{player.name}</p>
        {isButton && (
          <span
            className={`text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center ${
              isCurrent ? 'bg-black text-white' : 'bg-white text-black'
            }`}
          >
            D
          </span>
        )}
      </div>
      <p className={`text-xs tabular-nums ${isCurrent ? 'text-zinc-700' : 'text-zinc-400'}`}>
        {player.eliminated ? 'eliminado' : `${player.chips}`}
      </p>
      {player.bet > 0 && !player.eliminated && (
        <p className={`text-[11px] ${isCurrent ? 'text-zinc-600' : 'text-zinc-500'}`}>
          apuesta {player.bet}
        </p>
      )}
      {player.allIn && <p className="text-[11px] font-semibold">ALL-IN</p>}
      {reveal && (
        <div className="flex gap-1 justify-center mt-1">
          {reveal.hole.map((c, i) => (
            <Card key={i} card={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ResultBanner({ result }) {
  if (result.type === 'champion') return null;
  const names = result.winners.map((w) => w.name).join(', ');
  const hand = result.winners[0]?.hand;
  return (
    <div className="text-center mt-2">
      <p className="text-zinc-400 text-sm">
        {result.type === 'fold' ? 'Todos se retiraron' : 'Showdown'}
      </p>
      <p className="text-lg font-bold">
        {names} gana {result.pot}
        {hand ? ` · ${hand}` : ''}
      </p>
    </div>
  );
}

// ============================================================================
// SMALL HELPERS (view layer)
// ============================================================================
function phaseLabel(phase) {
  return (
    {
      preflop: 'Preflop',
      flop: 'Flop',
      turn: 'Turn',
      river: 'River',
      showdown: 'Showdown',
      finished: 'Final',
    }[phase] || phase
  );
}

function findReveal(room, name) {
  return room.last_result?.reveals?.find((r) => r.name === name) || null;
}
