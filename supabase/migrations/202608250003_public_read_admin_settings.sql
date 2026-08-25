alter table public.topics alter column user_id drop not null;
create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
-- Settings are accessed only by the server service-role client.
