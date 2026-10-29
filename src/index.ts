import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";
import { z } from "zod";
import { createSaasRouter, recordCustomerUsage, verifyCustomerApiKey } from "./saas.js";

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
    features: {
      streaming: false,
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
  const customer = res.locals.apiFlowCustomer as { userId: string; keyId: string } | undefined;
  if (customer) {
    try {
      await recordCustomerUsage({
        ...customer,
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
