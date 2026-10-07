const { default: PQueue } = require("p-queue");
const { whitelist, isWhitelisted } = require("./whitelist");
const { createClients, parseExtraMethods } = require("./clients");
const cacheServiceMod = require("./cache-service");
const { filterRpcResult } = require("../rpcResults");
const { createHandler, sendJson } = require("./router");
const { toClientError, getRPCErrorMessage, describeForLog, isThrottled } = require("../rpcError");
const { clientIp, resolveTrustedProxies } = require("../clientIp");
const { getSharedLimiter, isDepinMethod, refusalDescription } = require("../depinRateLimit");

function createRateLimiter(limit) {
  const recent = [];
  return {
    tryAccept() {
    const now = Date.now();
    while (recent.length && recent[0] < now - 1000) recent.shift();
    if (recent.length >= limit) return false;
    recent.push(now);
    return true;
    },
  };
}

function positiveInt(value, fallback, name) {
  const result = value == null ? fallback : value;
  if (!Number.isInteger(result) || result < 1) throw new Error(`[HTTP] ${name} must be a positive integer`);
  return result;
}

function create(rawCfg, globalConfig, injected = {}) {
  if (!rawCfg || rawCfg.enabled !== true) return null;
  const cfg = {
    serve_www: rawCfg.serve_www !== false,
    heading: rawCfg.heading,
    environment: rawCfg.environment,
    endpoint: rawCfg.endpoint,
    concurrency: positiveInt(rawCfg.concurrency, 4, "concurrency"),
    max_requests_per_second: positiveInt(rawCfg.max_requests_per_second, 100, "max_requests_per_second"),
    max_requests_per_second_per_ip: positiveInt(rawCfg.max_requests_per_second_per_ip, Math.min(20, rawCfg.max_requests_per_second || 100), "max_requests_per_second_per_ip"),
    max_queue_size: positiveInt(rawCfg.max_queue_size, 500, "max_queue_size"),
    rate_limiter_ttl_ms: positiveInt(rawCfg.rate_limiter_ttl_ms, 5 * 60 * 1000, "rate_limiter_ttl_ms"),
    max_rate_limiter_ips: positiveInt(rawCfg.max_rate_limiter_ips, 10000, "max_rate_limiter_ips"),
    // Opt-in methods from EXTRA_METHODS for every client; keyed clients may add their own.
    extra_methods: parseExtraMethods(rawCfg.extra_methods, "extra_methods"),
  };
  if (cfg.max_requests_per_second_per_ip > cfg.max_requests_per_second) throw new Error("[HTTP] max_requests_per_second_per_ip cannot exceed max_requests_per_second");
  // trusted_proxy_ips is shared with WSS and lives at the root of config.json;
  // the former http.trusted_proxy_ips is still honoured (see clientIp.js).
  const trustedProxies = injected.trustedProxies || resolveTrustedProxies(globalConfig || { http: rawCfg });
  // Lazy defaults avoid loading config-bound node modules in unit tests.
  const nodeDeps = injected.nodeDeps || require("../getRPCNode");
  const rpc = injected.rpc || require("../wss/rpc").callRPC;
  // One limiter for depin* across HTTP and WSS, keyed by client IP.
  const depinLimiter = injected.depinLimiter || getSharedLimiter(globalConfig);
  const queue = new PQueue({ concurrency: cfg.concurrency });
  const cache = cacheServiceMod.create();
  const limits = new Map();
  const globalLimit = createRateLimiter(cfg.max_requests_per_second);
  const clients = createClients(rawCfg.clients);
  const clientLimiters = new Map();
  // One lookup per request: tryAccept runs before routing, handleRpc after it.
  const clientOf = new WeakMap();
  let numberOfRequests = 0;
  let lastBlockHash = null;

  function pruneLimiters(now = Date.now()) {
    for (const [ip, entry] of limits) if (entry.lastSeen < now - cfg.rate_limiter_ttl_ms) limits.delete(ip);
  }
  const limiterPruneTimer = setInterval(pruneLimiters, Math.min(cfg.rate_limiter_ttl_ms, 60000));
  if (limiterPruneTimer.unref) limiterPruneTimer.unref();

  function clientFor(req) {
    if (!clientOf.has(req)) clientOf.set(req, clients.identify(req, clientIp(req, trustedProxies)));
    return clientOf.get(req);
  }

  function isAllowed(method, client) {
    return isWhitelisted(method) || cfg.extra_methods.has(method) || (client !== null && client.extraMethods.has(method));
  }

  function tryAccept(req) {
    // A trusted client spends its own budget, never the public per-IP or global one.
    const client = clientFor(req);
    if (client) {
      if (!client.maxRequestsPerSecond) return true;
      let limiter = clientLimiters.get(client.name);
      if (!limiter) {
        limiter = createRateLimiter(client.maxRequestsPerSecond);
        clientLimiters.set(client.name, limiter);
      }
      return limiter.tryAccept();
    }
    const ip = clientIp(req, trustedProxies);
    let entry = limits.get(ip);
    if (!entry) {
      pruneLimiters();
      if (limits.size >= cfg.max_rate_limiter_ips) return false;
      entry = { limiter: createRateLimiter(cfg.max_requests_per_second_per_ip), lastSeen: Date.now() };
      limits.set(ip, entry);
    }
    entry.lastSeen = Date.now();
    if (!entry.limiter.tryAccept()) return false;
    return globalLimit.tryAccept();
  }

  function countRequest() {
    if (numberOfRequests > Number.MAX_SAFE_INTEGER - 1000) numberOfRequests = 0;
    numberOfRequests++;
  }

  async function handleRpc(body, req, res) {
    const method = body && body.method;
    const params = body && body.params;
    const client = clientFor(req);
    countRequest();
    // Lets an operator check that a key was recognised (a wrong key silently gets the public tier).
    if (client) res.setHeader("x-rpc-client", client.name);
    if (!isAllowed(method, client)) return sendJson(res, 404, { error: "Not in whitelist", description: `Method ${method} is not supported` });
    if (method === "listaddressesbyasset" && Array.isArray(params) && params[1] === true) {
      return sendJson(res, 404, { error: "Not in whitelist", description: `Method ${method} with totalCount set to true is not whitelisted. Please use ${method} without totalCount = true` });
    }
    // DePIN abuse control by origin IP: over the limit, the IP is blocked for
    // a while and every depin* call answers 429 until it lapses. The node
    // applies its own per-address quota behind this one.
    if (isDepinMethod(method)) {
      const ip = clientIp(req, trustedProxies);
      const verdict = depinLimiter.check(ip, Date.now());
      if (!verdict.allowed) {
        if (verdict.justBanned) console.log(`[HTTP] DePIN rate limit exceeded, banning ${ip} for ${depinLimiter.stats().ban_minutes} minutes`);
        return sendJson(res, 429, { error: "Too many requests", description: refusalDescription(verdict, depinLimiter) }, { "retry-after": String(verdict.retryAfterSeconds) });
      }
    }
    // max_queue_size bounds the public backlog; trusted clients are bounded by their own budget.
    if (!client && queue.size >= cfg.max_queue_size) return sendJson(res, 503, { error: "queue full" }, { "retry-after": "1" });
    try {
      const result = await queue.add(async () => {
        if (req.aborted || res.destroyed) return undefined;
        cache.addMethod(method, new Date());
        const cached = cache.shouldCache(method) && cache.get(method, params);
        if (cached) return cached;
        // Low priority shares the node-wide queue with WSS, whose work uses
        // the default priority and therefore jumps ahead of pending HTTP work.
        const promise = rpc(method, params, -1).then((value) => filterRpcResult(method, value));
        if (cache.shouldCache(method)) { cache.put(method, params, promise); promise.catch(() => cache.remove(method, params, promise)); }
        return promise;
      }, { priority: client ? 1 : 0 });
      if (req.aborted || res.destroyed) return;
      // neurai-rpc 0.4.7 resolved `undefined` for a JSON-RPC error delivered
      // with HTTP 200, which left the request without a response. 0.5.0+
      // rejects instead; keep `null` here so nothing can hang.
      return sendJson(res, 200, { result: result === undefined ? null : result });
    } catch (e) {
      // A read that flushes the node's state, refused by the service-wide
      // limit (flushingReads.js): busy, not an upstream failure. The cache has
      // already dropped the rejected promise.
      if (isThrottled(e)) return sendJson(res, 503, { error: "node busy", description: e.message }, { "retry-after": String(e.retryAfterSeconds) });
      if (method === "checkdepinvalidity" && getRPCErrorMessage(e).includes("must start with &")) return sendJson(res, 200, { result: { valid: false, isDePinAsset: false, message: "Not a DePIN asset (assets must start with & to be DePIN assets)" } });
      const err = toClientError(e);
      // Node JSON-RPC errors keep the documented 500 + {message, code}; an
      // upstream failure (unreachable node, bad credentials, non-JSON reply) is
      // 502 with a neutral message and the detail only in the log.
      if (err.upstream) { console.log(`[HTTP] ${method}: ${describeForLog(e)}`); return sendJson(res, 502, { error: { message: err.message, code: null } }); }
      return sendJson(res, 500, { error: { message: err.message, code: err.code } });
    }
  }

  function getStats() {
    return { queue: { size: queue.size, pending: queue.pending }, cache_items: cache.getKeys().length, rate_limiter_ips: limits.size, clients: clients.count, numberOfRequests: numberOfRequests.toLocaleString(), depin_rate_limit: depinLimiter.stats() };
  }
  function getCache() {
    const result = { numberOfItemsInCache: cache.getKeys().length };
    for (const [key, value] of Object.entries(process.memoryUsage())) result[key] = `Memory usage by ${key}, ${Math.round(value / 1000000)} MB `;
    result.queueSize = queue.size; result.numberOfRequests = numberOfRequests.toLocaleString(); result.methods = cache.getMethods(); result.nodes = nodeDeps.getNodes(); result.depinRateLimit = depinLimiter.stats();
    return result;
  }
  const handleRequest = createHandler({ whitelist: [...whitelist, ...cfg.extra_methods], getCache, settings: async () => ({ heading: cfg.heading, environment: cfg.environment, endpoint: cfg.endpoint, exact_amounts: true, amounts: "rpc-native-units", numeric_encoding: "safe-number-or-string", ...(await nodeDeps.getIdentity()) }), serveWww: cfg.serve_www, tryAccept, handleRpc });
  return { handleRequest, getStats, onBlock(hash) { if (hash && hash !== lastBlockHash) { lastBlockHash = hash; cache.clear(); } } };
}

module.exports = { create };
