-- PaddyNet fix 1 (2026-10-26): the app sends scans through this function instead of writing
-- to the table directly. Direct inserts were refused by Row Level Security, because Supabase
-- gives the public key read rights on new tables, and then Postgres also checks read rules
-- on "insert, skip if already there". The function runs with the owner's rights, accepts
-- only scan rows, skips duplicates, and the table stays unreadable for the public key.
-- Run once: SQL Editor > New query > paste all > Run.

create or replace function public.submit_scans(scans jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  added integer;
begin
  if jsonb_typeof(scans) <> 'array' or jsonb_array_length(scans) > 100 then
    raise exception 'scans must be an array of at most 100 items';
  end if;

  insert into public.scans (id, device_id, label, confidence, probabilities, used_tta, inference_ms,
                            scanned_at, area, latitude, longitude, app_version, model_version)
  select r.id, r.device_id, r.label, r.confidence, r.probabilities, coalesce(r.used_tta, false),
         r.inference_ms, r.scanned_at, r.area, r.latitude, r.longitude, r.app_version, r.model_version
  from jsonb_to_recordset(scans) as r(
    id uuid, device_id uuid, label text, confidence real, probabilities real[], used_tta boolean,
    inference_ms integer, scanned_at timestamptz, area text, latitude double precision,
    longitude double precision, app_version text, model_version text)
  on conflict (id) do nothing;

  get diagnostics added = row_count;
  return added;
end;
$$;

revoke all on function public.submit_scans(jsonb) from public;
grant execute on function public.submit_scans(jsonb) to anon, authenticated;

-- The public key no longer needs (or gets) direct access to the table
revoke all on public.scans from anon;
drop policy if exists "app can add scans" on public.scans;
