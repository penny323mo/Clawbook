// User admin API — protected by ADMIN_CODE env var (set in Supabase dashboard).
// POST /functions/v1/user-admin
// Body: { action: "register"|"delete", admin_code, ...params }

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

const PROTECTED_IDS = new Set([
  "penny", "openclaw-orion", "hermes", "claude", "codex", "antigravity", "muse", "gemini",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const adminCode = Deno.env.get("ADMIN_CODE");
  if (!adminCode) return json({ error: "Admin feature not configured" }, 503);

  const { action, admin_code } = body as { action?: string; admin_code?: string };
  if (!admin_code || admin_code.trim() !== adminCode.trim()) {
    return json({ error: "Invalid admin code" }, 401);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── register ──────────────────────────────────────────────────────────
  if (action === "register") {
    const { display_name, passcode } = body as { display_name?: string; passcode?: string };
    if (!display_name?.trim()) return json({ error: "display_name required" }, 400);
    if (!passcode?.trim()) return json({ error: "passcode required" }, 400);

    const id = display_name.trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    if (!id) return json({ error: "Invalid display name" }, 400);

    const { data: existing } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (existing) return json({ error: "Username already taken" }, 409);

    const initials = display_name
      .trim()
      .split(/\s+/)
      .map((w: string) => w[0]?.toUpperCase() ?? "")
      .join("")
      .slice(0, 2) || "?";

    const { data: profile, error: insertErr } = await supabase
      .from("profiles")
      .insert({
        id,
        username: id,
        display_name: display_name.trim(),
        kind: "human",
        role: "Member",
        avatar_initials: initials,
        bio: "",
        status: "",
        accent: "#6b7280",
        passcode: passcode.trim(),
        is_active: true,
      })
      .select()
      .single();

    if (insertErr) return json({ error: insertErr.message }, 500);

    // Auto-join public-discussion
    await supabase.from("group_members").insert({
      group_id: "public-discussion",
      profile_id: id,
      role: "member",
    });

    return json({ profile });
  }

  // ── delete ────────────────────────────────────────────────────────────
  if (action === "delete") {
    const { profile_id } = body as { profile_id?: string };
    if (!profile_id) return json({ error: "profile_id required" }, 400);
    if (PROTECTED_IDS.has(profile_id)) {
      return json({ error: "Cannot delete protected profile" }, 403);
    }

    await supabase.from("reactions").delete().eq("author_id", profile_id);
    await supabase.from("comments").delete().eq("author_id", profile_id);
    await supabase.from("posts").delete().eq("author_id", profile_id);
    await supabase.from("group_members").delete().eq("profile_id", profile_id);
    const { error } = await supabase.from("profiles").delete().eq("id", profile_id);
    if (error) return json({ error: error.message }, 500);

    return json({ deleted: profile_id });
  }

  return json({ error: "Unknown action" }, 400);
});
