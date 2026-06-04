import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";

interface Store { id: string; name: string; address: string | null; timezone: string; }

export default function Stores() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");

  const stores = useQuery({
    queryKey: ["stores-page"],
    queryFn: async () => {
      const { data, error } = await supabase.from("stores").select("id,name,address,timezone").order("created_at");
      if (error) throw error;
      return data as Store[];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { error } = await supabase.from("stores").insert({
        owner_id: u.user.id,
        name,
        address: address || null,
        timezone: tz || "UTC",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Store created");
      setOpen(false); setName(""); setAddress("");
      qc.invalidateQueries({ queryKey: ["stores-page"] });
      qc.invalidateQueries({ queryKey: ["stores"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("stores").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Store removed");
      qc.invalidateQueries({ queryKey: ["stores-page"] });
      qc.invalidateQueries({ queryKey: ["stores"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Stores"
        subtitle="Manage your physical store locations"
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Add store</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>New store</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div className="space-y-2"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Downtown Flagship" /></div>
                <div className="space-y-2"><Label>Address</Label><Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Optional" /></div>
                <div className="space-y-2"><Label>Timezone</Label><Input value={tz} onChange={(e) => setTz(e.target.value)} /></div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={() => create.mutate()} disabled={!name || create.isPending}>
                  {create.isPending ? "…" : "Create"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />
      <div className="p-6">
        <Card className="divide-y">
          {(stores.data ?? []).map((s) => (
            <div key={s.id} className="flex items-center justify-between p-4">
              <div>
                <div className="font-medium">{s.name}</div>
                <div className="text-xs text-muted-foreground">
                  {s.address || "—"} · {s.timezone}
                </div>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="icon" variant="ghost" className="hover:text-destructive transition-colors">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete store</AlertDialogTitle>
                    <AlertDialogDescription>
                      Are you sure you want to delete the store "{s.name}"? This action cannot be undone and will permanently delete all cameras, vehicle events, and aggregates linked to this store.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className={buttonVariants({ variant: "destructive" })}
                      onClick={() => remove.mutate(s.id)}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ))}
          {stores.isSuccess && (stores.data?.length ?? 0) === 0 && (
            <div className="p-10 text-center text-sm text-muted-foreground">
              No stores yet. Create your first one to start adding cameras.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
