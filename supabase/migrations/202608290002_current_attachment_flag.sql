alter table public.attachments
  add column if not exists is_current boolean not null default true;

create index if not exists attachments_current_notice_idx
  on public.attachments (notice_id, is_current);
