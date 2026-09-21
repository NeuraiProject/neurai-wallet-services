// Characterization of how WSS handlers react to the rejection shapes of
// @neuraiproject/neurai-rpc (see rpcError.js), and to the `undefined` result
// 0.4.7 produced for JSON-RPC errors delivered with HTTP 200.
jest.mock("../../wss/rpc", () => ({ callRPC: jest.fn(), initQueue: jest.fn(), getQueueStats: () => ({ size: 0, pending: 0 }) }));
jest.mock("../../getRPCNode", () => ({ getRPCNode: () => ({ rpc: jest.fn() }), getNodes: () => [], getIdentity: async () => ({ network: "testnet", genesis_hash: "a".repeat(64), service_id: "test" }) }));

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
  const result = await handlers.hello({ ...session(), helloDone: false }, { protocol: "wss/1" });
  expect(result.tip_hash).toBe(null);
  expect(result.tip_height).toBe(null);
});

test("address.get_state: a rejected getaddressdeltas fails without publishing empty history", async () => {
  withRpc({
    validateaddress: { isvalid: true },
    getaddressbalance: [{ assetName: "XNA", balance: 5, received: 5 }],
    getaddressmempool: [],
    getaddressutxos: [],
    getaddressdeltas: { reject: shape2 },
  });
  await expect(handlers["address.get_state"](session(), { address: "Nabc" }, ctx)).rejects.toEqual(shape2);
});

test("address.get_state: an `undefined` validateaddress (0.4.7 on HTTP-200 errors) reads as invalid address", async () => {
  withRpc({ validateaddress: undefined });
  const e = await rejection(handlers["address.get_state"](session(), { address: "Nabc" }, ctx));
  expect(e.code).toBe(ERROR_CODES.INVALID_PARAMS);
});

test("address.subscribe: balance failure rolls back a new subscription", async () => {
  withRpc({
    validateaddress: { isvalid: true },
    getaddressbalance: { reject: shape2 },
    getaddressmempool: { reject: shape3 },
    getaddressutxos: { reject: shape1 },
    getblockcount: 10,
  });
  const client = session();
  await expect(handlers["address.subscribe"](client, { address: "Nabc" }, ctx)).rejects.toEqual(shape2);
  expect(client.subs.size).toBe(0);
});

function healthy(overrides = {}) {
  withRpc({ validateaddress: { isvalid: true }, getaddressbalance: [], getaddressmempool: [], getaddressutxos: [], getaddressdeltas: [], ...overrides });
}
test.each([undefined, 'wss/1', 'wss/2'])('negotiates %s and cannot renegotiate', async protocol => {
  healthy();
  const client = { ...session(), helloDone: false };
  const result = await handlers.hello(client, { protocol, network: 'testnet' });
  expect(result.protocol).toBe(protocol || 'wss/1');
  expect(result.exact_amounts).toBe(protocol === 'wss/2');
  await expect(handlers.hello(client, { protocol: 'wss/2' })).rejects.toThrow('already');
});
test('unsupported protocol and wrong network do not complete hello', async () => {
  const client = { ...session(), helloDone: false };
  await expect(handlers.hello(client, { protocol: 'wss/9' })).rejects.toMatchObject({ code: 1001 });
  await expect(handlers.hello(client, { network: 'mainnet' })).rejects.toThrow('network');
  expect(client.helloDone).toBe(false);
});
test('empty state is valid; required monetary fields are not optional', async () => {
  healthy();
  expect((await handlers['address.get_state'](session(), { address: 'empty' }, ctx)).balance).toEqual({ confirmed: 0n, unconfirmed: 0n });
  healthy({ getaddressbalance: [{ assetName: 'XNA' }] });
  await expect(handlers['address.get_state'](session(), { address: 'bad' }, ctx)).rejects.toThrow('amount');
});
test('large opposite deltas aggregate to one satoshi, all internal rows normalize', async () => {
  healthy({ getaddressbalance: [{ assetName: 'XNA', balance: '10000000000000001' }],
    getaddressmempool: [{ satoshis: '-10000000000000001', txid: 'm' }, { satoshis: '10000000000000000', txid: 'n' }],
    getaddressdeltas: [{ height: 1, blockindex: 0, txid: 't', satoshis: '10000000000000001' }, { height: 1, blockindex: 0, txid: 't', satoshis: '-10000000000000000' }] });
  const state = await handlers['address.get_state'](session(), { address: 'a' }, ctx);
  expect(state.balance).toEqual({ confirmed: 10000000000000001n, unconfirmed: -1n });
  expect(state.history[0].satoshis).toBe(1n);
  expect(state.mempool[0].satoshis).toBe(-10000000000000001n);
});
test('bulk preserves successes and existing subscriptions when a new initial fetch fails', async () => {
  const subscriptions = require('../../wss/subscriptions');
  const client = session();
  subscriptions.subscribe('old', client);
  healthy({ getaddressbalance: params => { if (params[0].addresses[0] !== 'ok') throw new Error('offline'); return []; } });
  const result = await handlers['address.subscribe.bulk'](client, { addresses: ['old', 'new', 'ok'] }, ctx);
  expect(result.results.map(r => !!r.error)).toEqual([true, true, false]);
  expect([...client.subs]).toEqual(['old', 'ok']);
  subscriptions.unsubscribeAll(client);
});
test('concurrent subscriptions cannot exceed a session cap', async () => {
  healthy();
  const client = session();
  const results = await Promise.allSettled(['a', 'b'].map(address => handlers['address.subscribe'](client, { address }, { config: { ...ctx.config, max_subscriptions_per_session: 1 } })));
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
  require('../../wss/subscriptions').unsubscribeAll(client);
});
test('history and UTXO pagination preserve exact values across all pages', async () => {
  healthy({ getaddressutxos: [{ txid: 'a', outputIndex: 0, height: 1, satoshis: '10000000000000001' }, { txid: 'b', outputIndex: 0, height: 2, satoshis: '10000000000000003' }],
    getaddressdeltas: [{ height: 1, blockindex: 0, txid: 'a', satoshis: '10000000000000001' }, { height: 2, blockindex: 0, txid: 'b', satoshis: '-10000000000000003' }] });
  const first = await handlers['address.get_state'](session(), { address: 'a', limit: 1, utxo_limit: 1 }, ctx);
  expect(first.page.has_more).toBe(true); expect(first.utxo_page.has_more).toBe(true);
  const second = await handlers['address.get_state'](session(), { address: 'a', limit: 1, utxo_limit: 1, cursor: first.page.next_cursor, utxo_cursor: first.utxo_page.next_cursor }, ctx);
  expect(second.history[0].satoshis).toBe(-10000000000000003n);
  expect(second.utxos[0].satoshis).toBe(10000000000000003n);
  expect(second.page.has_more).toBe(false); expect(second.utxo_page.has_more).toBe(false);
});
