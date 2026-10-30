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
    env: { ...process.env, NODE_ENV: "test", PORT: String(port), GROQ_API_KEYS: "", GROQ_API_KEY: "dummy-alpha", GROQ_API_KEY_1: "dummy-alpha", GROQ_API_KEY_2: "dummy-beta", OPENROUTER_API_KEYS: "", OPENROUTER_API_KEY: "dummy-gamma", GATEWAY_API_KEY: "" },
    stdio: "ignore"
  });
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error("API Flow exited before becoming ready");
    try { const response = await fetch(`${baseUrl}/health`); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("API Flow did not become ready in time");
});
after(() => { if (child && child.exitCode === null) child.kill("SIGTERM"); });
test("health detects single and numbered provider keys without exposing secrets", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.providers, [
    { name: "groq", configuredKeys: 2, configured: true },
    { name: "openrouter", configuredKeys: 1, configured: true }
  ]);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("dummy-alpha"), false);
  assert.equal(serialized.includes("dummy-gamma"), false);
});
