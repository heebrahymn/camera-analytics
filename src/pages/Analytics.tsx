import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Download } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Agg {
  store_id: string;
  camera_id: string;
  entries: number;
  exits: number;
  bucket_start: string;
}
interface Store { id: string; name: string; }

const ranges = [
  { value: "1d", label: "Last 24h", days: 1 },
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
];

export default function Analytics() {
  const [rangeKey, setRangeKey] = useState("7d");
  const [storeId, setStoreId] = useState<string>("all");

  const range = ranges.find((r) => r.value === rangeKey)!;
  const fromIso = useMemo(
    () => startOfDay(subDays(new Date(), range.days - 1)).toISOString(),
    [range.days],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const toIso = useMemo(() => endOfDay(new Date()).toISOString(), [rangeKey]);

  const stores = useQuery({
    queryKey: ["stores"],
    queryFn: async () => {
      const { data, error } = await supabase.from("stores").select("id,name").order("name");
      if (error) throw error;
      return data as Store[];
    },
  });

  const aggs = useQuery({
    queryKey: ["analytics-aggs", fromIso, toIso, storeId],
    queryFn: async () => {
      let q = supabase
        .from("count_aggregates_hourly")
        .select("store_id,camera_id,entries,exits,bucket_start")
        .gte("bucket_start", fromIso)
        .lte("bucket_start", toIso)
        .order("bucket_start");
      if (storeId !== "all") q = q.eq("store_id", storeId);
      const { data, error } = await q;
      if (error) throw error;
      return data as Agg[];
    },
  });

  const series = useMemo(() => {
    const data = aggs.data ?? [];
    const grouping: "hour" | "day" = range.days <= 1 ? "hour" : "day";
    const buckets = new Map<string, { label: string; entries: number; exits: number }>();
    for (const r of data) {
      const d = new Date(r.bucket_start);
      const key =
        grouping === "hour"
          ? format(d, "yyyy-MM-dd HH:00")
          : format(d, "yyyy-MM-dd");
      const label = grouping === "hour" ? format(d, "HH:00") : format(d, "MMM d");
      const cur = buckets.get(key) ?? { label, entries: 0, exits: 0 };
      cur.entries += r.entries;
      cur.exits += r.exits;
      buckets.set(key, cur);
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, v]) => v);
  }, [aggs.data, range.days]);

  const perStore = useMemo(() => {
    const map = new Map<string, { entries: number; exits: number }>();
    for (const r of aggs.data ?? []) {
      const cur = map.get(r.store_id) ?? { entries: 0, exits: 0 };
      cur.entries += r.entries;
      cur.exits += r.exits;
      map.set(r.store_id, cur);
    }
    return (stores.data ?? [])
      .map((s) => ({
        name: s.name,
        ...(map.get(s.id) ?? { entries: 0, exits: 0 }),
      }))
      .sort((a, b) => b.entries + b.exits - (a.entries + a.exits));
  }, [aggs.data, stores.data]);

  const peak = useMemo(() => {
    let best: typeof series[number] | null = null;
    for (const p of series) {
      if (!best || p.entries + p.exits > best.entries + best.exits) best = p;
    }
    return best;
  }, [series]);

  const totalEntries = series.reduce((s, p) => s + p.entries, 0);
  const totalExits = series.reduce((s, p) => s + p.exits, 0);

  const exportCsv = () => {
    const rows = [
      ["bucket", "entries", "exits"],
      ...series.map((p) => [p.label, String(p.entries), String(p.exits)]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `traffic_${rangeKey}_${format(new Date(), "yyyyMMdd")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Analytics"
        subtitle="Historical traffic trends, store comparison, and exports"
        actions={
          <>
            <Select value={storeId} onValueChange={setStoreId}>
              <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stores</SelectItem>
                {(stores.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={rangeKey} onValueChange={setRangeKey}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ranges.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={exportCsv}>
              <Download className="h-4 w-4 mr-2" /> CSV
            </Button>
          </>
        }
      />
      <div className="p-6 space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="p-5">
            <div className="text-sm text-muted-foreground">Entries</div>
            <div className="text-3xl font-semibold tabular-nums mt-1">{totalEntries}</div>
          </Card>
          <Card className="p-5">
            <div className="text-sm text-muted-foreground">Exits</div>
            <div className="text-3xl font-semibold tabular-nums mt-1">{totalExits}</div>
          </Card>
          <Card className="p-5">
            <div className="text-sm text-muted-foreground">Peak bucket</div>
            <div className="text-3xl font-semibold tabular-nums mt-1">
              {peak ? peak.entries + peak.exits : 0}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {peak ? peak.label : "—"}
            </div>
          </Card>
        </div>

        <Card className="p-5">
          <h2 className="font-semibold mb-4">Traffic over time</h2>
          <div className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Legend />
                <Line type="monotone" dataKey="entries" stroke="hsl(var(--success))" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="exits" stroke="hsl(var(--warning))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold mb-4">Per store comparison</h2>
          <div className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={perStore}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Legend />
                <Bar dataKey="entries" fill="hsl(var(--success))" radius={[4, 4, 0, 0]} />
                <Bar dataKey="exits" fill="hsl(var(--warning))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
    </div>
  );
}
