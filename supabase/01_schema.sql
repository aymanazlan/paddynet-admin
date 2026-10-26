-- PaddyNet online database (Supabase / PostgreSQL)
-- Run once in Supabase: SQL Editor > New query > paste all > Run.
-- Safe to run again: it only creates what is missing.

-- 1. Shared scan results sent by the app (only when the farmer opts in)
create table if not exists public.scans (
  id             uuid primary key,              -- made on the phone, so a retry never creates a duplicate
  device_id      uuid not null,                 -- random id per install, not linked to a person
  label          text not null check (label in ('Bacterial Leaf Blight','Blast','Brown Spot','Normal')),
  confidence     real not null check (confidence between 0 and 1),
  probabilities  real[] not null check (cardinality(probabilities) = 4),
  used_tta       boolean not null default false,
  inference_ms   integer check (inference_ms between 0 and 600000),
  scanned_at     timestamptz not null,
  received_at    timestamptz not null default now(),
  area           text check (char_length(area) <= 80),
  latitude       double precision check (latitude between -90 and 90),
  longitude      double precision check (longitude between -180 and 180),
  app_version    text check (char_length(app_version) <= 20),
  model_version  text check (char_length(model_version) <= 40)
);
create index if not exists scans_scanned_at_idx on public.scans (scanned_at desc);
create index if not exists scans_label_idx on public.scans (label);

-- 2. AI model versions shown on the dashboard
create table if not exists public.model_versions (
  version        text primary key,
  architecture   text not null,
  classes        text[] not null,
  input_size     text,
  val_accuracy   real,
  test_accuracy  real,
  tta_accuracy   real,
  file_size_mb   real,
  dataset        text,
  released_at    date,
  is_current     boolean not null default false,
  notes          text
);

insert into public.model_versions
  (version, architecture, classes, input_size, val_accuracy, test_accuracy, tta_accuracy,
   file_size_mb, dataset, released_at, is_current, notes)
values
  ('mnv4s-v1', 'MobileNetV4 Small (timm), TFLite via litert-torch',
   array['Bacterial Leaf Blight','Blast','Brown Spot','Normal'], '224 x 224 RGB',
   0.9649, 0.9492, 0.9562, 9.6,
   'PaddyDoctor, 6,661 images (70/15/15)', '2026-10-21', true,
   '15 epochs. TTA on phone: original, flip, brightness.')
on conflict (version) do nothing;

-- 3. Who may open the admin dashboard (add your own login after creating it)
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- 4. Row Level Security: the app can only ADD scans; only admins can READ
alter table public.scans          enable row level security;
alter table public.model_versions enable row level security;
alter table public.admins         enable row level security;

drop policy if exists "app can add scans" on public.scans;
create policy "app can add scans" on public.scans
  for insert to anon, authenticated with check (true);

drop policy if exists "admins read scans" on public.scans;
create policy "admins read scans" on public.scans
  for select to authenticated using (public.is_admin());

drop policy if exists "admins delete scans" on public.scans;
create policy "admins delete scans" on public.scans
  for delete to authenticated using (public.is_admin());

drop policy if exists "admins read models" on public.model_versions;
create policy "admins read models" on public.model_versions
  for select to authenticated using (public.is_admin());

drop policy if exists "admins manage models" on public.model_versions;
create policy "admins manage models" on public.model_versions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins see admins" on public.admins;
create policy "admins see admins" on public.admins
  for select to authenticated using (public.is_admin());

grant insert on public.scans to anon, authenticated;
grant select, delete on public.scans to authenticated;
grant select, insert, update, delete on public.model_versions to authenticated;
grant select on public.admins to authenticated;
grant execute on function public.is_admin() to authenticated;

-- 5. Outbreak alerts: 3+ scans of the same disease within 1 km in the last 14 days
--    (same rule the app uses on the phone, but across all shared scans)
create or replace function public.outbreak_alerts(
  min_scans int default 3, radius_km double precision default 1.0, window_days int default 14)
returns table (label text, center_lat double precision, center_lng double precision,
               scan_count bigint, area text, first_seen timestamptz, last_seen timestamptz)
language sql stable security invoker set search_path = public as $$
  with recent as (
    select * from scans
    where label <> 'Normal' and latitude is not null and longitude is not null
      and scanned_at >= now() - make_interval(days => window_days)
  ),
  clusters as (
    select c.id, c.label, c.latitude as center_lat, c.longitude as center_lng,
           count(*) as scan_count,
           mode() within group (order by o.area) as area,
           min(o.scanned_at) as first_seen, max(o.scanned_at) as last_seen
    from recent c
    join recent o on o.label = c.label
      and 2 * 6371 * asin(sqrt(
            power(sin(radians(o.latitude - c.latitude) / 2), 2) +
            cos(radians(c.latitude)) * cos(radians(o.latitude)) *
            power(sin(radians(o.longitude - c.longitude) / 2), 2))) <= radius_km
    group by c.id, c.label, c.latitude, c.longitude
    having count(*) >= min_scans
  ),
  ranked as (   -- keep the biggest cluster per disease and roughly per 2 km grid cell
    select *, row_number() over (
      partition by label, round(center_lat::numeric * 50), round(center_lng::numeric * 50)
      order by scan_count desc, last_seen desc) as rn
    from clusters
  )
  select label, center_lat, center_lng, scan_count, area, first_seen, last_seen
  from ranked where rn = 1
  order by scan_count desc, last_seen desc;
$$;
grant execute on function public.outbreak_alerts(int, double precision, int) to authenticated;
