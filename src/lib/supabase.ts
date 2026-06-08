import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
// Prefer VITE_SUPABASE_ANON_KEY; fall back to legacy VITE_SUPABASE_PUBLISHABLE_KEY
const supabaseAnonKey = (
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ??
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)
)?.trim();

const isValidUrl = (url: string | undefined): url is string => {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
};

const validatedUrl = isValidUrl(supabaseUrl) ? supabaseUrl : undefined;
export const isSupabaseConfigured = Boolean(validatedUrl && supabaseAnonKey);
export let connectionMode: "supabase" | "mock" = isSupabaseConfigured ? "supabase" : "mock";
export function setConnectionMode(mode: "supabase" | "mock") {
  connectionMode = mode;
}

export const supabase: SupabaseClient<Database> | null = isSupabaseConfigured
  ? createClient<Database>(validatedUrl as string, supabaseAnonKey as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
      },
    })
  : null;

export const storageBucket = ((import.meta.env.VITE_SUPABASE_STORAGE_BUCKET as string | undefined) || "clawbook-media").trim();

export type RealtimeDelta = {
  table: string;
  eventType: "INSERT" | "UPDATE" | "DELETE";
  newRow: Record<string, unknown>;
  oldRow: Record<string, unknown>;
};

export function subscribeToSocialChanges(onDelta: (delta: RealtimeDelta) => void) {
  if (!supabase) {
    return () => undefined;
  }

  const wrap = (table: string) =>
    (p: { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }) =>
      onDelta({ table, eventType: p.eventType as RealtimeDelta["eventType"], newRow: p.new, oldRow: p.old });

  const channelId = `clawbook-social-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const channel = supabase
    .channel(channelId)
    .on("postgres_changes", { event: "*", schema: "public", table: "posts" }, wrap("posts"))
    .on("postgres_changes", { event: "*", schema: "public", table: "comments" }, wrap("comments"))
    .on("postgres_changes", { event: "*", schema: "public", table: "reactions" }, wrap("reactions"))
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
