jest.mock("../../getRPCNode", () => ({ getRPCNode: () => ({ rpc: jest.fn() }), getNodes: () => [], getIdentity: async () => ({}) }));
jest.mock("../../wss/poller", () => ({ start: jest.fn() }));

const http = require("http");
const poller = require("../../wss/poller");
const { start, listenerConfig } = require("../../http/standalone");
const { create } = require("../../http");

function post(server, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: "/rpc", headers: { "content-type": "application/json" } }, (res) => {
      let data = ""; res.on("data", (chunk) => { data += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
}

test("serves /rpc without WSS and clears the per-block cache on every new tip", async () => {
  let calls = 0;
  const service = create({ enabled: true }, null, { nodeDeps: { getNodes: () => [] }, rpc: async () => ++calls });
  const server = start({ enabled: true, host: "127.0.0.1", port: 0, tls_enabled: false }, service);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    // Only the tip is followed: no mempool handler, so the poller never asks for it.
    expect(poller.start).toHaveBeenCalledTimes(1);
    const [pollConfig, handlers] = poller.start.mock.calls[0];
    expect(pollConfig).toEqual({ poll_interval_ms: 1000 });
    expect(handlers.onMempoolAdded).toBeUndefined();

    expect((await post(server, { method: "getblockcount", params: [] })).body).toEqual({ result: 1 });
    expect((await post(server, { method: "getblockcount", params: [] })).body).toEqual({ result: 1 });
    handlers.onBlock("b".repeat(64));
    expect((await post(server, { method: "getblockcount", params: [] })).body).toEqual({ result: 2 });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the standalone listener needs a port, certificates for TLS and a sane poll interval", () => {
  expect(() => listenerConfig({})).toThrow("http.port is required");
  expect(() => listenerConfig({ port: 19020 })).toThrow("http.ssl_cert and http.ssl_key required");
  expect(() => listenerConfig({ port: 19020, tls_enabled: false, tip_poll_interval_ms: 100 })).toThrow("at least 500");
  expect(listenerConfig({ port: 19020, tls_enabled: false })).toEqual({
    host: "0.0.0.0", port: 19020, tls_enabled: false, ssl_cert: undefined, ssl_key: undefined, tip_poll_interval_ms: 1000,
  });
});
