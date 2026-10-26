# PaddyNet online setup (Supabase), about 10 minutes

You only do this once. Supabase moves its buttons around now and then, so if a name below
looks slightly different on your screen, pick the closest one (or send me a screenshot).

## 1. Create the account and project
1. Go to https://supabase.com and click **Start your project**. Sign in with GitHub or Google.
2. Click **New project**.
   - Name: `paddynet`
   - Database password: click **Generate a password** and save it somewhere safe (you won't need to send it to me).
   - Region: **Southeast Asia (Singapore)** (closest to Malaysia, so it's faster).
   - Plan: **Free**.
3. Click **Create new project** and wait 1 to 2 minutes until it's ready.

## 2. Create the database tables
1. In the left menu, open **SQL Editor**, then click **New query**.
2. Open `supabase/01_schema.sql` (attached in the thread), copy everything, paste it in, and click **Run**.
3. You should see "Success. No rows returned". (I already tested this script on a local PostgreSQL.)
4. Do the same with `supabase/02_upload_function.sql` (the safe way the app sends scans).

## 3. Create your admin login (for the dashboard)
1. Left menu: **Authentication > Users > Add user > Create new user**.
2. Enter your email and a password. Tick **Auto Confirm User**. Click **Create user**.
3. Back in **SQL Editor > New query**, run this (put your own email):
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'your-email@example.com';
   ```
4. Stop strangers from signing up: **Authentication > Sign In / Providers**, turn **off**
   "Allow new users to sign up", then **Save**.

## 4. Send me two things
Click the **Connect** button at the top (or open **Project Settings > API Keys** and **Data API**) and copy:
- **Project URL**, which looks like `https://abcdefgh.supabase.co`
- **Publishable key** (starts with `sb_publishable_`), or if your page only shows the older kind, the **anon public** key (a long text starting with `eyJ`).

These two are meant to be public (they go inside the app), so it's fine to paste them in the thread.

**Do NOT send:** your database password, the **secret** key (`sb_secret_...`), or the **service_role** key.

## Good to know
- The free project goes to sleep if nobody uses it for 7 days. If that happens, open the
  Supabase dashboard and click **Restore project**. Open it a day before your demo or viva to be safe.
- The app can only *add* scan results. Nobody can read them without logging in as an admin.
