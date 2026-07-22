// Server-side Supabase client for the NSAT dashboard.
//
// Uses the SERVICE_ROLE key (bypasses RLS) so the dashboard can read the
// funnel tables (which hold phone/email PII and are NOT anon-readable).
// This module must ONLY be imported from server code (never a client
// component) — the key never reaches the browser bundle.
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL || "";
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";

if (!url) console.warn("[supabase] SUPABASE_URL not set - live data will fail");
if (!key) console.warn("[supabase] no Supabase key set - live data will fail");
else if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
  console.info("[supabase] using anon key (RLS applies) - set SERVICE_ROLE for full read");

// Reused across requests; no user session to persist on the server.
export const supabase: SupabaseClient = createClient(url || "http://invalid", key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const supabaseConfigured = Boolean(url && key);
