const http = require("http");
const { RpcTimeoutError, resolveRpcTimeouts, withTimeout } = require("../../rpcTimeout");
const { toClientError, describeForLog, isUpstreamFailure } = require("../../rpcError");
const { create } = require("../../http");

/*
neurai-rpc's fetch() has no AbortSignal: without a limit, a node that stops
answering holds a slot of the shared node queue for as long as the socket
lives, and a hung health check blocks every request waiting for a healthy node.
*/

const hung = () => new Promise(() => {});
const fixed = (ms) => ({ timeoutFor: () => ms });

test("a call that outlives its limit rejects with a timeout; others pass through untouched", async () => {
  const bounded = withTimeout(async (method, params) => {
    if (method === "getblock") return hung();
    if (method === "fail") throw { error: { code: -5, message: "Invalid address" } };
    return [method, params];
  }, fixed(20));
  await expect(bounded("getblock", ["a"])).rejects.toMatchObject({ type: "Timeout", method: "getblock", timeoutMs: 20 });
  await expect(bounded("getblockcount", [])).resolves.toEqual(["getblockcount", []]);
  await expect(bounded("fail", [])).rejects.toEqual({ error: { code: -5, message: "Invalid address" } });
});

test("30 s by default, minutes for gettxoutsetinfo, both configurable", () => {
  const defaults = resolveRpcTimeouts({});
  expect(defaults.timeoutFor("getblock")).toBe(30000);
  expect(defaults.timeoutFor("gettxoutsetinfo")).toBe(600000);
  const custom = resolveRpcTimeouts({ rpc_timeout_ms: 5000, rpc_method_timeouts_ms: { getaddressdeltas: 60000, gettxoutsetinfo: 900000 } });
  expect(custom.timeoutFor("getblock")).toBe(5000);
  expect(custom.timeoutFor("getaddressdeltas")).toBe(60000);
  expect(custom.timeoutFor("gettxoutsetinfo")).toBe(900000);
  // Inherited object keys are not methods.
  expect(custom.timeoutFor("constructor")).toBe(5000);
});

test.each([
  [{ rpc_timeout_ms: 0 }, "rpc_timeout_ms must be a positive integer"],
  [{ rpc_timeout_ms: "30000" }, "rpc_timeout_ms must be a positive integer"],
  [{ rpc_method_timeouts_ms: [] }, "must be an object"],
  [{ rpc_method_timeouts_ms: { getblock: -1 } }, "rpc_method_timeouts_ms.getblock must be a positive integer"],
])("refuses %j", (config, message) => {
  expect(() => resolveRpcTimeouts(config)).toThrow(message);
});

test("a timeout is an upstream failure: neutral message for clients, details for the log", () => {
  const timeout = new RpcTimeoutError("getblock", 30000);
  expect(isUpstreamFailure(timeout)).toBe(true);
  expect(toClientError(timeout)).toEqual({ upstream: true, code: null, message: "upstream RPC unavailable" });
  expect(describeForLog(timeout)).toBe("node timeout: getblock timed out after 30000 ms");
});

test("over HTTP a timed-out call answers 502 and is not cached", async () => {
  let calls = 0;
  const rpc = withTimeout(async () => { calls++; return hung(); }, fixed(20));
  const service = create({ enabled: true }, null, { nodeDeps: { getNodes: () => [] }, rpc });
  const server = http.createServer(service.handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  jest.spyOn(console, "log").mockImplementation(() => {});
  try {
    for (let i = 0; i < 2; i++) {
      const reply = await new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: "/rpc", headers: { "content-type": "application/json" } }, (res) => {
          let data = ""; res.on("data", (chunk) => { data += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        });
        req.on("error", reject); req.end(JSON.stringify({ method: "getblockcount", params: [] }));
      });
      expect(reply).toEqual({ status: 502, body: { error: { message: "upstream RPC unavailable", code: null } } });
    }
    expect(calls).toBe(2);
    expect(console.log).toHaveBeenCalledWith("[HTTP] getblockcount: node timeout: getblockcount timed out after 20 ms");
  } finally {
    jest.restoreAllMocks();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a node that hangs during the health check is excluded instead of blocking every request", async () => {
  let nodes;
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.isolateModules(() => {
    jest.doMock("../../getConfig", () => () => ({ service_id: "test", network: "testnet", rpc_timeout_ms: 30, nodes: [{ name: "stuck", neurai_url: "stuck" }] }));
    jest.doMock("@neuraiproject/neurai-rpc", () => ({ ...jest.requireActual("@neuraiproject/neurai-rpc"), getRPC: () => hung }));
    nodes = require("../../getRPCNode");
  });
  try {
    await expect(nodes.getIdentity()).rejects.toThrow(/No healthy node/);
    expect(nodes.getNodes()).toMatchObject([{ name: "stuck", active: false, healthError: "RPC health check failed" }]);
  } finally {
    jest.restoreAllMocks();
  }
});
