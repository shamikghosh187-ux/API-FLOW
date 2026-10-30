const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const path = require("node:path");
const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");

let child;
let baseUrl;

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, "..", "dist", "index.js")], {
    env: { ...process.env, NODE_ENV: "test", PORT: String(port), GROQ_API_KEYS: "", OPENROUTER_API_KEYS: "", GATEWAY_API_KEY: "" },
    stdio: "ignore"
  });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error("API Flow exited before becoming ready");
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!ready) throw new Error("API Flow did not become ready in time");
});

after(() => {
  if (child && child.exitCode === null) child.kill("SIGTERM");
});

test("root endpoint serves the React API FLOW product website", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("content-type")?.includes("text/html"));
  const body = await response.text();
  assert.match(body, /API FLOW — Intelligence in motion/);
  assert.match(body, /id="root"/);
  assert.match(body, /\/assets\/index-[^"]+\.js/);
  assert.match(body, /\/assets\/index-[^"]+\.css/);
});

test("customer dashboard is served as a separate product page", async () => {
  const response = await fetch(`${baseUrl}/dashboard.html`);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("content-type")?.includes("text/html"));
  const body = await response.text();
  assert.match(body, /API dashboard/);
  assert.match(body, /Create account/);
  assert.match(body, /Usage history/);
});

test("customer API keys are rejected when SaaS verification is not configured", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer af_live_invalid-test-key" },
    body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.type, "authentication_error");
});

test("product info endpoint exposes current implementation status", async () => {
  const response = await fetch(`${baseUrl}/api/info`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.name, "API FLOW");
  assert.equal(body.features.customerAccounts, false);
  assert.equal(body.features.subscriptions, false);
  assert.equal(body.features.dailyRequestQuotas, false);
  assert.deepEqual(body.limits.dailyRequests, { free: 100, pro: 1000, business: 5000 });
});

test("health endpoint reports configured state without secrets", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.service, "api-flow");
  assert.deepEqual(body.providers.map((p) => p.configured), [false, false]);
});

test("invalid request returns 400", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [] })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, "invalid_request_error");
});

test("valid request without providers returns 503", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.type, "configuration_error");
});

test("malformed JSON returns controlled 400", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{"
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, "invalid_request_error");
});
