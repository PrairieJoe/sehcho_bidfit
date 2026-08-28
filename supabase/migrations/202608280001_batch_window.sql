alter table public.batch_runs add column if not exists window_start timestamptz;
alter table public.batch_runs add column if not exists window_end timestamptz;
alter table public.batch_runs add column if not exists window_hours integer;
