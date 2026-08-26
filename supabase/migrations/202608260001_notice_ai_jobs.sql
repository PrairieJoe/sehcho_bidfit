create table if not exists public.notice_ai_jobs (
  id uuid primary key default gen_random_uuid(),
  notice_id uuid not null references public.notices(id) on delete cascade,
  input_hash text not null,
  status text not null default '대기' check (status in ('대기', '처리 중', '완료', '실패')),
  attempts integer not null default 0,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (notice_id, input_hash)
);

create index if not exists notice_ai_jobs_status_idx on public.notice_ai_jobs (status, created_at);
alter table public.notice_ai_jobs enable row level security;
create policy "authenticated users read notice ai jobs" on public.notice_ai_jobs for select to authenticated using (true);
