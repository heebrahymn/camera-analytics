import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, startOfDay, endOfDay } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { FileDown, Calendar as CalendarIcon, ArrowDownRight, ArrowUpRight, Eye } from "lucide-react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

interface Store {
  id: string;
  name: string;
}

interface Camera {
  id: string;
  name: string;
  store_id: string;
}

interface VehicleEvent {
  id: number;
  direction: "entry" | "exit";
  occurred_at: string;
  camera_id: string;
  store_id: string;
  snapshot_path: string | null;
  v_type: string | null;
  confidence: number | null;
}

export default function Reports() {
  const [selectedDate, setSelectedDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [storeId, setStoreId] = useState<string>("all");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  // Reset pagination on filter change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedDate, storeId]);

  // Snapshot modal states
  const [selectedSnapshot, setSelectedSnapshot] = useState<string | null>(null);
  const [selectedVType, setSelectedVType] = useState<string | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

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

  // Queries
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
      const { data, error } = await supabase.from("cameras").select("id,name,store_id");
      if (error) throw error;
      return data as Camera[];
    },
  });

  const events = useQuery({
    queryKey: ["reports-events", selectedDate, storeId],
    queryFn: async () => {
      const start = startOfDay(new Date(selectedDate + "T00:00:00")).toISOString();
      const end = endOfDay(new Date(selectedDate + "T23:59:59")).toISOString();

      let q = supabase
        .from("vehicle_events")
        .select("id,direction,occurred_at,camera_id,store_id,snapshot_path,v_type,confidence")
        .gte("occurred_at", start)
        .lte("occurred_at", end)
        .order("occurred_at", { ascending: true });

      if (storeId !== "all") {
        q = q.eq("store_id", storeId);
      }

      const { data, error } = await q;
      if (error) throw error;
      return data as VehicleEvent[];
    },
  });

  // Derived metrics
  const totalDetections = events.data?.length ?? 0;
  const totalEntries = useMemo(() => {
    return (events.data ?? []).filter((e) => e.direction === "entry").length;
  }, [events.data]);

  const totalExits = useMemo(() => {
    return (events.data ?? []).filter((e) => e.direction === "exit").length;
  }, [events.data]);

  // Classification breakdown
  const types = useMemo(() => {
    const counts: Record<string, number> = {};
    (events.data ?? []).forEach((e) => {
      const type = e.v_type || "car";
      counts[type] = (counts[type] || 0) + 1;
    });

    return Object.entries(counts)
      .map(([type, count]) => ({
        type,
        count,
        percentage: totalDetections > 0 ? (count / totalDetections) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }, [events.data, totalDetections]);

  // On-screen Pagination
  const paginatedEvents = useMemo(() => {
    const data = events.data ?? [];
    const startIndex = (currentPage - 1) * itemsPerPage;
    return data.slice(startIndex, startIndex + itemsPerPage);
  }, [events.data, currentPage]);

  const totalPages = Math.ceil(totalDetections / itemsPerPage);

  // PDF Export
  const exportPdf = async () => {
    const element = document.getElementById("printable-report-container");
    if (!element) return;
    setIsExporting(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
      });
      const imgData = canvas.toDataURL("image/jpeg", 0.95);
      const pdf = new jsPDF("p", "mm", "a4");
      const imgWidth = 210;
      const pageHeight = 297;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      let heightLeft = imgHeight;
      let position = 0;

      // Draw first page
      pdf.addImage(imgData, "JPEG", 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;

      // Handle pagination
      while (heightLeft > 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, "JPEG", 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
      }

      const storeName =
        storeId === "all" ? "All Stores" : (stores.data?.find((s) => s.id === storeId)?.name || "Store");
      const sanitizedStore = storeName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      pdf.save(`daily-report-${sanitizedStore}-${selectedDate}.pdf`);
    } catch (err) {
      console.error("Error exporting PDF:", err);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen">
      <PageHeader
        title="Daily Reports"
        subtitle="View and download comprehensive traffic reports"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 border bg-card rounded-md px-3 py-1.5 shadow-sm text-sm text-foreground">
              <CalendarIcon className="h-4 w-4 text-muted-foreground" />
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="bg-transparent border-0 outline-none text-foreground focus:ring-0 cursor-pointer"
              />
            </div>
            <Select value={storeId} onValueChange={setStoreId}>
              <SelectTrigger className="w-[180px] bg-card text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stores</SelectItem>
                {(stores.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={exportPdf} disabled={isExporting || events.isLoading} className="shadow-sm">
              <FileDown className="h-4 w-4 mr-2" />
              {isExporting ? "Generating PDF..." : "Export PDF"}
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-6 flex-1 bg-background text-foreground">
        {/* Metric Cards */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="p-5">
            <div className="text-sm text-muted-foreground">Total Detections</div>
            <div className="text-3xl font-semibold mt-1 tabular-nums">
              {events.isLoading ? "..." : totalDetections}
            </div>
          </Card>
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Entries</span>
              <ArrowDownRight className="h-4 w-4 text-success" />
            </div>
            <div className="text-3xl font-semibold mt-1 tabular-nums text-success">
              {events.isLoading ? "..." : totalEntries}
            </div>
          </Card>
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Exits</span>
              <ArrowUpRight className="h-4 w-4 text-warning" />
            </div>
            <div className="text-3xl font-semibold mt-1 tabular-nums text-warning">
              {events.isLoading ? "..." : totalExits}
            </div>
          </Card>
        </div>

        {/* Dashboard Grid */}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Classification Breakdown */}
          <Card className="p-5 flex flex-col justify-between">
            <div>
              <h2 className="font-semibold mb-4 text-foreground">Vehicle Classification</h2>
              <div className="space-y-5">
                {events.isLoading ? (
                  <div className="space-y-4">
                    <div className="h-4 bg-muted animate-pulse rounded w-3/4" />
                    <div className="h-4 bg-muted animate-pulse rounded w-1/2" />
                    <div className="h-4 bg-muted animate-pulse rounded w-2/3" />
                  </div>
                ) : (
                  types.map((t) => (
                    <div key={t.type} className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="capitalize font-medium text-foreground">{t.type}</span>
                        <span className="text-muted-foreground">
                          {t.count} ({t.percentage.toFixed(0)}%)
                        </span>
                      </div>
                      <Progress value={t.percentage} className="h-2" />
                    </div>
                  ))
                )}
                {!events.isLoading && types.length === 0 && (
                  <div className="text-sm text-muted-foreground text-center py-6">
                    No classification data for this filter.
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Logs Table */}
          <Card className="lg:col-span-2 p-5">
            <h2 className="font-semibold mb-4 text-foreground">Detection Logs</h2>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    {storeId === "all" && <TableHead>Store</TableHead>}
                    <TableHead>Camera</TableHead>
                    <TableHead>Direction</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.isLoading ? (
                    <TableRow>
                      <TableCell colSpan={storeId === "all" ? 7 : 6} className="text-center py-6 text-muted-foreground">
                        Loading detections...
                      </TableCell>
                    </TableRow>
                  ) : paginatedEvents.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={storeId === "all" ? 7 : 6} className="text-center py-6 text-muted-foreground">
                        No events recorded for this date.
                      </TableCell>
                    </TableRow>
                  ) : (
                    paginatedEvents.map((e) => {
                      const cam = (cameras.data ?? []).find((c) => c.id === e.camera_id);
                      const storeName =
                        (stores.data ?? []).find((s) => s.id === e.store_id)?.name || "Store";
                      return (
                        <TableRow key={e.id}>
                          <TableCell className="font-medium">
                            {new Date(e.occurred_at).toLocaleTimeString(undefined, {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                              hour12: false,
                            })}
                          </TableCell>
                          {storeId === "all" && <TableCell>{storeName}</TableCell>}
                          <TableCell>{cam?.name || "Camera"}</TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={`capitalize font-semibold ${
                                e.direction === "entry"
                                  ? "bg-success/10 text-success border-success/20 hover:bg-success/10"
                                  : "bg-warning/10 text-warning border-warning/20 hover:bg-warning/10"
                              }`}
                            >
                              {e.direction}
                            </Badge>
                          </TableCell>
                          <TableCell className="capitalize">{e.v_type || "car"}</TableCell>
                          <TableCell>{e.confidence ? `${(e.confidence * 100).toFixed(0)}%` : "—"}</TableCell>
                          <TableCell className="text-right">
                            {e.snapshot_path ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                                onClick={() => handleViewSnapshot(e.snapshot_path!, e.v_type)}
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Pagination Controls */}
            {!events.isLoading && totalPages > 1 && (
              <div className="flex items-center justify-between mt-4">
                <div className="text-xs text-muted-foreground">
                  Showing {(currentPage - 1) * itemsPerPage + 1} to{" "}
                  {Math.min(currentPage * itemsPerPage, totalDetections)} of {totalDetections} events
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage === 1}
                    onClick={() => setCurrentPage((prev) => prev - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage >= totalPages}
                    onClick={() => setCurrentPage((prev) => prev + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Snapshot Modal */}
      <Dialog
        open={!!selectedSnapshot}
        onOpenChange={(open) => {
          if (!open) setSelectedSnapshot(null);
        }}
      >
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
              <span className="text-sm text-muted-foreground animate-pulse">Generating secure link...</span>
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

      {/* PDF Printable Off-Screen Element (Strict Light Mode) */}
      <div
        id="printable-report-container"
        style={{
          position: "absolute",
          left: "-9999px",
          top: "-9999px",
          width: "800px",
          backgroundColor: "#ffffff",
          color: "#0f172a",
          padding: "40px",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {/* Print Header */}
        <div style={{ borderBottom: "2px solid #e2e8f0", paddingBottom: "20px", marginBottom: "24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <h1 style={{ fontSize: "28px", fontWeight: "bold", margin: 0, color: "#1e3a8a", letterSpacing: "-0.5px" }}>
                DAILY VEHICLE TRAFFIC REPORT
              </h1>
              <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
                Generated on {new Date().toLocaleString(undefined, { dateStyle: "long", timeStyle: "medium" })}
              </p>
            </div>
            <img
              src="/report-logo.png"
              style={{ height: "30px", width: "auto", objectFit: "contain" }}
              alt="Carbon Logo"
            />
          </div>

          <div style={{ display: "flex", gap: "28px", marginTop: "20px", fontSize: "13px", color: "#475569" }}>
            <div>
              <strong>Report Date:</strong> {format(new Date(selectedDate + "T00:00:00"), "MMMM d, yyyy")}
            </div>
            <div>
              <strong>Store:</strong>{" "}
              {storeId === "all" ? "All Stores" : stores.data?.find((s) => s.id === storeId)?.name || "Store"}
            </div>
            <div>
              <strong>Total Detections:</strong> {totalDetections}
            </div>
          </div>
        </div>

        {/* Print Metrics Overview */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px", marginBottom: "32px" }}>
          <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "16px", backgroundColor: "#f8fafc" }}>
            <div style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", fontWeight: "bold", letterSpacing: "0.5px" }}>
              Total Traffic
            </div>
            <div style={{ fontSize: "26px", fontWeight: "bold", marginTop: "4px", color: "#0f172a" }}>{totalDetections}</div>
          </div>
          <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "16px", backgroundColor: "#f8fafc" }}>
            <div style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", fontWeight: "bold", letterSpacing: "0.5px" }}>
              Total Entries
            </div>
            <div style={{ fontSize: "26px", fontWeight: "bold", color: "#16a34a", marginTop: "4px" }}>{totalEntries}</div>
          </div>
          <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "16px", backgroundColor: "#f8fafc" }}>
            <div style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase", fontWeight: "bold", letterSpacing: "0.5px" }}>
              Total Exits
            </div>
            <div style={{ fontSize: "26px", fontWeight: "bold", color: "#ea580c", marginTop: "4px" }}>{totalExits}</div>
          </div>
        </div>

        {/* Print Content Layout */}
        <div style={{ display: "grid", gridTemplateColumns: "230px 1fr", gap: "32px", alignItems: "flex-start" }}>
          {/* Classification Breakdown */}
          <div>
            <h3 style={{ fontSize: "14px", fontWeight: "bold", borderBottom: "2px solid #cbd5e1", paddingBottom: "6px", marginBottom: "16px", color: "#1e293b" }}>
              Vehicle Classification
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              {types.map((t) => (
                <div key={t.type}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "4px", color: "#334155" }}>
                    <span style={{ textTransform: "capitalize", fontWeight: "500" }}>{t.type}</span>
                    <strong>
                      {t.count} ({t.percentage.toFixed(0)}%)
                    </strong>
                  </div>
                  <div style={{ height: "6px", backgroundColor: "#f1f5f9", borderRadius: "3px", border: "1px solid #e2e8f0" }}>
                    <div style={{ height: "4px", backgroundColor: "#334155", borderRadius: "2px", width: `${t.percentage}%` }} />
                  </div>
                </div>
              ))}
              {types.length === 0 && (
                <div style={{ fontSize: "12px", color: "#64748b", fontStyle: "italic" }}>No classification data available.</div>
              )}
            </div>
          </div>

          {/* Logs Table */}
          <div>
            <h3 style={{ fontSize: "14px", fontWeight: "bold", borderBottom: "2px solid #cbd5e1", paddingBottom: "6px", marginBottom: "16px", color: "#1e293b" }}>
              Detection Logs
            </h3>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #94a3b8", textAlign: "left" }}>
                  <th style={{ padding: "6px 8px", color: "#475569", fontWeight: "bold" }}>Time</th>
                  <th style={{ padding: "6px 8px", color: "#475569", fontWeight: "bold" }}>Store</th>
                  <th style={{ padding: "6px 8px", color: "#475569", fontWeight: "bold" }}>Camera</th>
                  <th style={{ padding: "6px 8px", color: "#475569", fontWeight: "bold" }}>Direction</th>
                  <th style={{ padding: "6px 8px", color: "#475569", fontWeight: "bold" }}>Type</th>
                  <th style={{ padding: "6px 8px", color: "#475569", fontWeight: "bold" }}>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {(events.data ?? []).map((e, idx) => {
                  const cam = (cameras.data ?? []).find((c) => c.id === e.camera_id);
                  const storeName = (stores.data ?? []).find((s) => s.id === e.store_id)?.name || "Store";
                  return (
                    <tr
                      key={e.id}
                      style={{
                        borderBottom: "1px solid #e2e8f0",
                        backgroundColor: idx % 2 === 0 ? "#f8fafc" : "#ffffff",
                      }}
                    >
                      <td style={{ padding: "8px", fontWeight: "500" }}>
                        {new Date(e.occurred_at).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                          hour12: false,
                        })}
                      </td>
                      <td style={{ padding: "8px" }}>{storeName}</td>
                      <td style={{ padding: "8px" }}>{cam?.name || "Camera"}</td>
                      <td
                        style={{
                          padding: "8px",
                          textTransform: "capitalize",
                          fontWeight: "bold",
                          color: e.direction === "entry" ? "#16a34a" : "#ea580c",
                        }}
                      >
                        {e.direction}
                      </td>
                      <td style={{ padding: "8px", textTransform: "capitalize" }}>{e.v_type || "car"}</td>
                      <td style={{ padding: "8px" }}>{e.confidence ? `${(e.confidence * 100).toFixed(0)}%` : "—"}</td>
                    </tr>
                  );
                })}
                {(events.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: "24px", textAlign: "center", color: "#64748b", fontStyle: "italic" }}>
                      No events recorded for this date.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            marginTop: "60px",
            borderTop: "1px solid #e2e8f0",
            paddingTop: "20px",
            display: "flex",
            justifyContent: "space-between",
            fontSize: "11px",
            color: "#94a3b8",
          }}
        >
          <div>Report Identifier: CRB-REP-{selectedDate.replace(/-/g, "")}</div>
          <div>Carbon Platform · cameraAnalyticsApp</div>
        </div>
      </div>
    </div>
  );
}
