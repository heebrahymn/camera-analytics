import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Camera as CamIcon, Car, Store as StoreIcon, Eye } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/useAuth";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatLastSeen } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface Store { id: string; name: string; }
interface Camera { id: string; name: string; store_id: string; status: string; last_seen_at: string | null; }
interface Agg { store_id: string; camera_id: string; entries: number; exits: number; bucket_start: string; }

function startOfTodayWAT() {
  const now = new Date();
  const lagosDateString = now.toLocaleDateString("en-US", { timeZone: "Africa/Lagos" });
  const lagosStart = new Date(lagosDateString + " 00:00:00 GMT+0100");
  return lagosStart.toISOString();
}

export default function Live() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const [selectedSnapshot, setSelectedSnapshot] = useState<string | null>(null);
  const [selectedVType, setSelectedVType] = useState<string | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);

  const handleViewSnapshot = async (path: string, vType?: string | null) => {
    setSelectedVType(vType || null);
    setSelectedSnapshot(path);
    setLoadingSnapshot(true);
    setSignedUrl(null);
    try {
      const { data, error } = await supabase.storage
        .from("vision-snapshots")
        .createSignedUrl(path, 300);
      if (error) throw error;
      setSignedUrl(data.signedUrl);
    } catch (err) {
      console.error("Failed to generate signed URL:", err);
    } finally {
      setLoadingSnapshot(false);
    }
  };

  const stores = useQuery({
    queryKey: ["stores"],
    queryFn: async () => {
      const { data, error } = await supabase.from("stores").select("id,name").order("name");
      if (error) throw error;
      return data as Store[];
    },
  });

  const cameras = useQuery({
    queryKey: ["cameras"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cameras")
        .select("id,name,store_id,status,last_seen_at");
      if (error) throw error;
      return data as Camera[];
    },
    refetchInterval: 30000,
  });

  const today = useMemo(() => startOfTodayWAT(), []);
  const aggs = useQuery({
    queryKey: ["aggs-today", today],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("count_aggregates_hourly")
        .select("store_id,camera_id,entries,exits,bucket_start")
        .gte("bucket_start", today);
      if (error) throw error;
      return data as Agg[];
    },
  });

  const recent = useQuery({
    queryKey: ["recent-events"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vehicle_events")
        .select("id,direction,occurred_at,camera_id,store_id,snapshot_path,v_type")
        .order("occurred_at", { ascending: false })
        .limit(15);
      if (error) throw error;
      return data as {
        id: number;
        direction: "entry" | "exit";
        occurred_at: string;
        camera_id: string;
        store_id: string;
        snapshot_path?: string | null;
        v_type?: string | null;
      }[];
    },
  });

  // Realtime subscriptions: refresh on new events / agg updates
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("live-dashboard")
      .on("postgres_changes", { event: "*", schema: "public", table: "vehicle_events" }, () => {
        qc.invalidateQueries({ queryKey: ["recent-events"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "count_aggregates_hourly" }, () => {
        qc.invalidateQueries({ queryKey: ["aggs-today"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "cameras" }, () => {
        qc.invalidateQueries({ queryKey: ["cameras"] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, qc]);

  const totals = useMemo(() => {
    const a = aggs.data ?? [];
    const entries = a.reduce((s, r) => s + r.entries, 0);
    const exits = a.reduce((s, r) => s + r.exits, 0);
    return { entries, exits };
  }, [aggs.data]);

  const perCamera = useMemo(() => {
    const map = new Map<string, { entries: number; exits: number }>();
    for (const r of aggs.data ?? []) {
      const cur = map.get(r.camera_id) ?? { entries: 0, exits: 0 };
      cur.entries += r.entries;
      cur.exits += r.exits;
      map.set(r.camera_id, cur);
    }
    return map;
  }, [aggs.data]);

  const onlineCams = (cameras.data ?? []).filter((c) => {
    if (c.status !== "online") return false;
    if (!c.last_seen_at) return false;
    const lastSeen = new Date(c.last_seen_at).getTime();
    const diffSec = (new Date().getTime() - lastSeen) / 1000;
    return diffSec < 120; // Seen within last 2 minutes
  }).length;
  const totalCams = (cameras.data ?? []).length;
  const isWorkerRunning = onlineCams > 0;

  const noStores = stores.isSuccess && (stores.data?.length ?? 0) === 0;

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Live"
        subtitle="Real-time vehicle counts across all stores · today (WAT)"
        showLogo
        actions={
          totalCams > 0 ? (
            <Badge
              variant="outline"
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border transition-all duration-300 ${
                isWorkerRunning
                  ? "bg-success/15 text-success border-success/35 shadow-[0_0_10px_rgba(34,197,94,0.1)]"
                  : "bg-destructive/15 text-destructive border-destructive/35"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${isWorkerRunning ? "bg-success animate-pulse" : "bg-destructive"}`} />
              Worker: {isWorkerRunning ? "Running" : "Stopped"}
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-secondary/50 text-muted-foreground border-secondary">
              No Cameras Configured
            </Badge>
          )
        }
      />
      <div className="p-6 space-y-6">
        {noStores ? (
          <EmptyState />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                icon={<Car className="h-4 w-4" />}
                label="Total today"
                value={totals.entries + totals.exits}
                loading={aggs.isLoading}
              />
              <StatCard
                icon={<ArrowDownRight className="h-4 w-4 text-success" />}
                label="Entries today"
                value={totals.entries}
                loading={aggs.isLoading}
              />
              <StatCard
                icon={<ArrowUpRight className="h-4 w-4 text-warning" />}
                label="Exits today"
                value={totals.exits}
                loading={aggs.isLoading}
              />
              <StatCard
                icon={<CamIcon className="h-4 w-4" />}
                label="Cameras online"
                value={`${onlineCams} / ${totalCams}`}
                loading={cameras.isLoading}
              />
            </div>

            <div className="grid gap-6 lg:grid-cols-3">
              <Card className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold">By camera · today</h2>
                  <span className="text-xs text-muted-foreground flex items-center gap-2">
                    <span className="pulse-dot" /> Live
                  </span>
                </div>
                <div className="space-y-6">
                  {(stores.data ?? []).map((s) => {
                    const cams = (cameras.data ?? []).filter((c) => c.store_id === s.id);
                    return (
                      <div key={s.id} className="space-y-3">
                        <div className="flex items-center gap-2 pb-2 border-b">
                           <StoreIcon className="h-4 w-4 text-muted-foreground" />
                           <h3 className="font-semibold text-xs text-muted-foreground uppercase tracking-wider">{s.name}</h3>
                        </div>
                        <div className="divide-y divide-border/40">
                          {cams.map((c) => {
                            const v = perCamera.get(c.id) ?? { entries: 0, exits: 0 };
                            const isOnline = c.status === "online" && c.last_seen_at && (new Date().getTime() - new Date(c.last_seen_at).getTime()) / 1000 < 120;
                            return (
                              <div key={c.id} className="flex items-center justify-between py-2.5">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <div className="relative">
                                    <CamIcon className="h-4 w-4 text-muted-foreground/80" />
                                    <span className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-card ${isOnline ? "bg-success" : "bg-muted-foreground/40"
                                      }`} />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="font-medium text-sm text-foreground truncate block">{c.name}</span>
                                    <span className="text-[10px] text-muted-foreground block">
                                      {isOnline ? "Worker active" : "Worker stopped"}
                                      {c.last_seen_at && ` · ${formatLastSeen(c.last_seen_at)}`}
                                    </span>
                                  </div>
                                </div>
                                <div className="flex gap-6 text-sm">
                                  <Metric label="In" value={v.entries} tone="success" />
                                  <Metric label="Out" value={v.exits} tone="warning" />
                                  <Metric label="Total" value={v.entries + v.exits} />
                                </div>
                              </div>
                            );
                          })}
                          {cams.length === 0 && (
                            <div className="text-sm text-muted-foreground py-2 text-center">
                              No cameras registered for this store.
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>

              <Card className="lg:col-span-2 p-5">
                <h2 className="font-semibold mb-4">Recent car entries and exits</h2>
                <div className="space-y-2 max-h-[420px] overflow-auto">
                  {(recent.data ?? []).map((e) => {
                    const cam = (cameras.data ?? []).find((c) => c.id === e.camera_id);
                    const store = (stores.data ?? []).find((s) => s.id === e.store_id);
                    return (
                      <div key={e.id} className="flex items-center justify-between text-sm py-2 border-b last:border-0">
                        <div className="flex items-center gap-2 min-w-0">
                          {e.direction === "entry" ? (
                            <ArrowDownRight className="h-4 w-4 text-success shrink-0" />
                          ) : (
                            <ArrowUpRight className="h-4 w-4 text-warning shrink-0" />
                          )}
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="truncate font-medium text-foreground">
                              {store?.name ?? "—"} · {cam?.name ?? "Camera"}
                            </span>
                            {e.v_type && (
                              <Badge variant="outline" className="h-4 px-1 text-[9px] capitalize shrink-0 font-normal border-muted-foreground/35 text-muted-foreground">
                                {e.v_type}
                              </Badge>
                            )}
                            {e.snapshot_path && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5 rounded-full shrink-0 text-muted-foreground hover:text-foreground hover:bg-secondary"
                                onClick={() => handleViewSnapshot(e.snapshot_path!, e.v_type)}
                                title="View snapshot"
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        </div>
                        <span className="text-muted-foreground text-xs shrink-0 ml-2">
                          {new Date(e.occurred_at).toLocaleDateString("en-US", { timeZone: "Africa/Lagos", month: "short", day: "numeric" })} · {new Date(e.occurred_at).toLocaleTimeString("en-US", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
                        </span>
                      </div>
                    );
                  })}
                  {(recent.data ?? []).length === 0 && (
                    <div className="text-sm text-muted-foreground py-8 text-center">
                      No car events recorded yet today.
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </>
        )}
      </div>

      <Dialog open={!!selectedSnapshot} onOpenChange={(open) => { if (!open) setSelectedSnapshot(null); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {selectedVType
                ? `${selectedVType.charAt(0).toUpperCase()}${selectedVType.slice(1)} Snapshot`
                : "Vehicle Snapshot"}
            </DialogTitle>
            <DialogDescription>
              Captured when the {selectedVType || "vehicle"} was detected crossing the virtual line.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center p-4 min-h-[250px] bg-secondary/30 rounded-md border overflow-hidden">
            {loadingSnapshot ? (
              <span className="text-sm text-muted-foreground">Generating secure link...</span>
            ) : signedUrl ? (
              <img
                src={signedUrl}
                alt="Vehicle Snapshot"
                className="max-h-[400px] max-w-full rounded-md object-contain"
              />
            ) : (
              <span className="text-sm text-destructive">Failed to load snapshot</span>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({ icon, label, value, loading }: { icon: React.ReactNode; label: string; value: number | string; loading?: boolean }) {
  return (
    <div className="stat-card">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums">
        {loading ? <Skeleton className="h-8 w-16" /> : value}
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" }) {
  const toneClass =
    tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-foreground";
  return (
    <div className="text-right">
      <div className={`text-lg font-semibold tabular-nums ${toneClass}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="p-10 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
        <StoreIcon className="h-5 w-5" />
      </div>
      <h2 className="mt-4 font-semibold text-lg">Welcome to Carbon</h2>
      <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
        Get started by adding your first store, then connect an IP camera. Once
        your worker pushes counts to the ingestion API, this dashboard will
        update in real time.
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <Button asChild>
          <Link to="/stores">Add a store</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/cameras">Add a camera</Link>
        </Button>
      </div>
    </Card>
  );
}
