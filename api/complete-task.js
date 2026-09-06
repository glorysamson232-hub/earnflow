-- ============================================================
-- EARNFLOW DATABASE SCHEMA
-- Paste this whole file into Supabase SQL Editor and click Run.
-- ============================================================

-- 1. ADMIN CONFIG (single row, editable by admin only)
create table admin_config (
  id int primary key default 1,
  points_per_dollar integer not null default 10000,       -- 100 pts = $0.01
  referral_qualification_tasks integer not null default 3,
  referral_system_enabled boolean not null default true,
  min_withdrawal integer not null default 1500,
  max_withdrawal integer not null default 2500,
  withdrawal_fee_percent numeric not null default 10,
  withdrawals_per_day integer not null default 3,
  withdrawal_days text[] not null default array['SU','MO','TU','WE','TH','FR','SA'],
  withdrawal_open time not null default '09:00',
  withdrawal_close time not null default '16:00',
  method_usdt_enabled boolean not null default true,
  method_ton_enabled boolean not null default true,
  constraint single_row check (id = 1)
);
insert into admin_config (id) values (1);

-- 2. REFERRAL TIERS (admin-configurable commission drop)
create table referral_tiers (
  id uuid primary key default gen_random_uuid(),
  min_ref integer not null,
  max_ref integer not null,
  reward integer not null,
  created_at timestamptz not null default now()
);
insert into referral_tiers (min_ref, max_ref, reward) values
  (1, 10, 100), (11, 25, 80), (26, 50, 60), (51, 100, 40), (101, 999999, 20);

-- 3. TASKS
create table tasks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  link text,
  reward integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 4. USERS (one row per Telegram account)
create table app_users (
  id uuid primary key default gen_random_uuid(),
  telegram_id text unique not null,
  display_name text,
  points_balance integer not null default 0,
  pending_withdrawal integer not null default 0,
  total_earned integer not null default 0,
  total_referral_earnings integer not null default 0,
  total_withdrawn integer not null default 0,
  referred_by uuid references app_users(id),
  wallet_usdt text,
  wallet_ton text,
  is_flagged boolean not null default false,
  created_at timestamptz not null default now()
);

-- 5. TASK COMPLETIONS (tracks who completed what, prevents double-claiming)
create table task_completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  completed_at timestamptz not null default now(),
  unique (user_id, task_id)
);

-- 6. REFERRALS
create table referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references app_users(id) on delete cascade,
  referred_id uuid not null references app_users(id) on delete cascade,
  tasks_completed integer not null default 0,
  qualified boolean not null default false,
  qualified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (referred_id)  -- a user can only be referred once
);

-- 7. WITHDRAWALS
create table withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  method text not null check (method in ('USDT','TON')),
  points integer not null,
  usd_value numeric not null,
  fee numeric not null,
  net_amount numeric not null,
  wallet_address text not null,
  status text not null default 'Pending'
    check (status in ('Pending','Under Review','Approved','Processing','Paid','Rejected')),
  tx_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- Users can only see/edit their own data. All writes that touch
-- balances happen through server-side functions/edge functions
-- using the service role key — never directly from the app.
-- ============================================================

alter table app_users enable row level security;
alter table task_completions enable row level security;
alter table referrals enable row level security;
alter table withdrawals enable row level security;
alter table tasks enable row level security;
alter table admin_config enable row level security;
alter table referral_tiers enable row level security;

-- Everyone (even anonymous) can read active tasks and current config —
-- needed so the app can display them before/without login.
create policy "Public can read active tasks" on tasks
  for select using (active = true);

create policy "Public can read admin config" on admin_config
  for select using (true);

create policy "Public can read referral tiers" on referral_tiers
  for select using (true);

-- Users can only read their own row (matched by telegram_id via a
-- custom claim set during your Telegram auth verification step).
create policy "Users read own profile" on app_users
  for select using (telegram_id = auth.jwt() ->> 'telegram_id');

create policy "Users read own task completions" on task_completions
  for select using (
    user_id = (select id from app_users where telegram_id = auth.jwt() ->> 'telegram_id')
  );

create policy "Users read own referrals" on referrals
  for select using (
    referrer_id = (select id from app_users where telegram_id = auth.jwt() ->> 'telegram_id')
  );

create policy "Users read own withdrawals" on withdrawals
  for select using (
    user_id = (select id from app_users where telegram_id = auth.jwt() ->> 'telegram_id')
  );

-- No insert/update/delete policies are defined for regular users on
-- purpose: all writes (completing a task, submitting a withdrawal,
-- qualifying a referral) must go through your Vercel API routes using
-- the Supabase SERVICE ROLE key, so the server can validate everything
-- (balance checks, anti-cheat, fee math) before touching the database.
  
