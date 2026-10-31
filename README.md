# API FLOW

**One API. Automatic failover.**

API FLOW is an early-stage, self-hostable OpenAI-compatible gateway. It forwards chat-completion requests to configured providers and tries eligible keys in sequence when an upstream returns an authentication failure, rate limit, timeout, network error, or selected server errors.

## Current capabilities

- Public product landing page served from `public/index.html`, with a customer console at `public/dashboard.html`.
- OpenAI-compatible `POST /v1/chat/completions` endpoint.
- Multiple keys for Groq, OpenRouter, OpenAI, DeepSeek, and Mistral configured server-side using OpenAI-compatible chat-completions APIs.
- Sequential provider/key failover for selected transient errors.
- Shared operator key authentication for controlled testing, plus individual customer API-key verification when Supabase server credentials are configured.
- Supabase-backed signup/login endpoints, account profile lookup, and customer API-key create/list/revoke endpoints.
- Customer dashboard for key management and recent usage summaries.
- Request validation, request timeout, body-size limit, Helmet security headers, and redacted authorization logs.
- `GET /health` endpoint showing whether provider keys are configured without revealing them.
- `GET /api/info` endpoint describing current implementation status.
- Automated HTTP tests, including a mock-upstream test proving failover after a simulated 429.

## SaaS database foundation

A starter Supabase migration is available at `supabase/migrations/202610290001_api_flow_saas_foundation.sql`. It defines customer profiles, hashed customer API-key records, request usage events, indexes, and restrictive row-level security policies.

The migration is applied to the dedicated API FLOW Supabase project. The server includes signup/login, profile lookup, customer API-key create/list/revoke routes, usage event recording for customer-key gateway requests, and a `/api/saas/usage` endpoint. The dashboard lets customers manage keys and inspect recent request records. API key secrets are returned once and only hashes are stored. Browser clients cannot directly read or write API-key or usage-event records. Daily request quotas are enforced using recorded request events: Free 100/day, Pro 1,000/day, and Business 5,000/day (UTC reset). These are starter limits, not a concurrency-safe billing meter; plan upgrades are not self-service. Billing, robust IP rate limiting/abuse protection, email verification UX, and production tests remain to be completed.

## Important: what is not implemented yet

The website includes **proposed** Free, Pro, and Business prices for product direction only. They are not purchasable plans and do not represent a live subscription service. The backend currently applies starter daily request limits based on the profile plan; customers cannot purchase or self-select paid plans.

Not implemented yet:
- Token-based quotas, atomic concurrent quota reservations, and plan upgrades.
- Billing, subscription management, and payment enforcement.
- Production-grade IP rate limiting and abuse protection.
- Payments, subscription management, invoicing, or billing enforcement.
- Streaming responses.
- Production-grade persistent provider health and cooldown management.
- Live integration tests using real provider credentials.

Do not expose this early gateway as a public multi-customer API service until customer authentication, quotas, abuse protection, secret management, and usage/billing controls are implemented and tested.

## Requirements

- Node.js 20+
- One or more provider API keys from providers you are authorized to use.

## Run locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the example environment file.

   Windows PowerShell:
   ```powershell
   Copy-Item .env.example .env
   ```

   macOS/Linux:
   ```bash
   cp .env.example .env
   ```

3. Edit `.env`. Add comma-separated keys to `GROQ_API_KEYS`, `OPENROUTER_API_KEYS`, `OPENAI_API_KEYS`, `DEEPSEEK_API_KEYS`, and/or `MISTRAL_API_KEYS`. Keep real keys private and never commit `.env`.

4. Start in development:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:8787` to view the website, `http://localhost:8787/dashboard.html` for the customer console, or `http://localhost:8787/health` to check the gateway.

## Tests

Run the automated build and HTTP tests:

```bash
npm test
```

Tests use no real provider API keys. The failover test uses a mock upstream; it does not establish live provider availability or guarantee production reliability.

## SaaS API routes

- `POST /api/saas/signup` — JSON `{ "email", "password", "displayName?" }` (password minimum 10 characters).
- `POST /api/saas/login` — JSON `{ "email", "password" }`.
- `GET /api/saas/me` — requires `Authorization: Bearer <Supabase access token>`.
- `GET /api/saas/keys` — list your own key metadata (never returns stored secrets).
- `GET /api/saas/usage` — usage totals and recent request records for the last 30 days (up to 500 records).
- `POST /api/saas/keys` — JSON `{ "name": "My app" }`; returns the new secret once.
- `DELETE /api/saas/keys/:id` — revoke an active key owned by the signed-in user.

Customer gateway keys start with `af_live_`. Set the three Supabase environment variables above on the server before these routes will work. The publishable key is not a secret; the Supabase secret key is server-only. Email confirmation settings in Supabase Auth may require users to confirm email before login.

## Example request

Replace `YOUR_GATEWAY_KEY` with the value of `GATEWAY_API_KEY` if you configured one. In local development, the key is optional when the variable is empty.

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \
  -d '{
    "model": "llama-3.3-70b-versatile",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}],
    "stream": false
  }'
```

Use a model supported by the configured provider. This initial version preserves the requested model name, so a model unavailable on the selected provider may return an upstream client error instead of trying another provider.

## Environment variables

- `PORT` — HTTP port (default `8787`).
- `NODE_ENV` — set to `production` in production.
- `GATEWAY_API_KEY` — long, random operator key for controlled testing.
- `SUPABASE_URL` — URL of the dedicated API FLOW Supabase project.
- `SUPABASE_PUBLISHABLE_KEY` — Supabase publishable key used for Auth signup/login.
- `SUPABASE_SECRET_KEY` — server-only Supabase secret key; never expose it to the browser or commit real values.
- `GROQ_API_KEYS` — comma-separated Groq key pool. Also accepts `GROQ_API_KEY` and `GROQ_API_KEY_1` through `GROQ_API_KEY_20` for hosting dashboards that store each key separately.
- `OPENROUTER_API_KEYS` — comma-separated OpenRouter key pool. Also accepts `OPENROUTER_API_KEY` and `OPENROUTER_API_KEY_1` through `OPENROUTER_API_KEY_20`.
- `OPENAI_API_KEYS`, `DEEPSEEK_API_KEYS`, `MISTRAL_API_KEYS` — optional comma-separated key pools for the respective OpenAI-compatible APIs. Each also accepts the singular `*_API_KEY` and numbered `*_API_KEY_1` through `*_API_KEY_20` forms.
- `OPENAI_BASE_URL`, `DEEPSEEK_BASE_URL`, `MISTRAL_BASE_URL` — optional base URL overrides.

Provider keys are de-duplicated at startup. `/health` reports configured key counts only and never returns secret values. Environment-variable changes on Vercel require a new deployment to take effect.
- `GROQ_BASE_URL`, `OPENROUTER_BASE_URL` — optional provider base URLs (also used by automated mock tests).
- `REQUEST_TIMEOUT_MS` — upstream request timeout.
- `MAX_BODY_BYTES` — maximum JSON body size.

## Security notes

- Put real provider keys only in local `.env` files or your host's secret manager.
- Never put provider secrets in browser JavaScript or the public repository.
- Failover does not create additional provider quota or authorize bypassing provider limits. Follow provider terms.
- Do not use the current shared gateway key as customer authentication for a public SaaS. Build individual customer credentials and quotas first.

## Deploy

The app serves the landing page and API from one Node.js process. Choose a host that supports long-running HTTP servers, configure environment variables securely, run `npm run build`, then `npm start`. Hosting costs, sleep behavior, limits, and availability depend on the selected provider and plan.

## License

See the `LICENSE` file for the project's current license.


## BYOK platform direction

API FLOW is being developed as a **bring-your-own-key (BYOK)** gateway: users connect their own upstream provider accounts and remain responsible for provider inference charges. API FLOW must not silently fall back to platform-owned inference credentials. Infrastructure, storage, telemetry, and hosting still have operating costs.

- [Production architecture blueprint](docs/PRODUCTION_ARCHITECTURE.md) — data-plane/control-plane boundaries, routing, failover, security, observability, scaling, API surface, deployment and acceptance gates.
- [BYOK control-plane migration](supabase/migrations/202610300001_byok_control_plane.sql) — initial schema for organizations, provider credential ciphertext metadata, pools, versioned routing policies, gateway tokens, request attempts, health and audit events.

### Important deployment notes

The migration defines storage structures and baseline read policies; it does **not** implement the full encrypted credential lifecycle or all control-plane endpoints by itself. Apply it only after reviewing it against your current Supabase schema and taking a backup. Do not enable user-managed provider secrets in production until the backend has KMS/Vault-backed envelope encryption, authorized decrypt paths, tenant isolation tests, rotation, redaction tests, and revocation behavior.

The architecture blueprint is a target contract, not a statement that Kubernetes, Redis, all listed provider adapters, streaming, multi-region failover, billing, SSO/MFA, or enterprise analytics are already implemented. Check the API responses and test results for actual current capabilities.
