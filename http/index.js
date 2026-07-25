const { default: PQueue } = require("p-queue");
const { whitelist, isWhitelisted } = require("./whitelist");
const cacheServiceMod = require("./cache-service");
const { createHandler, sendJson } = require("./router");

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

function clientIp(req, trustedProxies) {
  const remote = (req.socket && req.socket.remoteAddress) || "unknown";
  // A forwarded header is client-controlled unless its immediate peer is an
  // explicitly configured trusted proxy.
  if (trustedProxies.has(remote) && req.headers["x-forwarded-for"]) return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  return remote;
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
    trusted_proxy_ips: rawCfg.trusted_proxy_ips == null ? ["127.0.0.1", "::1", "::ffff:127.0.0.1"] : rawCfg.trusted_proxy_ips,
  };
  if (!Array.isArray(cfg.trusted_proxy_ips) || !cfg.trusted_proxy_ips.every((ip) => typeof ip === "string" && ip.length > 0)) throw new Error("[HTTP] trusted_proxy_ips must be an array of IP addresses");
  if (cfg.max_requests_per_second_per_ip > cfg.max_requests_per_second) throw new Error("[HTTP] max_requests_per_second_per_ip cannot exceed max_requests_per_second");
  const trustedProxies = new Set(cfg.trusted_proxy_ips);
  // Lazy defaults avoid loading config-bound node modules in unit tests.
  const nodeDeps = injected.nodeDeps || require("../getRPCNode");
  const depinService = injected.depinService || require("../depinService");
  const rpc = injected.rpc || require("../wss/rpc").callRPC;
  const queue = new PQueue({ concurrency: cfg.concurrency });
  const cache = cacheServiceMod.create();
  const limits = new Map();
  const globalLimit = createRateLimiter(cfg.max_requests_per_second);
  let numberOfRequests = 0;
  let lastBlockHash = null;

  function pruneLimiters(now = Date.now()) {
    for (const [ip, entry] of limits) if (entry.lastSeen < now - cfg.rate_limiter_ttl_ms) limits.delete(ip);
  }
  const limiterPruneTimer = setInterval(pruneLimiters, Math.min(cfg.rate_limiter_ttl_ms, 60000));
  if (limiterPruneTimer.unref) limiterPruneTimer.unref();

  function tryAccept(req) {
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
    countRequest();
    if (!isWhitelisted(method)) return sendJson(res, 404, { error: "Not in whitelist", description: `Method ${method} is not supported` });
    if (method === "listaddressesbyasset" && Array.isArray(params) && params[1] === true) {
      return sendJson(res, 404, { error: "Not in whitelist", description: `Method ${method} with totalCount set to true is not whitelisted. Please use ${method} without totalCount = true` });
    }
    if (queue.size >= cfg.max_queue_size) return sendJson(res, 503, { error: "queue full" }, { "retry-after": "1" });
    try {
      const result = await queue.add(async () => {
        if (req.aborted || res.destroyed) return undefined;
        cache.addMethod(method, new Date());
        const cached = cache.shouldCache(method) && cache.get(method, params);
        if (cached) return cached;
        // Low priority shares the node-wide queue with WSS, whose work uses
        // the default priority and therefore jumps ahead of pending HTTP work.
        const promise = rpc(method, params, -1);
        if (cache.shouldCache(method)) { cache.put(method, params, promise); promise.catch(() => cache.remove(method, params)); }
        return promise;
      });
      if (result === undefined || req.aborted || res.destroyed) return;
      return sendJson(res, 200, { result });
    } catch (e) {
      if (method === "checkdepinvalidity" && e && e.message && e.message.includes("must start with &")) return sendJson(res, 200, { result: { valid: false, isDePinAsset: false, message: "Not a DePIN asset (assets must start with & to be DePIN assets)" } });
      return sendJson(res, 500, { error: { message: e && e.message ? e.message : "RPC request failed", code: e && e.code } });
    }
  }

  async function handleDePin(body, req, res) {
    const { address, signature, method, params } = body || {};
    if (!address || typeof address !== "string") return sendJson(res, 400, { error: "Missing or invalid address", description: "Request must include a valid 'address' field" });
    if (!signature || typeof signature !== "string") return sendJson(res, 400, { error: "Missing or invalid signature", description: "Request must include a valid 'signature' field (base64-encoded)" });
    if (!method || typeof method !== "string") return sendJson(res, 400, { error: "Missing or invalid method", description: "Request must include a valid 'method' field" });
    if (!Array.isArray(params)) return sendJson(res, 400, { error: "Missing or invalid params", description: "Request must include a 'params' array" });
    if (!isWhitelisted(method)) return sendJson(res, 404, { error: "Not in whitelist", description: `Method ${method} is not supported` });
    const depinNode = nodeDeps.getDePinNode();
    let modified = params;
    if ((method === "depingetmsg" || method === "depinsendmsg") && params.length >= 2 && (!params[1] || params[1] === "auto")) {
      modified = [...params];
      try { modified[1] = new URL(depinNode.depinUrl).host; } catch { modified[1] = "localhost:19002"; }
    }
    try {
      const result = await depinService.executeDePinRPC(depinNode.depinUrl, address, async () => signature, method, modified);
      countRequest();
      return sendJson(res, 200, { result });
    } catch (e) { return sendJson(res, 500, { error: e && e.message ? e.message : "Something went wrong with DePIN request" }); }
  }

  function getStats() {
    return { queue: { size: queue.size, pending: queue.pending }, cache_items: cache.getKeys().length, rate_limiter_ips: limits.size, numberOfRequests: numberOfRequests.toLocaleString() };
  }
  function getCache() {
    const result = { numberOfItemsInCache: cache.getKeys().length };
    for (const [key, value] of Object.entries(process.memoryUsage())) result[key] = `Memory usage by ${key}, ${Math.round(value / 1000000)} MB `;
    result.queueSize = queue.size; result.numberOfRequests = numberOfRequests.toLocaleString(); result.methods = cache.getMethods(); result.depinChallenges = depinService.getCacheStats(); result.nodes = nodeDeps.getNodes(); result.depinNodes = nodeDeps.getDePinNodes();
    return result;
  }
  const handleRequest = createHandler({ whitelist, getCache, settings: { heading: cfg.heading, environment: cfg.environment, endpoint: cfg.endpoint }, serveWww: cfg.serve_www, tryAccept, handleRpc, handleDePin });
  return { handleRequest, getStats, onBlock(hash) { if (hash && hash !== lastBlockHash) { lastBlockHash = hash; cache.clear(); } } };
}

module.exports = { create };
