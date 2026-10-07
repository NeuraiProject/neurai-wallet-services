const http = require("http");
const { create } = require("../../http");
const { createClients, presentedKey } = require("../../http/clients");

/*
Trusted clients replace the per-IP budget for backends that call /rpc from one
address (explorers, faucets, swaps). Pin down how they are recognised, what
they may skip and what still applies to everyone else.
*/

const nodeDeps = { getNodes: () => [] };
const KEY = "explorer-key-0123456789";

function basic(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function request(server, { method = "POST", path = "/rpc", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let data = ""; res.on("data", (chunk) => { data += chunk; }); res.on("end", () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null });
      });
    });
    req.on("error", reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
const rpcCall = (server, method, headers) => request(server, { body: { method, params: [] }, headers });

// Closed after every test as well, so a failed assertion cannot leave a
// listener open and keep Jest from exiting.
const open = new Set();
function closeServer(server) {
  open.delete(server);
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}
afterEach(() => Promise.all([...open].map(closeServer)));

async function serve(httpConfig, rpc = async () => 1, injected = {}) {
  const service = create({ enabled: true, ...httpConfig }, null, { nodeDeps, rpc, ...injected });
  const server = http.createServer(service.handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.add(server);
  return { service, server, close: () => closeServer(server) };
}

// Waits for a condition, failing instead of spinning forever.
async function waitFor(condition) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a key is recognised as the Basic auth password or a Bearer token, and unlocks its extra methods", async () => {
  const { server, close } = await serve({ clients: [{ name: "explorer", key: KEY, extra_methods: ["gettxoutsetinfo"] }] });
  for (const authorization of [basic("explorer", KEY), basic("anything", KEY), `Bearer ${KEY}`]) {
    const reply = await rpcCall(server, "gettxoutsetinfo", { authorization });
    expect([authorization, reply.status, reply.headers["x-rpc-client"]]).toEqual([authorization, 200, "explorer"]);
  }
  // Unknown credentials are not refused: existing clients send "anonymous" and stay public.
  for (const headers of [{ authorization: basic("anonymous", "anonymous") }, {}]) {
    const reply = await rpcCall(server, "gettxoutsetinfo", headers);
    expect(reply.status).toBe(404);
    expect(reply.headers["x-rpc-client"]).toBeUndefined();
    expect((await rpcCall(server, "getblockcount", headers)).status).toBe(200);
  }
  await close();
});

test("trusted clients skip the public per-IP and global budgets, but keep their own", async () => {
  const { server, close } = await serve({
    max_requests_per_second: 1,
    max_requests_per_second_per_ip: 1,
    clients: [
      { name: "explorer", key: KEY },
      { name: "faucet", key: "faucet-key-0123456789", max_requests_per_second: 2 },
    ],
  });
  expect((await rpcCall(server, "getblockcount")).status).toBe(200);
  expect((await rpcCall(server, "getblockcount")).status).toBe(429);
  for (let i = 0; i < 5; i++) {
    expect((await rpcCall(server, "getblockcount", { authorization: basic("explorer", KEY) })).status).toBe(200);
  }
  const faucet = { authorization: basic("faucet", "faucet-key-0123456789") };
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await rpcCall(server, "getblockcount", faucet)).status);
  expect(statuses).toEqual([200, 200, 429]);
  await close();
});

test("a client can be recognised by address or CIDR range, honouring only trusted proxies", async () => {
  const internal = { clients: [{ name: "internal", ips: ["127.0.0.1", "::1", "10.0.0.0/8"], extra_methods: ["getmininginfo"] }] };
  const { server, close } = await serve(internal);
  const direct = await rpcCall(server, "getmininginfo");
  expect([direct.status, direct.headers["x-rpc-client"]]).toEqual([200, "internal"]);
  await close();

  // Loopback is a trusted proxy by default, so X-Forwarded-For names the client.
  const behindProxy = await serve({ clients: [{ name: "docker", ips: ["172.16.0.0/12"] }] });
  expect((await rpcCall(behindProxy.server, "getblockcount", { "x-forwarded-for": "172.18.0.5" })).headers["x-rpc-client"]).toBe("docker");
  expect((await rpcCall(behindProxy.server, "getblockcount", { "x-forwarded-for": "203.0.113.5" })).headers["x-rpc-client"]).toBeUndefined();
  await behindProxy.close();

  // From an untrusted peer the same header is ignored.
  const untrusted = await serve({ clients: [{ name: "docker", ips: ["172.16.0.0/12"] }] }, async () => 1, { trustedProxies: new Set() });
  expect((await rpcCall(untrusted.server, "getblockcount", { "x-forwarded-for": "172.18.0.5" })).headers["x-rpc-client"]).toBeUndefined();
  await untrusted.close();
});

test("http.extra_methods opens a method for every client and lists it in /whitelist", async () => {
  const { server, close } = await serve({ extra_methods: ["gettxoutsetinfo"] });
  expect((await rpcCall(server, "gettxoutsetinfo")).status).toBe(200);
  expect((await rpcCall(server, "getnettotals")).status).toBe(404);
  const whitelist = await request(server, { method: "GET", path: "/whitelist" });
  expect(whitelist.body).toContain("gettxoutsetinfo");
  expect(whitelist.body).not.toContain("getnettotals");
  await close();
});

test("trusted requests go ahead of waiting public ones in the HTTP queue", async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const rpc = async (method) => { order.push(method); if (method === "getblockcount") await gate; return 1; };
  const { service, server, close } = await serve({ concurrency: 1, clients: [{ name: "explorer", key: KEY }] }, rpc);
  const busy = rpcCall(server, "getblockcount");
  await waitFor(() => order.length === 1);
  const publicCall = rpcCall(server, "getbestblockhash");
  await waitFor(() => service.getStats().queue.size === 1);
  const trustedCall = rpcCall(server, "getdifficulty", { authorization: `Bearer ${KEY}` });
  await waitFor(() => service.getStats().queue.size === 2);
  release();
  await Promise.all([busy, publicCall, trustedCall]);
  expect(order).toEqual(["getblockcount", "getdifficulty", "getbestblockhash"]);
  await close();
});

test("getnetworkinfo leaves out proxies and local addresses, also when served from the cache", async () => {
  let calls = 0;
  const info = {
    version: 1000600, subversion: "/Neurai:1.0.6/", protocolversion: 70028, relayfee: 0.01, incrementalfee: 0.00001,
    connections: 8, warnings: "",
    networks: [{ name: "onion", proxy: "127.0.0.1:9050" }],
    localaddresses: [{ address: "203.0.113.9", port: 19000, score: 4 }],
  };
  const { server, close } = await serve({}, async () => { calls++; return info; });
  for (let i = 0; i < 2; i++) {
    const reply = await rpcCall(server, "getnetworkinfo");
    expect(reply.status).toBe(200);
    expect(reply.body.result).toEqual({ version: 1000600, subversion: "/Neurai:1.0.6/", protocolversion: 70028, relayfee: 0.01, incrementalfee: 0.00001, connections: 8, warnings: "" });
  }
  expect(calls).toBe(1);
  await close();
});

test.each([
  [{ clients: {} }, "clients must be an array"],
  [{ clients: [{ key: KEY }] }, "name must be"],
  [{ clients: [{ name: "has space", key: KEY }] }, "name must be"],
  [{ clients: [{ name: "a", key: KEY }, { name: "a", key: "other-key-0123456789" }] }, "defined twice"],
  [{ clients: [{ name: "a", key: KEY }, { name: "b", key: KEY }] }, "reuses the key"],
  [{ clients: [{ name: "a", key: "short" }] }, "at least 16 characters"],
  [{ clients: [{ name: "a" }] }, "needs a key, ips or both"],
  [{ clients: [{ name: "a", ips: [] }] }, "non-empty array"],
  [{ clients: [{ name: "a", ips: ["not-an-ip"] }] }, "invalid address"],
  [{ clients: [{ name: "a", ips: ["10.0.0.0/33"] }] }, "invalid prefix"],
  [{ clients: [{ name: "a", key: KEY, max_requests_per_second: 0 }] }, "positive integer"],
  [{ clients: [{ name: "a", key: KEY, extra_methods: ["dumpprivkey"] }] }, "dumpprivkey cannot be added"],
  [{ extra_methods: ["stop"] }, "stop cannot be added"],
  [{ extra_methods: "gettxoutsetinfo" }, "must be an array"],
])("refuses to start with %j", (httpConfig, message) => {
  expect(() => create({ enabled: true, ...httpConfig }, null, { nodeDeps, rpc: async () => 1 })).toThrow(message);
});

test("only the password of Basic auth or a Bearer token counts as a key", () => {
  const req = (authorization) => ({ headers: { authorization } });
  expect(presentedKey(req(basic("user", "pa:ss")))).toBe("pa:ss");
  expect(presentedKey(req(basic("user", "")))).toBeNull();
  expect(presentedKey(req(`Bearer ${KEY}`))).toBe(KEY);
  expect(presentedKey(req(KEY))).toBeNull();
  expect(presentedKey(req(`Digest ${KEY}`))).toBeNull();
  expect(presentedKey({ headers: {} })).toBeNull();
  expect(createClients([]).identify(req(`Bearer ${KEY}`), "127.0.0.1")).toBeNull();
});
