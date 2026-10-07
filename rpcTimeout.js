// Time limit for every call to a node.
//
// @neuraiproject/neurai-rpc calls fetch() without an AbortSignal, so a node
// that stops answering kept the call pending for as long as the socket lived.
// Each pending call holds a slot of the node queue that HTTP and WSS share
// (wss/rpc.js), and a hung health check blocked every request waiting for a
// healthy node (getRPCNode.js). The limit releases the caller; the request may
// still finish on the node, which cannot be cancelled from here.
//
// Root config: `rpc_timeout_ms` for every method (30 s by default) and
// `rpc_method_timeouts_ms` for the slow ones, e.g. {"gettxoutsetinfo": 600000}.

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_METHOD_TIMEOUTS_MS = {
  // Scans the whole UTXO set; minutes on mainnet.
  gettxoutsetinfo: 600000,
};

function positiveInt(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`[config] ${name} must be a positive integer (milliseconds)`);
  return value;
}

function resolveRpcTimeouts(config) {
  const root = config || {};
  const base = root.rpc_timeout_ms == null ? DEFAULT_TIMEOUT_MS : positiveInt(root.rpc_timeout_ms, "rpc_timeout_ms");
  const overrides = root.rpc_method_timeouts_ms == null ? {} : root.rpc_method_timeouts_ms;
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("[config] rpc_method_timeouts_ms must be an object of method: milliseconds");
  }
  const perMethod = new Map(Object.entries(DEFAULT_METHOD_TIMEOUTS_MS));
  for (const [method, value] of Object.entries(overrides)) perMethod.set(method, positiveInt(value, `rpc_method_timeouts_ms.${method}`));
  return {
    timeoutFor(method) {
      return perMethod.has(method) ? perMethod.get(method) : base;
    },
  };
}

// Recognised by rpcError.js as an upstream failure, like an unreachable node.
class RpcTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super(`${method} timed out after ${timeoutMs} ms`);
    this.name = "RpcTimeoutError";
    this.type = "Timeout";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

function withTimeout(rpc, timeouts) {
  return (method, params) => new Promise((resolve, reject) => {
    const timeoutMs = timeouts.timeoutFor(method);
    const timer = setTimeout(() => reject(new RpcTimeoutError(method, timeoutMs)), timeoutMs);
    if (timer.unref) timer.unref();
    Promise.resolve()
      .then(() => rpc(method, params))
      .then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
  });
}

module.exports = { DEFAULT_TIMEOUT_MS, DEFAULT_METHOD_TIMEOUTS_MS, RpcTimeoutError, resolveRpcTimeouts, withTimeout };
