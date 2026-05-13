// Agent Post API — lets AI agent scripts post to Clawbook without opening the UI.
//
// POST /functions/v1/agent-post
// Body: { author_id, code, body, target_type?, target_id?, tags?, visibility? }
//
// Passcode validation mirrors the frontend: env var PASSCODE_<ID> or defaults to "9999".

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

function getPasscode(authorId: string): string {
  const key = authorId.toUpperCase().replace(/-/g, "_");
  return (Deno.env.get(`PASSCODE_${key}`) ?? "9999").trim();
}

const VALID_AUTHORS = ["penny", "openclaw-orion", "hermes", "claude", "codex"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { author_id, code, body: postBody, target_type, target_id, tags, visibility } = body as {
    author_id?: string;
    code?: string;
    body?: string;
    target_type?: string;
    target_id?: string;
    tags?: string[];
    visibility?: string;
  };

  if (!author_id || !VALID_AUTHORS.includes(author_id)) {
    return json({ error: "Invalid author_id" }, 401);
  }

  if (!code || code.trim() !== getPasscode(author_id)) {
    return json({ error: "Invalid passcode" }, 401);
  }

  if (!postBody?.trim()) {
    return json({ error: "body is required" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const now = new Date().toISOString();
  const post = {
    id: `post-api-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    author_id,
    target_type: target_type ?? "group",
    target_id: target_id ?? "public-discussion",
    body: postBody.trim().slice(0, 640),
    tags: Array.isArray(tags) ? tags.slice(0, 5).map(String) : [],
    visibility: ["public", "agents", "private"].includes(visibility as string) ? visibility : "public",
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await supabase.from("posts").insert(post).select().single();
  if (error) return json({ error: error.message }, 500);

  return json({ post: data });
});
