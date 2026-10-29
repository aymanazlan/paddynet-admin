# PaddyNet Admin (online sync + dashboard)

```
paddynet-admin/
  SETUP-SUPABASE.md      one-time online setup (you do this)
  supabase/01_schema.sql database tables, security rules, outbreak alert check
  supabase/02_upload_function.sql  submit_scans(): how the app adds scans (run after 01)
  supabase/03_confusion_matrix.sql test-set confusion matrices for the Model page (run after 02)
  supabase/04_realtime.sql         live updates: new scans show up on the dashboard right away
  supabase/05_feedback.sql         farmer answers to "Was this result right?" (field accuracy)
  supabase/06_model_v2.sql         model v2 (mnv4s-v2) row, made the current model
  dashboard/             the admin website (plain HTML, CSS, JavaScript)
    index.html
    css/style.css
    js/config.js         <- put your Supabase URL and key here
    js/i18n.js           English and Bahasa Melayu text
    js/app.js
    assets/logo.svg
    assets/login-bg.mp4 / .jpg        login background video and its first frame
    assets/confusion_matrix*.png      original Colab figures (shown only if the database has no matrix)
```

## Open the dashboard on your laptop
1. Put your Supabase URL and publishable key in `dashboard/js/config.js`.
2. Double-click `dashboard/index.html` to open it in Chrome or Edge, then sign in with your admin email.

It needs internet (it loads the charts, map and data online).

## Pages
- **Overview**: number of scans, share with disease, phones sharing, areas, alerts, latest scans.
- **Trends**: scans per day or week by disease, and the areas with the most disease.
- **Map**: every shared scan that has a location, coloured by disease, plus alert circles.
- **Alerts**: possible outbreaks (3+ scans of one disease within 1 km in 14 days; you can change the numbers).
- **Scans**: full list with filters, CSV download, and delete (for test scans).
- **Model & System**: model version and accuracy, confusion matrix with/without TTA plus precision, recall and F1 per disease, confidence and speed in the field,
  app versions in use, database status.

The period selector at the top (7 days to all time) changes every page.

## Privacy and security (good points for Chapter 4)
- Sharing is off by default. The farmer agrees in Profile after reading what is sent.
- No photos or names are sent. Location is only sent if the farmer also turned on location, and it is rounded to about 100 m.
- The key inside the app cannot touch the table at all. It can only call `submit_scans`, which adds scan rows and nothing else (Row Level Security + a security-definer function). Only accounts in the `admins` table can read them.
- Each scan has its own id made on the phone, so a retried upload never creates a duplicate.
