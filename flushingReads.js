// Temporary guard for node reads that flush the node's state on every call.
//
// Mainnet runs node v1.0.6. There, the asset and restricted-asset list RPCs
// and gettxoutsetinfo call FlushStateToDisk() each time: cs_main is held while
// the UTXO cache is written out, so a burst of them stalls block validation.
// The node fix flushes at most once per chain state (DePIN-Test b96c49f and
// a9f7ca5 for the asset reads, 1e32522 for gettxoutsetinfo); drop this guard
// once mainnet runs a release that has it.
//
// One limiter for the whole service, not per IP: the point is to protect the
// node. wss/rpc.js checks it inside the shared node queue, right before the
// call reaches the node, so HTTP and WSS draw from the same budget, a reply
// from the HTTP cache never counts, and calls waiting in a queue spend nothing
// until their turn.
//  - a token bucket: `per_second` tokens per second, at most `burst` stored.
//    Not a cap per second: a full bucket lets `burst` calls through at once;
//  - at most `max_in_flight` of these calls outstanding at once. A call that
//    times out frees its slot although the node may still be running it.
// Both limits are checked and taken together: a call refused for one of them
// takes nothing from the other. per_second = 0 disables both.

const FLUSHING_READ_METHODS = Object.freeze([
  "listassets",
  "listaddressesbyasset",
  "listassetbalancesbyaddress",
  "listtagsforaddress",
  "listaddressesfortag",
  "listaddressrestrictions",
  "listglobalrestrictions",
  "gettxoutsetinfo",
]);
const FLUSHING_READS = new Set(FLUSHING_READ_METHODS);

// max_in_flight 4 matches the node queue (wss/rpc.js), so by default no call is
// refused for concurrency: the explorer asks for three of these at once on an
// asset page, and gettxoutsetinfo keeps its slot for minutes on mainnet (its
// scan runs after the flush, without cs_main). The rate is what limits flushes.
const DEFAULTS = Object.freeze({ per_second: 2, burst: 20, max_in_flight: 4 });

function isFlushingRead(method) {
  return FLUSHING_READS.has(method);
}

// Thrown by wss/rpc.js instead of calling the node (rpcError.isThrottled).
// HTTP answers 503 with Retry-After, WSS answers 1007 with retry_after_seconds.
class FlushingReadThrottledError extends Error {
  constructor(method, retryAfterSeconds) {
    super(`${method} is rate limited on this service to protect the node; retry in ${retryAfterSeconds} s`);
    this.name = "FlushingReadThrottledError";
    this.type = "Throttled";
    this.method = method;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function createFlushingReadLimiter({ perSecond = DEFAULTS.per_second, burst = DEFAULTS.burst, maxInFlight = DEFAULTS.max_in_flight } = {}) {
  let tokens = burst;
  let refilledAt = null;
  let inFlight = 0;

  function refill(now) {
    if (refilledAt !== null && now > refilledAt) tokens = Math.min(burst, tokens + ((now - refilledAt) * perSecond) / 1000);
    if (refilledAt === null || now > refilledAt) refilledAt = now;
  }

  // Returns a permit to release once the node call ends, or the refusal.
  function tryAcquire(now = Date.now()) {
    if (perSecond <= 0) return { allowed: true, release() {} };
    refill(now);
    // The node gives no hint of when a running call ends: one second.
    if (inFlight >= maxInFlight) return { allowed: false, reason: "in_flight", retryAfterSeconds: 1 };
    if (tokens < 1) return { allowed: false, reason: "rate", retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / perSecond)) };
    tokens -= 1;
    inFlight += 1;
    let released = false;
    return {
      allowed: true,
      release() {
        if (released) return;
        released = true;
        inFlight -= 1;
      },
    };
  }

  function stats(now = Date.now()) {
    if (perSecond > 0) refill(now);
    return { per_second: perSecond, burst, max_in_flight: maxInFlight, tokens: Math.floor(tokens), in_flight: inFlight };
  }

  return { tryAcquire, stats };
}

// config.json:  "flushing_reads": { "per_second": 2, "burst": 20, "max_in_flight": 4 }
function resolveFlushingReadsConfig(globalConfig) {
  const raw = globalConfig && globalConfig.flushing_reads;
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) throw new Error("[config] flushing_reads must be an object");
  const section = raw || {};
  const perSecond = section.per_second == null ? DEFAULTS.per_second : section.per_second;
  if (typeof perSecond !== "number" || !Number.isFinite(perSecond) || perSecond < 0) {
    throw new Error("[config] flushing_reads.per_second must be a non-negative number (0 disables the limit)");
  }
  const positive = (name) => {
    const value = section[name] == null ? DEFAULTS[name] : section[name];
    if (!Number.isInteger(value) || value < 1) throw new Error(`[config] flushing_reads.${name} must be a positive integer`);
    return value;
  };
  return { per_second: perSecond, burst: positive("burst"), max_in_flight: positive("max_in_flight") };
}

let shared = null;

// index.js creates it at start with the root config; later calls (wss/rpc.js)
// get that same instance.
function getSharedFlushingLimiter(globalConfig) {
  if (shared) return shared;
  const cfg = resolveFlushingReadsConfig(globalConfig);
  shared = createFlushingReadLimiter({ perSecond: cfg.per_second, burst: cfg.burst, maxInFlight: cfg.max_in_flight });
  return shared;
}

function resetSharedFlushingLimiter() {
  shared = null;
}

module.exports = {
  FLUSHING_READ_METHODS,
  FlushingReadThrottledError,
  isFlushingRead,
  createFlushingReadLimiter,
  resolveFlushingReadsConfig,
  getSharedFlushingLimiter,
  resetSharedFlushingLimiter,
};
