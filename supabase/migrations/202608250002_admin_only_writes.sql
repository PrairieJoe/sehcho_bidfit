-- The web app uses server-side service-role access. Browser clients remain read-only.
alter table public.allowed_users enable row level security;

drop policy if exists "topic owner manages topics" on public.topics;
drop policy if exists "notification owner manages notifications" on public.notifications;
drop policy if exists "state owner manages state" on public.user_bid_states;

create policy "authenticated users read topics" on public.topics for select to authenticated using (true);
create policy "notification owner reads notifications" on public.notifications for select to authenticated using (auth.uid() = user_id);
create policy "state owner reads state" on public.user_bid_states for select to authenticated using (auth.uid() = user_id);

-- No INSERT, UPDATE, or DELETE policy is intentionally granted to browser users.
-- Administrator mutations are authenticated by the Next.js server and service role.
