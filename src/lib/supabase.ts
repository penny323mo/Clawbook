import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);

export const supabase: SupabaseClient<Database> | null = isSupabaseConfigured
  ? createClient<Database>(supabaseUrl as string, supabasePublishableKey as string, {
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
