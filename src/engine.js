// ============================================================================
// POKER ENGINE — pure, side-effect-free game logic.
// No React, no Supabase: every function takes state in and returns new state,
// which makes the turn/phase logic unit-testable in isolation (see test/).
// ============================================================================

// ============================================================================
// CONSTANTS
// ============================================================================
export const SUITS = { s: '♠', h: '♥', d: '♦', c: '♣' };
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const STARTING_CHIPS = 1000;
export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;
export const MAX_PLAYERS = 6;

export const HAND_NAMES = [
  'Carta alta',
  'Pareja',
  'Doble pareja',
  'Trío',
  'Escalera',
  'Color',
  'Full House',
  'Póker',
  'Escalera de color',
];

// ============================================================================
// DECK
// ============================================================================
export function createDeck() {
  const deck = [];
  for (const suit of Object.keys(SUITS)) {
    for (const rank of RANKS) deck.push({ rank, suit });
  }
  // Fisher–Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ============================================================================
// HAND EVALUATION (best 5 of 7)
// ============================================================================
const RANK_VALUE = {
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

function score5(cards) {
  const vals = cards.map((c) => RANK_VALUE[c.rank]).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  const uniq = [...new Set(vals)];
  let isStraight = false;
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) {
      isStraight = true;
      straightHigh = uniq[0];
    } else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) {
      // wheel: A-2-3-4-5
      isStraight = true;
      straightHigh = 5;
    }
  }

  const counts = {};
  vals.forEach((v) => (counts[v] = (counts[v] || 0) + 1));
  const groups = Object.entries(counts)
    .map(([v, c]) => [c, Number(v)])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const pattern = groups.map((g) => g[0]).join('');
  const kick = groups.map((g) => g[1]);

  if (isStraight && isFlush) return [8, straightHigh];
  if (pattern === '41') return [7, kick[0], kick[1]];
  if (pattern === '32') return [6, kick[0], kick[1]];
  if (isFlush) return [5, ...vals];
  if (isStraight) return [4, straightHigh];
  if (pattern === '311') return [3, kick[0], kick[1], kick[2]];
  if (pattern === '221') return [2, kick[0], kick[1], kick[2]];
  if (pattern === '2111') return [1, kick[0], kick[1], kick[2], kick[3]];
  return [0, ...vals];
}

export function cmpScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

export function evaluate7(cards) {
  let best = null;
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const five = cards.filter((_, k) => k !== i && k !== j);
      const s = score5(five);
      if (!best || cmpScore(s, best) > 0) best = s;
    }
  }
  return best;
}

// ============================================================================
// SEATING / TURN HELPERS
// ============================================================================
export const isLive = (p) => !p.eliminated && !p.folded;
export const canAct = (p) => !p.eliminated && !p.folded && !p.allIn;

// Strictly sequential search to the LEFT (increasing index, wrapping with
// modulo) for the next seat matching `pred`. Starts at `from + 1` so it never
// returns `from` itself unless every other seat fails and `from` matches.
// This is the single source of truth for "who acts next".
export function nextIdx(players, from, pred) {
  const n = players.length;
  for (let step = 1; step <= n; step++) {
    const j = (from + step) % n;
    if (pred(players[j])) return j;
  }
  return -1;
}

// A seat still owes action this round if it can act AND it either hasn't acted
// yet or hasn't matched the current bet.
function owesAction(p, currentBet) {
  return canAct(p) && (!p.acted || (p.bet || 0) < currentBet);
}

function postBlind(p, amount) {
  const pay = Math.min(amount, p.chips);
  p.chips -= pay;
  p.bet = (p.bet || 0) + pay;
  if (p.chips === 0) p.allIn = true;
  return pay;
}

// ============================================================================
// HAND SETUP
// ============================================================================
// Build the full state patch for the start of a new hand.
export function dealHand(rawPlayers, button) {
  const deck = createDeck();
  const players = rawPlayers.map((p) => ({
    ...p,
    eliminated: p.eliminated || p.chips <= 0,
    hole: [],
    folded: false,
    bet: 0,
    acted: false,
    allIn: false,
  }));

  players.forEach((p) => {
    if (!p.eliminated) p.hole = [deck.pop(), deck.pop()];
  });

  const notEliminated = (p) => !p.eliminated;
  const activeCount = players.filter(notEliminated).length;
  const heads = activeCount === 2;

  let sbIdx;
  let bbIdx;
  let firstIdx;
  if (heads) {
    // Heads-up: the button is the small blind and acts first preflop.
    sbIdx = button;
    bbIdx = nextIdx(players, button, notEliminated);
    firstIdx = button;
  } else {
    // 3+ handed: SB left of button, BB next, action opens left of the BB.
    sbIdx = nextIdx(players, button, notEliminated);
    bbIdx = nextIdx(players, sbIdx, notEliminated);
    firstIdx = nextIdx(players, bbIdx, notEliminated);
  }

  postBlind(players[sbIdx], SMALL_BLIND);
  postBlind(players[bbIdx], BIG_BLIND);
  const pot = players[sbIdx].bet + players[bbIdx].bet;

  return {
    deck,
    players,
    community_cards: [],
    pot,
    current_bet: BIG_BLIND,
    current_phase: 'preflop',
    current_player: firstIdx,
    button_position: button,
    last_result: null,
    phase_started_at: new Date().toISOString(),
  };
}

// ============================================================================
// SHOWDOWN / SETTLEMENT
// ============================================================================
// Award the pot, reveal hands, freeze on a 'showdown' phase for everyone to see.
function settle(players, winners, pot, board, reveals) {
  const next = players.map((p) => ({ ...p }));
  const share = Math.floor(pot / winners.length);
  const remainder = pot - share * winners.length;
  winners.forEach((w, i) => {
    const target = next.find((p) => p.id === w.id);
    target.chips += share + (i === 0 ? remainder : 0);
  });
  return {
    players: next,
    pot: 0,
    current_bet: 0,
    current_phase: 'showdown',
    community_cards: board,
    last_result: {
      type: reveals ? 'showdown' : 'fold',
      pot,
      board,
      winners: winners.map((w) => ({ name: w.name, hand: w.hand || null })),
      reveals: reveals || null,
    },
    phase_started_at: new Date().toISOString(),
  };
}

// Resolve showdown: evaluate every live hand, award to best.
function runShowdown(players, board, pot) {
  const live = players.filter(isLive);
  const scored = live.map((p) => {
    const s = evaluate7([...p.hole, ...board]);
    return { id: p.id, name: p.name, score: s, hand: HAND_NAMES[s[0]] };
  });
  let best = null;
  scored.forEach((s) => {
    if (!best || cmpScore(s.score, best) > 0) best = s.score;
  });
  const winners = scored.filter((s) => cmpScore(s.score, best) === 0);
  const reveals = live.map((p) => {
    const s = scored.find((x) => x.id === p.id);
    return { name: p.name, hole: p.hole, hand: s.hand };
  });
  return settle(players, winners, pot, board, reveals);
}

// ============================================================================
// PHASE ADVANCEMENT
// ============================================================================
// Deal the next street (or run straight to showdown if betting is closed).
// On every new street the first turn goes to the first seat still able to act
// to the LEFT of the dealer button — exactly as in Texas Hold'em.
function advancePhase(room, players, deck, board, pot) {
  const next = players.map((p) => ({ ...p, bet: 0, acted: false }));
  const phase = room.current_phase;
  let newBoard;
  let nextPhase;

  if (phase === 'preflop') {
    newBoard = [...board, deck.pop(), deck.pop(), deck.pop()];
    nextPhase = 'flop';
  } else if (phase === 'flop') {
    newBoard = [...board, deck.pop()];
    nextPhase = 'turn';
  } else if (phase === 'turn') {
    newBoard = [...board, deck.pop()];
    nextPhase = 'river';
  } else {
    // river complete → showdown
    return runShowdown(next, board, pot);
  }

  // If at most one player can still act, no more betting: run the board out.
  if (next.filter(canAct).length <= 1) {
    return advancePhase({ ...room, current_phase: nextPhase }, next, deck, newBoard, pot);
  }

  const firstIdx = nextIdx(next, room.button_position, canAct);
  return {
    players: next,
    deck,
    community_cards: newBoard,
    pot,
    current_bet: 0,
    current_phase: nextPhase,
    current_player: firstIdx,
    phase_started_at: new Date().toISOString(),
  };
}

// ============================================================================
// PLAYER ACTION
// ============================================================================
// Apply a player action and return the full state patch to persist.
// action: 'fold' | 'call' | 'raise'. raiseTo = total bet target for 'raise'.
export function applyAction(room, playerId, action, raiseTo) {
  const players = room.players.map((p) => ({ ...p }));
  const deck = [...(room.deck || [])];
  const board = [...(room.community_cards || [])];
  let pot = room.pot || 0;
  let currentBet = room.current_bet || 0;

  const idx = players.findIndex((p) => p.id === playerId);
  if (idx === -1) return {}; // unknown player → no-op
  const p = players[idx];

  // Guard: ignore actions from a seat that is not the one on turn. This keeps
  // the turn order strictly sequential even if a stale client double-submits.
  if (idx !== room.current_player || !canAct(p)) return {};

  if (action === 'fold') {
    p.folded = true;
    p.acted = true;
  } else if (action === 'call') {
    const toCall = Math.min(currentBet - (p.bet || 0), p.chips);
    p.chips -= toCall;
    p.bet = (p.bet || 0) + toCall;
    pot += toCall;
    p.acted = true;
    if (p.chips === 0) p.allIn = true;
  } else if (action === 'raise') {
    const maxTo = (p.bet || 0) + p.chips;
    const target = Math.min(Math.max(raiseTo, currentBet), maxTo);
    const pay = target - (p.bet || 0);
    p.chips -= pay;
    p.bet = target;
    pot += pay;
    if (p.chips === 0) p.allIn = true;
    currentBet = Math.max(currentBet, p.bet);
    // A raise reopens the action: everyone else who can act must respond again.
    players.forEach((q, qi) => {
      if (qi !== idx && canAct(q)) q.acted = false;
    });
    p.acted = true;
  } else {
    return {};
  }

  // Everyone else folded → lone winner takes the pot.
  const live = players.filter(isLive);
  if (live.length === 1) {
    const w = { id: live[0].id, name: live[0].name };
    return settle(players, [w], pot, board, null);
  }

  // Find the next seat (strictly to the left) that still owes action this round.
  const needs = nextIdx(players, idx, (q) => owesAction(q, currentBet));
  if (needs === -1) {
    // Betting round complete → next street (or showdown).
    return advancePhase(room, players, deck, board, pot);
  }

  return {
    players,
    deck,
    community_cards: board,
    pot,
    current_bet: currentBet,
    current_player: needs,
  };
}

// ============================================================================
// NEXT HAND
// ============================================================================
// Start the next hand after a showdown (rotates the dealer, handles elimination).
export function startNextHand(room) {
  const cleaned = room.players.map((p) => ({
    ...p,
    eliminated: p.eliminated || p.chips <= 0,
  }));
  const remaining = cleaned.filter((p) => !p.eliminated);

  if (remaining.length <= 1) {
    return {
      status: 'finished',
      players: cleaned,
      current_phase: 'finished',
      last_result: { type: 'champion', name: remaining[0]?.name || '—' },
    };
  }

  const newButton = nextIdx(cleaned, room.button_position, (p) => !p.eliminated);
  return {
    ...dealHand(cleaned, newButton),
    hands_played: (room.hands_played || 0) + 1,
  };
}
