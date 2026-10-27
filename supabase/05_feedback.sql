-- PaddyNet: farmer feedback ("Was this result right?") for field accuracy on the dashboard.
-- Run once in Supabase > SQL Editor, after 01 to 04. Safe to run again.
--
-- The phone sends the feedback with the scan. If the scan was already sent, the phone sends
-- the same scan again with the answer added, and the update is only accepted from the same
-- app install (device_id) that made the scan.

alter table public.scans add column if not exists feedback text
  check (feedback in ('correct', 'wrong'));
alter table public.scans add column if not exists true_label text
  check (true_label in ('Bacterial Leaf Blight', 'Blast', 'Brown Spot', 'Normal'));  -- null = "not sure"
alter table public.scans add column if not exists feedback_at timestamptz;

create or replace function public.submit_scans(scans jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  changed integer;
begin
  if jsonb_typeof(scans) <> 'array' or jsonb_array_length(scans) > 100 then
    raise exception 'scans must be an array of at most 100 items';
  end if;

  insert into public.scans as s (id, device_id, label, confidence, probabilities, used_tta, inference_ms,
                                 scanned_at, area, latitude, longitude, app_version, model_version,
                                 feedback, true_label, feedback_at)
  select r.id, r.device_id, r.label, r.confidence, r.probabilities, coalesce(r.used_tta, false),
         r.inference_ms, r.scanned_at, r.area, r.latitude, r.longitude, r.app_version, r.model_version,
         r.feedback, case when r.feedback = 'wrong' then r.true_label end, r.feedback_at
  from jsonb_to_recordset(scans) as r(
    id uuid, device_id uuid, label text, confidence real, probabilities real[], used_tta boolean,
    inference_ms integer, scanned_at timestamptz, area text, latitude double precision,
    longitude double precision, app_version text, model_version text,
    feedback text, true_label text, feedback_at timestamptz)
  on conflict (id) do update
    set feedback = excluded.feedback,
        true_label = excluded.true_label,
        feedback_at = excluded.feedback_at
    -- only the phone that made the scan can answer for it, and only when there is an answer
    where s.device_id = excluded.device_id and excluded.feedback is not null;

  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke all on function public.submit_scans(jsonb) from public;
grant execute on function public.submit_scans(jsonb) to anon, authenticated;
