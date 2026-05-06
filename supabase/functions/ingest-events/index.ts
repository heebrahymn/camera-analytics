interface DenoStatic {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
  env: {
    get(key: string): string | undefined;
  };
}
declare const Deno: DenoStatic;

// @ts-expect-error URL imports are native to Deno but unsupported in standard Node TS
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-ingest-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface IncomingEvent {
  direction: "entry" | "exit";
  track_id?: string;
  occurred_at?: string; // ISO
  confidence?: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const ingestKey =
    req.headers.get("x-ingest-key") ??
    new URL(req.url).searchParams.get("key") ??
    "";

  if (!ingestKey) return json({ error: "Missing ingest key" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false },
  });

  // Look up camera + last_seen update
  const { data: cam, error: camErr } = await admin
    .from("cameras")
    .select("id, owner_id, store_id")
    .eq("ingest_key", ingestKey)
    .maybeSingle();
  if (camErr || !cam) return json({ error: "Invalid ingest key" }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const events: IncomingEvent[] = Array.isArray(body)
    ? (body as IncomingEvent[])
    : Array.isArray((body as { events?: IncomingEvent[] })?.events)
    ? (body as { events: IncomingEvent[] }).events
    : [body as IncomingEvent];

  const valid = events.filter(
    (e) => e && (e.direction === "entry" || e.direction === "exit"),
  );
  if (valid.length === 0) return json({ error: "No valid events" }, 400);
  if (valid.length > 500) return json({ error: "Too many events (max 500)" }, 400);

  const rows = valid.map((e) => ({
    owner_id: cam.owner_id,
    store_id: cam.store_id,
    camera_id: cam.id,
    direction: e.direction,
    track_id: e.track_id ?? null,
    occurred_at: e.occurred_at ?? new Date().toISOString(),
    confidence: typeof e.confidence === "number" ? e.confidence : null,
  }));

  const { error: insErr } = await admin.from("vehicle_events").insert(rows);
  if (insErr) return json({ error: insErr.message }, 500);

  await admin
    .from("cameras")
    .update({ status: "online", last_seen_at: new Date().toISOString() })
    .eq("id", cam.id);

  return json({ ok: true, inserted: rows.length });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
