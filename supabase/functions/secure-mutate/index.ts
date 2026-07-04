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
  const bytes = new TextEncoder().encode(`${profileId}:${code.trim()}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
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
  if (!actor_id || !code) return json({ error: "actor_id and code are required" }, 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: actorRow, error: actorErr } = await supabase
    .from("profiles")
    .select("id, role, passcode, passcode_hash")
    .eq("id", actor_id)
    .maybeSingle();
  if (actorErr || !actorRow) return json({ error: "Unknown actor_id" }, 401);

  if (actorRow.passcode_hash) {
    const gotHash = await hashPasscode(actor_id, code);
    if (gotHash !== actorRow.passcode_hash) return json({ error: "Invalid passcode" }, 401);
  } else {
    const expected = actorRow.passcode ? String(actorRow.passcode) : envPasscode(actor_id);
    if (code.trim() !== expected.trim()) return json({ error: "Invalid passcode" }, 401);
    // Self-heal: migrate this account to a hashed passcode now that we've
    // verified it, so the plaintext column empties out over time.
    if (actorRow.passcode) {
      const newHash = await hashPasscode(actor_id, code);
      await supabase.from("profiles").update({ passcode_hash: newHash, passcode: null }).eq("id", actor_id);
    }
  }

  const isAdmin = actorRow.role === "admin" || actor_id === "penny";

  // ── login verification (no row mutation) ───────────────────────────────
  if (action === "verify-login") {
    const { data: profile } = await supabase
      .from("profiles")
      .select("id, username, display_name, role, kind, avatar_url, avatar_initials, cover_url, bio, status, accent, is_active, created_at, updated_at")
      .eq("id", actor_id)
      .single();
    return json({ ok: true, profile });
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

  return json({ error: "Unknown action" }, 400);
});
