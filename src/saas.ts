import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

type AuthUser = { id: string; email?: string };
type SaasRequest = Request & { saasUser?: AuthUser };

const signupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(128),
  displayName: z.string().trim().min(1).max(80).optional()
});
const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(128)
});
const createKeySchema = z.object({ name: z.string().trim().min(1).max(80) });

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { message } });
}

export async function verifyCustomerApiKey(rawKey: string): Promise<{ userId: string; keyId: string } | null> {
  const url = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !secretKey || !rawKey.startsWith("af_live_")) return null;
  const admin = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const keyHash = hashKey(rawKey);
  const { data, error } = await admin.from("api_keys")
    .select("id, user_id")
    .eq("key_hash", keyHash).is("revoked_at", null)
    .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
    .maybeSingle();
  if (error || !data) return null;
  void admin.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return { userId: data.user_id, keyId: data.id };
}

export async function recordCustomerUsage(input: {
  userId: string;
  keyId: string;
  provider: "groq" | "openrouter" | "other";
  model?: string;
  statusCode: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}): Promise<void> {
  const url = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !secretKey) return;
  const admin = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await admin.from("usage_events").insert({
    user_id: input.userId,
    api_key_id: input.keyId,
    provider: input.provider,
    model: input.model?.slice(0, 200) ?? null,
    status_code: Math.min(599, Math.max(100, Math.trunc(input.statusCode))),
    latency_ms: input.latencyMs == null ? null : Math.max(0, Math.trunc(input.latencyMs)),
    input_tokens: input.inputTokens == null ? null : Math.max(0, Math.trunc(input.inputTokens)),
    output_tokens: input.outputTokens == null ? null : Math.max(0, Math.trunc(input.outputTokens))
  });
  if (error) throw new Error("Usage event could not be recorded");
}

export function createSaasRouter(): Router {
  const router = Router();
  const url = process.env.SUPABASE_URL?.trim();
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!url || !publishableKey || !secretKey) {
    router.use((_req, res) => publicError(res, 503, "SaaS authentication is not configured on the server."));
    return router;
  }

  const authClient = createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
  });
  const admin: SupabaseClient = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
  });

  async function requireUser(req: SaasRequest, res: Response, next: (error?: unknown) => void): Promise<void> {
    const token = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
      publicError(res, 401, "Sign in first.");
      return;
    }
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) {
      publicError(res, 401, "Session is invalid or expired.");
      return;
    }
    req.saasUser = { id: data.user.id, email: data.user.email };
    next();
  }

  router.post("/signup", async (req, res) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      publicError(res, 400, "Provide a valid email, a password of at least 10 characters, and an optional display name.");
      return;
    }
    const { email, password, displayName } = parsed.data;
    const { data, error } = await authClient.auth.signUp({
      email,
      password,
      options: { data: displayName ? { display_name: displayName } : {} }
    });
    if (error || !data.user) {
      publicError(res, 400, error?.message ?? "Could not create account.");
      return;
    }
    const { error: profileError } = await admin.from("profiles").upsert({
      id: data.user.id,
      display_name: displayName ?? null
    }, { onConflict: "id" });
    if (profileError) {
      // The Auth account remains valid; tell the client the setup needs retrying rather than exposing DB details.
      publicError(res, 500, "Account was created, but profile setup failed. Contact support before creating API keys.");
      return;
    }
    res.status(201).json({
      user: { id: data.user.id, email: data.user.email },
      session: data.session,
      emailConfirmationRequired: !data.session
    });
  });

  router.post("/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      publicError(res, 400, "Provide a valid email and password.");
      return;
    }
    const { data, error } = await authClient.auth.signInWithPassword(parsed.data);
    if (error || !data.user) {
      publicError(res, 401, "Email or password is incorrect, or email confirmation is required.");
      return;
    }
    // Repair a missing profile safely after signup or an interrupted request.
    const { error: profileError } = await admin.from("profiles").upsert({
      id: data.user.id,
      display_name: typeof data.user.user_metadata?.display_name === "string"
        ? data.user.user_metadata.display_name.slice(0, 80)
        : null
    }, { onConflict: "id", ignoreDuplicates: true });
    if (profileError) {
      publicError(res, 500, "Could not load account profile.");
      return;
    }
    res.json({ user: { id: data.user.id, email: data.user.email }, session: data.session });
  });

  router.get("/me", requireUser, async (req: SaasRequest, res) => {
    const { data, error } = await admin.from("profiles")
      .select("id, display_name, plan, created_at")
      .eq("id", req.saasUser!.id).maybeSingle();
    if (error || !data) {
      publicError(res, 404, "Account profile not found.");
      return;
    }
    res.json({ user: { id: req.saasUser!.id, email: req.saasUser!.email }, profile: data });
  });

  router.get("/usage", requireUser, async (req: SaasRequest, res) => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await admin.from("usage_events")
      .select("id, api_key_id, provider, model, status_code, latency_ms, input_tokens, output_tokens, created_at")
      .eq("user_id", req.saasUser!.id).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(500);
    if (error) { publicError(res, 500, "Could not load usage history."); return; }
    const events = data ?? [];
    res.json({
      period: "30d",
      totalRequests: events.length,
      successfulRequests: events.filter((event) => event.status_code >= 200 && event.status_code < 400).length,
      failedRequests: events.filter((event) => event.status_code >= 400).length,
      totalInputTokens: events.reduce((sum, event) => sum + (event.input_tokens ?? 0), 0),
      totalOutputTokens: events.reduce((sum, event) => sum + (event.output_tokens ?? 0), 0),
      events
    });
  });

  router.get("/keys", requireUser, async (req: SaasRequest, res) => {
    const { data, error } = await admin.from("api_keys")
      .select("id, name, key_prefix, last_used_at, expires_at, revoked_at, created_at")
      .eq("user_id", req.saasUser!.id).order("created_at", { ascending: false }).limit(100);
    if (error) {
      publicError(res, 500, "Could not load API keys.");
      return;
    }
    res.json({ keys: data ?? [] });
  });

  router.post("/keys", requireUser, async (req: SaasRequest, res) => {
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) {
      publicError(res, 400, "Key name must be between 1 and 80 characters.");
      return;
    }
    const { count, error: countError } = await admin.from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("user_id", req.saasUser!.id).is("revoked_at", null);
    if (countError) {
      publicError(res, 500, "Could not check API key limits.");
      return;
    }
    if ((count ?? 0) >= 5) {
      publicError(res, 429, "Free-tier starter limit is 5 active API keys.");
      return;
    }
    const secret = `af_live_${randomBytes(32).toString("base64url")}`;
    const { data, error } = await admin.from("api_keys").insert({
      user_id: req.saasUser!.id,
      name: parsed.data.name,
      key_prefix: secret.slice(0, 16),
      key_hash: hashKey(secret)
    }).select("id, name, key_prefix, created_at").single();
    if (error || !data) {
      publicError(res, 500, "Could not create API key.");
      return;
    }
    res.status(201).json({
      key: { ...data, secret, warning: "Copy this secret now. It cannot be shown again." }
    });
  });

  router.delete("/keys/:id", requireUser, async (req: SaasRequest, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      publicError(res, 400, "Invalid API key ID.");
      return;
    }
    const { data, error } = await admin.from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id.data).eq("user_id", req.saasUser!.id).is("revoked_at", null)
      .select("id").maybeSingle();
    if (error) {
      publicError(res, 500, "Could not revoke API key.");
      return;
    }
    if (!data) {
      publicError(res, 404, "Active API key not found.");
      return;
    }
    res.json({ revoked: true, id: data.id });
  });

  return router;
}
