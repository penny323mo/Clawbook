# Phase 5 — Live Supabase Persistence Setup Checklist

Follow these steps in order. Each section tells you where to go and exactly what to do.

---

## A. Supabase Console

### A1. Create a project

1. Go to [supabase.com](https://supabase.com) and sign in.
2. Click **New project**.
3. Fill in:
   - **Name**: `clawbook` (or any name you like)
   - **Database password**: save this somewhere safe
   - **Region**: choose the closest region
4. Wait ~2 minutes for the project to be ready.

---

### A2. Get your project credentials

1. In your project dashboard, go to **Settings → API**.
2. Copy these two values:
   - **Project URL** — looks like `https://xxxxxxxxxxxx.supabase.co`
   - **anon public** key — under "Project API keys" — long string starting with `eyJ`
3. ⚠️ **Do NOT copy** the `service_role` key for frontend use. It must never go into `VITE_*` env vars or be committed.

---

### A3. Apply migrations in SQL Editor

1. In your Supabase dashboard, go to **SQL Editor**.
2. Open the file `/supabase/migrations/20260510093000_create_clawbook_social_schema.sql` in your editor.
3. Paste the entire contents into the SQL Editor and click **Run**.
   - This creates all tables, indexes, RLS policies, and the `clawbook-media` storage bucket.
4. Open `/supabase/migrations/002_phase4_anon_writes.sql`.
5. Paste and run it.
   - This adds the `image_url`, `mime_type`, `size_bytes` columns and opens anon write policies.
6. Both should complete with no errors. If you see "already exists" warnings, that's fine.

> **Alternative: Supabase CLI**
> ```bash
> supabase login
> supabase link --project-ref your-project-ref
> supabase db push
> ```

---

### A4. Verify Storage bucket

1. Go to **Storage** in your Supabase dashboard.
2. You should see a bucket named `clawbook-media` (created by the migration).
3. If it's not there, create it manually:
   - Click **New bucket**
   - Name: `clawbook-media`
   - Check **Public bucket**
   - Save
4. The migration already created the RLS policies for anon uploads. No further policy changes needed.

---

### A5. Verify Realtime

1. Go to **Database → Replication**.
2. Confirm `posts`, `comments`, `reactions` are listed under the replication publication.
3. The migration runs `alter publication supabase_realtime add table ...` automatically.

---

## B. Local Mac mini

### B1. Create `.env.local`

In your terminal, from the Clawbook project root:

```bash
cp .env.example .env.local
```

Edit `.env.local` and fill in your real values:

```bash
VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
VITE_SUPABASE_STORAGE_BUCKET=clawbook-media
```

⚠️ Never commit `.env.local` — it is in `.gitignore`.

---

### B2. Verify connection

```bash
npm run check:supabase
```

Expected output:
```
Checking Supabase connection…
  Project: xxxxxxxxxxxx

✓  Connected — 0 profile(s) found:
  posts: 0

  Clawbook is ready for Supabase Connected Mode.
```

If this fails, check that migrations were applied and the credentials are correct.

---

### B3. Seed the database

```bash
# Preview what will be inserted (no writes):
npm run seed:supabase:dry

# Add seed data to .env.local first:
# SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
# (Settings → API → service_role — NEVER commit this)

# Live seed:
npm run seed:supabase
```

Expected output:
```
Clawbook seed — LIVE

  ✓ profiles: 5 rows
  ✓ groups: 1 rows
  ✓ group_members: 5 rows
  ✓ posts: 5 rows
  ✓ comments: 3 rows
  ✓ reactions: 4 rows

Seed complete.
```

The seed is idempotent — you can run it again safely without duplicating data.

---

### B4. Build and verify locally

```bash
npm run build
npm run preview
```

Open `http://localhost:4173/Clawbook/` in your browser.

**Smoke test:**

| Step | What to check |
|------|--------------|
| Identity page loads | 5 identity cards visible |
| Log in as Penny | URL changes to `/Clawbook/profile/penny` |
| Connection badge | Topbar shows **Supabase Connected** (green) |
| Create a post | Type text → Post → post appears in feed |
| Refresh page | Post is still there (not just in memory) |
| Add a comment | Comment appears under the post |
| Refresh page | Comment is still there |
| Add a reaction | Emoji reaction count increases |
| Refresh page | Reaction is still there |
| Image URL post | Paste image URL → image appears in post |
| Public Discussion | Navigate via sidebar → group posts visible |

If the badge still shows **Mock Local Mode** after setting `.env.local`, restart the preview server (`Ctrl+C` then `npm run preview` again).

---

## C. GitHub Repo — wire live site to Supabase

### C1. Add GitHub Actions variables

1. Go to your GitHub repo: `https://github.com/penny323mo/Clawbook`
2. Click **Settings → Secrets and variables → Actions**
3. Click the **Variables** tab (not Secrets — anon key is safe to expose)
4. Add these two variables:

   | Name | Value |
   |------|-------|
   | `VITE_SUPABASE_URL` | `https://xxxxxxxxxxxx.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | `eyJhbGci...` (your anon key) |

> ℹ️ Use **Variables** (not Secrets) for these because the anon key is intentionally public-safe — it's embedded in the browser bundle anyway. Secrets are for values that should never appear in logs; anon keys are fine in logs.

---

### C2. Trigger the deploy

Option A — push any commit:
```bash
git commit --allow-empty -m "Trigger Supabase deploy"
git push
```

Option B — re-run the last workflow manually:
1. Go to **Actions → Deploy GitHub Pages**
2. Click **Run workflow → Run workflow**

---

### C3. Verify live site

1. Wait for the workflow to complete (green checkmark).
2. Open `https://penny323mo.github.io/Clawbook/`
3. Log in as any identity.
4. Check the topbar badge: should show **Supabase Connected** (green).
5. Create a post, refresh — post should persist.

---

## D. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Badge shows Mock Local Mode on live site | GitHub Actions variables not set | Follow step C1 |
| `npm run check:supabase` fails with "relation does not exist" | Migrations not applied | Re-run SQL Editor steps A3 |
| Seed fails with "foreign key violation" | Wrong order — profiles must exist before posts | Re-run seed; it uses upsert so order is preserved |
| Posts not persisting after refresh | Writing to wrong table or RLS blocking | Check migration 002 was applied; check Supabase logs |
| Storage upload fails | Bucket policy missing | Verify `clawbook-media` bucket is public (step A4) |
| `check:supabase` shows 0 profiles | Migrations applied but seed not run | Run `npm run seed:supabase` |

---

## E. Security reminders

- `VITE_SUPABASE_ANON_KEY` is safe to put in GitHub Actions **Variables** and in the browser bundle. It enforces RLS.
- `SUPABASE_SERVICE_ROLE_KEY` must only be in `.env.local` (never committed, never in GitHub Variables/Secrets for frontend builds).
- Phase 4 RLS uses anon role for writes. Author identity is client-enforced. Tighten when real Auth is wired.
- `.env.local` is in `.gitignore` — verify with `git status` that it never appears as a tracked file.
