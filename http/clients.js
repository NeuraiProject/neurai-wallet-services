// Trusted HTTP clients: backends (explorers, faucets, swaps, indexers) that
// call /rpc from a single IP and would exhaust the public per-IP budget at once.
//
// A client is recognised by its key or by its source address, whichever matches:
//   - key: the password of HTTP Basic auth, which is what neurai-rpc's
//     getRPC(username, password, url) already sends, or `Authorization:
//     Bearer <key>`. The username is ignored.
//   - ips: addresses or CIDR ranges (e.g. a Docker network) checked against
//     the client IP, which honours X-Forwarded-For only from trusted proxies.
// Credentials that match no key are not an error: existing clients send some
// (usually "anonymous") and simply stay on the public tier.
//
// A recognised client gets its own request budget instead of the per-IP and
// global public ones (none when max_requests_per_second is unset), goes ahead
// of public requests in the HTTP queue and may call its extra_methods.

const crypto = require("crypto");
const net = require("net");
const { EXTRA_METHODS } = require("./whitelist");

const MIN_KEY_LENGTH = 16;
// Echoed in the x-rpc-client response header, so keep it header-safe.
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function digest(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest();
}

function parseExtraMethods(list, where) {
  if (list == null) return new Set();
  if (!Array.isArray(list)) throw new Error(`[HTTP] ${where} must be an array of method names`);
  for (const method of list) {
    if (!EXTRA_METHODS.includes(method)) {
      throw new Error(`[HTTP] ${where}: ${method} cannot be added (allowed: ${EXTRA_METHODS.join(", ")})`);
    }
  }
  return new Set(list);
}

// IPv4 peers of a dual-stack socket arrive as ::ffff:a.b.c.d
function plainIp(ip) {
  return typeof ip === "string" && ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}

function familyOf(ip) {
  if (net.isIPv4(ip)) return "ipv4";
  if (net.isIPv6(ip)) return "ipv6";
  return null;
}

function parseIps(list, where) {
  if (!Array.isArray(list) || list.length === 0) throw new Error(`[HTTP] ${where} must be a non-empty array of addresses or CIDR ranges`);
  const blockList = new net.BlockList();
  for (const entry of list) {
    const parts = typeof entry === "string" ? entry.trim().split("/") : [];
    const address = plainIp(parts[0]);
    const family = familyOf(address);
    if (!family || parts.length > 2) throw new Error(`[HTTP] ${where}: invalid address ${JSON.stringify(entry)}`);
    if (parts.length === 1) {
      blockList.addAddress(address, family);
      continue;
    }
    const prefix = Number(parts[1]);
    if (!/^[0-9]+$/.test(parts[1]) || prefix > (family === "ipv4" ? 32 : 128)) {
      throw new Error(`[HTTP] ${where}: invalid prefix in ${JSON.stringify(entry)}`);
    }
    blockList.addSubnet(address, prefix, family);
  }
  return blockList;
}

function presentedKey(req) {
  const header = req && req.headers && req.headers.authorization;
  if (typeof header !== "string") return null;
  const space = header.indexOf(" ");
  if (space === -1) return null;
  const scheme = header.slice(0, space).toLowerCase();
  const value = header.slice(space + 1).trim();
  if (scheme === "bearer") return value || null;
  if (scheme !== "basic") return null;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1 ? null : decoded.slice(colon + 1) || null;
}

function createClients(list) {
  if (list == null) list = [];
  if (!Array.isArray(list)) throw new Error("[HTTP] clients must be an array");
  const names = new Set();
  const keys = new Set();
  const clients = list.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`[HTTP] clients[${index}] must be an object`);
    const { name } = entry;
    if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
      throw new Error(`[HTTP] clients[${index}].name must be 1-64 letters, digits, dots, dashes or underscores`);
    }
    if (names.has(name)) throw new Error(`[HTTP] client "${name}" is defined twice`);
    names.add(name);
    let keyDigest = null;
    if (entry.key != null) {
      if (typeof entry.key !== "string" || entry.key.length < MIN_KEY_LENGTH) {
        throw new Error(`[HTTP] client "${name}": key must be a string of at least ${MIN_KEY_LENGTH} characters`);
      }
      if (keys.has(entry.key)) throw new Error(`[HTTP] client "${name}" reuses the key of another client`);
      keys.add(entry.key);
      keyDigest = digest(entry.key);
    }
    const ips = entry.ips == null ? null : parseIps(entry.ips, `client "${name}" ips`);
    if (!keyDigest && !ips) throw new Error(`[HTTP] client "${name}" needs a key, ips or both`);
    const rps = entry.max_requests_per_second;
    if (rps != null && (!Number.isInteger(rps) || rps < 1)) {
      throw new Error(`[HTTP] client "${name}": max_requests_per_second must be a positive integer`);
    }
    return {
      name,
      keyDigest,
      ips,
      maxRequestsPerSecond: rps == null ? null : rps,
      extraMethods: parseExtraMethods(entry.extra_methods, `client "${name}" extra_methods`),
    };
  });

  function identify(req, ip) {
    if (clients.length === 0) return null;
    const key = presentedKey(req);
    if (key) {
      const presented = digest(key);
      let found = null;
      // Compare with every key, so the time taken does not tell which one matched.
      for (const client of clients) {
        if (client.keyDigest && crypto.timingSafeEqual(client.keyDigest, presented) && !found) found = client;
      }
      if (found) return found;
    }
    const address = plainIp(ip);
    const family = familyOf(address);
    if (family) {
      for (const client of clients) if (client.ips && client.ips.check(address, family)) return client;
    }
    return null;
  }

  return { identify, count: clients.length };
}

module.exports = { createClients, parseExtraMethods, presentedKey, MIN_KEY_LENGTH };
