-- ============================================================================
-- DESTRUYE TODO (limpia completamente antes de crear)
-- ============================================================================
drop table if exists poker_rooms cascade;

-- ============================================================================
-- CREA TABLA DESDE CERO
-- ============================================================================
-- Create poker_rooms table with Realtime support
create table poker_rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  host_id text not null,
  host_name text not null,
  mode text not null default 'standard' check (mode in ('standard', 'flash')),
  status text not null default 'waiting' check (status in ('waiting', 'playing', 'finished')),

  -- Game state
  players jsonb not null default '[]',
  hands_played int not null default 0,
  small_blind int not null default 10,
  big_blind int not null default 20,
  button_position int not null default 0,
  current_player int default 0,
  current_phase text default 'preflop',

  -- Board
  deck jsonb,
  community_cards jsonb default '[]',
  pot int default 0,
  current_bet int default 0,

  -- Resultado de la última mano (showdown / ganador / campeón)
  last_result jsonb,

  -- Timing
  phase_started_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Create indexes
create index poker_rooms_code on poker_rooms(code);
create index poker_rooms_host_id on poker_rooms(host_id);

-- Enable Row Level Security
alter table poker_rooms enable row level security;

-- Public access policies (anyone can read/write)
create policy "Public access poker_rooms" on poker_rooms
  for all
  using (true)
  with check (true);

-- ===============;=============================================================
-- REALTIME (imprescindible: sin esto el multijugador NO se sincroniza)
-- ============================================================================
alter publication supabase_realtime add table poker_rooms;
