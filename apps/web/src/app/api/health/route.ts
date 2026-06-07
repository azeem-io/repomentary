import { supabaseConfigured } from "@/lib/supabase";

export function GET(): Response {
  return Response.json({
    ok: true,
    db: supabaseConfigured() ? "configured" : "unconfigured",
    at: new Date().toISOString(),
  });
}
