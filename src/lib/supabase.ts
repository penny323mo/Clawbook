import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
// Prefer VITE_SUPABASE_ANON_KEY; fall back to legacy VITE_SUPABASE_PUBLISHABLE_KEY
const supabaseAnonKey = (
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ??
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)
);

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
export const connectionMode: "supabase" | "mock" = isSupabaseConfigured ? "supabase" : "mock";

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

export const storageBucket = (import.meta.env.VITE_SUPABASE_STORAGE_BUCKET as string | undefined) || "clawbook-media";

export function subscribeToSocialChanges(onChange: () => void) {
  if (!supabase) {
    return () => undefined;
  }

  const channel = supabase
    .channel("clawbook-social-feed")
    .on("postgres_changes", { event: "*", schema: "public", table: "posts" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "comments" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "reactions" }, onChange)
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
