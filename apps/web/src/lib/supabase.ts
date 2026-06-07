import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * The app must boot and deploy with NO database configured.
 * Everything DB-related goes through these helpers so "unconfigured"
 * is a first-class state, not a crash.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export function supabaseConfigured(): boolean {
  return Boolean(url && key);
}

let client: SupabaseClient<Database> | null = null;

/** Returns a typed client, or null when env vars are absent (the current default). */
export function getSupabase(): SupabaseClient<Database> | null {
  if (!supabaseConfigured()) return null;
  if (!client) {
    client = createClient<Database>(url as string, key as string, {
      auth: { persistSession: false },
    });
  }
  return client;
}
