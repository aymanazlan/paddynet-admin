-- PaddyNet update (2026-10-29): model v2 (mnv4s-v2) replaces v1 in the app.
-- Retrained on PaddyDoctor + Sethy et al. + Leaf & Crop with zoom/colour/blur augmentation,
-- class weights and label smoothing. Test numbers are on the same PaddyDoctor test set as v1.
-- Run once after 01 to 05: SQL Editor > New query > paste all > Run. Safe to run again.

insert into public.model_versions
  (version, architecture, classes, input_size, val_accuracy, test_accuracy, tta_accuracy,
   file_size_mb, dataset, released_at, is_current, notes, test_images, confusion_matrix)
values
  ('mnv4s-v2', 'MobileNetV4 Small (timm), TFLite via litert-torch',
   array['Bacterial Leaf Blight','Blast','Brown Spot','Normal'], '224 x 224 RGB',
   0.9604, 0.9582, null, 9.6,
   'PaddyDoctor + Sethy et al. + Rice Leaf & Crop (raw), 12,910 images', '2026-10-29', true,
   '35 epochs. Outside photos (200, never trained on, with TTA): 50.5% (v1: 20.0%). App says "Not sure, retake" below 70% confidence.',
   1004, '[[92,2,3,1],[3,338,6,7],[1,8,176,5],[6,0,0,356]]')
on conflict (version) do update set
  val_accuracy = excluded.val_accuracy, test_accuracy = excluded.test_accuracy,
  dataset = excluded.dataset, notes = excluded.notes, is_current = true,
  test_images = excluded.test_images, confusion_matrix = excluded.confusion_matrix;

update public.model_versions set is_current = false where version <> 'mnv4s-v2';
