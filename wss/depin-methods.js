const { ERROR_CODES } = require("./protocol");
const { MethodError, requireHello, requireSynced } = require("./common");
const { callRPC } = require("./rpc");
const { toClientError, getRPCErrorMessage } = require("../rpcError");
const { getSharedLimiter, isDepinMethod } = require("../depinRateLimit");

// DePIN protocol 2: every DePIN operation is a normal JSON-RPC call on the
// node's RPC port, so each depin.* method below is a name translation over
// callRPC and nothing more. The client signs challenge requests (DEPIN-REQ)
// and challenges (DEPIN-GET / DEPIN-CLEAR), decrypts replies bound to its
// address, verifies `poolsig` against the pool key it pinned, and wraps
// depinsubmitmsg in an ECIES envelope for that key. This service keeps no
// challenges and no keys; the node issues, validates and consumes them.
//
// Params are positional (`[...]`) or `{args: [...]}`, forwarded untouched.

// Chain queries. Cacheable chain state; refused while the node is syncing so
// we never answer from a partial index.
const CHAIN_METHODS = {
  "depin.check_validity": "checkdepinvalidity",
  "depin.list_holders": "listdepinholders",
  "depin.list_addresses": "listdepinaddresses",
  "depin.get_pubkey": "getpubkey",
  "depin.ancestor_recipients": "depingetancestorrecipients",
};

// Pool operations. The node decides access against its own index, so they are
// not gated by this service's view of sync state (plan §4; the IBD
// integration test validates that decision).
const POOL_METHODS = {
  "depin.msg_info": "depingetmsginfo",
  "depin.pool_stats": "depinpoolstats",
  "depin.mcp_status": "depinmcpstatus",
  "depin.challenge": "depinchallenge",
  "depin.receive_msg": "depinreceivemsg",
  "depin.submit_msg": "depinsubmitmsg",
  "depin.sections": "depinlistsections",
  "depin.clear_msg": "depinclearmsg",
};

// Retired with protocol 2. Registered only to answer with a pointer instead of
// a bare "method not found".
const REMOVED_METHODS = {
  "depin.send_msg": "depinsendmsg needs the node's wallet; sign and encrypt locally, then depin.submit_msg",
  "depin.get_msg": "depingetmsg needs the node's wallet; read with depin.receive_msg and decrypt locally",
  "depin.pool_pkey": "the pool key is published by depin.msg_info (depinpoolpkey)",
  "depin.pool_content": "depingetpoolcontent no longer exists in the node",
  "depin.list_pq_addresses": "listpqaddresses lists the node wallet's addresses",
};

const LEGACY_PARAMS_HINT =
  "DePIN protocol 2: pass positional params; the proxy no longer requests challenges or signs on your behalf";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function coerceArgs(params) {
  if (params == null) return [];
  if (Array.isArray(params)) return params;
  if (typeof params !== "object") {
    throw new MethodError(ERROR_CODES.INVALID_PARAMS, "params must be a positional array or {args: [...]}");
  }
  // The protocol 1 shapes were {address} and {address, signature, args}. Refuse
  // them outright (with or without args) rather than forwarding something the
  // node would reject for the wrong reason.
  if (hasOwn(params, "address") || hasOwn(params, "signature")) {
    throw new MethodError(ERROR_CODES.INVALID_PARAMS, LEGACY_PARAMS_HINT);
  }
  if (Array.isArray(params.args)) return params.args;
  if (Object.keys(params).length === 0) return [];
  throw new MethodError(ERROR_CODES.INVALID_PARAMS, "params must be a positional array or {args: [...]}");
}

// Same per-IP quota as HTTP, same limiter instance: changing transport does
// not reset the count. Only RPC names starting with "depin" count.
function enforceQuota(session, ctx, rpcMethod) {
  if (!isDepinMethod(rpcMethod)) return;
  const limiter = getSharedLimiter(ctx && ctx.globalConfig);
  const ip = session.ip || "unknown";
  const verdict = limiter.check(ip, Date.now());
  if (verdict.allowed) return;
  if (verdict.justBanned) {
    console.log(`[WSS] DePIN rate limit exceeded, banning ${ip} for ${limiter.stats().ban_minutes} minutes`);
  }
  throw new MethodError(ERROR_CODES.RATE_LIMITED, "too many DePIN requests", {
    retry_after_seconds: verdict.retryAfterSeconds,
    banned: verdict.banned === true,
  });
}

function makeHandler(rpcMethod, { gated }) {
  return async (session, params, ctx) => {
    requireHello(session);
    if (gated) requireSynced();
    const args = coerceArgs(params);
    enforceQuota(session, ctx, rpcMethod);
    try {
      return await callRPC(rpcMethod, args);
    } catch (e) {
      // Match the original /rpc behavior: checkdepinvalidity on non-DePIN assets
      // ("must start with &") returns a structured "not a DePIN asset" object
      // instead of erroring out — useful for wallets querying arbitrary assets.
      if (rpcMethod === "checkdepinvalidity" && getRPCErrorMessage(e).includes("must start with &")) {
        return {
          valid: false,
          isDePinAsset: false,
          message: "Not a DePIN asset (assets must start with & to be DePIN assets)",
        };
      }
      // The node's message and JSON-RPC code (-32600, -8, -5, -22, -25, -1;
      // spec §10) reach the client; an upstream failure is reported neutrally.
      const err = toClientError(e, `${rpcMethod} failed`);
      throw new MethodError(ERROR_CODES.INTERNAL_ERROR, err.message, { code: err.code });
    }
  };
}

const handlers = {};
for (const [wssMethod, rpcMethod] of Object.entries(CHAIN_METHODS)) handlers[wssMethod] = makeHandler(rpcMethod, { gated: true });
for (const [wssMethod, rpcMethod] of Object.entries(POOL_METHODS)) handlers[wssMethod] = makeHandler(rpcMethod, { gated: false });
for (const [wssMethod, reason] of Object.entries(REMOVED_METHODS)) {
  handlers[wssMethod] = async () => {
    throw new MethodError(ERROR_CODES.METHOD_NOT_FOUND, `${wssMethod} was removed with DePIN protocol 2: ${reason}`);
  };
}

module.exports = { handlers, CHAIN_METHODS, POOL_METHODS, REMOVED_METHODS, coerceArgs, LEGACY_PARAMS_HINT };
