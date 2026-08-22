const http = require("http");
const { create } = require("../../http");

const { createDepinLimiter } = require("../../depinRateLimit");

const nodeDeps = { getNodes: () => [] };

function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, method, path, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      let data = ""; res.on("data", (chunk) => { data += chunk; }); res.on("end", () => {
        const json = String(res.headers["content-type"] || "").includes("application/json");
        resolve({ status: res.statusCode, headers: res.headers, body: data && json ? JSON.parse(data) : data || null });
      });
    });
    req.on("error", reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}

test("HTTP routes, cache invalidation and method guard", async () => {
  let calls = 0;
  const service = create({ enabled: true, max_requests_per_second: 100, concurrency: 1, max_queue_size: 2 }, null, {
    nodeDeps, rpc: async () => { calls++; return 123; },
  });
  const server = http.createServer(service.handleRequest);
  await new Promise((resolve) => server.listen(0, resolve));
  for (const path of ["/rpc", "/depin", "/depin/challenge"]) {
    const getOnly = await request(server, "GET", path);
    expect(getOnly.status).toBe(405);
    expect(getOnly.headers.allow).toBe("POST");
    expect(getOnly.body).toEqual({ description: "Please use the HTTP POST method to proceed. For more details, refer to our documentation." });
  }
  const first = await request(server, "POST", "/rpc", { method: "getblockcount", params: [] });
  expect(first.body).toEqual({ result: 123 });
  await request(server, "POST", "/rpc", { method: "getblockcount", params: [] });
  expect(calls).toBe(1);
  service.onBlock("a");
  await request(server, "POST", "/rpc", { method: "getblockcount", params: [] });
  expect(calls).toBe(2);
  expect((await request(server, "POST", "/rpc", { method: "stop", params: [] })).status).toBe(404);
  // Compatibility/security fixture: broadcasting remains public, but asking
  // the service to sign a supplied private key is intentionally not exposed.
  expect((await request(server, "POST", "/rpc", { method: "sendrawtransaction", params: [] })).status).toBe(200);
  expect((await request(server, "POST", "/rpc", { method: "signmessagewithprivkey", params: [] })).status).toBe(404);
  // Protocol 1 endpoints answer 410 for one release, pointing at POST /rpc.
  for (const path of ["/depin", "/depin/challenge"]) {
    const gone = await request(server, "POST", path, { address: "Nabc" });
    expect(gone.status).toBe(410);
    expect(gone.body.error).toBe("Gone");
    expect(gone.body.description).toMatch(/POST \/rpc/);
  }
  expect((await request(server, "GET", "/%2e%2e/package.json")).status).toBe(404);
  expect((await request(server, "GET", "/")).status).toBe(200);
  await new Promise((resolve) => server.close(resolve));
});

test("RPC errors have the documented compatibility format", async () => {
  const service = create({ enabled: true }, null, {
    nodeDeps, rpc: async () => { const error = new Error("upstream failed"); error.code = -42; throw error; },
  });
  const server = http.createServer(service.handleRequest);
  await new Promise((resolve) => server.listen(0, resolve));
  const response = await request(server, "POST", "/rpc", { method: "getblockcount", params: [] });
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: { message: "upstream failed", code: -42 } });
  await new Promise((resolve) => server.close(resolve));
});

test("node JSON-RPC errors keep their code whatever HTTP status the node used", async () => {
  // The node answers JSON-RPC errors with HTTP 500 (most codes) or 400 (-32600);
  // the library rejects with {statusText, status, error: {code, message}}.
  const nodeError = { statusText: "Bad Request", status: 400, description: undefined, error: { code: -32600, message: "Request authentication failed: stale timestamp" } };
  const service = create({ enabled: true }, null, { nodeDeps, rpc: async () => { throw nodeError; } });
  const server = http.createServer(service.handleRequest);
  await new Promise((resolve) => server.listen(0, resolve));
  const response = await request(server, "POST", "/rpc", { method: "getblockcount", params: [] });
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: { message: "Request authentication failed: stale timestamp", code: -32600 } });
  await new Promise((resolve) => server.close(resolve));
});

test("upstream failures are 502 with a neutral message, never the upstream body", async () => {
  const cases = [
    { originalError: new Error("ECONNREFUSED"), type: "ServerUnreachable", error: "Could not communicate with Neurai core node", description: "Are you sure that the URL is correct?" },
    { statusText: "Unauthorized", status: 401, description: null, error: null },
  ];
  for (const failure of cases) {
    const service = create({ enabled: true }, null, { nodeDeps, rpc: async () => { throw failure; } });
    const server = http.createServer(service.handleRequest);
    await new Promise((resolve) => server.listen(0, resolve));
    const response = await request(server, "POST", "/rpc", { method: "getblockcount", params: [] });
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: { message: "upstream RPC unavailable", code: null } });
    expect(JSON.stringify(response.body)).not.toMatch(/Unauthorized|URL is correct/);
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an `undefined` RPC result (0.4.7 on HTTP-200 errors) answers {result: null} instead of hanging", async () => {
  const service = create({ enabled: true }, null, { nodeDeps, rpc: async () => undefined });
  const server = http.createServer(service.handleRequest);
  await new Promise((resolve) => server.listen(0, resolve));
  const response = await request(server, "POST", "/rpc", { method: "getblockcount", params: [] });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ result: null });
  await new Promise((resolve) => server.close(resolve));
});

test("depin* methods share one per-IP quota: 429 + Retry-After, then a ban", async () => {
  const limiter = createDepinLimiter({ perMinute: 2, banMinutes: 1 });
  const service = create({ enabled: true }, null, { nodeDeps, rpc: async () => ({ body: "00", poolsig: "sig" }), depinLimiter: limiter });
  const server = http.createServer(service.handleRequest);
  await new Promise((resolve) => server.listen(0, resolve));
  const call = (method) => request(server, "POST", "/rpc", { method, params: [] });
  expect((await call("depingetmsginfo")).status).toBe(200);
  expect((await call("depinpoolstats")).status).toBe(200);
  const refused = await call("depinchallenge");
  expect(refused.status).toBe(429);
  expect(refused.headers["retry-after"]).toBe("60");
  expect(refused.body.error).toBe("Too many requests");
  expect(refused.body.description).toMatch(/blocked for 60 seconds/);
  // Banned: even a cheap pool query is refused, but chain queries and
  // non-DePIN methods are untouched.
  expect((await call("depingetmsginfo")).status).toBe(429);
  expect((await call("checkdepinvalidity")).status).toBe(200);
  expect((await call("getblockcount")).status).toBe(200);
  expect(service.getStats().depin_rate_limit).toEqual({ per_minute: 2, ban_minutes: 1, tracked: 0, banned: 1 });
  await new Promise((resolve) => server.close(resolve));
});

test("X-Forwarded-For only identifies the client when the peer is a trusted proxy", async () => {
  const limiter = createDepinLimiter({ perMinute: 1, banMinutes: 1 });
  // The test client connects from loopback, which is trusted by default, so a
  // forwarded header is honoured: two different forwarded clients get two
  // buckets. With an empty trusted set the same header is ignored and both
  // requests land in the loopback bucket.
  for (const [trusted, secondStatus] of [[undefined, 200], [new Set(), 429]]) {
    const service = create({ enabled: true }, null, { nodeDeps, rpc: async () => 1, depinLimiter: createDepinLimiter({ perMinute: 1, banMinutes: 1 }), trustedProxies: trusted });
    const server = http.createServer(service.handleRequest);
    await new Promise((resolve) => server.listen(0, resolve));
    const forwarded = (ip) => new Promise((resolve, reject) => {
      const req = http.request({ port: server.address().port, method: "POST", path: "/rpc", headers: { "content-type": "application/json", "x-forwarded-for": ip } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject); req.end(JSON.stringify({ method: "depingetmsginfo", params: [] }));
    });
    expect(await forwarded("203.0.113.1")).toBe(200);
    expect(await forwarded("203.0.113.2")).toBe(secondStatus);
    await new Promise((resolve) => server.close(resolve));
  }
  expect(limiter.stats().tracked).toBe(0);
});

test("wallet-only DePIN helpers are refused before any RPC connection", async () => {
  let calls = 0;
  const service = create({ enabled: true }, null, { nodeDeps, rpc: async () => { calls++; return 1; } });
  const server = http.createServer(service.handleRequest);
  await new Promise((resolve) => server.listen(0, resolve));
  for (const method of ["depinsignrequest", "depinsignchallenge", "depindecrypt", "depinsendmsg", "depingetmsg", "depinpoolpkey", "depingetpoolcontent", "listpqaddresses", "getibdstatus"]) {
    const response = await request(server, "POST", "/rpc", { method, params: [] });
    expect([method, response.status]).toEqual([method, 404]);
  }
  expect(calls).toBe(0);
  await new Promise((resolve) => server.close(resolve));
});

test("per-IP rate limit must not exceed the global limit", () => {
  expect(() => create({ enabled: true, max_requests_per_second: 10, max_requests_per_second_per_ip: 11 }, null, {
    nodeDeps, rpc: async () => 1,
  })).toThrow("max_requests_per_second_per_ip cannot exceed");
});
