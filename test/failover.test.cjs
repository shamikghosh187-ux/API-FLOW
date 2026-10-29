const { spawn } = require("node:child_process");
const { once } = require("node:events");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");

let upstream;
let gateway;
let baseUrl;
let seenKeys = [];

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

before(async () => {
  const upstreamPort = await freePort();
  upstream = http.createServer((req, res) => {
    seenKeys.push(req.headers.authorization);
    if (req.headers.authorization === "Bearer first-key") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "mock-completion", choices: [{ message: { role: "assistant", content: "failover worked" } }] }));
  });
  upstream.listen(upstreamPort, "127.0.0.1");
  await once(upstream, "listening");

  const gatewayPort = await freePort();
  baseUrl = `http://127.0.0.1:${gatewayPort}`;
  gateway = spawn(process.execPath, [path.join(__dirname, "..", "dist", "index.js")], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(gatewayPort),
      GROQ_API_KEYS: "first-key,second-key",
      OPENROUTER_API_KEYS: "",
      GROQ_BASE_URL: `http://127.0.0.1:${upstreamPort}/openai/v1`,
      GATEWAY_API_KEY: ""
    },
    stdio: "ignore"
  });

  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (gateway.exitCode !== null) throw new Error("API Flow exited before becoming ready");
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!ready) throw new Error("API Flow did not become ready in time");
});

after(async () => {
  if (gateway && gateway.exitCode === null) gateway.kill("SIGTERM");
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
});

test("a rate-limited key fails over to the next configured key", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mock-model",
      messages: [{ role: "user", content: "hello" }]
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "failover worked");
  assert.deepEqual(seenKeys, ["Bearer first-key", "Bearer second-key"]);
});
