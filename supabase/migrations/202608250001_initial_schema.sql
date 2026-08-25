create extension if not exists "pgcrypto";

create table if not exists public.allowed_users (
  email text primary key check (email = lower(email)),
  role text not null default 'user' check (role in ('admin', 'user')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text not null,
  capabilities text not null default '',
  include_keywords text[] not null default '{}',
  exclude_keywords text[] not null default '{}',
  business_types text[] not null default '{용역}',
  regions text[] not null default '{전국}',
  min_budget numeric,
  max_budget numeric,
  minimum_days integer not null default 3 check (minimum_days >= 0),
  threshold integer not null default 70 check (threshold between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notices (
  id uuid primary key default gen_random_uuid(),
  bid_number text not null,
  bid_order text not null default '000',
  title text not null,
  business_type text not null,
  status text not null default '신규',
  agency text not null default '',
  demand_agency text not null default '',
  region text not null default '',
  published_at timestamptz,
  closes_at timestamptz,
  budget numeric,
  budget_label text not null default '',
  contract_method text not null default '',
  detail_url text not null default '',
  description text not null default '',
  tasks jsonb not null default '[]'::jsonb,
  qualifications jsonb not null default '[]'::jsonb,
  change_summary text,
  source_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bid_number, bid_order)
);

create table if not exists public.notice_versions (
  id uuid primary key default gen_random_uuid(),
  notice_id uuid not null references public.notices(id) on delete cascade,
  source_hash text not null,
  source_payload jsonb not null,
  observed_at timestamptz not null default now(),
  unique (notice_id, source_hash)
);

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  notice_id uuid not null references public.notices(id) on delete cascade,
  source_url text not null,
  name text not null,
  kind text not null default '첨부문서',
  storage_path text,
  content_type text,
  byte_size bigint,
  sha256 text,
  status text not null default '대기',
  pages integer,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (notice_id, source_url)
);

create table if not exists public.attachment_texts (
  attachment_id uuid primary key references public.attachments(id) on delete cascade,
  extracted_text text not null,
  page_map jsonb not null default '[]'::jsonb,
  extractor_version text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.topic_scores (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.topics(id) on delete cascade,
  notice_id uuid not null references public.notices(id) on delete cascade,
  analysis jsonb not null,
  score integer not null check (score between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (topic_id, notice_id)
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  notice_id uuid not null references public.notices(id) on delete cascade,
  title text not null,
  message text not null,
  score integer not null,
  event_key text not null,
  read boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, event_key)
);

create table if not exists public.user_bid_states (
  user_id uuid not null references auth.users(id) on delete cascade,
  notice_id uuid not null references public.notices(id) on delete cascade,
  review_state text not null default '검토 전',
  memo text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, notice_id)
);

create table if not exists public.batch_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default '실행 중',
  discovered integer not null default 0,
  changed integer not null default 0,
  analyzed integer not null default 0,
  notified integer not null default 0,
  api_calls integer not null default 0,
  error_summary text
);

create table if not exists public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  attachment_id uuid not null references public.attachments(id) on delete cascade,
  status text not null default '대기' check (status in ('대기', '처리 중', '완료', '실패', '보류')),
  attempts integer not null default 0,
  run_after timestamptz not null default now(),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (attachment_id)
);

create index if not exists notices_closes_at_idx on public.notices (closes_at);
create index if not exists topic_scores_topic_score_idx on public.topic_scores (topic_id, score desc);
create index if not exists processing_jobs_pending_idx on public.processing_jobs (status, run_after);

alter table public.topics enable row level security;
alter table public.notices enable row level security;
alter table public.notice_versions enable row level security;
alter table public.attachments enable row level security;
alter table public.attachment_texts enable row level security;
alter table public.topic_scores enable row level security;
alter table public.notifications enable row level security;
alter table public.user_bid_states enable row level security;
alter table public.batch_runs enable row level security;
alter table public.processing_jobs enable row level security;

create policy "topic owner manages topics" on public.topics for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "authenticated users read notices" on public.notices for select to authenticated using (true);
create policy "authenticated users read versions" on public.notice_versions for select to authenticated using (true);
create policy "authenticated users read attachments" on public.attachments for select to authenticated using (true);
create policy "authenticated users read attachment texts" on public.attachment_texts for select to authenticated using (true);
create policy "topic owner reads scores" on public.topic_scores for select using (exists (select 1 from public.topics t where t.id = topic_id and t.user_id = auth.uid()));
create policy "notification owner manages notifications" on public.notifications for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "state owner manages state" on public.user_bid_states for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "authenticated users read runs" on public.batch_runs for select to authenticated using (true);
create policy "authenticated users read jobs" on public.processing_jobs for select to authenticated using (true);

insert into storage.buckets (id, name, public) values ('bid-documents', 'bid-documents', false) on conflict (id) do nothing;
create policy "authenticated users read bid documents" on storage.objects for select to authenticated using (bucket_id = 'bid-documents');
