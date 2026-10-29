# API Flow

**One endpoint. Multiple provider keys. Automatic failover.**

API Flow is a lightweight, self-hostable gateway that accepts an OpenAI-compatible chat-completions request and routes it to configured providers. It tries configured keys in order and moves to the next attempt for authentication failures, rate limits, timeouts, network failures, and upstream server errors.

## Current capabilities

- OpenAI-compatible `POST /v1/chat/completions` endpoint.
- Multiple Groq keys and OpenRouter keys, configured server-side.
- Sequential key/provider failover per request.
- Optional gateway client-key authentication.
- Request logging with authorization headers redacted.
- Health endpoint that reports provider configuration without exposing keys.
- Request timeout and body-size limit.
- TypeScript build and development scripts.

## Not implemented yet

Streaming responses, durable usage analytics, a web dashboard, customer accounts, per-customer quotas/billing, model-aware routing, persistent provider health/cooldowns, and automated integration tests are future milestones. Do not treat this initial gateway as a fully managed production SaaS.

## Requirements

- Node.js 20+
- One or more provider API keys from providers you are authorized to use.

## Run locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the example environment file:

   Windows PowerShell:
   ```powershell
   Copy-Item .env.example .env
   ```

   macOS/Linux:
   ```bash
   cp .env.example .env
   ```

3. Edit `.env`. Add comma-separated keys to `GROQ_API_KEYS` and/or `OPENROUTER_API_KEYS`. Keep keys private. Never commit `.env`.

4. Start in development:

   ```bash
   npm run dev
   ```

5. Check health:

   ```bash
   curl http://localhost:8787/health
   ```

## Example request

Replace `YOUR_GATEWAY_KEY` with the value of `GATEWAY_API_KEY` if you configured one. In local development, the key is optional if the variable is empty.

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

Use a model supported by the provider selected by the configured key order. Since this initial version preserves the requested model name, a model unavailable on the first provider may return an upstream client error instead of trying other providers.

## Security notes

- Put real provider keys only in local `.env` files or hosting-provider secret settings.
- Set a strong, random `GATEWAY_API_KEY` before exposing the gateway to any network.
- In production, the gateway refuses to serve protected chat requests if `GATEWAY_API_KEY` is not configured.
- Avoid exposing this service publicly until you have rate limits, customer isolation, abuse controls, and usage/billing protections.
- Failover does not create additional provider quota. Follow each provider's terms and limits.

## Deploy

Deploy to a Node.js host that supports long-running HTTP servers. Configure the environment variables in the host's secret manager, run `npm run build`, then `npm start`. Serverless platforms may require adapting the server entry point to their runtime.

## API

- `GET /` — service information.
- `GET /health` — health/configuration status.
- `POST /v1/chat/completions` — chat completions proxy.

## License

No license has been added yet. Add one before accepting external contributions or distributing the project.