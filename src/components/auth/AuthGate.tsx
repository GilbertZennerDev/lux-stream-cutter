import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, Link } from "@tanstack/react-router";
import type { Session } from "@supabase/supabase-js";
import { AuthPage } from "./AuthPage";
import { Loader2, LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { getMyAccessContext } from "@/lib/admin.functions";

/**
 * Client-side auth + tenancy gate.
 * - Not signed in → AuthPage.
 * - Signed in without group membership and not super-admin → blocker screen.
 * - Otherwise → children.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const qc = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
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

  return <AccessGate session={session}>{children}</AccessGate>;
}

function AccessGate({ session, children }: { session: Session; children: ReactNode }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["access-context", session.user.id],
    queryFn: () => getMyAccessContext(),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen grid place-items-center bg-background text-foreground">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isSuperAdmin = data?.isSuperAdmin ?? false;
  const hasGroup = !!data?.group && data.group.isActive !== false;

  if (error) {
    return <AccessErrorScreen email={session.user.email ?? ""} message={(error as Error).message} />;
  }

  if (!hasGroup && !isSuperAdmin) {
    return <NoAccessScreen email={session.user.email ?? ""} inactive={!!data?.group && !data.group.isActive} />;
  }

  return (
    <>
      {children}
      <SessionBar email={session.user.email ?? ""} isSuperAdmin={isSuperAdmin} groupName={data?.group?.name ?? null} />
    </>
  );
}

function SessionBar({
  email,
  isSuperAdmin,
  groupName,
}: {
  email: string;
  isSuperAdmin: boolean;
  groupName: string | null;
}) {
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
      {isSuperAdmin && (
        <Link
          to="/admin"
          className="text-xs font-medium text-primary hover:underline"
        >
          Admin
        </Link>
      )}
      {groupName && (
        <span className="text-xs text-muted-foreground max-w-[120px] truncate" title={groupName}>
          {groupName}
        </span>
      )}
      <span className="text-xs text-muted-foreground max-w-[160px] truncate" title={email}>
        {email}
      </span>
      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={signOut}>
        <LogOut className="h-3.5 w-3.5 mr-1" /> Sign out
      </Button>
    </div>
  );
}

function NoAccessScreen({ email, inactive }: { email: string; inactive: boolean }) {
  const signOut = async () => {
    await supabase.auth.signOut();
  };
  return (
    <div className="min-h-screen grid place-items-center bg-background text-foreground px-4">
      <div className="max-w-md w-full text-center space-y-4 border rounded-lg p-6 bg-card">
        <div className="mx-auto h-11 w-11 rounded-md bg-muted grid place-items-center">
          <ShieldAlert className="h-5 w-5 text-muted-foreground" />
        </div>
        <h1 className="text-lg font-semibold">
          {inactive ? "Your group is currently disabled" : "Waiting for admin approval"}
        </h1>
        <p className="text-sm text-muted-foreground">
          You are signed in as <span className="font-medium text-foreground">{email}</span>, but
          {inactive
            ? " your group has been deactivated by the administrator."
            : " your account has not been added to a group yet. Please contact the administrator to be added to a group."}
        </p>
        <Button variant="outline" onClick={signOut}>
          <LogOut className="h-4 w-4 mr-2" />
          Sign out
        </Button>
      </div>
    </div>
  );
}

function AccessErrorScreen({ email, message }: { email: string; message: string }) {
  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <div className="min-h-screen grid place-items-center bg-background text-foreground px-4">
      <div className="max-w-md w-full text-center space-y-4 border rounded-lg p-6 bg-card">
        <div className="mx-auto h-11 w-11 rounded-md bg-destructive/10 grid place-items-center">
          <ShieldAlert className="h-5 w-5 text-destructive" />
        </div>
        <h1 className="text-lg font-semibold">Access check failed</h1>
        <p className="text-sm text-muted-foreground">
          You are signed in as <span className="font-medium text-foreground">{email}</span>, but your access could not be verified.
        </p>
        <p className="rounded-md bg-muted px-3 py-2 text-left text-xs text-muted-foreground break-words">{message}</p>
        <Button variant="outline" onClick={signOut}>
          <LogOut className="h-4 w-4 mr-2" />
          Sign out
        </Button>
      </div>
    </div>
  );
}
