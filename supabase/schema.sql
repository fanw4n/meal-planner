-- Supabase schema for the meal planner.
-- Recipes remain in data.js for now; this database stores user-owned plans
-- and shopping state so the same account can use several devices.

create extension if not exists pgcrypto;

create table if not exists public.week_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  mode text not null default 'both' check (mode in ('both', 'separate')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, week_start)
);

create index if not exists week_plans_user_week_idx
  on public.week_plans (user_id, week_start);

create table if not exists public.week_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  day date not null,
  slot text not null check (slot in ('breakfast', 'lunch', 'dinner', 'lateSnack')),
  person text not null check (person in ('both', 'me', 'alina')),
  recipe_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, week_start, day, slot, person)
);

create index if not exists week_entries_user_week_idx
  on public.week_entries (user_id, week_start);

create table if not exists public.shopping_status (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  ingredient_key text not null,
  checked boolean not null default false,
  pantry boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (user_id, week_start, ingredient_key)
);

create index if not exists shopping_status_user_week_idx
  on public.shopping_status (user_id, week_start);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists week_plans_set_updated_at on public.week_plans;
create trigger week_plans_set_updated_at
before update on public.week_plans
for each row execute function public.set_updated_at();

drop trigger if exists week_entries_set_updated_at on public.week_entries;
create trigger week_entries_set_updated_at
before update on public.week_entries
for each row execute function public.set_updated_at();

drop trigger if exists shopping_status_set_updated_at on public.shopping_status;
create trigger shopping_status_set_updated_at
before update on public.shopping_status
for each row execute function public.set_updated_at();

alter table public.week_plans enable row level security;
alter table public.week_entries enable row level security;
alter table public.shopping_status enable row level security;

revoke all on public.week_plans, public.week_entries, public.shopping_status from anon;
revoke all on public.week_plans, public.week_entries, public.shopping_status from public;
grant select, insert, update, delete
  on public.week_plans, public.week_entries, public.shopping_status
  to authenticated;

drop policy if exists "users manage their week plans" on public.week_plans;
create policy "users manage their week plans"
on public.week_plans
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "users manage their week entries" on public.week_entries;
create policy "users manage their week entries"
on public.week_entries
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "users manage their shopping status" on public.shopping_status;
create policy "users manage their shopping status"
on public.shopping_status
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
