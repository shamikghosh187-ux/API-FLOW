# API FLOW

**One API. Automatic failover.**

API FLOW is an early-stage, self-hostable OpenAI-compatible gateway. It forwards chat-completion requests to configured providers and tries eligible keys in sequence when an upstream returns an authentication failure, rate limit, timeout, network error, or selected server errors.

## Current capabilities

- Public product landing page served from `public/index.html`.
- OpenAI-compatible `POST /v1/chat/completions` endpoint.
- Multiple Groq keys and OpenRouter keys configured server-side.
- Sequential provider/key failover for selected transient errors.
- Optional gateway client-key authentication (required for protected chat requests in production).
- Request validation, request timeout, body-size limit, Helmet security headers, and redacted authorization logs.
- `GET /health` endpoint showing whether provider keys are configured without revealing them.
- `GET /api/info` endpoint describing current implementation status.
- Automated HTTP tests, including a mock-upstream test proving failover after a simulated 429.

## Important: what is not implemented yet

The website includes **proposed** Free, Pro, and Business plans for product direction only. They are not purchasable plans and do not represent a live subscription service.

Not implemented yet:
- Customer registration, login, or individual customer accounts.
- Per-customer gateway keys, tenant isolation, and usage quotas.
- Persistent request analytics or a customer dashboard backed by real usage data.
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

3. Edit `.env`. Add comma-separated keys to `GROQ_API_KEYS` and/or `OPENROUTER_API_KEYS`. Keep real keys private and never commit `.env`.

4. Start in development:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:8787` to view the website, or `http://localhost:8787/health` to check the gateway.

## Tests

Run the automated build and HTTP tests:

```bash
npm test
```

Tests use no real provider API keys. The failover test uses a mock upstream; it does not establish live provider availability or guarantee production reliability.

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
- `GATEWAY_API_KEY` — long, random client key for the current single-key gateway authentication.
- `GROQ_API_KEYS` — comma-separated Groq keys.
- `OPENROUTER_API_KEYS` — comma-separated OpenRouter keys.
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
