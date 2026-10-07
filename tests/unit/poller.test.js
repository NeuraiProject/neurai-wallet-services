jest.mock("../../wss/rpc", () => ({ callRPC: jest.fn() }));
const { callRPC } = require("../../wss/rpc");
const poller = require("../../wss/poller");

afterEach(() => jest.useRealTimers());

test("without an onMempoolAdded handler only the tip is polled", () => {
  jest.useFakeTimers();
  callRPC.mockReturnValue(new Promise(() => {}));
  const timers = poller.start({ poll_interval_ms: 1000 }, { onBlock: jest.fn(), onInitialTip: jest.fn() });
  jest.advanceTimersByTime(5000);
  expect(callRPC).toHaveBeenCalledWith("getbestblockhash", []);
  expect(callRPC.mock.calls.every(([method]) => method === "getbestblockhash")).toBe(true);
  expect(timers.mempoolTimer).toBeNull();
  clearInterval(timers.blockTimer);
});

test("with an onMempoolAdded handler the mempool is polled too", () => {
  jest.useFakeTimers();
  callRPC.mockReset();
  callRPC.mockReturnValue(new Promise(() => {}));
  const timers = poller.start({ poll_interval_ms: 1000, mempool_interval_ms: 1000 }, { onBlock: jest.fn(), onMempoolAdded: jest.fn() });
  jest.advanceTimersByTime(2000);
  expect(callRPC).toHaveBeenCalledWith("getrawmempool", []);
  clearInterval(timers.blockTimer);
  clearInterval(timers.mempoolTimer);
});
