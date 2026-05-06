import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

export default function Auth() {
  const { user, signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);

  const handle = async (mode: "signin" | "signup") => {
    if (!email || password.length < 6) {
      toast.error("Enter a valid email and a password (min 6 chars)");
      return;
    }
    setLoading(true);
    const { error } =
      mode === "signin"
        ? await signIn(email, password)
        : await signUp(email, password, name);
    setLoading(false);
    if (error) toast.error(error);
    else if (mode === "signup") toast.success("Account created. Signing you in…");
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-background">
      <div
        className="hidden lg:flex flex-col justify-between p-10 text-sidebar-accent-foreground"
        style={{ background: "hsl(var(--sidebar-background))" }}
      >
        <div className="flex items-center">
          <Logo className="h-9 text-sidebar-accent-foreground" />
        </div>
        <div className="space-y-4 max-w-md">
          <h2 className="text-3xl font-semibold leading-tight">
            Turn CCTV into reliable vehicle traffic metrics.
          </h2>
          <p className="text-sm text-sidebar-foreground/80">
            Connect IP cameras across every store, count entries and exits in
            real time, and analyze traffic trends — all in one dashboard.
          </p>
        </div>
        <div className="text-xs text-sidebar-foreground/60">
          Counting accuracy. Reliability. Clean analytics.
        </div>
      </div>

      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm space-y-6">
          <div>
            <h1 className="text-2xl font-semibold">Welcome</h1>
            <p className="text-sm text-muted-foreground">
              Sign in or create an account to manage your cameras.
            </p>
          </div>
          <Tabs defaultValue="signin" className="w-full">
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="signin">Sign in</TabsTrigger>
              <TabsTrigger value="signup">Sign up</TabsTrigger>
            </TabsList>
            <TabsContent value="signin" className="space-y-3 mt-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <Button className="w-full" disabled={loading} onClick={() => handle("signin")}>
                {loading ? "…" : "Sign in"}
              </Button>
            </TabsContent>
            <TabsContent value="signup" className="space-y-3 mt-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email2">Email</Label>
                <Input id="email2" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password2">Password</Label>
                <Input id="password2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <Button className="w-full" disabled={loading} onClick={() => handle("signup")}>
                {loading ? "…" : "Create account"}
              </Button>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
