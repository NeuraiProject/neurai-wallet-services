// Service-wide limit on node reads that flush the node's state (mainnet
// v1.0.6). The node queue (wss/rpc.js) is real; only the node is mocked.
jest.mock("../../getRPCNode", () => ({ getRPCNode: jest.fn(), getIdentity: jest.fn(async () => null), getNodes: () => [] }));
jest.mock("../../wss/node-health", () => ({ isSyncing: () => false }));

const http = require("http");
const { getRPCNode } = require("../../getRPCNode");
const rpcQueue = require("../../wss/rpc");
const flushing = require("../../flushingReads");
const { create } = require("../../http");
const { handle } = require("../../wss/wallet-rpc");
const { ERROR_CODES } = require("../../wss/protocol");
const { createDepinLimiter } = require("../../depinRateLimit");
const { isUpstreamFailure, toClientError, describeForLog } = require("../../rpcError");

const T0 = 1790380800000;
let now = T0;
const nodeDeps = { getNodes: () => [] };
const session = { helloDone: true, protocol: "wss/2" };

// Node mock: records every call and how many protected reads overlap.
const node = { calls: [], running: 0, maxRunning: 0, impl: null };
function resetNode(impl = async (method) => method) {
  Object.assign(node, { calls: [], running: 0, maxRunning: 0, impl });
}
async function nodeRpc(method, params) {
  node.calls.push([method, params]);
  const protectedRead = flushing.isFlushingRead(method);
  if (protectedRead) node.maxRunning = Math.max(node.maxRunning, ++node.running);
  try { return await node.impl(method, params); } finally { if (protectedRead) node.running--; }
}

function configure(flushingReads) {
  flushing.resetSharedFlushingLimiter();
  return flushing.getSharedFlushingLimiter({ flushing_reads: flushingReads });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const outcome = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

function request(server, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, method: "POST", path: "/rpc", headers: { "content-type": "application/json" } }, (res) => {
      let data = ""; res.on("data", (chunk) => { data += chunk; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject); req.write(JSON.stringify(body)); req.end();
  });
}

beforeAll(() => {
  // One slot in the shared queue, so a single pending call blocks it.
  rpcQueue.initQueue(1);
});

beforeEach(() => {
  now = T0;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  getRPCNode.mockReturnValue({ rpc: nodeRpc });
  resetNode();
});

afterEach(() => jest.restoreAllMocks());

describe("limiter", () => {
  test("allows the burst, then one call per 1/per_second, never storing more than the burst", () => {
    const limiter = flushing.createFlushingReadLimiter({ perSecond: 2, burst: 5, maxInFlight: 1 });
    const take = (t) => { const permit = limiter.tryAcquire(t); if (permit.allowed) permit.release(); return permit; };
    for (let i = 0; i < 5; i++) expect(take(T0).allowed).toBe(true);
    expect(take(T0)).toMatchObject({ allowed: false, reason: "rate", retryAfterSeconds: 1 });
    expect(take(T0 + 499).allowed).toBe(false);
    expect(take(T0 + 500).allowed).toBe(true);
    expect(take(T0 + 500).allowed).toBe(false);
    // A long idle period refills up to the burst only.
    for (let i = 0; i < 5; i++) expect(take(T0 + 3600000).allowed).toBe(true);
    expect(take(T0 + 3600000).allowed).toBe(false);
  });

  test("a fractional rate reports the whole seconds to wait", () => {
    const limiter = flushing.createFlushingReadLimiter({ perSecond: 0.25, burst: 1, maxInFlight: 1 });
    limiter.tryAcquire(T0).release();
    expect(limiter.tryAcquire(T0)).toMatchObject({ allowed: false, reason: "rate", retryAfterSeconds: 4 });
  });

  test("both limits are taken together: a refusal for one takes nothing from the other", () => {
    const limiter = flushing.createFlushingReadLimiter({ perSecond: 1, burst: 2, maxInFlight: 1 });
    const first = limiter.tryAcquire(T0);
    expect(first.allowed).toBe(true);
    expect(limiter.tryAcquire(T0)).toMatchObject({ allowed: false, reason: "in_flight", retryAfterSeconds: 1 });
    expect(limiter.stats(T0)).toMatchObject({ tokens: 1, in_flight: 1 });
    first.release();
    first.release(); // idempotent
    expect(limiter.stats(T0).in_flight).toBe(0);
    // The token the refused call did not take is still there.
    const second = limiter.tryAcquire(T0);
    expect(second.allowed).toBe(true);
    second.release();
    expect(limiter.tryAcquire(T0)).toMatchObject({ allowed: false, reason: "rate" });
    // ...and a refusal for rate holds no slot.
    expect(limiter.stats(T0)).toMatchObject({ tokens: 0, in_flight: 0 });
  });

  test("per_second 0 disables the rate and the in-flight limit", () => {
    const limiter = flushing.createFlushingReadLimiter({ perSecond: 0, burst: 1, maxInFlight: 1 });
    for (let i = 0; i < 50; i++) expect(limiter.tryAcquire(T0).allowed).toBe(true);
  });

  test("covers the eight reads that flush on node v1.0.6 and nothing else", () => {
    expect([...flushing.FLUSHING_READ_METHODS].sort()).toEqual([
      "gettxoutsetinfo", "listaddressesbyasset", "listaddressesfortag", "listaddressrestrictions",
      "listassetbalancesbyaddress", "listassets", "listglobalrestrictions", "listtagsforaddress",
    ]);
    expect(flushing.isFlushingRead("getassetdata")).toBe(false);
    expect(flushing.isFlushingRead("constructor")).toBe(false);
  });
});

describe("config", () => {
  test("defaults and explicit values", () => {
    expect(flushing.resolveFlushingReadsConfig(null)).toEqual({ per_second: 2, burst: 20, max_in_flight: 4 });
    expect(flushing.resolveFlushingReadsConfig({})).toEqual({ per_second: 2, burst: 20, max_in_flight: 4 });
    expect(flushing.resolveFlushingReadsConfig({ flushing_reads: { per_second: 0 } })).toEqual({ per_second: 0, burst: 20, max_in_flight: 4 });
    expect(flushing.resolveFlushingReadsConfig({ flushing_reads: { per_second: 0.5, burst: 3, max_in_flight: 2 } })).toEqual({ per_second: 0.5, burst: 3, max_in_flight: 2 });
  });

  test.each([
    [{ flushing_reads: [] }, "flushing_reads must be an object"],
    [{ flushing_reads: "2" }, "flushing_reads must be an object"],
    [{ flushing_reads: { per_second: -1 } }, "flushing_reads.per_second"],
    [{ flushing_reads: { per_second: "2" } }, "flushing_reads.per_second"],
    [{ flushing_reads: { per_second: Infinity } }, "flushing_reads.per_second"],
    [{ flushing_reads: { burst: 0 } }, "flushing_reads.burst"],
    [{ flushing_reads: { burst: 1.5 } }, "flushing_reads.burst"],
    [{ flushing_reads: { max_in_flight: 0 } }, "flushing_reads.max_in_flight"],
  ])("refuses %j", (config, message) => {
    expect(() => flushing.resolveFlushingReadsConfig(config)).toThrow(message);
  });
});

describe("shared node queue", () => {
  test("calls waiting behind a blocked queue spend nothing until their turn", async () => {
    const limiter = configure({ per_second: 2, burst: 5, max_in_flight: 1 });
    let unblock;
    const gate = new Promise((resolve) => { unblock = resolve; });
    resetNode(async (method) => { if (method === "getblockcount") await gate; return method; });

    const blocker = rpcQueue.callRPC("getblockcount", []);
    const waiting = Array.from({ length: 7 }, (_, i) => outcome(rpcQueue.callRPC("listassets", [`A${i}*`])));
    await settle();
    expect(rpcQueue.getQueueStats()).toEqual({ size: 7, pending: 1 });
    expect(limiter.stats()).toMatchObject({ tokens: 5, in_flight: 0 });

    unblock();
    await blocker;
    const results = await Promise.all(waiting);
    // Time stands still here: the bucket lets the burst through, in queue
    // order, and refuses the rest; the node never saw two at once.
    expect(results.slice(0, 5).map((r) => r.value)).toEqual(Array(5).fill("listassets"));
    for (const r of results.slice(5)) expect(r.error).toMatchObject({ type: "Throttled", method: "listassets", retryAfterSeconds: 1 });
    expect(node.calls.filter(([method]) => method === "listassets")).toHaveLength(5);
    expect(node.maxRunning).toBe(1);
    // Methods outside the list never count.
    await expect(rpcQueue.callRPC("getassetdata", ["A"])).resolves.toBe("getassetdata");
  });

  test("the in-flight slot is released when the node call fails", async () => {
    configure({ per_second: 100, burst: 100, max_in_flight: 1 });
    resetNode(async (method, params) => { if (params[0] === "bad") throw { error: { code: -8, message: "bad filter" } }; return method; });
    await expect(rpcQueue.callRPC("listaddressesbyasset", ["bad"])).rejects.toEqual({ error: { code: -8, message: "bad filter" } });
    await expect(rpcQueue.callRPC("listaddressesbyasset", ["GOLD"])).resolves.toBe("listaddressesbyasset");
  });

  test("at most max_in_flight protected reads reach the node at once", async () => {
    let q; let fl; let nodeModule;
    jest.isolateModules(() => {
      nodeModule = require("../../getRPCNode");
      q = require("../../wss/rpc");
      fl = require("../../flushingReads");
    });
    q.initQueue(4);
    fl.getSharedFlushingLimiter({ flushing_reads: { per_second: 100, burst: 100, max_in_flight: 2 } });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let running = 0; let maxRunning = 0;
    nodeModule.getRPCNode.mockReturnValue({ rpc: async (method) => { maxRunning = Math.max(maxRunning, ++running); await gate; running--; return method; } });

    const calls = Array.from({ length: 6 }, (_, i) => outcome(q.callRPC("listtagsforaddress", [`N${i}`])));
    await settle();
    expect(running).toBe(2);
    release();
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.value)).toHaveLength(2);
    expect(results.filter((r) => r.error && r.error.type === "Throttled")).toHaveLength(4);
    expect(maxRunning).toBe(2);
  });

  test("with the defaults, ten different reads at once all reach the node, four at a time", async () => {
    let q; let fl; let nodeModule;
    jest.isolateModules(() => {
      nodeModule = require("../../getRPCNode");
      q = require("../../wss/rpc");
      fl = require("../../flushingReads");
    });
    q.initQueue(4);
    fl.getSharedFlushingLimiter({});
    let running = 0; let maxRunning = 0;
    nodeModule.getRPCNode.mockReturnValue({ rpc: async (method) => { maxRunning = Math.max(maxRunning, ++running); await settle(); running--; return method; } });

    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => outcome(q.callRPC("listaddressesbyasset", [`ASSET${i}`]))));
    expect(results.filter((r) => r.value)).toHaveLength(10);
    expect(maxRunning).toBe(4);
  });

  test("a refusal is neither an upstream failure nor a node error", () => {
    const e = new flushing.FlushingReadThrottledError("listassets", 3);
    expect(isUpstreamFailure(e)).toBe(false);
    expect(toClientError(e)).toEqual({ upstream: false, code: null, message: e.message });
    expect(describeForLog(e)).toMatch(/^throttled: listassets/);
  });
});

describe("HTTP and WSS", () => {
  let server;
  afterEach(async () => { if (server) await new Promise((resolve) => server.close(resolve)); server = null; });

  async function startHttp() {
    const service = create({ enabled: true, concurrency: 4, max_requests_per_second: 1000, max_requests_per_second_per_ip: 1000 }, null, {
      nodeDeps, rpc: rpcQueue.callRPC, depinLimiter: createDepinLimiter(),
    });
    server = http.createServer(service.handleRequest);
    await new Promise((resolve) => server.listen(0, resolve));
    return service;
  }

  test("a cached reply takes no token; past the burst, 503 with Retry-After, and the refusal is not cached", async () => {
    const limiter = configure({ per_second: 1, burst: 2, max_in_flight: 1 });
    await startHttp();
    for (let i = 0; i < 4; i++) expect(await request(server, { method: "listassets", params: ["A*"] })).toMatchObject({ status: 200, body: { result: "listassets" } });
    expect(node.calls).toHaveLength(1);
    expect(limiter.stats()).toMatchObject({ tokens: 1 });

    expect((await request(server, { method: "listassets", params: ["B*"] })).status).toBe(200);
    const refused = await request(server, { method: "listassets", params: ["C*"] });
    expect(refused.status).toBe(503);
    expect(refused.headers["retry-after"]).toBe("1");
    expect(refused.body).toEqual({ error: "node busy", description: expect.stringContaining("listassets is rate limited") });
    // Other methods are untouched by the empty bucket.
    expect((await request(server, { method: "getblockcount", params: [] })).status).toBe(200);

    now += 1000;
    expect(await request(server, { method: "listassets", params: ["C*"] })).toMatchObject({ status: 200, body: { result: "listassets" } });
    expect(node.calls.filter(([method]) => method === "listassets").map(([, params]) => params[0])).toEqual(["A*", "B*", "C*"]);
  });

  test("WSS rpc.call answers 1007 with retry_after_seconds, from the bucket HTTP also draws on", async () => {
    configure({ per_second: 0.5, burst: 1, max_in_flight: 1 });
    await startHttp();
    expect((await request(server, { method: "listaddressesfortag", params: ["#KYC"] })).status).toBe(200);
    const e = await outcome(handle(session, { method: "listaddressesfortag", params: ["#OTHER"] }));
    expect(e.error).toMatchObject({ code: ERROR_CODES.RATE_LIMITED, extra: { retry_after_seconds: 2 } });
    expect(node.calls).toHaveLength(1);
    // Methods outside the list still go through over WSS.
    await expect(handle(session, { method: "getassetdata", params: ["GOLD"] })).resolves.toBe("getassetdata");
  });

  test("with per_second 0 nothing is refused", async () => {
    configure({ per_second: 0, burst: 1, max_in_flight: 1 });
    await startHttp();
    for (let i = 0; i < 10; i++) expect((await request(server, { method: "listglobalrestrictions", params: [String(i)] })).status).toBe(200);
    expect(node.calls).toHaveLength(10);
  });
});
