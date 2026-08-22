jest.mock("../../wss/rpc", () => ({ callRPC: jest.fn(), initQueue: jest.fn(), getQueueStats: () => ({ size: 0, pending: 0 }) }));
jest.mock("../../getRPCNode", () => ({ getRPCNode: () => ({ rpc: jest.fn() }), getNodes: () => [] }));

const { callRPC } = require("../../wss/rpc");
const nodeHealth = require("../../wss/node-health");
const { handlers } = require("../../wss/methods");
const { CHAIN_METHODS, POOL_METHODS, REMOVED_METHODS, LEGACY_PARAMS_HINT } = require("../../wss/depin-methods");
const { ERROR_CODES } = require("../../wss/protocol");
const depinRateLimit = require("../../depinRateLimit");

const ctx = { config: {}, globalConfig: { depin: { rate_limit: 1000, ban_minutes: 10 } } };
function session(ip = "203.0.113.9") { return { helloDone: true, subs: new Set(), ip }; }
async function rejection(promise) {
  try { await promise; } catch (e) { return e; }
  throw new Error("expected rejection");
}

beforeEach(() => {
  depinRateLimit.resetSharedLimiter();
  callRPC.mockReset();
  jest.spyOn(nodeHealth, "isSyncing").mockReturnValue(false);
});

// The protocol 2 contracts (node registration in src/rpc/messages.cpp). The
// service forwards exactly these arrays; it never inserts or reorders.
const CONTRACTS = [
  ["depin.msg_info", "depingetmsginfo", []],
  ["depin.pool_stats", "depinpoolstats", []],
  ["depin.mcp_status", "depinmcpstatus", []],
  ["depin.challenge", "depinchallenge", ["&TEST/SEC", "tRERn8G265FxuHmiWVYtZ84ntQjW56BF8n", 1730000000000, "IIMy0pTV...=", "receive"]],
  ["depin.receive_msg", "depinreceivemsg", ["&TEST/SEC", "tRERn8G265FxuHmiWVYtZ84ntQjW56BF8n", "9bbd728c...", "IHpzi6TQ...=", 0, "", 50]],
  ["depin.sections", "depinlistsections", []],
  ["depin.sections", "depinlistsections", ["tRERn8G265FxuHmiWVYtZ84ntQjW56BF8n", "&TEST/SEC", "9bbd728c...", "IHpzi6TQ...="]],
  ["depin.clear_msg", "depinclearmsg", ["&TEST", "tQPMWuhNSyFQnMzf8NgGD5RfN95J17G8hp", "db3c2710...", "sig=", "all"]],
  ["depin.submit_msg", "depinsubmitmsg", [{ sender: "tQPMWuhNSyFQnMzf8NgGD5RfN95J17G8hp", encrypted: "2103..." }]],
  ["depin.ancestor_recipients", "depingetancestorrecipients", ["&TEST/SEC", 20, "&TEST"]],
  ["depin.check_validity", "checkdepinvalidity", ["&TEST", "tRERn8G265FxuHmiWVYtZ84ntQjW56BF8n"]],
  ["depin.list_holders", "listdepinholders", ["&TEST"]],
  ["depin.list_addresses", "listdepinaddresses", ["&TEST", 10, 0]],
  ["depin.get_pubkey", "getpubkey", ["tRERn8G265FxuHmiWVYtZ84ntQjW56BF8n"]],
];

test.each(CONTRACTS)("%s forwards to %s with params untouched", async (method, rpc, args) => {
  const reply = { encrypted: "21...", poolsig: "sig" };
  callRPC.mockResolvedValue(reply);
  expect(await handlers[method](session(), args, ctx)).toBe(reply);
  expect(callRPC).toHaveBeenLastCalledWith(rpc, args);
  // {args: [...]} is the other accepted shape.
  expect(await handlers[method](session(), { args }, ctx)).toBe(reply);
  expect(callRPC).toHaveBeenLastCalledWith(rpc, args);
});

test("the method table matches the plan: nothing wallet-bound, nothing retired", () => {
  expect(Object.keys({ ...CHAIN_METHODS, ...POOL_METHODS }).sort()).toEqual([
    "depin.ancestor_recipients", "depin.challenge", "depin.check_validity", "depin.clear_msg", "depin.get_pubkey",
    "depin.list_addresses", "depin.list_holders", "depin.mcp_status", "depin.msg_info", "depin.pool_stats",
    "depin.receive_msg", "depin.sections", "depin.submit_msg",
  ]);
  const rpcs = Object.values({ ...CHAIN_METHODS, ...POOL_METHODS });
  for (const never of ["depinsendmsg", "depingetmsg", "depinsignrequest", "depinsignchallenge", "depindecrypt", "depinpoolpkey", "depingetpoolcontent", "listpqaddresses"]) {
    expect(rpcs).not.toContain(never);
  }
});

test("protocol 1 param shapes are refused with 1003 and never reach the node", async () => {
  for (const legacy of [{ address: "Nabc" }, { address: "Nabc", signature: "sig", args: ["&TEST"] }, { signature: "sig", args: [] }]) {
    for (const method of ["depin.challenge", "depin.receive_msg", "depin.submit_msg", "depin.clear_msg"]) {
      const e = await rejection(handlers[method](session(), legacy, ctx));
      expect(e.code).toBe(ERROR_CODES.INVALID_PARAMS);
      expect(e.message).toBe(LEGACY_PARAMS_HINT);
    }
  }
  const e = await rejection(handlers["depin.msg_info"](session(), { token: "&TEST" }, ctx));
  expect(e.code).toBe(ERROR_CODES.INVALID_PARAMS);
  expect(callRPC).not.toHaveBeenCalled();
});

test.each(Object.keys(REMOVED_METHODS))("%s answers 1004 with a pointer", async (method) => {
  const e = await rejection(handlers[method](session(), [], ctx));
  expect(e.code).toBe(ERROR_CODES.METHOD_NOT_FOUND);
  expect(e.message).toMatch(/removed with DePIN protocol 2/);
});

test("pool methods are not gated by the service's sync state; chain queries are", async () => {
  nodeHealth.isSyncing.mockReturnValue(true);
  callRPC.mockResolvedValue({ body: "00", poolsig: "sig" });
  for (const method of Object.keys(POOL_METHODS)) {
    await expect(handlers[method](session(), [], ctx)).resolves.toBeDefined();
  }
  for (const method of Object.keys(CHAIN_METHODS)) {
    const e = await rejection(handlers[method](session(), ["&TEST"], ctx));
    expect([method, e.code]).toEqual([method, ERROR_CODES.NODE_SYNCING]);
  }
});

test("hello is required", async () => {
  const e = await rejection(handlers["depin.msg_info"]({ helloDone: false, subs: new Set() }, [], ctx));
  expect(e.code).toBe(ERROR_CODES.INVALID_PARAMS);
});

test("node errors keep their JSON-RPC code; upstream failures are neutral", async () => {
  callRPC.mockRejectedValueOnce({ statusText: "Bad Request", status: 400, error: { code: -32600, message: "Request authentication failed: replayed request" } });
  let e = await rejection(handlers["depin.challenge"](session(), ["&TEST", "t..", 1, "sig", "receive"], ctx));
  expect(e.code).toBe(ERROR_CODES.INTERNAL_ERROR);
  expect(e.message).toBe("Request authentication failed: replayed request");
  expect(e.extra).toEqual({ code: -32600 });

  callRPC.mockRejectedValueOnce({ statusText: "Unauthorized", status: 401, description: null, error: null });
  e = await rejection(handlers["depin.msg_info"](session(), [], ctx));
  expect(e.message).toBe("upstream RPC unavailable");
  expect(e.extra).toEqual({ code: null });

  callRPC.mockRejectedValueOnce({ error: { code: -8, message: "Asset name must start with &" }, description: "x" });
  expect(await handlers["depin.check_validity"](session(), ["FOO", "N"], ctx)).toEqual({ valid: false, isDePinAsset: false, message: "Not a DePIN asset (assets must start with & to be DePIN assets)" });
});

test("depin* quota is per session IP, shared with HTTP, and ignores chain queries", async () => {
  const quota = { config: {}, globalConfig: { depin: { rate_limit: 2, ban_minutes: 1 } } };
  callRPC.mockResolvedValue({ body: "00", poolsig: "sig" });
  await handlers["depin.msg_info"](session(), [], quota);
  await handlers["depin.check_validity"](session(), ["&TEST", "N"], quota); // not counted
  await handlers["depin.pool_stats"](session(), [], quota);
  const e = await rejection(handlers["depin.challenge"](session(), ["&TEST", "N", 1, "s", "receive"], quota));
  expect(e.code).toBe(ERROR_CODES.RATE_LIMITED);
  expect(e.extra).toEqual({ retry_after_seconds: 60, banned: true });
  expect(callRPC).toHaveBeenCalledTimes(3);
  // Another IP is unaffected; the HTTP side sees the same ban because it is
  // the same limiter instance.
  await expect(handlers["depin.msg_info"](session("203.0.113.10"), [], quota)).resolves.toBeDefined();
  expect(depinRateLimit.getSharedLimiter().check("203.0.113.9").banned).toBe(true);
});
