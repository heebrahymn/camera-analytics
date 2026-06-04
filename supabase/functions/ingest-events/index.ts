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
  // Vision snapshot fields (only present when store_snapshots=true in worker config)
  snapshot_path?: string; // Supabase Storage path: vision-snapshots/<cam_id>/<ts>.jpg
  v_type?: string;        // 'car' | 'truck' | 'van' | 'bus' | 'motorcycle' | etc.
}

// Clamp event timestamps: max 5 minutes in the future, max 24 hours in the past
function parseAndClampOccurredAt(s: string | undefined): string {
  const now = new Date();
  if (!s) return now.toISOString();
  
  const parsed = new Date(s);
  if (isNaN(parsed.getTime())) {
    return now.toISOString();
  }
  
  const diffMs = now.getTime() - parsed.getTime();
  const maxFutureMs = -5 * 60 * 1000;
  const maxPastMs = 24 * 60 * 60 * 1000;

  if (diffMs < maxFutureMs || diffMs > maxPastMs) {
    return now.toISOString();
  }
  return parsed.toISOString();
}

// Sanitize storage path: must be a safe relative path (no absolute paths, no traversal)
function sanitizeStoragePath(p: string | undefined): string | null {
  if (!p || typeof p !== "string") return null;
  // Must match pattern: <uuid>/<safe-timestamp>.jpg
  // Allow only alphanumeric, hyphens, underscores, dots, forward slashes
  if (!/^[a-zA-Z0-9\-_./]+\.jpe?g$/i.test(p)) return null;
  // Disallow path traversal
  if (p.includes("..")) return null;
  return p.slice(0, 500); // cap length
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const ingestKey = req.headers.get("x-ingest-key") ?? "";
  if (!ingestKey) return json({ error: "Missing ingest key" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false },
  });

  // Look up camera
  const { data: cam, error: camErr } = await admin
    .from("cameras")
    .select("id, owner_id, store_id")
    .eq("ingest_key", ingestKey)
    .maybeSingle();
  if (camErr || !cam) return json({ error: "Invalid ingest key" }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Handle explicit camera status reports
  if (body && typeof body === "object" && !Array.isArray(body) && "status" in body) {
    const newStatus = body.status;
    if (newStatus === "online" || newStatus === "offline" || newStatus === "error" || newStatus === "pending") {
      await admin
        .from("cameras")
        .update({ status: newStatus, last_seen_at: new Date().toISOString() })
        .eq("id", cam.id);
      return json({ ok: true, status_updated: newStatus });
    }
  }

  const events: IncomingEvent[] = Array.isArray(body)
    ? (body as IncomingEvent[])
    : Array.isArray((body as { events?: IncomingEvent[] })?.events)
    ? (body as { events: IncomingEvent[] }).events
    : [body as IncomingEvent];

  const valid = events.filter(
    (e) => e && (e.direction === "entry" || e.direction === "exit"),
  );

  if (valid.length === 0) {
    // Empty payload = heartbeat
    await admin
      .from("cameras")
      .update({ status: "online", last_seen_at: new Date().toISOString() })
      .eq("id", cam.id);
    return json({ ok: true, heartbeat: true });
  }
  if (valid.length > 500) return json({ error: "Too many events (max 500)" }, 400);

  const rows = valid.map((e) => ({
    owner_id:      cam.owner_id,
    store_id:      cam.store_id,
    camera_id:     cam.id,
    direction:     e.direction,
    track_id:      e.track_id ? String(e.track_id).slice(0, 64) : null,
    occurred_at:   parseAndClampOccurredAt(e.occurred_at),
    confidence:    typeof e.confidence === "number" && !isNaN(e.confidence)
                     ? Math.max(0, Math.min(1, e.confidence))
                     : null,
    // Snapshot fields — stored only when the worker has store_snapshots=true
    snapshot_path: sanitizeStoragePath(e.snapshot_path),
    v_type:        e.v_type ? String(e.v_type).slice(0, 32) : null,
  }));

  const { error: insErr } = await admin.from("vehicle_events").insert(rows);
  if (insErr) {
    console.error("Database insert error:", insErr.message);
    return json({ error: "Failed to store events" }, 500);
  }

  await admin
    .from("cameras")
    .update({ status: "online", last_seen_at: new Date().toISOString() })
    .eq("id", cam.id);

  // Probabilistic stale-camera cleanup (5% chance to reduce write contention)
  if (Math.random() < 0.05) {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await admin
      .from("cameras")
      .update({ status: "offline" })
      .lt("last_seen_at", fiveMinutesAgo)
      .eq("status", "online");
  }

  return json({ ok: true, inserted: rows.length });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
