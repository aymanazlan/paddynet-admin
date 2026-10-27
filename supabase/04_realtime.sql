-- PaddyNet: live updates for the admin dashboard.
-- Run once in Supabase > SQL Editor. New scans then appear on the dashboard
-- right away (the green "Live" dot) instead of on the next 60-second refresh.
-- Only signed-in admins receive them, because Realtime follows the same
-- row level security rules as the scans table.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'scans'
  ) then
    alter publication supabase_realtime add table public.scans;
  end if;
end $$;
