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
  res.type("html").send("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"theme-color\" content=\"#07090d\"><meta name=\"description\" content=\"API FLOW — cinematic, resilient AI infrastructure for developers.\"><title>API FLOW — Intelligence in motion</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\"><link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin><link href=\"https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Manrope:wght@400;500;600;700;800&display=swap\" rel=\"stylesheet\">\n<style>\n:root{color-scheme:dark;--bg:#07090d;--panel:#10151d;--line:#242c38;--text:#f3f5f8;--muted:#98a2b3;--lime:#c4ff68;--violet:#a99bff}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 Manrope,system-ui,sans-serif;overflow-x:hidden}body:before{content:\"\";position:fixed;inset:0;pointer-events:none;z-index:-1;background:radial-gradient(ellipse at 80% 0%,#263c2a45,transparent 35%),radial-gradient(ellipse at 10% 50%,#20203b22,transparent 40%)}a{color:inherit;text-decoration:none}.wrap{width:min(1190px,calc(100% - 48px));margin:auto}.top{height:82px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ffffff12}.brand{display:flex;align-items:center;gap:11px;font-size:15px;font-weight:800;letter-spacing:.14em}.logo{width:38px;height:38px;display:grid;place-items:center;border-radius:12px;background:var(--lime);color:#10160a;box-shadow:0 0 35px #c4ff6820}.logo svg{width:22px;height:22px}.nav{display:flex;gap:29px;color:#a5afbd;font-size:12px}.nav a:hover{color:white}.top-actions{display:flex;gap:10px;align-items:center}.btn{display:inline-flex;align-items:center;justify-content:center;gap:9px;padding:12px 17px;border-radius:9px;border:1px solid #323b49;background:#111720;font:700 12px Manrope,sans-serif;transition:.2s}.btn:hover{transform:translateY(-2px);border-color:#6e7a89}.btn.primary{background:var(--lime);color:#101609;border-color:var(--lime)}.btn.primary:hover{box-shadow:0 0 28px #c4ff6825}.tiny{font:10px 'DM Mono',monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--lime)}.hero{min-height:670px;padding:90px 0 75px;display:grid;grid-template-columns:1fr 1fr;gap:60px;align-items:center}.pill{display:inline-flex;align-items:center;gap:9px;padding:7px 11px;border:1px solid #343d48;border-radius:99px;color:#c0c9d5;font-size:10px;letter-spacing:.07em;text-transform:uppercase}.pulse{width:6px;height:6px;border-radius:50%;background:var(--lime);box-shadow:0 0 12px var(--lime)}h1{font-size:clamp(48px,6vw,78px);line-height:.99;letter-spacing:-.075em;margin:25px 0 23px;font-weight:800}h1 span{color:var(--lime)}.lead{font-size:16px;line-height:1.9;color:#a4adba;max-width:510px}.actions{display:flex;gap:11px;flex-wrap:wrap;margin:29px 0 22px}.micro{color:#778394;font-size:11px}.visual{position:relative;min-height:485px;isolation:isolate}.orb{position:absolute;width:360px;height:360px;border-radius:50%;right:10%;top:6%;background:radial-gradient(circle at 35% 30%,#d2ff8d 0,#8ebf5a 12%,#273b2a 35%,#0d1315 67%,transparent 70%);filter:drop-shadow(0 0 70px #a9e96a20);opacity:.88}.orbit{position:absolute;inset:6% 1% 3% 4%;border:1px solid #a8c98e24;border-radius:50%;transform:rotate(-25deg) scaleY(.48)}.orbit.two{inset:12% -2% 0 1%;transform:rotate(35deg) scaleY(.52);border-color:#b2a6ff2c}.star{position:absolute;color:var(--lime);font-size:22px;filter:drop-shadow(0 0 15px #c4ff68)}.star.s1{top:12%;right:20%}.star.s2{top:55%;left:7%;font-size:13px}.glass{position:absolute;z-index:2;background:linear-gradient(135deg,#171e28eF,#0c1018f5);border:1px solid #ffffff1a;border-radius:14px;box-shadow:0 25px 80px #0008;backdrop-filter:blur(16px)}.route-card{width:270px;right:0;top:11%;padding:17px}.card-top{display:flex;align-items:center;justify-content:space-between;color:#a7b1c0;font:10px 'DM Mono',monospace;letter-spacing:.06em}.live{color:var(--lime)}.provider{display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid #ffffff0b}.provider:last-child{border:0;padding-bottom:0}.provider-icon{width:34px;height:34px;display:grid;place-items:center;background:#202a25;border:1px solid #ffffff12;border-radius:10px;color:var(--lime)}.provider strong{display:block;font-size:11px}.provider small{display:block;color:#7e8998;font-size:9px}.provider .state{margin-left:auto;color:var(--lime);font:9px 'DM Mono',monospace}.terminal{left:0;bottom:8%;width:310px;padding:16px}.terminal-head{display:flex;gap:5px;margin-bottom:14px}.terminal-head i{width:6px;height:6px;border-radius:50%;background:#536070}.terminal pre{white-space:pre-wrap;margin:0;color:#b8c3d2;font:10px/2 'DM Mono',monospace}.g{color:var(--lime)}.v{color:var(--violet)}.latency{right:2%;bottom:2%;padding:12px 16px;width:166px}.latency b{font-size:24px;letter-spacing:-.05em}.latency small{display:block;color:#9aa5b5;font-size:9px}.wave{display:flex;align-items:end;gap:3px;height:25px;margin-top:7px}.wave i{display:block;width:4px;border-radius:5px;background:var(--lime);opacity:.8}.section{padding:66px 0}.section-heading{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:24px}.section-heading h2{font-size:32px;line-height:1.15;letter-spacing:-.055em;margin:10px 0}.section-heading p{max-width:420px;color:var(--muted);font-size:12px}.image-grid{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:15px}.image-card{position:relative;min-height:290px;overflow:hidden;border:1px solid #ffffff19;border-radius:15px;background:#111720}.image-card img{position:absolute;width:100%;height:100%;inset:0;object-fit:cover;opacity:.65;transition:transform .65s,opacity .4s}.image-card:hover img{transform:scale(1.06);opacity:.8}.image-card:after{content:\"\";position:absolute;inset:0;background:linear-gradient(180deg,#080b1000 5%,#080b1080 52%,#080b10 100%)}.image-content{position:absolute;z-index:1;bottom:0;left:0;right:0;padding:23px}.iconbox{width:39px;height:39px;display:grid;place-items:center;border:1px solid #ffffff2b;background:#080b10a8;backdrop-filter:blur(8px);border-radius:11px;margin-bottom:14px;color:var(--lime)}.iconbox svg{width:20px;height:20px}.image-content h3{font-size:17px;margin:0 0 6px}.image-content p{font-size:11px;line-height:1.8;color:#c2c8d2;margin:0;max-width:290px}.section-line{border-top:1px solid #ffffff12}.feature-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.feature{padding:24px;border:1px solid var(--line);border-radius:13px;background:linear-gradient(145deg,#131922,#0b0f15)}.feature .iconbox{margin-bottom:20px}.feature h3{margin:0 0 8px;font-size:14px}.feature p{margin:0;color:var(--muted);font-size:12px;line-height:1.9}.demo{display:grid;grid-template-columns:.8fr 1.2fr;gap:38px;align-items:center;padding:36px;border:1px solid #ffffff19;border-radius:18px;background:radial-gradient(ellipse at 95% 5%,#25392a7a,transparent 38%),#0e131a}.demo h2{font-size:35px;line-height:1.1;letter-spacing:-.06em;margin:13px 0}.demo p{color:var(--muted);font-size:12px;line-height:1.9}.code{border:1px solid #2a3442;border-radius:11px;overflow:hidden;background:#070a0f}.codebar{display:flex;justify-content:space-between;padding:12px 15px;border-bottom:1px solid #ffffff12;color:#7d8999;font:9px 'DM Mono',monospace}.code pre{padding:19px;margin:0;overflow:auto;color:#cad3de;font:11px/2 'DM Mono',monospace}.statusnote{display:none;margin-top:16px;padding:12px 14px;border:1px solid #384a30;border-radius:9px;color:#d6edc8;background:#101a11;font-size:11px}.footer{display:flex;justify-content:space-between;gap:20px;padding:28px 0 35px;border-top:1px solid #ffffff12;color:#748092;font-size:10px}.footbrand{display:flex;align-items:center;gap:8px}.footbrand .logo{width:25px;height:25px;border-radius:8px}.footbrand .logo svg{width:15px}.mono{font:10px 'DM Mono',monospace;color:#8994a3}@media(max-width:900px){.hero{grid-template-columns:1fr;gap:20px;padding-top:65px}.visual{max-width:600px;width:100%;margin:auto}.image-grid{grid-template-columns:1fr 1fr}.image-card:first-child{grid-column:span 2}.demo{grid-template-columns:1fr}.nav{display:none}}@media(max-width:580px){.wrap{width:calc(100% - 34px)}.top{height:70px}.top-actions .btn:first-child{display:none}.hero{padding:54px 0 45px}h1{font-size:51px}.visual{min-height:390px;transform:scale(.92);transform-origin:top center;margin-bottom:-25px}.orb{width:290px;height:290px}.route-card{width:230px;right:0}.terminal{width:260px;bottom:5%}.latency{right:0;bottom:0}.image-grid,.feature-grid{grid-template-columns:1fr}.image-card:first-child{grid-column:auto}.image-card{min-height:250px}.section{padding:48px 0}.section-heading{display:block}.section-heading h2{font-size:28px}.demo{padding:22px}.demo h2{font-size:30px}.footer{flex-direction:column}}\n</style></head>\n<body>\n<header class=\"wrap top\"><a class=\"brand\" href=\"/\"><span class=\"logo\"><svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M4 16.5 10 5l3.1 6H20M14.5 19 20 11\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M4 19h7\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"/></svg></span>API FLOW</a><nav class=\"nav\"><a href=\"#platform\">Platform</a><a href=\"#features\">Capabilities</a><a href=\"#developers\">Developers</a></nav><div class=\"top-actions\"><span class=\"pill\"><i class=\"pulse\"></i><span id=\"live-status\">Checking gateway</span></span><a class=\"btn\" href=\"https://github.com/shamikghosh187-ux/API-FLOW\" target=\"_blank\" rel=\"noreferrer\">GitHub ↗</a></div></header>\n<main class=\"wrap\">\n<section class=\"hero\"><div><div class=\"pill\"><i class=\"pulse\"></i> AI INFRASTRUCTURE · EARLY ACCESS</div><h1>Intelligence<br>in <span>motion.</span></h1><p class=\"lead\">One resilient API layer between your product and the models behind it. Route across configured providers and keys, recover from upstream failures, and keep your integration beautifully simple.</p><div class=\"actions\"><a class=\"btn primary\" href=\"#developers\">Explore the gateway <span>↗</span></a><a class=\"btn\" href=\"#platform\">See the platform <span>↓</span></a></div><div class=\"micro\">YOUR KEYS · YOUR MODELS · ONE CONSISTENT INTERFACE</div><div class=\"statusnote\" id=\"status-note\"></div></div>\n<div class=\"visual\" aria-label=\"Illustration of an AI routing network\"><div class=\"orb\"></div><div class=\"orbit\"></div><div class=\"orbit two\"></div><span class=\"star s1\">✳</span><span class=\"star s2\">✦</span>\n<div class=\"glass route-card\"><div class=\"card-top\"><span>ROUTING NETWORK</span><span class=\"live\">● ACTIVE</span></div><div class=\"provider\"><span class=\"provider-icon\"><svg viewBox=\"0 0 24 24\" width=\"18\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\"><path d=\"M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z\"/><path d=\"m4 7.5 8 4.5 8-4.5M12 12v9\"/></svg></span><div><strong>Primary provider</strong><small>Preferred route</small></div><span class=\"state\">01</span></div><div class=\"provider\"><span class=\"provider-icon\"><svg viewBox=\"0 0 24 24\" width=\"18\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\"><path d=\"M4 12h16M12 4v16\"/><circle cx=\"12\" cy=\"12\" r=\"8\"/></svg></span><div><strong>Fallback provider</strong><small>Next eligible key</small></div><span class=\"state\">02</span></div><div class=\"provider\"><span class=\"provider-icon\">✓</span><div><strong>Response delivered</strong><small>Same endpoint</small></div><span class=\"state\">OK</span></div></div>\n<div class=\"glass terminal\"><div class=\"terminal-head\"><i></i><i></i><i></i><span class=\"mono\" style=\"margin-left:6px\">request.flow</span></div><pre><span class=\"v\">POST</span> /v1/chat/completions\n<span class=\"g\">→</span> evaluate available routes\n<span class=\"g\">→</span> retry eligible failures\n<span class=\"g\">→</span> return provider response\n<span style=\"color:#7d8999\"># One integration. Multiple paths.</span></pre></div>\n<div class=\"glass latency\"><div class=\"tiny\">Gateway health</div><b id=\"health-big\">Checking</b><small id=\"health-caption\">Verifying live endpoint</small><div class=\"wave\"><i style=\"height:7px\"></i><i style=\"height:13px\"></i><i style=\"height:19px\"></i><i style=\"height:11px\"></i><i style=\"height:23px\"></i><i style=\"height:16px\"></i><i style=\"height:9px\"></i><i style=\"height:20px\"></i><i style=\"height:13px\"></i><i style=\"height:24px\"></i><i style=\"height:12px\"></i><i style=\"height:17px\"></i><i style=\"height:7px\"></i><i style=\"height:21px\"></i><i style=\"height:11px\"></i><i style=\"height:18px\"></i></div></div></div></section>\n<section class=\"section section-line\" id=\"platform\"><div class=\"section-heading\"><div><div class=\"tiny\">Designed for the next layer</div><h2>Infrastructure that stays<br>out of your way.</h2></div><p>Clean routing primitives, resilient request handling, and a developer experience designed to feel effortless.</p></div>\n<div class=\"image-grid\">\n<article class=\"image-card\"><img src=\"https://images.unsplash.com/photo-1634017839464-5c339ebe3cb4?auto=format&fit=crop&w=1100&q=85\" alt=\"Abstract luminous violet and blue digital light forms\" loading=\"lazy\"><div class=\"image-content\"><div class=\"iconbox\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"><path d=\"M12 3v4m0 10v4M3 12h4m10 0h4M5.6 5.6l2.8 2.8m7.2 7.2 2.8 2.8m0-12.8-2.8 2.8m-7.2 7.2-2.8 2.8\"/><circle cx=\"12\" cy=\"12\" r=\"4\"/></svg></div><h3>Intelligent routing</h3><p>Keep provider choices behind one stable integration point.</p></div></article>\n<article class=\"image-card\"><img src=\"https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=900&q=85\" alt=\"Deep night sky filled with stars\" loading=\"lazy\"><div class=\"image-content\"><div class=\"iconbox\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"><path d=\"M12 3 4.5 6v5.5c0 4.5 3.2 7.6 7.5 9.5 4.3-1.9 7.5-5 7.5-9.5V6L12 3Z\"/><path d=\"m8.5 12 2.2 2.2 4.8-4.8\"/></svg></div><h3>Resilience by design</h3><p>Retry eligible upstream failures across configured keys.</p></div></article>\n<article class=\"image-card\"><img src=\"https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=900&q=85\" alt=\"Glowing interconnected planet and network lines\" loading=\"lazy\"><div class=\"image-content\"><div class=\"iconbox\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"13\" rx=\"2\"/><path d=\"M8 21h8m-4-4v4M7 9h4m-4 3h7\"/></svg></div><h3>Developer-first</h3><p>Familiar API patterns, clear status, and server-side secrets.</p></div></article>\n</div></section>\n<section class=\"section\" id=\"features\"><div class=\"section-heading\"><div><div class=\"tiny\">Core capabilities</div><h2>Small surface. Serious intent.</h2></div><p>Built around practical infrastructure features instead of adding complexity to your stack.</p></div><div class=\"feature-grid\">\n<article class=\"feature\"><div class=\"iconbox\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"><path d=\"M20 7v5h-5M4 17v-5h5\"/><path d=\"M6.1 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 11.9-3\"/></svg></div><h3>Automatic failover</h3><p>Move to another configured key when a provider is rate-limited or hits eligible transient errors.</p></article>\n<article class=\"feature\"><div class=\"iconbox\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"><path d=\"M12 3 4 7v10l8 4 8-4V7l-8-4Z\"/><path d=\"m4 7 8 4 8-4M12 11v10\"/></svg></div><h3>One consistent endpoint</h3><p>Keep integrations aligned around an OpenAI-compatible chat-completions request shape.</p></article>\n<article class=\"feature\"><div class=\"iconbox\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"><rect x=\"4\" y=\"10\" width=\"16\" height=\"11\" rx=\"2\"/><path d=\"M8 10V7a4 4 0 0 1 8 0v3m-4 5v2\"/></svg></div><h3>Security-conscious core</h3><p>Provider credentials stay server-side, with gateway key checks and authorization-log redaction.</p></article>\n</div></section>\n<section class=\"section\" id=\"developers\"><div class=\"demo\"><div><div class=\"tiny\">Made for builders</div><h2>Ship your idea.<br>Keep the API simple.</h2><p>API FLOW is an early-access gateway. Configure your own provider keys on the server, then send a request through the same endpoint.</p><p>Provider usage and billing remain subject to each provider's terms. Streaming and paid plans are not live yet.</p><a class=\"btn primary\" href=\"https://github.com/shamikghosh187-ux/API-FLOW\" target=\"_blank\" rel=\"noreferrer\">Read the repository ↗</a></div><div class=\"code\"><div class=\"codebar\"><span>QUICK START / CURL</span><span>JSON</span></div><pre><span class=\"v\">curl</span> /v1/chat/completions \\\n  -H <span class=\"g\">\"Content-Type: application/json\"</span> \\\n  -H <span class=\"g\">\"Authorization: Bearer YOUR_GATEWAY_KEY\"</span> \\\n  -d '{\n    \"model\": \"llama-3.3-70b-versatile\",\n    \"messages\": [\n      {\"role\": \"user\", \"content\": \"Hello, API FLOW\"}\n    ],\n    \"stream\": false\n  }'</pre></div></div></section>\n</main><footer class=\"wrap footer\"><div class=\"footbrand\"><span class=\"logo\"><svg viewBox=\"0 0 24 24\" fill=\"none\"><path d=\"M4 16.5 10 5l3.1 6H20M14.5 19 20 11M4 19h7\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg></span><span>API FLOW · INTELLIGENCE IN MOTION</span></div><span>© <span id=\"year\"></span> API FLOW. Early access build.</span><span>One API. Multiple paths.</span></footer>\n<script>document.getElementById(\"year\").textContent=new Date().getFullYear();async function checkStatus(){try{const r=await fetch(\"/health\",{cache:\"no-store\"});if(!r.ok)throw Error(\"status\");const d=await r.json();document.getElementById(\"live-status\").textContent=\"GATEWAY ONLINE\";document.getElementById(\"health-big\").textContent=\"Online\";document.getElementById(\"health-caption\").textContent=(d.providers||[]).filter(p=>p.configured).length+\" provider(s) configured\";const n=document.getElementById(\"status-note\");n.style.display=\"block\";n.textContent=(d.providers||[]).some(p=>p.configured)?\"Gateway responds. Provider credentials are configured; live upstream availability is not guaranteed.\":\"Gateway responds, but provider API keys are not configured on this server yet.\"}catch{document.getElementById(\"live-status\").textContent=\"STATUS UNAVAILABLE\";document.getElementById(\"health-big\").textContent=\"Offline\";document.getElementById(\"health-caption\").textContent=\"Endpoint could not be reached\"}}checkStatus();</script>\n</body></html>");
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
