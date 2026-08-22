// Per-IP rate limiting and temporary bans for the depin* methods.
//
// The node limits challenges issued and messages accepted per authenticated
// *address*; origin IPs only exist here, in front of it. One limiter instance
// is shared by HTTP and WSS, so switching transport does not reset the count.
//
//  - requests inside the sliding window are counted per key (the client IP);
//  - exceeding `perMinute` bans the key for `banMinutes`: every depin* request
//    answers 429 (HTTP) / 1007 (WSS) with a Retry-After until the ban lapses;
//    with banMinutes = 0 the request is only refused until the window frees;
//  - perMinute = 0 disables the limiter.
//
// Only methods whose RPC name starts with "depin" count. The cacheable chain
// queries (checkdepinvalidity, listdepinholders, getpubkey, ...) do not.

function createDepinLimiter({ perMinute = 60, banMinutes = 10, windowMs = 60 * 1000, maxKeys = 10000 } = {}) {
  const hits = new Map(); // key -> ascending timestamps inside the window
  const bans = new Map(); // key -> ban end (ms)

  function prune(now = Date.now()) {
    for (const [key, until] of bans) if (now >= until) bans.delete(key);
    for (const [key, stamps] of hits) {
      while (stamps.length && stamps[0] <= now - windowMs) stamps.shift();
      if (stamps.length === 0) hits.delete(key);
    }
  }

  function check(key, now = Date.now()) {
    if (perMinute <= 0) return { allowed: true, banned: false };
    const until = bans.get(key);
    if (until !== undefined) {
      if (now < until) {
        return { allowed: false, banned: true, retryAfterSeconds: Math.max(1, Math.ceil((until - now) / 1000)) };
      }
      bans.delete(key);
      hits.delete(key);
    }
    let stamps = hits.get(key);
    if (!stamps) {
      if (hits.size >= maxKeys) prune(now);
      if (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
      stamps = [];
      hits.set(key, stamps);
    }
    while (stamps.length && stamps[0] <= now - windowMs) stamps.shift();
    if (stamps.length >= perMinute) {
      if (banMinutes > 0) {
        bans.set(key, now + banMinutes * 60 * 1000);
        hits.delete(key);
        return { allowed: false, banned: true, justBanned: true, retryAfterSeconds: banMinutes * 60 };
      }
      return { allowed: false, banned: false, retryAfterSeconds: Math.max(1, Math.ceil((stamps[0] + windowMs - now) / 1000)) };
    }
    stamps.push(now);
    return { allowed: true, banned: false };
  }

  function stats() {
    return { per_minute: perMinute, ban_minutes: banMinutes, tracked: hits.size, banned: bans.size };
  }

  return { check, prune, stats };
}

function nonNegativeInt(value, fallback, name) {
  const result = value == null ? fallback : value;
  if (!Number.isInteger(result) || result < 0) throw new Error(`[config] depin.${name} must be a non-negative integer`);
  return result;
}

// config.json:  "depin": { "rate_limit": 60, "ban_minutes": 10 }
function resolveDepinConfig(globalConfig) {
  const raw = globalConfig && globalConfig.depin;
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) throw new Error("[config] depin must be an object");
  const section = raw || {};
  return {
    rate_limit: nonNegativeInt(section.rate_limit, 60, "rate_limit"),
    ban_minutes: nonNegativeInt(section.ban_minutes, 10, "ban_minutes"),
  };
}

function isDepinMethod(method) {
  return typeof method === "string" && method.startsWith("depin");
}

function refusalDescription(verdict, limiter) {
  const { per_minute } = limiter.stats();
  return `DePIN requests from this address are blocked for ${verdict.retryAfterSeconds} seconds (limit: ${per_minute} depin* requests per minute)`;
}

let shared = null;

function getSharedLimiter(globalConfig) {
  if (shared) return shared;
  const cfg = resolveDepinConfig(globalConfig);
  shared = createDepinLimiter({ perMinute: cfg.rate_limit, banMinutes: cfg.ban_minutes });
  const timer = setInterval(() => shared.prune(Date.now()), 60 * 1000);
  if (timer.unref) timer.unref();
  shared.timer = timer;
  return shared;
}

function resetSharedLimiter() {
  if (shared && shared.timer) clearInterval(shared.timer);
  shared = null;
}

module.exports = { createDepinLimiter, resolveDepinConfig, isDepinMethod, refusalDescription, getSharedLimiter, resetSharedLimiter };
