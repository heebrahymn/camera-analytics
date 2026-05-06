import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Activity, BarChart3, Camera, LogOut, Store } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Logo from "./Logo";

const nav = [
  { to: "/", label: "Live", icon: Activity, end: true },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/stores", label: "Stores", icon: Store },
  { to: "/cameras", label: "Cameras", icon: Camera },
];

export default function AppLayout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden md:flex w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
        <div className="flex items-center px-5 h-16 border-b border-sidebar-border">
          <Logo className="h-7 text-sidebar-accent-foreground" />
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-sidebar-border p-3 space-y-2">
          <div className="px-2 text-xs text-sidebar-foreground/70 truncate">
            {user?.email}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={async () => {
              await signOut();
              navigate("/auth");
            }}
          >
            <LogOut className="h-4 w-4 mr-2" />
            Sign out
          </Button>
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
