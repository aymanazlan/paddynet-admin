-- PaddyNet update 2 (2026-10-26): store the test-set confusion matrices with each model version,
-- so the dashboard can show them and work out precision, recall and F1 per disease.
-- Rows = true class, columns = predicted class, order: BLB, Blast, Brown Spot, Normal.
-- Run once: SQL Editor > New query > paste all > Run.

alter table public.model_versions
  add column if not exists test_images integer,
  add column if not exists confusion_matrix jsonb,
  add column if not exists confusion_matrix_tta jsonb;

update public.model_versions set
  test_images = 1004,
  confusion_matrix     = '[[92,0,3,3],[10,328,14,2],[2,7,177,4],[0,4,2,356]]',
  confusion_matrix_tta = '[[90,1,3,4],[6,332,13,3],[2,4,180,4],[0,2,2,358]]'
where version = 'mnv4s-v1';
