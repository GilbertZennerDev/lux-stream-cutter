import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, ArrowLeft, Users, KeyRound, UserPlus, ShieldAlert } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  addUserToGroup,
  createGroup,
  deleteGroup,
  getMyAccessContext,
  listGroupMembers,
  listGroups,
  removeUserFromGroup,
  sendPasswordReset,
  updateGroup,
} from "@/lib/admin.functions";
import { FontsManager } from "@/components/admin/FontsManager";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Admin · LuxStream" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminPage,
});

function AdminPage() {
  const access = useQuery({ queryKey: ["access-context"], queryFn: () => getMyAccessContext() });

  if (access.isLoading) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!access.data?.isSuperAdmin) {
    return (
      <div className="min-h-screen grid place-items-center px-4">
        <div className="max-w-md w-full text-center space-y-3 border rounded-lg p-6 bg-card">
          <ShieldAlert className="h-6 w-6 mx-auto text-muted-foreground" />
          <h1 className="text-lg font-semibold">Access denied</h1>
          <p className="text-sm text-muted-foreground">You must be a super administrator to view this page.</p>
          <Link to="/" className="inline-flex items-center text-sm text-primary hover:underline">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to app
          </Link>
        </div>
      </div>
    );
  }

  return <AdminContent />;
}

function AdminContent() {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link to="/" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center">
              <ArrowLeft className="h-4 w-4 mr-1" /> App
            </Link>
            <span className="text-muted-foreground">/</span>
            <h1 className="text-sm font-semibold">Admin</h1>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 grid gap-6 md:grid-cols-[320px_1fr]">
        <GroupsList selectedGroupId={selectedGroupId} onSelect={setSelectedGroupId} />
        {selectedGroupId ? (
          <GroupDetail groupId={selectedGroupId} onDeleted={() => setSelectedGroupId(null)} />
        ) : (
          <div className="border rounded-lg p-6 text-sm text-muted-foreground grid place-items-center min-h-[240px]">
            Select or create a group to manage its members.
          </div>
        )}
      </main>
    </div>
  );
}

function GroupsList({
  selectedGroupId,
  onSelect,
}: {
  selectedGroupId: string | null;
  onSelect: (id: string) => void;
}) {
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: ["admin-groups"], queryFn: () => listGroups() });
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () => createGroup({ data: { name: name.trim() } }),
    onSuccess: (row) => {
      toast.success("Group created");
      setName("");
      qc.invalidateQueries({ queryKey: ["admin-groups"] });
      onSelect((row as { id: string }).id);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm">Groups</CardTitle>
        <Badge variant="secondary" className="text-xs">
          {groups.data?.length ?? 0}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
          className="flex gap-2"
        >
          <Input
            placeholder="New group name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" size="icon" disabled={!name.trim() || create.isPending}>
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          </Button>
        </form>

        {groups.isLoading && (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        )}

        <div className="space-y-1">
          {(groups.data ?? []).map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => onSelect(g.id)}
              className={`w-full text-left rounded-md px-3 py-2 text-sm border transition-colors ${
                selectedGroupId === g.id ? "bg-accent border-primary" : "hover:bg-accent border-transparent"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium truncate">{g.name}</span>
                {!g.is_active && (
                  <Badge variant="outline" className="text-[10px]">
                    inactive
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground flex items-center gap-3 mt-0.5">
                <span className="inline-flex items-center gap-1">
                  <Users className="h-3 w-3" /> {g.memberCount}
                </span>
                <span>{g.recordingCount} recordings</span>
              </div>
            </button>
          ))}
          {groups.data && groups.data.length === 0 && (
            <p className="text-xs text-muted-foreground">No groups yet.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function GroupDetail({ groupId, onDeleted }: { groupId: string; onDeleted: () => void }) {
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: ["admin-groups"], queryFn: () => listGroups() });
  const group = (groups.data ?? []).find((g) => g.id === groupId);

  const members = useQuery({
    queryKey: ["admin-group-members", groupId],
    queryFn: () => listGroupMembers({ data: { groupId } }),
  });

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [mode, setMode] = useState<"invite" | "password">("invite");
  const [tempPassword, setTempPassword] = useState("");

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["admin-groups"] });
    qc.invalidateQueries({ queryKey: ["admin-group-members", groupId] });
  };

  const rename = useMutation({
    mutationFn: (name: string) => updateGroup({ data: { id: groupId, name } }),
    onSuccess: () => invalidateAll(),
    onError: (e) => toast.error((e as Error).message),
  });

  const toggleActive = useMutation({
    mutationFn: (v: boolean) => updateGroup({ data: { id: groupId, isActive: v } }),
    onSuccess: () => invalidateAll(),
    onError: (e) => toast.error((e as Error).message),
  });

  const remove = useMutation({
    mutationFn: () => deleteGroup({ data: { id: groupId } }),
    onSuccess: () => {
      toast.success("Group deleted");
      onDeleted();
      qc.invalidateQueries({ queryKey: ["admin-groups"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const addUser = useMutation({
    mutationFn: () =>
      addUserToGroup({
        data: {
          groupId,
          email: newEmail.trim().toLowerCase(),
          mode,
          password: mode === "password" && tempPassword ? tempPassword : undefined,
        },
      }),
    onSuccess: (res) => {
      const r = res as { tempPassword: string | null; invited: boolean };
      if (r.tempPassword) {
        toast.success(`User created. Temporary password: ${r.tempPassword}`, { duration: 15000 });
      } else if (r.invited) {
        toast.success("Invitation email sent");
      } else {
        toast.success("Existing user added to group");
      }
      setNewEmail("");
      setTempPassword("");
      invalidateAll();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => removeUserFromGroup({ data: { userId } }),
    onSuccess: () => invalidateAll(),
    onError: (e) => toast.error((e as Error).message),
  });

  const resetPw = useMutation({
    mutationFn: (email: string) => sendPasswordReset({ data: { email } }),
    onSuccess: () => toast.success("Password reset email sent"),
    onError: (e) => toast.error((e as Error).message),
  });

  if (!group) {
    return (
      <div className="border rounded-lg p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading group…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 space-y-2">
              <Label className="text-xs text-muted-foreground">Group name</Label>
              <Input
                defaultValue={group.name}
                key={group.id + group.name}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim();
                  if (v && v !== group.name) rename.mutate(v);
                }}
              />
              <p className="text-xs text-muted-foreground">Slug: {group.slug}</p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <label className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Active</span>
                <Switch
                  checked={group.is_active}
                  onCheckedChange={(v) => toggleActive.mutate(v)}
                />
              </label>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-4 w-4 mr-1" /> Delete group
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <UserPlus className="h-4 w-4" /> Add user
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex-1 min-w-[220px] space-y-1.5">
              <Label htmlFor="new-email" className="text-xs">Email</Label>
              <Input
                id="new-email"
                type="email"
                placeholder="user@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Method</Label>
              <div className="flex rounded-md border overflow-hidden text-xs">
                <button
                  type="button"
                  className={`px-3 py-2 ${mode === "invite" ? "bg-accent" : ""}`}
                  onClick={() => setMode("invite")}
                >
                  Invite by email
                </button>
                <button
                  type="button"
                  className={`px-3 py-2 border-l ${mode === "password" ? "bg-accent" : ""}`}
                  onClick={() => setMode("password")}
                >
                  Set password
                </button>
              </div>
            </div>
            {mode === "password" && (
              <div className="space-y-1.5">
                <Label className="text-xs">Password (optional)</Label>
                <Input
                  type="text"
                  placeholder="Leave blank to auto-generate"
                  value={tempPassword}
                  onChange={(e) => setTempPassword(e.target.value)}
                />
              </div>
            )}
            <Button
              onClick={() => addUser.mutate()}
              disabled={!newEmail.trim() || addUser.isPending}
            >
              {addUser.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {mode === "invite"
              ? "Sends an invitation email; the user sets their own password."
              : "Creates the user immediately with the given password (or an auto-generated one shown after creation)."}{" "}
            Existing users can also sign in with Google using the same email.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4" /> Members ({members.data?.length ?? 0})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {members.isLoading && (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          )}
          {(members.data ?? []).map((m) => (
            <div
              key={m.userId}
              className="flex items-center justify-between rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{m.email ?? m.userId}</div>
                <div className="text-xs text-muted-foreground">
                  Added {new Date(m.createdAt).toLocaleDateString()}
                  {m.lastSignInAt && ` · last sign-in ${new Date(m.lastSignInAt).toLocaleDateString()}`}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {m.email && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resetPw.mutate(m.email as string)}
                    disabled={resetPw.isPending}
                  >
                    <KeyRound className="h-3.5 w-3.5 mr-1" /> Reset password
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => removeMember.mutate(m.userId)}
                  disabled={removeMember.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
          {members.data && members.data.length === 0 && (
            <p className="text-xs text-muted-foreground">No members yet.</p>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete group?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This removes the group, all memberships, and all of its recordings. This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false);
                remove.mutate();
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
