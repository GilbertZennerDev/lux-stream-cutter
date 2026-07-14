import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Returns current user context: whether they are super admin and their group (if any). */
export const getMyAccessContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [roleRes, memRes] = await Promise.all([
      supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", context.userId)
        .eq("role", "super_admin")
        .maybeSingle(),
      supabaseAdmin
        .from("group_members")
        .select("group_id, groups(id,name,slug,is_active)")
        .eq("user_id", context.userId)
        .maybeSingle(),
    ]);
    if (roleRes.error) throw new Error(`Could not read admin role: ${roleRes.error.message}`);
    if (memRes.error) throw new Error(`Could not read group membership: ${memRes.error.message}`);
    return {
      userId: context.userId,
      isSuperAdmin: !!roleRes.data,
      group: memRes.data
        ? {
            id: (memRes.data as any).group_id as string,
            name: (memRes.data as any).groups?.name as string,
            slug: (memRes.data as any).groups?.slug as string,
            isActive: (memRes.data as any).groups?.is_active as boolean,
          }
        : null,
    };
  });

// ---------- Groups ----------

export const listGroups = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: adminRole, error: adminError } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "super_admin")
      .maybeSingle();
    if (adminError) throw new Error(adminError.message);
    if (!adminRole) throw new Error("Forbidden: super admin required");
    const { data: groups, error } = await supabaseAdmin
      .from("groups")
      .select("id, name, slug, notes, is_active, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const { data: counts } = await supabaseAdmin
      .from("group_members")
      .select("group_id");
    const memberCount = new Map<string, number>();
    for (const row of counts ?? []) {
      memberCount.set(row.group_id, (memberCount.get(row.group_id) ?? 0) + 1);
    }

    const { data: recCounts } = await supabaseAdmin
      .from("recordings")
      .select("group_id");
    const recCount = new Map<string, number>();
    for (const row of recCounts ?? []) {
      if (row.group_id) recCount.set(row.group_id, (recCount.get(row.group_id) ?? 0) + 1);
    }

    return (groups ?? []).map((g) => ({
      ...g,
      memberCount: memberCount.get(g.id) ?? 0,
      recordingCount: recCount.get(g.id) ?? 0,
    }));
  });

export const createGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ name: z.string().trim().min(1).max(80), notes: z.string().max(500).optional() }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: adminRole, error: adminError } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "super_admin")
      .maybeSingle();
    if (adminError) throw new Error(adminError.message);
    if (!adminRole) throw new Error("Forbidden: super admin required");
    const slugify = (s: string) =>
      s
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || `group-${Date.now()}`;
    const base = slugify(data.name);
    let slug = base;
    for (let i = 1; i < 20; i++) {
      const { data: exists } = await supabaseAdmin.from("groups").select("id").eq("slug", slug).maybeSingle();
      if (!exists) break;
      slug = `${base}-${i}`;
    }
    const { data: row, error } = await supabaseAdmin
      .from("groups")
      .insert({ name: data.name, slug, notes: data.notes ?? null })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(80).optional(),
        notes: z.string().max(500).nullable().optional(),
        isActive: z.boolean().optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: adminRole, error: adminError } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "super_admin")
      .maybeSingle();
    if (adminError) throw new Error(adminError.message);
    if (!adminRole) throw new Error("Forbidden: super admin required");
    const patch: { name?: string; notes?: string | null; is_active?: boolean } = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.notes !== undefined) patch.notes = data.notes;
    if (data.isActive !== undefined) patch.is_active = data.isActive;
    const { error } = await supabaseAdmin.from("groups").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: adminRole, error: adminError } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "super_admin")
      .maybeSingle();
    if (adminError) throw new Error(adminError.message);
    if (!adminRole) throw new Error("Forbidden: super admin required");
    const { error } = await supabaseAdmin.from("groups").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ---------- Members ----------

export const listGroupMembers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ groupId: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: adminRole, error: adminError } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "super_admin")
      .maybeSingle();
    if (adminError) throw new Error(adminError.message);
    if (!adminRole) throw new Error("Forbidden: super admin required");
    const { data: rows, error } = await supabaseAdmin
      .from("group_members")
      .select("user_id, created_at")
      .eq("group_id", data.groupId);
    if (error) throw new Error(error.message);

    const members: Array<{ userId: string; email: string | null; createdAt: string; lastSignInAt: string | null }> = [];
    for (const r of rows ?? []) {
      const { data: u } = await supabaseAdmin.auth.admin.getUserById(r.user_id);
      members.push({
        userId: r.user_id,
        email: u?.user?.email ?? null,
        createdAt: r.created_at,
        lastSignInAt: (u?.user?.last_sign_in_at as string | null) ?? null,
      });
    }
    return members;
  });

export const addUserToGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        groupId: z.string().uuid(),
        email: z.string().email(),
        mode: z.enum(["invite", "password"]).default("invite"),
        password: z.string().min(8).max(72).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: adminRole, error: adminError } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "super_admin")
      .maybeSingle();
    if (adminError) throw new Error(adminError.message);
    if (!adminRole) throw new Error("Forbidden: super admin required");

    // Find existing user by email
    let userId: string | null = null;
    const { data: existing } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const found = existing?.users?.find((u) => (u.email ?? "").toLowerCase() === data.email.toLowerCase());
    if (found) userId = found.id;

    let tempPassword: string | null = null;
    if (!userId) {
      if (data.mode === "password") {
        const pw = data.password ?? crypto.randomUUID().slice(0, 12) + "!A1";
        const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
          email: data.email,
          password: pw,
          email_confirm: true,
        });
        if (error) throw new Error(error.message);
        userId = created.user!.id;
        tempPassword = pw;
      } else {
        // invite by email
        const { data: invited, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(data.email);
        if (error) throw new Error(error.message);
        userId = invited.user!.id;
      }
    } else if (data.mode === "password") {
      // User already exists — apply the password the admin just entered so they can actually sign in.
      const pw = data.password ?? crypto.randomUUID().slice(0, 12) + "!A1";
      const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        password: pw,
        email_confirm: true,
      });
      if (error) throw new Error(error.message);
      tempPassword = pw;
    }

    // Enforce single-group membership via upsert on primary key user_id
    const { error: upErr } = await supabaseAdmin
      .from("group_members")
      .upsert({ user_id: userId, group_id: data.groupId });
    if (upErr) throw new Error(upErr.message);

    return { userId, tempPassword: null, invited: !found };
  });

export const removeUserFromGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ userId: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: adminRole, error: adminError } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "super_admin")
      .maybeSingle();
    if (adminError) throw new Error(adminError.message);
    if (!adminRole) throw new Error("Forbidden: super admin required");
    const { error } = await supabaseAdmin.from("group_members").delete().eq("user_id", data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const sendPasswordReset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ email: z.string().email() }).parse(i))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: adminRole, error: adminError } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "super_admin")
      .maybeSingle();
    if (adminError) throw new Error(adminError.message);
    if (!adminRole) throw new Error("Forbidden: super admin required");
    // generate a recovery link and let Supabase email it
    const { error } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email: data.email,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
