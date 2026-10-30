import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";
import { z } from "zod";
import { checkCustomerQuota, createSaasRouter, recordCustomerUsage, verifyCustomerApiKey } from "./saas.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const app = express();
const port = Number(process.env.PORT ?? 8787);
const timeoutMs = clamp(Number(process.env.REQUEST_TIMEOUT_MS ?? 30_000), 1_000, 120_000);
const maxBodyBytes = process.env.MAX_BODY_BYTES ?? "1mb";
const gatewayApiKey = process.env.GATEWAY_API_KEY?.trim();

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

type ProviderName = "groq" | "openrouter";
type Provider = { name: ProviderName; baseUrl: string; keys: string[]; headers: Record<string, string> };

function parseKeys(value: string | undefined): string[] {
  return (value ?? "").split(",").map((key) => key.trim()).filter(Boolean);
}

const providers: Provider[] = [
  {
    name: "groq",
    baseUrl: process.env.GROQ_BASE_URL?.trim() || "https://api.groq.com/openai/v1",
    keys: parseKeys(process.env.GROQ_API_KEYS),
    headers: {}
  },
  {
    name: "openrouter",
    baseUrl: process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1",
    keys: parseKeys(process.env.OPENROUTER_API_KEYS),
    headers: {
      ...(process.env.OPENROUTER_HTTP_REFERER ? { "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER } : {}),
      ...(process.env.OPENROUTER_APP_TITLE ? { "X-Title": process.env.OPENROUTER_APP_TITLE } : {})
    }
  }
];

const requestSchema = z.object({
  model: z.string().min(1).max(200),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(z.unknown())]),
    name: z.string().optional(),
    tool_call_id: z.string().optional()
  }).passthrough()).min(1).max(200),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().max(100_000).optional(),
  stream: z.boolean().optional()
}).passthrough();

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",").map((x) => x.trim()) ?? false }));
app.use(express.json({ limit: maxBodyBytes }));
app.use("/api/saas", createSaasRouter());
app.use(pinoHttp({ logger, redact: ["req.headers.authorization", "req.headers.x-api-key"] }));
// Serve the public product landing page while keeping the API endpoints on this same origin.
app.use(express.static("public", { index: "index.html", maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#080b10"><title>API FLOW — One endpoint. Fewer failures.</title><style>
  *{box-sizing:border-box}body{margin:0;background:#080b10;color:#f4f7fb;font:16px/1.6 system-ui,Segoe UI,sans-serif}a{color:inherit;text-decoration:none}.wrap{max-width:1100px;margin:auto;padding:0 24px}.nav{height:76px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ffffff18}.brand{font-weight:900;letter-spacing:.13em}.mark{display:inline-grid;place-items:center;background:#b8ff65;color:#10150b;border-radius:9px;width:34px;height:34px;margin-right:9px}.btn{display:inline-block;border:1px solid #344050;border-radius:9px;padding:10px 15px;font-weight:700}.hero{padding:90px 0 65px;max-width:780px}.eyebrow{color:#b8ff65;text-transform:uppercase;font-size:12px;font-weight:800;letter-spacing:.15em}h1{font-size:clamp(44px,8vw,78px);line-height:1.03;letter-spacing:-.06em;margin:20px 0}h1 span{color:#b8ff65}p{color:#a0adbd;font-size:18px;max-width:670px}.primary{background:#b8ff65;color:#10150b;border-color:#b8ff65}.actions{display:flex;flex-wrap:wrap;gap:12px;margin:28px 0}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding-bottom:70px}.card{padding:22px;border:1px solid #263241;border-radius:13px;background:#101720}.card h2{font-size:17px}.card p{font-size:14px;margin-bottom:0}.foot{border-top:1px solid #ffffff18;padding:25px 0;color:#7f8d9f;font-size:12px}@media(max-width:700px){.grid{grid-template-columns:1fr}.hero{padding:60px 0 45px}.wrap{padding:0 17px}}</style></head><body><header class="wrap nav"><a class="brand" href="/"><span class="mark">↗</span>API FLOW</a><a class="btn" href="/health">Gateway status ↗</a></header><main class="wrap"><section class="hero"><div class="eyebrow">AI infrastructure · Early access</div><h1>One endpoint.<br><span>Fewer failures.</span></h1><p>A developer-first gateway for OpenAI-compatible AI requests. Route through configured providers and keys, with automatic failover when an upstream is rate-limited or temporarily unavailable.</p><div class="actions"><a class="btn primary" href="#developers">Explore the API →</a><a class="btn" href="https://github.com/shamikghosh187-ux/API-FLOW">View on GitHub ↗</a></div><small style="color:#7f8d9f">Bring your own provider keys · Provider charges are separate</small></section><section class="grid"><article class="card"><h2>↻ Automatic failover</h2><p>Try configured keys when an upstream request fails or hits a rate limit.</p></article><article class="card"><h2>⌘ Familiar API</h2><p>Use an OpenAI-compatible chat-completions request shape through one gateway.</p></article><article class="card"><h2>◈ Developer first</h2><p>Keep provider credentials server-side and protect requests with gateway API keys.</p></article></section><section id="developers" style="padding-bottom:55px"><div class="eyebrow">Gateway status</div><p id="status">Checking API FLOW status…</p><a class="btn" href="/api/info">Explore API endpoints</a></section></main><footer class="wrap foot">© API FLOW · Early access</footer><script>fetch("/health",{cache:"no-store"}).then(r=>r.json()).then(d=>document.getElementById("status").textContent="Gateway is "+d.status+". Provider keys configured: "+d.providers.filter(p=>p.configured).length+".").catch(()=>document.getElementById("status").textContent="Status temporarily unavailable.")</script></body></html>`);
});

async function requireGatewayKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.header("authorization") ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? req.header("x-api-key");

  // Customer keys are hashed and verified against the dedicated SaaS database.
  if (bearer?.startsWith("af_live_")) {
    try {
      const customer = await verifyCustomerApiKey(bearer);
      if (!customer) {
        res.status(401).json({ error: { message: "Invalid or revoked API FLOW customer key.", type: "authentication_error" } });
        return;
      }
      res.locals.apiFlowCustomer = customer;
      next();
    } catch (error) {
      logger.error({ err: error }, "Customer key verification failed");
      res.status(503).json({ error: { message: "Customer key verification is temporarily unavailable.", type: "configuration_error" } });
    }
    return;
  }

  // Keep the single shared key for local development and controlled operator testing.
  if (!gatewayApiKey) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({ error: { message: "Customer API key or gateway authentication is not configured.", type: "configuration_error" } });
      return;
    }
    next();
    return;
  }
  if (!bearer || !safeEqual(bearer, gatewayApiKey)) {
    res.status(401).json({ error: { message: "Invalid or missing API FLOW key.", type: "authentication_error" } });
    return;
  }
  next();
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "api-flow",
    providers: providers.map((provider) => ({
      name: provider.name,
      configuredKeys: provider.keys.length,
      configured: provider.keys.length > 0
    }))
  });
});

app.get("/api/info", (_req, res) => {
  res.json({
    name: "API FLOW",
    description: "OpenAI-compatible API gateway with provider and API-key failover.",
    endpoints: { health: "/health", chatCompletions: "POST /v1/chat/completions" },
    limits: {
      dailyRequests: { free: 100, pro: 1000, business: 5000 },
      resetTime: "00:00 UTC",
      note: "Starter per-account request limits; not a billing meter or concurrency-safe reservation system."
    },
    features: {
      streaming: false,
      dailyRequestQuotas: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY),
      customerAccounts: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY && process.env.SUPABASE_SECRET_KEY),
      customerApiKeys: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY),
      usageAnalytics: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY),
      subscriptions: false
    }
  });
});

app.post("/v1/chat/completions", requireGatewayKey, async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: "Invalid chat completion request.",
        type: "invalid_request_error",
        details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      }
    });
    return;
  }

  if (parsed.data.stream) {
    res.status(400).json({
      error: { message: "Streaming is not supported yet. Set stream=false or omit it.", type: "unsupported_feature" }
    });
    return;
  }

  const available = providers.filter((provider) => provider.keys.length > 0);
  if (!available.length) {
    res.status(503).json({
      error: { message: "No providers configured. Add GROQ_API_KEYS and/or OPENROUTER_API_KEYS.", type: "configuration_error" }
    });
    return;
  }

  const customer = res.locals.apiFlowCustomer as { userId: string; keyId: string } | undefined;
  if (customer) {
    try {
      const quota = await checkCustomerQuota(customer.userId);
      if (!quota.allowed) {
        if (quota.reason === "unavailable") {
          res.status(503).json({ error: { message: "Usage controls are temporarily unavailable. Please retry shortly.", type: "quota_service_unavailable" } });
          return;
        }
        res.setHeader("X-RateLimit-Limit", String(quota.limit));
        res.setHeader("X-RateLimit-Remaining", "0");
        res.setHeader("X-RateLimit-Reset", String(Math.floor(new Date(quota.resetsAt).getTime() / 1000)));
        res.status(429).json({
          error: {
            message: "Daily API FLOW request allowance reached for your plan.",
            type: "rate_limit_error",
            plan: quota.plan,
            limit: quota.limit,
            used: quota.used,
            resetsAt: quota.resetsAt
          }
        });
        return;
      }
      res.setHeader("X-RateLimit-Limit", String(quota.limit));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(0, quota.limit - quota.used - 1)));
      res.setHeader("X-RateLimit-Reset", String(Math.floor(new Date(quota.resetsAt).getTime() / 1000)));
    } catch (quotaError) {
      logger.error({ err: quotaError }, "Customer quota check failed");
      res.status(503).json({ error: { message: "Usage controls are temporarily unavailable. Please retry shortly.", type: "quota_service_unavailable" } });
      return;
    }
  }

  const errors: Array<{ provider: ProviderName; status?: number; message: string }> = [];
  const attempts = available.flatMap((provider) =>
    provider.keys.map((key, keyIndex) => ({ provider, key, keyIndex }))
  );

  for (const attempt of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const upstream = await fetch(`${attempt.provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${attempt.key}`,
          "Content-Type": "application/json",
          ...attempt.provider.headers
        },
        body: JSON.stringify(parsed.data),
        signal: controller.signal
      });

      if (upstream.ok) {
        const payload = await upstream.json();
        logger.info({
          provider: attempt.provider.name,
          keyIndex: attempt.keyIndex,
          latencyMs: Date.now() - startedAt,
          status: upstream.status
        }, "Upstream request succeeded");
        const customer = res.locals.apiFlowCustomer as { userId: string; keyId: string } | undefined;
        if (customer) {
          try {
            await recordCustomerUsage({
              ...customer,
              provider: attempt.provider.name,
              model: typeof payload?.model === "string" ? payload.model : parsed.data.model,
              statusCode: upstream.status,
              latencyMs: Date.now() - startedAt,
              inputTokens: Number.isInteger(payload?.usage?.prompt_tokens) ? payload.usage.prompt_tokens : undefined,
              outputTokens: Number.isInteger(payload?.usage?.completion_tokens) ? payload.usage.completion_tokens : undefined
            });
          } catch (usageError) {
            logger.error({ err: usageError }, "Could not record customer usage");
          }
        }
        res.status(upstream.status).json(payload);
        return;
      }

      const bodyText = await upstream.text();
      errors.push({ provider: attempt.provider.name, status: upstream.status, message: bodyText.slice(0, 1_000) });
      logger.warn({
        provider: attempt.provider.name,
        keyIndex: attempt.keyIndex,
        latencyMs: Date.now() - startedAt,
        status: upstream.status
      }, "Upstream request failed");

      if (![401, 403, 408, 429, 500, 502, 503, 504].includes(upstream.status)) {
        const customer = res.locals.apiFlowCustomer as { userId: string; keyId: string } | undefined;
        if (customer) {
          try {
            await recordCustomerUsage({ ...customer, provider: attempt.provider.name, model: parsed.data.model, statusCode: upstream.status, latencyMs: Date.now() - startedAt });
          } catch (usageError) {
            logger.error({ err: usageError }, "Could not record customer usage");
          }
        }
        res.status(upstream.status).json({
          error: { message: "The provider rejected the request.", type: "upstream_error", provider: attempt.provider.name, status: upstream.status }
        });
        return;
      }
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError" ? "Upstream request timed out." : "Upstream network request failed.";
      errors.push({ provider: attempt.provider.name, message });
      logger.warn({ provider: attempt.provider.name, keyIndex: attempt.keyIndex, message }, "Upstream connection failed");
    } finally {
      clearTimeout(timer);
    }
  }

  const rateLimited = errors.some((error) => error.status === 429);
  const failedRequestCustomer = res.locals.apiFlowCustomer as { userId: string; keyId: string } | undefined;
  if (failedRequestCustomer) {
    try {
      await recordCustomerUsage({
        ...failedRequestCustomer,
        provider: errors.at(-1)?.provider ?? "other",
        model: parsed.data.model,
        statusCode: 502
      });
    } catch (usageError) {
      logger.error({ err: usageError }, "Could not record customer usage");
    }
  }
  res.status(502).json({
    error: {
      message: "All configured upstream attempts failed. Check provider keys, limits, and model availability.",
      type: rateLimited ? "upstream_rate_limit" : "upstream_unavailable",
      attempts: errors.map(({ provider, status }) => ({ provider, ...(status ? { status } : {}) }))
    }
  });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof SyntaxError) {
    res.status(400).json({ error: { message: "Malformed JSON body.", type: "invalid_request_error" } });
    return;
  }
  logger.error({ err }, "Unhandled request error");
  res.status(500).json({ error: { message: "Internal server error.", type: "internal_error" } });
});

app.listen(port, () => {
  logger.info({ port, providers: providers.map((provider) => ({ name: provider.name, keys: provider.keys.length })) }, "API Flow gateway started");
});
