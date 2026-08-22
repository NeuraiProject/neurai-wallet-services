// Characterization of how WSS handlers react to the rejection shapes of
// @neuraiproject/neurai-rpc (see rpcError.js), and to the `undefined` result
// 0.4.7 produced for JSON-RPC errors delivered with HTTP 200.
jest.mock("../../wss/rpc", () => ({ callRPC: jest.fn(), initQueue: jest.fn(), getQueueStats: () => ({ size: 0, pending: 0 }) }));
jest.mock("../../getRPCNode", () => ({ getRPCNode: () => ({ rpc: jest.fn() }), getNodes: () => [] }));

const { callRPC } = require("../../wss/rpc");
const nodeHealth = require("../../wss/node-health");
const { handlers } = require("../../wss/methods");
const { ERROR_CODES } = require("../../wss/protocol");
const { UPSTREAM_UNAVAILABLE } = require("../../rpcError");

const shape1 = { error: { code: -26, message: "txn-mempool-conflict" }, description: "txn-mempool-conflict" };
const shape2 = { statusText: "Internal Server Error", status: 500, description: undefined, error: { code: -5, message: "Invalid address" } };
const shape3 = { originalError: new Error("ECONNREFUSED"), type: "ServerUnreachable", error: "Could not communicate with Neurai core node", description: "..." };

const ctx = { config: { max_subscriptions_per_session: 200, send_initial_state: true, history_page_limit: 100, utxo_page_limit: 1000, bulk_subscribe_limit: 200 } };
function session() { return { helloDone: true, subs: new Set(), ip: "203.0.113.9" }; }
function withRpc(table) {
  callRPC.mockImplementation(async (method, params) => {
    const entry = table[method];
    if (typeof entry === "function") return entry(params);
    if (entry && entry.reject) throw entry.reject;
    return entry;
  });
}
async function rejection(promise) {
  try { await promise; } catch (e) { return e; }
  throw new Error("expected rejection");
}

beforeEach(() => { jest.spyOn(nodeHealth, "isSyncing").mockReturnValue(false); callRPC.mockReset(); });

test("tx.broadcast surfaces the node's JSON-RPC message and code", async () => {
  withRpc({ sendrawtransaction: { reject: shape1 } });
  const e = await rejection(handlers["tx.broadcast"](session(), { rawtx: "00" }));
  expect(e.code).toBe(ERROR_CODES.INTERNAL_ERROR);
  expect(e.message).toBe("txn-mempool-conflict");
  expect(e.extra).toEqual({ code: -26 });
});

test("tx.broadcast reports an upstream failure neutrally", async () => {
  withRpc({ sendrawtransaction: { reject: shape3 } });
  const e = await rejection(handlers["tx.broadcast"](session(), { rawtx: "00" }));
  expect(e.code).toBe(ERROR_CODES.INTERNAL_ERROR);
  expect(e.message).toBe(UPSTREAM_UNAVAILABLE);
  expect(e.extra).toEqual({ code: null });
});

test("hello tolerates a failing tip lookup", async () => {
  withRpc({ getbestblockhash: { reject: shape3 } });
  const result = await handlers.hello(session(), { protocol: "wss/1" });
  expect(result.tip_hash).toBe(null);
  expect(result.tip_height).toBe(null);
});

test("address.get_state: a rejected getaddressdeltas yields an empty history, not an error", async () => {
  withRpc({
    validateaddress: { isvalid: true },
    getaddressbalance: [{ assetName: "XNA", balance: 5, received: 5 }],
    getaddressmempool: [],
    getaddressutxos: [],
    getaddressdeltas: { reject: shape2 },
  });
  const result = await handlers["address.get_state"](session(), { address: "Nabc" }, ctx);
  expect(result.history).toEqual([]);
  expect(result.balance).toEqual({ confirmed: 5, unconfirmed: 0 });
});

test("address.get_state: an `undefined` validateaddress (0.4.7 on HTTP-200 errors) reads as invalid address", async () => {
  withRpc({ validateaddress: undefined });
  const e = await rejection(handlers["address.get_state"](session(), { address: "Nabc" }, ctx));
  expect(e.code).toBe(ERROR_CODES.INVALID_PARAMS);
});

test("address.subscribe: balance lookups that reject degrade to zero balances", async () => {
  withRpc({
    validateaddress: { isvalid: true },
    getaddressbalance: { reject: shape2 },
    getaddressmempool: { reject: shape3 },
    getaddressutxos: { reject: shape1 },
    getblockcount: 10,
  });
  const result = await handlers["address.subscribe"](session(), { address: "Nabc" }, ctx);
  expect(result.balance).toEqual({ confirmed: 0, unconfirmed: 0 });
  expect(result.height).toBe(10);
});
