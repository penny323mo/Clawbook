#!/usr/bin/env node
/**
 * Quick connectivity check for Supabase.
 * Reads .env.local, attempts a select on profiles, reports connection status.
 *
 * Usage:
 *   npm run check:supabase
 */

import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// load .env.local
const envPath = new URL("../.env.local", import.meta.url).pathname;
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const url = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error("\n✗  Missing env vars in .env.local:");
  if (!url) console.error("    VITE_SUPABASE_URL");
  if (!anonKey) console.error("    VITE_SUPABASE_ANON_KEY");
  console.error("\n  Create .env.local from .env.example and fill in your project values.\n");
  process.exit(1);
}

const projectRef = new URL(url).hostname.split(".")[0];
console.log(`\nChecking Supabase connection…`);
console.log(`  Project: ${projectRef}`);

const supabase = createClient(url, anonKey, { auth: { persistSession: false } });

const { data, error } = await supabase.from("profiles").select("id, display_name").limit(5);

if (error) {
  console.error(`\n✗  Connection failed: ${error.message}`);
  console.error("  Check that migrations have been applied and RLS allows anon reads.");
  process.exit(1);
}

console.log(`\n✓  Connected — ${data.length} profile(s) found:`);
data.forEach((p) => console.log(`    • ${p.id} (${p.display_name})`));

// also check posts count
const { count: postCount } = await supabase
  .from("posts")
  .select("*", { count: "exact", head: true });

console.log(`  posts: ${postCount ?? 0}`);
console.log("\n  Clawbook is ready for Supabase Connected Mode.\n");
