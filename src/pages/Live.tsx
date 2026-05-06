import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Camera as CamIcon, Car, Store as StoreIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

interface Store { id: string; name: string; }
interface Camera { id: string; name: string; store_id: string; status: string; last_seen_at: string | null; }
interface Agg { store_id: string; camera_id: string; entries: number; exits: number; bucket_start: string; }

function startOfTodayUTC() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export default function Live() {
  const { user } = useAuth();
  const qc = useQueryClient();

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
  });

  const today = useMemo(() => startOfTodayUTC(), []);
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
        .select("id,direction,occurred_at,camera_id,store_id")
        .order("occurred_at", { ascending: false })
        .limit(15);
      if (error) throw error;
      return data as { id: number; direction: "entry" | "exit"; occurred_at: string; camera_id: string; store_id: string }[];
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

  const perStore = useMemo(() => {
    const map = new Map<string, { entries: number; exits: number }>();
    for (const r of aggs.data ?? []) {
      const cur = map.get(r.store_id) ?? { entries: 0, exits: 0 };
      cur.entries += r.entries;
      cur.exits += r.exits;
      map.set(r.store_id, cur);
    }
    return map;
  }, [aggs.data]);

  const onlineCams = (cameras.data ?? []).filter((c) => c.status === "online").length;
  const totalCams = (cameras.data ?? []).length;

  const noStores = stores.isSuccess && (stores.data?.length ?? 0) === 0;

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Live"
        subtitle="Real-time vehicle counts across all stores · today (UTC)"
        showLogo
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
              <Card className="lg:col-span-2 p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold">By store · today</h2>
                  <span className="text-xs text-muted-foreground flex items-center gap-2">
                    <span className="pulse-dot" /> Live
                  </span>
                </div>
                <div className="divide-y">
                  {(stores.data ?? []).map((s) => {
                    const v = perStore.get(s.id) ?? { entries: 0, exits: 0 };
                    const cams = (cameras.data ?? []).filter((c) => c.store_id === s.id);
                    const online = cams.filter((c) => c.status === "online").length;
                    return (
                      <div key={s.id} className="flex items-center justify-between py-3">
                        <div>
                          <div className="font-medium">{s.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {online}/{cams.length} cameras online
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
                </div>
              </Card>

              <Card className="p-5">
                <h2 className="font-semibold mb-4">Recent events</h2>
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
                          <span className="truncate">
                            {store?.name ?? "—"} · {cam?.name ?? "Camera"}
                          </span>
                        </div>
                        <span className="text-muted-foreground text-xs shrink-0 ml-2">
                          {new Date(e.occurred_at).toLocaleTimeString()}
                        </span>
                      </div>
                    );
                  })}
                  {(recent.data ?? []).length === 0 && (
                    <div className="text-sm text-muted-foreground py-8 text-center">
                      No events yet. Once a worker pushes counts, they will appear here in real time.
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </>
        )}
      </div>
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
