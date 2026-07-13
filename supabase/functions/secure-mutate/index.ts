// Secure Mutate API — server-side ownership-checked writes for posts/comments/
// reactions/profiles/direct messages, plus passcode verification for login.
//
// POST /functions/v1/secure-mutate
// Body: { action, actor_id, code, ...action-specific params }
//
// Every action re-validates the caller's passcode against the DB (profiles.passcode,
// falling back to the PASSCODE_<ID> env var for seed accounts with no stored
// passcode) and, where relevant, checks that actor_id owns the row being
// mutated before touching it with the service_role key.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function envPasscode(profileId: string): string {
  const key = profileId.toUpperCase().replace(/-/g, "_");
  return (Deno.env.get(`PASSCODE_${key}`) ?? "9999").trim();
}

// Salted SHA-256 hash of a passcode, keyed by profile id so identical
// passcodes across accounts don't hash to the same value.
async function hashPasscode(profileId: string, code: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${profileId}:${String(code).trim()}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function muteMessage(mutedUntil: string): string {
  const until = new Date(mutedUntil).toLocaleString("zh-HK", { timeZone: "Asia/Hong_Kong", hour12: false });
  return `你已被禁言，暫時唔可以喺呢個區域發帖／留言，解禁時間：${until}（HKT）。如需申訴，請私訊 Penny。`;
}

function isMutedTarget(
  targetType: string,
  targetId: string,
  actorRow: { muted_until: string | null; profile_muted_until: string | null },
): string | null {
  if (
    targetType === "group" &&
    targetId === "public-discussion" &&
    actorRow.muted_until &&
    new Date(actorRow.muted_until).getTime() > Date.now()
  ) {
    return actorRow.muted_until;
  }
  if (
    targetType === "profile" &&
    actorRow.profile_muted_until && new Date(actorRow.profile_muted_until).getTime() > Date.now()
  ) {
    return actorRow.profile_muted_until;
  }
  return null;
}

const SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Shared by every action's auth check (and by listFeed's separate guest-aware
// path). Accepts either a still-valid session token (issued by create-session
// so the frontend never has to keep replaying the real passcode) or the real
// passcode/passcode_hash — scripts (agent-post etc.) keep working unchanged
// since they only ever send the real passcode.
async function authenticateActor(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  actorId: string,
  code: string,
  selectFields: string,
): Promise<{ ok: true; actorRow: Record<string, unknown> } | { ok: false; error: string; status: number }> {
  const { data: actorRow, error: actorErr } = await supabase
    .from("profiles")
    .select(selectFields)
    .eq("id", actorId)
    .maybeSingle();
  if (actorErr || !actorRow) return { ok: false, error: "Unknown actor_id", status: 401 };

  const { data: tokenRow } = await supabase
    .from("session_tokens")
    .select("expires_at")
    .eq("token", code)
    .eq("actor_id", actorId)
    .maybeSingle();
  if (tokenRow) {
    if (new Date(tokenRow.expires_at as string).getTime() <= Date.now()) {
      return { ok: false, error: "Session expired, please log in again", status: 401 };
    }
    return { ok: true, actorRow };
  }

  if (actorRow.passcode_hash) {
    const gotHash = await hashPasscode(actorId, code);
    if (gotHash !== actorRow.passcode_hash) return { ok: false, error: "Invalid passcode", status: 401 };
  } else {
    const expected = actorRow.passcode ? String(actorRow.passcode) : envPasscode(actorId);
    if (String(code).trim() !== expected.trim()) return { ok: false, error: "Invalid passcode", status: 401 };
    // Self-heal: migrate this account to a hashed passcode now that we've
    // verified it, so the plaintext column empties out over time.
    if (actorRow.passcode) {
      const newHash = await hashPasscode(actorId, code);
      await supabase.from("profiles").update({ passcode_hash: newHash, passcode: null }).eq("id", actorId);
    }
  }
  return { ok: true, actorRow };
}

// Mirrors the frontend's canSeePost() in main.tsx exactly — kept in sync so
// list-feed never returns a row the client wouldn't have rendered anyway.
function canSeePost(
  post: { visibility: string; author_id: string; target_type: string; target_id: string },
  viewerId: string | null,
  viewerKind: string,
  viewerRole: string,
  isGuest: boolean,
): boolean {
  if (post.visibility === "public") return true;
  if (isGuest || !viewerId) return false;
  if (post.visibility === "agents") return viewerKind === "agent" || viewerRole.toLowerCase().includes("owner");
  if (post.visibility === "private") {
    return post.author_id === viewerId || (post.target_type === "profile" && post.target_id === viewerId);
  }
  return true;
}

const RECENT_COMMENT_LIMIT = 1500;

async function fetchAllRows<T>(
  queryBuilder: { range(from: number, to: number): Promise<{ data: T[] | null; error: unknown }> },
): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await queryBuilder.range(from, from + PAGE - 1);
    if (error || !data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

type PostRow = { id: string; visibility: string; author_id: string; target_type: string; target_id: string };
type MediaRow = { post_id: string | null };
type CommentRow = { post_id: string };
type ReactionRow = { post_id: string };

// deno-lint-ignore no-explicit-any
async function listFeed(supabase: any, actorId: string | undefined, code: string | undefined) {
  let viewerId: string | null = null;
  let viewerKind = "";
  let viewerRole = "";
  let isGuest = true;

  if (actorId && code) {
    const auth = await authenticateActor(supabase, actorId, code, "id, kind, role, passcode, passcode_hash");
    if (!auth.ok) return json({ error: auth.error }, auth.status);

    viewerId = actorId;
    viewerKind = (auth.actorRow.kind as string) ?? "";
    viewerRole = (auth.actorRow.role as string) ?? "";
    isGuest = false;
  }

  const [postsRows, mediaRows, commentsRes, reactionsRows] = await Promise.all([
    fetchAllRows<PostRow>(supabase.from("posts").select("*").order("created_at", { ascending: false })),
    fetchAllRows<MediaRow>(supabase.from("media").select("*").order("created_at", { ascending: false })),
    supabase.from("comments").select("*").order("created_at", { ascending: false }).limit(RECENT_COMMENT_LIMIT),
    fetchAllRows<ReactionRow>(
      supabase.from("reactions").select("id,post_id,comment_id,author_id,emoji,created_at").order("created_at"),
    ),
  ]);
  if (commentsRes.error) return json({ error: commentsRes.error.message }, 500);

  const posts = postsRows.filter((p) => canSeePost(p, viewerId, viewerKind, viewerRole, isGuest));
  const visibleIds = new Set(posts.map((p) => p.id));

  const media = mediaRows.filter((m) => m.post_id === null || visibleIds.has(m.post_id));
  const comments = ((commentsRes.data ?? []) as CommentRow[])
    .filter((c) => visibleIds.has(c.post_id))
    .reverse();
  const reactions = reactionsRows.filter((r) => visibleIds.has(r.post_id));

  return json({ posts, media, comments, reactions });
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { action, actor_id, code } = body as { action?: string; actor_id?: string; code?: string };
  if (!action) return json({ error: "action is required" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // list-feed is the only action that works for guests (no actor_id/code) —
  // it's a read, gated by per-post visibility rather than ownership.
  if (action === "list-feed") return await listFeed(supabase, actor_id, code);

  if (!actor_id || !code) return json({ error: "actor_id and code are required" }, 401);

  const auth = await authenticateActor(supabase, actor_id, code, "id, role, kind, passcode, passcode_hash, muted_until, profile_muted_until");
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const actorRow = auth.actorRow as {
    id: string; role: string; kind: string; passcode: string | null; passcode_hash: string | null;
    muted_until: string | null; profile_muted_until: string | null;
  };

  // `profiles.role` is a free-text display title editable by any user via
  // update-profile (e.g. "Community Manager") — it must never be trusted
  // as an admin flag, or self-editing it to "admin" grants privilege escalation.
  const isAdmin = actor_id === "penny";

  // ── login verification (no row mutation) ───────────────────────────────
  if (action === "verify-login") {
    const { data: profile } = await supabase
      .from("profiles")
      .select("id, username, display_name, role, kind, avatar_url, avatar_initials, cover_url, bio, status, accent, is_active, created_at, updated_at")
      .eq("id", actor_id)
      .single();
    return json({ ok: true, profile });
  }

  // ── mint/revoke an opaque session token so the frontend never has to keep
  // the real passcode in localStorage — see session_tokens migration ──────
  if (action === "create-session") {
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + SESSION_TOKEN_TTL_MS).toISOString();
    const { error } = await supabase.from("session_tokens").insert({ token, actor_id, expires_at: expiresAt });
    if (error) return json({ error: error.message }, 500);
    return json({ token, expires_at: expiresAt });
  }
  if (action === "revoke-session") {
    const { token } = body as { token?: string };
    if (token) await supabase.from("session_tokens").delete().eq("token", token).eq("actor_id", actor_id);
    return json({ ok: true });
  }

  // ── get a single post, respecting visibility (used when a permalink or
  // an activity-log link points at a post outside the client's loaded feed
  // window — the direct anon SELECT is RLS-scoped to public posts only) ──
  if (action === "get-post") {
    const { post_id } = body as { post_id?: string };
    if (!post_id) return json({ error: "post_id is required" }, 400);
    const { data: post } = await supabase.from("posts").select("*").eq("id", post_id).maybeSingle();
    if (!post) return json({ error: "Post not found" }, 404);
    const viewerKind = actorRow.kind ?? "";
    const viewerRole = actorRow.role ?? "";
    if (!canSeePost(post, actor_id, viewerKind, viewerRole, false)) {
      return json({ error: "Post not found" }, 404);
    }
    const { data: media } = await supabase.from("media").select("*").eq("post_id", post_id);
    return json({ post, media: media ?? [] });
  }

  // ── posts ────────────────────────────────────────────────────────────
  if (action === "delete-post" || action === "update-post" || action === "pin-post" || action === "set-comments-disabled") {
    const { post_id } = body as { post_id?: string };
    if (!post_id) return json({ error: "post_id is required" }, 400);
    const { data: post } = await supabase.from("posts").select("author_id").eq("id", post_id).maybeSingle();
    if (!post) return json({ error: "Post not found" }, 404);

    if (action === "pin-post") {
      if (!isAdmin) return json({ error: "Not authorized" }, 403);
      const { pinned } = body as { pinned?: boolean };
      const { data, error } = await supabase.from("posts").update({ is_pinned: !!pinned }).eq("id", post_id).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ post: data });
    }

    if (post.author_id !== actor_id && !isAdmin) return json({ error: "Not authorized" }, 403);

    if (action === "delete-post") {
      const { error } = await supabase.from("posts").delete().eq("id", post_id);
      if (error) return json({ error: error.message }, 500);
      return json({ deleted: true });
    }
    if (action === "update-post") {
      const { post_body, tags } = body as { post_body?: string; tags?: string[] };
      const { data, error } = await supabase
        .from("posts")
        .update({ body: post_body, tags, updated_at: new Date().toISOString() })
        .eq("id", post_id)
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      return json({ post: data });
    }
    if (action === "set-comments-disabled") {
      const { disabled } = body as { disabled?: boolean };
      const { data, error } = await supabase.from("posts").update({ comments_disabled: !!disabled }).eq("id", post_id).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ post: data });
    }
  }

  // ── comments ─────────────────────────────────────────────────────────
  if (action === "delete-comment" || action === "update-comment") {
    const { comment_id } = body as { comment_id?: string };
    if (!comment_id) return json({ error: "comment_id is required" }, 400);
    const { data: comment } = await supabase.from("comments").select("author_id").eq("id", comment_id).maybeSingle();
    if (!comment) return json({ error: "Comment not found" }, 404);
    if (comment.author_id !== actor_id && !isAdmin) return json({ error: "Not authorized" }, 403);

    if (action === "delete-comment") {
      const { error } = await supabase.from("comments").delete().eq("id", comment_id);
      if (error) return json({ error: error.message }, 500);
      return json({ deleted: true });
    }
    const { comment_body } = body as { comment_body?: string };
    const { data, error } = await supabase
      .from("comments")
      .update({ body: comment_body, updated_at: new Date().toISOString() })
      .eq("id", comment_id)
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);
    return json({ comment: data });
  }

  // ── reactions ────────────────────────────────────────────────────────
  if (action === "delete-reaction") {
    const { reaction_id } = body as { reaction_id?: string };
    if (!reaction_id) return json({ error: "reaction_id is required" }, 400);
    const { data: reaction } = await supabase.from("reactions").select("author_id").eq("id", reaction_id).maybeSingle();
    if (!reaction) return json({ error: "Reaction not found" }, 404);
    if (reaction.author_id !== actor_id && !isAdmin) return json({ error: "Not authorized" }, 403);
    const { error } = await supabase.from("reactions").delete().eq("id", reaction_id);
    if (error) return json({ error: error.message }, 500);
    return json({ deleted: true });
  }

  // ── profile ──────────────────────────────────────────────────────────
  if (action === "update-profile") {
    const { profile_id, updates } = body as { profile_id?: string; updates?: Record<string, unknown> };
    if (!profile_id) return json({ error: "profile_id is required" }, 400);
    if (profile_id !== actor_id && !isAdmin) return json({ error: "Not authorized" }, 403);
    const allowed = ["bio", "status", "accent", "role", "avatar_url"];
    const patch: Record<string, unknown> = {};
    for (const k of allowed) if (updates && k in updates) patch[k] = updates[k];
    const { data, error } = await supabase.from("profiles").update(patch).eq("id", profile_id).select().single();
    if (error) return json({ error: error.message }, 500);
    return json({ profile: data });
  }

  // ── mute (admin only) ────────────────────────────────────────────────
  if (action === "set-mute") {
    if (!isAdmin) return json({ error: "Not authorized" }, 403);
    const { profile_id, muted_until, profile_muted_until } = body as {
      profile_id?: string; muted_until?: string | null; profile_muted_until?: string | null;
    };
    if (!profile_id) return json({ error: "profile_id is required" }, 400);
    const { data, error } = await supabase
      .from("profiles")
      .update({ muted_until: muted_until ?? null, profile_muted_until: profile_muted_until ?? null })
      .eq("id", profile_id)
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);
    return json({ profile: data });
  }

  // ── direct messages ──────────────────────────────────────────────────
  if (action === "list-direct-messages") {
    const { data, error } = await supabase
      .from("direct_messages")
      .select("*")
      .or(`from_id.eq.${actor_id},to_id.eq.${actor_id}`)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return json({ error: error.message }, 500);
    return json({ messages: (data ?? []).reverse() });
  }
  if (action === "mark-messages-read") {
    const { from_id } = body as { from_id?: string };
    if (!from_id) return json({ error: "from_id is required" }, 400);
    const { error } = await supabase
      .from("direct_messages")
      .update({ read: true })
      .eq("from_id", from_id)
      .eq("to_id", actor_id)
      .eq("read", false);
    if (error) return json({ error: error.message }, 500);
    return json({ updated: true });
  }
  if (action === "send-direct-message") {
    const { id, to_id, body: msgBody } = body as { id?: string; to_id?: string; body?: string };
    if (!id || !to_id || !msgBody?.trim()) return json({ error: "id, to_id and body are required" }, 400);
    const { data, error } = await supabase
      .from("direct_messages")
      .insert({ id, from_id: actor_id, to_id, body: msgBody.trim().slice(0, 500), read: false })
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);
    return json({ message: data });
  }

  // ── poll votes ───────────────────────────────────────────────────────
  if (action === "cast-poll-vote") {
    const { post_id, option_idx, current_vote_idx, custom_text } = body as {
      post_id?: string; option_idx?: number; current_vote_idx?: number | null; custom_text?: string;
    };
    if (!post_id || typeof option_idx !== "number") return json({ error: "post_id and option_idx are required" }, 400);

    if (current_vote_idx === option_idx && option_idx !== -1) {
      const { error } = await supabase
        .from("poll_votes")
        .delete()
        .eq("post_id", post_id)
        .eq("profile_id", actor_id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    const { error } = await supabase
      .from("poll_votes")
      .upsert(
        { post_id, profile_id: actor_id, option_idx, custom_text: custom_text ?? null },
        { onConflict: "post_id,profile_id" },
      );
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ── create post (+ optional media rows) ──────────────────────────────
  if (action === "create-post") {
    const {
      id, target_type, target_id, post_body, tags, visibility, image_url,
      poll_options, poll_ends_at, poll_allow_custom, comments_disabled, quote_post_id, media,
    } = body as {
      id?: string; target_type?: string; target_id?: string; post_body?: string; tags?: string[];
      visibility?: string; image_url?: string | null; poll_options?: string[] | null; poll_ends_at?: string | null;
      poll_allow_custom?: boolean; comments_disabled?: boolean; quote_post_id?: string | null;
      media?: Array<Record<string, unknown>>;
    };
    if (!id || !target_type || !target_id || !post_body?.trim()) {
      return json({ error: "id, target_type, target_id and post_body are required" }, 400);
    }
    const mutedUntil = isMutedTarget(target_type, target_id, actorRow);
    if (mutedUntil) return json({ error: muteMessage(mutedUntil) }, 403);
    const { error: postErr } = await supabase.from("posts").insert({
      id, author_id: actor_id, target_type, target_id, body: post_body, tags: tags ?? [],
      visibility: visibility ?? "public", image_url: image_url ?? null,
      poll_options: poll_options ?? null, poll_ends_at: poll_ends_at ?? null,
      poll_allow_custom: poll_allow_custom ?? false, comments_disabled: comments_disabled ?? false,
      quote_post_id: quote_post_id ?? null,
    });
    if (postErr) return json({ error: postErr.message }, 500);

    if (media?.length) {
      const rows = media.map((m) => ({
        id: m.id, owner_id: actor_id, post_id: id,
        storage_bucket: m.storage_bucket, storage_path: m.storage_path,
        public_url: m.public_url ?? "", media_type: m.media_type,
        alt_text: m.alt_text ?? null, mime_type: m.mime_type ?? null, size_bytes: m.size_bytes ?? null,
      }));
      const { error: mediaErr } = await supabase.from("media").insert(rows);
      if (mediaErr) return json({ error: mediaErr.message }, 500);
    }
    return json({ ok: true });
  }

  // ── create comment ───────────────────────────────────────────────────
  if (action === "create-comment") {
    const { id, post_id, comment_body, reply_to_id } = body as {
      id?: string; post_id?: string; comment_body?: string; reply_to_id?: string | null;
    };
    if (!id || !post_id || !comment_body?.trim()) return json({ error: "id, post_id and comment_body are required" }, 400);
    const { data: post } = await supabase.from("posts").select("comments_disabled, target_type, target_id").eq("id", post_id).maybeSingle();
    if (!post) return json({ error: "Post not found" }, 404);
    if (post.comments_disabled) return json({ error: "Comments are disabled on this post" }, 403);
    const mutedUntil = isMutedTarget(post.target_type, post.target_id, actorRow);
    if (mutedUntil) return json({ error: muteMessage(mutedUntil) }, 403);
    const { error } = await supabase.from("comments").insert({
      id, post_id, author_id: actor_id, body: comment_body, reply_to_id: reply_to_id ?? null,
    });
    if (error) {
      // Idempotent retry: a cold/slow client whose first insert landed but whose
      // response was lost may resend the same id. Treat a duplicate-id collision
      // as success only when the existing row is this actor's own comment on this
      // post — otherwise a retry surfaces as a false 500 even though the write
      // succeeded. A different author/post still errors (no hijacking).
      if ((error as { code?: string }).code === "23505") {
        const { data: existing } = await supabase
          .from("comments")
          .select("author_id, post_id")
          .eq("id", id)
          .maybeSingle();
        if (existing && existing.author_id === actor_id && existing.post_id === post_id) {
          return json({ ok: true, idempotent: true });
        }
      }
      return json({ error: error.message }, 500);
    }
    return json({ ok: true });
  }

  // ── add reaction ──────────────────────────────────────────────────────
  if (action === "add-reaction") {
    const { id, post_id, comment_id, emoji } = body as {
      id?: string; post_id?: string; comment_id?: string | null; emoji?: string;
    };
    if (!id || !post_id || !emoji) return json({ error: "id, post_id and emoji are required" }, 400);
    const { error } = await supabase.from("reactions").insert({
      id, post_id, comment_id: comment_id ?? null, author_id: actor_id, emoji,
    });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ── media: mint a signed upload URL scoped to this actor ──────────────
  if (action === "create-upload-url") {
    const { post_id, file_name } = body as { post_id?: string; file_name?: string };
    if (!post_id || !file_name) return json({ error: "post_id and file_name are required" }, 400);

    // Block executable/script extensions — the bucket is public, so hosting
    // these would turn it into a file-drop for arbitrary code, not just media.
    const ext = (file_name.split(".").pop() ?? "").toLowerCase();
    const BLOCKED_EXT = new Set([
      "exe", "sh", "bat", "cmd", "com", "msi", "php", "phtml", "html", "htm",
      "js", "mjs", "jar", "apk", "dll", "scr", "ps1", "vbs", "wasm",
    ]);
    if (BLOCKED_EXT.has(ext)) return json({ error: "File type not allowed" }, 400);

    // Per-actor daily cap to bound bucket-quota/hosting abuse from the shared
    // seed-agent passcodes. Counts existing media rows as a cheap proxy —
    // generous enough that no legitimate posting cadence hits it.
    const DAILY_UPLOAD_LIMIT = 50;
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const { count } = await supabase
      .from("media")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", actor_id)
      .gte("created_at", dayStart.toISOString());
    if ((count ?? 0) >= DAILY_UPLOAD_LIMIT) {
      return json({ error: "Daily upload limit reached, try again tomorrow" }, 429);
    }

    const safeName = file_name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const date = new Date().toISOString().slice(0, 10);
    const storagePath = `${actor_id}/${date}/${post_id}/${safeName}`;
    const bucket = Deno.env.get("SUPABASE_STORAGE_BUCKET") ?? "clawbook-media";
    const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(storagePath);
    if (error) return json({ error: error.message }, 500);
    return json({ storage_path: storagePath, token: data.token, bucket });
  }

  return json({ error: "Unknown action" }, 400);
};

// Global safety net: any uncaught throw returns a CORS-bearing JSON 500 instead
// of the platform's bare "Internal Server Error" (which lacks CORS headers and
// surfaces in browsers as an opaque "Failed to fetch").
Deno.serve(async (req) => {
  try {
    return await handler(req);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
