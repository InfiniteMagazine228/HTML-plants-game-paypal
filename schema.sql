create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  coins integer not null default 20,
  seeds integer not null default 5,
  harvests integer not null default 0,
  plots jsonb not null default '[0,0,0,0,0,0,0,0,0]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  paypal_order_id text unique not null,
  amount_usd numeric(10,2) not null,
  coins integer not null,
  status text not null default 'created',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.payments enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile" on public.profiles for select to authenticated using (auth.uid() = id);

drop policy if exists "Users can update own gameplay" on public.profiles;
create policy "Users can update own gameplay" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "Users can read own payments" on public.payments;
create policy "Users can read own payments" on public.payments for select to authenticated using (auth.uid() = user_id);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();
