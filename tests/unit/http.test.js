const http = require("http");
const { create } = require("../../http");

const nodeDeps = {
  getNodes: () => [], getDePinNodes: () => [], getDePinNode: () => ({ depinUrl: "http://localhost:19002" }),
};
const depinService = { getCacheStats: () => ({}), executeDePinRPC: jest.fn() };

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
    nodeDeps, depinService, rpc: async () => { calls++; return 123; },
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
  expect((await request(server, "POST", "/depin", {})).body).toEqual({ error: "Missing or invalid address", description: "Request must include a valid 'address' field" });
  expect((await request(server, "GET", "/%2e%2e/package.json")).status).toBe(404);
  expect((await request(server, "GET", "/")).status).toBe(200);
  await new Promise((resolve) => server.close(resolve));
});

test("RPC errors have the documented compatibility format", async () => {
  const service = create({ enabled: true }, null, {
    nodeDeps, depinService, rpc: async () => { const error = new Error("upstream failed"); error.code = -42; throw error; },
  });
  const server = http.createServer(service.handleRequest);
  await new Promise((resolve) => server.listen(0, resolve));
  const response = await request(server, "POST", "/rpc", { method: "getblockcount", params: [] });
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: { message: "upstream failed", code: -42 } });
  await new Promise((resolve) => server.close(resolve));
});

test("POST /depin/challenge issues the challenge the client has to sign", async () => {
  const expiresAt = 1750000000000;
  const service = create({ enabled: true }, null, {
    nodeDeps, rpc: async () => 1,
    depinService: { ...depinService, requestChallenge: async (url, address) => ({ challenge: `c-${address}`, timeout: 60, expiresAt }) },
  });
  const server = http.createServer(service.handleRequest);
  await new Promise((resolve) => server.listen(0, resolve));
  const issued = await request(server, "POST", "/depin/challenge", { address: "Nabc" });
  expect(issued.status).toBe(200);
  expect(issued.body).toEqual({ result: { challenge: "c-Nabc", timeout: 60, expires_at: new Date(expiresAt).toISOString() } });
  const missing = await request(server, "POST", "/depin/challenge", {});
  expect(missing.status).toBe(400);
  expect(missing.body).toEqual({ error: "Missing or invalid address", description: "Request must include a valid 'address' field" });
  await new Promise((resolve) => server.close(resolve));
});

test("POST /depin/challenge reports an unreachable DePIN node", async () => {
  const service = create({ enabled: true }, null, {
    nodeDeps, rpc: async () => 1,
    depinService: { ...depinService, requestChallenge: async () => { throw new Error("Failed to request challenge: 502 Bad Gateway"); } },
  });
  const server = http.createServer(service.handleRequest);
  await new Promise((resolve) => server.listen(0, resolve));
  const failed = await request(server, "POST", "/depin/challenge", { address: "Nabc" });
  expect(failed.status).toBe(500);
  expect(failed.body).toEqual({ error: "Failed to request challenge: 502 Bad Gateway" });
  await new Promise((resolve) => server.close(resolve));
});

test("per-IP rate limit must not exceed the global limit", () => {
  expect(() => create({ enabled: true, max_requests_per_second: 10, max_requests_per_second_per_ip: 11 }, null, {
    nodeDeps, depinService, rpc: async () => 1,
  })).toThrow("max_requests_per_second_per_ip cannot exceed");
});
