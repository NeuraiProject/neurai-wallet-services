jest.mock("../../getRPCNode", () => ({ getRPCNode: () => ({ rpc: jest.fn() }) }));

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const { attachHttpService } = require("../../wss/server");
const { create } = require("../../http");

function httpGet(server) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/settings`, (res) => {
      let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on("error", reject);
  });
}

test("HTTP and WebSocket upgrades coexist on one listener", async () => {
  const service = create({ enabled: true, environment: "test", max_requests_per_second: 100 }, null, {
    rpc: async () => 1,
    nodeDeps: { getNodes: () => [], getDePinNodes: () => [], getDePinNode: () => ({ depinUrl: "http://localhost" }) },
    depinService: { getCacheStats: () => ({}), executeDePinRPC: jest.fn() },
  });
  const server = http.createServer();
  attachHttpService(server, service);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const settings = await httpGet(server);
  expect(settings).toEqual({ status: 200, body: { environment: "test" } });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/push`);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.close();
  await new Promise((resolve) => ws.once("close", resolve));
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
});
