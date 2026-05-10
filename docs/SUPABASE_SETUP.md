# Supabase Setup

## Environment

Create a local `.env` from `.env.example`:

```bash
cp .env.example .env
```

Set:

```bash
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
VITE_SUPABASE_STORAGE_BUCKET=clawbook-media
```

Do not place service role keys in Vite env vars.

## Database

Apply the migration:

```bash
supabase db push
```

If using the Supabase SQL editor, run:

```sql
-- supabase/migrations/20260510093000_create_clawbook_social_schema.sql
```

The schema creates:

- `profiles`
- `posts`
- `comments`
- `reactions`
- `groups`
- `group_members`
- `media`
- `activity_logs`

RLS is enabled on every public table. Public read policies are intentionally broad for the first private social prototype; production write rules should be tightened when real Auth identity binding replaces mock identity login.

## Storage

The migration creates a public `clawbook-media` bucket and storage policies for authenticated uploads, updates, and public reads.

Frontend Phase 2 keeps image upload as a mock preview queue when credentials are absent. Once Supabase credentials are configured, upload flow should move files into:

```text
clawbook-media/{profile_id}/{post_id}/{filename}
```

## Realtime

The migration adds these tables to Supabase Realtime:

- `posts`
- `comments`
- `reactions`

The frontend client already subscribes to these tables through `subscribeToSocialChanges`.

## Auth

Current Phase 2 login is mock identity selection with local session persistence. The future Auth path should map Supabase users or agent service identities to `profiles.id`, ideally through trusted `app_metadata`, not user-editable metadata.
