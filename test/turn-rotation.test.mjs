// Deterministic simulation of turn rotation. Run: node test/turn-rotation.test.mjs
// Proves the engine advances turns strictly to the next eligible seat and never
// hands the turn back to the player who just acted.
import { dealHand, applyAction, startNextHand, isLive, canAct } from '../src/engine.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error('  ✗ ' + msg);
  } else {
    console.log('  ✓ ' + msg);
  }
}

function mkPlayers(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'p' + i,
    name: 'P' + i,
    chips: 1000,
    hole: [],
    folded: false,
    bet: 0,
    acted: false,
    allIn: false,
    eliminated: false,
  }));
}

// Merge an engine patch into the room, like Supabase would.
function applyPatch(room, patch) {
  return { ...room, ...patch };
}

// Drive a hand to completion with every active player just calling/checking.
// Records the sequence of acting seat indices and validates each transition.
function simulateCallDownHand(numPlayers, label) {
  console.log(`\n[${label}] ${numPlayers} players, everyone calls/checks`);
  let room = applyPatch({ players: mkPlayers(numPlayers), button_position: 0 }, dealHand(mkPlayers(numPlayers), 0));

  const turnLog = [];
  let guard = 0;
  while (room.current_phase !== 'showdown' && guard++ < 200) {
    const actor = room.current_player;
    turnLog.push({ phase: room.current_phase, actor });

    // The seat on turn must always be eligible to act.
    assert(canAct(room.players[actor]), `seat ${actor} on turn is eligible (${room.current_phase})`);

    const patch = applyAction(room, room.players[actor].id, 'call');
    assert(Object.keys(patch).length > 0, `action by seat ${actor} produced a state change`);

    const prevPhase = room.current_phase;
    room = applyPatch(room, patch);

    // KEY INVARIANT: within the same betting round, the turn must NOT come
    // straight back to the player who just acted.
    if (room.current_phase === prevPhase && room.current_player != null) {
      assert(
        room.current_player !== actor,
        `seat ${actor} did NOT get the turn back immediately (still in ${prevPhase})`
      );
    }
  }
  assert(room.current_phase === 'showdown', 'hand reached showdown');
  assert(guard < 200, 'no infinite loop');
  console.log('   turn order:', turnLog.map((t) => `${t.phase[0]}${t.actor}`).join(' → '));
  return room;
}

// 1) Strict sequencing for 2..6 players, call-down.
for (let n = 2; n <= 6; n++) simulateCallDownHand(n, 'call-down');

// 2) Preflop order must be: 3-handed UTG is the button, BB gets the option.
{
  console.log('\n[order] 3-handed preflop order + BB option');
  let room = applyPatch({ players: mkPlayers(3) }, dealHand(mkPlayers(3), 0));
  assert(room.current_player === 0, 'preflop first to act is the button (UTG) seat 0');
  room = applyPatch(room, applyAction(room, 'p0', 'call'));
  assert(room.current_player === 1, 'then small blind seat 1');
  room = applyPatch(room, applyAction(room, 'p1', 'call'));
  assert(room.current_player === 2, 'then big blind seat 2 (gets the option)');
  room = applyPatch(room, applyAction(room, 'p2', 'call'));
  assert(room.current_phase === 'flop', 'BB checking option closes preflop → flop');
  assert(room.current_player === 1, 'flop first to act is first seat left of button (seat 1)');
}

// 3) A raise must reopen the action to everyone else (sequential, no skip).
//    4-handed, button=0 → SB=1, BB=2, UTG/first-to-act=3. Order: 3→0→1→2.
{
  console.log('\n[raise] raise reopens action (4-handed, first to act = seat 3)');
  let room = applyPatch({ players: mkPlayers(4) }, dealHand(mkPlayers(4), 0));
  assert(room.current_player === 3, 'preflop first to act is UTG seat 3 (left of BB)');
  // UTG (seat 3) raises to 60 — reopens action to the rest, in order.
  room = applyPatch(room, applyAction(room, 'p3', 'raise', 60));
  assert(room.current_player === 0, 'after raise, action moves sequentially to seat 0');
  room = applyPatch(room, applyAction(room, 'p0', 'call'));
  assert(room.current_player === 1, 'sequential to seat 1 (SB)');
  room = applyPatch(room, applyAction(room, 'p1', 'call'));
  assert(room.current_player === 2, 'sequential to seat 2 (BB)');
  assert(room.current_phase === 'preflop', 'still preflop until the BB matches the raise');
  room = applyPatch(room, applyAction(room, 'p2', 'call'));
  // Action returns to the aggressor with everyone matched → round closes (the
  // raiser does not act again unless re-raised). Correct Hold'em behaviour.
  assert(room.current_phase === 'flop', 'all matched the raise → round closes → flop');
  assert(room.current_player === 1, 'flop opens on first seat left of button (seat 1)');
}

// 4) Folds must be skipped; turn never lands on a folded/eliminated seat.
//    4-handed: first to act = seat 3.
{
  console.log('\n[fold] folded seats are skipped');
  let room = applyPatch({ players: mkPlayers(4) }, dealHand(mkPlayers(4), 0));
  assert(room.current_player === 3, 'first to act is seat 3');
  room = applyPatch(room, applyAction(room, 'p3', 'fold'));
  assert(room.current_player === 0, 'after seat 3 folds, action at seat 0');
  room = applyPatch(room, applyAction(room, 'p0', 'fold'));
  assert(room.current_player === 1, 'after seat 0 folds, action at seat 1 (skips folded)');
  assert(!isLive(room.players[3]) && !isLive(room.players[0]), 'seats 3,0 are folded');
  room = applyPatch(room, applyAction(room, 'p1', 'call'));
  assert(room.current_player === 2, 'action at seat 2 (BB), never landing on a folded seat');
}

// 5) Out-of-turn / stale action must be ignored (no turn corruption).
{
  console.log('\n[guard] out-of-turn action is a no-op');
  let room = applyPatch({ players: mkPlayers(3) }, dealHand(mkPlayers(3), 0));
  const onTurn = room.current_player;
  const offTurnId = room.players[(onTurn + 1) % 3].id;
  const patch = applyAction(room, offTurnId, 'call');
  assert(Object.keys(patch).length === 0, 'action from a seat not on turn returns empty patch');
}

// 6) Multi-hand: dealer button rotates to the next seat each hand.
{
  console.log('\n[dealer] button rotates each hand');
  let room = applyPatch({ players: mkPlayers(3), hands_played: 1 }, dealHand(mkPlayers(3), 0));
  assert(room.button_position === 0, 'hand 1 button at seat 0');
  // fast-forward this hand to showdown via call-down
  let guard = 0;
  while (room.current_phase !== 'showdown' && guard++ < 100) {
    room = applyPatch(room, applyAction(room, room.players[room.current_player].id, 'call'));
  }
  room = applyPatch(room, startNextHand(room));
  assert(room.button_position === 1, 'hand 2 button rotated to seat 1');
}

console.log('\n' + (failures === 0 ? '✅ ALL TURN-ROTATION TESTS PASSED' : `❌ ${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
