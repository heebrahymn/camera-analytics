import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Trash2, Eye, EyeOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

interface Camera {
  id: string; name: string; rtsp_url: string; rtsp_username: string | null;
  store_id: string; status: string; last_seen_at: string | null; ingest_key: string;
  location_label: string | null;
}
interface Store { id: string; name: string; }

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

export default function Cameras() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [storeId, setStoreId] = useState("");
  const [rtsp, setRtsp] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [loc, setLoc] = useState("");
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});

  const stores = useQuery({
    queryKey: ["stores"],
    queryFn: async () => {
      const { data, error } = await supabase.from("stores").select("id,name").order("name");
      if (error) throw error;
      return data as Store[];
    },
  });

  const cams = useQuery({
    queryKey: ["cameras-page"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cameras")
        .select("id,name,rtsp_url,rtsp_username,store_id,status,last_seen_at,ingest_key,location_label")
        .order("created_at");
      if (error) throw error;
      return data as Camera[];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { error } = await supabase.from("cameras").insert({
        owner_id: u.user.id,
        store_id: storeId,
        name,
        rtsp_url: rtsp,
        rtsp_username: user || null,
        rtsp_password: pass || null,
        location_label: loc || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Camera added");
      setOpen(false); setName(""); setRtsp(""); setUser(""); setPass(""); setLoc("");
      qc.invalidateQueries({ queryKey: ["cameras-page"] });
      qc.invalidateQueries({ queryKey: ["cameras"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("cameras").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Camera removed");
      qc.invalidateQueries({ queryKey: ["cameras-page"] });
      qc.invalidateQueries({ queryKey: ["cameras"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const ingestUrl = `${SUPABASE_URL}/functions/v1/ingest-events`;
  const noStores = stores.isSuccess && (stores.data?.length ?? 0) === 0;

  const copy = (v: string) => {
    navigator.clipboard.writeText(v);
    toast.success("Copied");
  };

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Cameras"
        subtitle="Connect RTSP cameras and copy the ingest endpoint for your worker"
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button disabled={noStores}>
                <Plus className="h-4 w-4 mr-2" /> Add camera
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New camera</DialogTitle>
                <DialogDescription>
                  Configure an IP camera. Your AI worker will use the generated ingest key to push counts.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>Store</Label>
                  <Select value={storeId} onValueChange={setStoreId}>
                    <SelectTrigger><SelectValue placeholder="Select store" /></SelectTrigger>
                    <SelectContent>
                      {(stores.data ?? []).map((s) => (
                        <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Front entrance" /></div>
                <div className="space-y-2"><Label>RTSP URL</Label><Input value={rtsp} onChange={(e) => setRtsp(e.target.value)} placeholder="rtsp://…" /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2"><Label>Username</Label><Input value={user} onChange={(e) => setUser(e.target.value)} /></div>
                  <div className="space-y-2"><Label>Password</Label><Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} /></div>
                </div>
                <div className="space-y-2"><Label>Location label</Label><Input value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="North driveway (optional)" /></div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={() => create.mutate()} disabled={!name || !rtsp || !storeId || create.isPending}>
                  {create.isPending ? "…" : "Add camera"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />
      <div className="p-6 space-y-4">
        <Card className="p-4 bg-secondary/50">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="text-sm">
              <div className="font-medium">Ingestion endpoint</div>
              <div className="text-xs text-muted-foreground">
                Workers POST events with header <code className="bg-background px-1 rounded">x-ingest-key: &lt;camera key&gt;</code>
              </div>
            </div>
            <code className="flex-1 text-xs bg-background border rounded px-2 py-1.5 truncate">
              {ingestUrl}
            </code>
            <Button size="sm" variant="outline" onClick={() => copy(ingestUrl)}>
              <Copy className="h-3.5 w-3.5 mr-1.5" /> Copy
            </Button>
          </div>
        </Card>

        <Card className="divide-y">
          {(cams.data ?? []).map((c) => {
            const store = (stores.data ?? []).find((s) => s.id === c.store_id);
            const visible = !!showKey[c.id];
            return (
              <div key={c.id} className="p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="font-medium">{c.name}</div>
                    <StatusBadge status={c.status} />
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 truncate">
                    {store?.name ?? "—"} · {c.location_label || "—"} · {c.rtsp_url}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="text-xs bg-secondary border rounded px-2 py-1 font-mono">
                      {visible ? c.ingest_key : "•".repeat(16)}
                    </code>
                    <Button size="icon" variant="ghost" onClick={() => setShowKey((m) => ({ ...m, [c.id]: !visible }))}>
                      {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => copy(c.ingest_key)}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <Button size="icon" variant="ghost" onClick={() => remove.mutate(c.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
          {cams.isSuccess && (cams.data?.length ?? 0) === 0 && (
            <div className="p-10 text-center text-sm text-muted-foreground">
              {noStores ? "Create a store first, then add cameras." : "No cameras yet."}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { className: string; label: string }> = {
    online:  { className: "bg-success text-success-foreground", label: "Online" },
    offline: { className: "bg-muted text-muted-foreground", label: "Offline" },
    error:   { className: "bg-destructive text-destructive-foreground", label: "Error" },
    pending: { className: "bg-secondary text-secondary-foreground", label: "Pending" },
  };
  const v = map[status] ?? map.pending;
  return <Badge className={v.className} variant="secondary">{v.label}</Badge>;
}
