import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";
import { z } from "zod";

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
app.use(pinoHttp({ logger, redact: ["req.headers.authorization", "req.headers.x-api-key"] }));

function requireGatewayKey(req: Request, res: Response, next: NextFunction): void {
  // Local development can run without a client key, but production must be configured.
  if (!gatewayApiKey) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({ error: { message: "Gateway authentication is not configured.", type: "configuration_error" } });
      return;
    }
    next();
    return;
  }
  const auth = req.header("authorization") ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? req.header("x-api-key");
  if (!bearer || !safeEqual(bearer, gatewayApiKey)) {
    res.status(401).json({ error: { message: "Invalid or missing API Flow key.", type: "authentication_error" } });
    return;
  }
  next();
}

function safeEqual(a: string, b: string): boolean {
  // Compare equal-length buffers without a content-dependent early exit.
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

app.get("/", (_req, res) => {
  res.json({
    name: "API Flow",
    description: "OpenAI-compatible API gateway with provider and API-key failover.",
    endpoints: { health: "/health", chatCompletions: "POST /v1/chat/completions" }
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
  // Try each configured key exactly once per request, preserving provider order.
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
        res.status(upstream.status).json(payload);
        return;
      }

      const bodyText = await upstream.text();
      const safeMessage = bodyText.slice(0, 1_000);
      errors.push({ provider: attempt.provider.name, status: upstream.status, message: safeMessage });
      logger.warn({
        provider: attempt.provider.name,
        keyIndex: attempt.keyIndex,
        latencyMs: Date.now() - startedAt,
        status: upstream.status
      }, "Upstream request failed");

      // Fail over on auth, rate limits, server errors, and transient gateway errors.
      // Other client errors (for example an invalid model) are unlikely to improve with another key.
      if (![401, 403, 408, 429, 500, 502, 503, 504].includes(upstream.status)) {
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