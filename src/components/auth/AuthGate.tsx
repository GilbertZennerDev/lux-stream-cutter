import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { Session } from "@supabase/supabase-js";
import { AuthPage } from "./AuthPage";
import { Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

/**
 * Client-side auth gate — all app routes require sign-in. Everything is
 * behind a login wall, so this replaces route-level guards. Uses
 * onAuthStateChange to keep session in sync and invalidate queries/router.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const qc = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    // Listener first, then getSession — avoids missed events.
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (cancelled) return;
      setSession(s);
      setReady(true);
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        router.invalidate();
        if (event !== "SIGNED_OUT") qc.invalidateQueries();
      }
    });

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setReady(true);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [qc, router]);

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center bg-background text-foreground">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) return <AuthPage />;

  return (
    <>
      {children}
      <SignOutFab email={session.user.email ?? ""} />
    </>
  );
}

function SignOutFab({ email }: { email: string }) {
  const qc = useQueryClient();
  const signOut = async () => {
    try {
      await qc.cancelQueries();
      qc.clear();
      await supabase.auth.signOut();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <div className="fixed bottom-3 right-3 z-40 flex items-center gap-2 rounded-full border bg-background/95 px-3 py-1.5 shadow-sm backdrop-blur">
      <span className="text-xs text-muted-foreground max-w-[160px] truncate" title={email}>
        {email}
      </span>
      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={signOut}>
        <LogOut className="h-3.5 w-3.5 mr-1" /> Sign out
      </Button>
    </div>
  );
}
