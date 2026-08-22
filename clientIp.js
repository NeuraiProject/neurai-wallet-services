// Client IP derivation shared by HTTP and WSS.
//
// A forwarded header is client-controlled unless the immediate peer is an
// explicitly trusted reverse proxy, and even then only if that proxy
// *overwrites* X-Forwarded-For (nginx: `proxy_set_header X-Forwarded-For
// $remote_addr;`). With an appending proxy ($proxy_add_x_forwarded_for) the
// first element — the one used here — is whatever the client sent.
//
// `trusted_proxy_ips` lives at the root of config.json because both
// transports share it; the former `http.trusted_proxy_ips` is still honoured.

const DEFAULT_TRUSTED_PROXY_IPS = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

let warnedLegacyKey = false;

function resolveTrustedProxies(globalConfig) {
  const root = globalConfig && globalConfig.trusted_proxy_ips;
  const legacy = globalConfig && globalConfig.http && globalConfig.http.trusted_proxy_ips;
  let list = DEFAULT_TRUSTED_PROXY_IPS;
  if (root != null) list = root;
  else if (legacy != null) {
    list = legacy;
    if (!warnedLegacyKey) {
      warnedLegacyKey = true;
      console.log("[config] http.trusted_proxy_ips is deprecated: move it to the root trusted_proxy_ips (shared by HTTP and WSS)");
    }
  }
  if (!Array.isArray(list) || !list.every((ip) => typeof ip === "string" && ip.length > 0)) {
    throw new Error("[config] trusted_proxy_ips must be an array of IP addresses");
  }
  return new Set(list);
}

function clientIp(req, trustedProxies) {
  const remote = (req && req.socket && req.socket.remoteAddress) || "unknown";
  const forwarded = req && req.headers && req.headers["x-forwarded-for"];
  if (forwarded && trustedProxies && trustedProxies.has(remote)) {
    const first = String(forwarded).split(",")[0].trim();
    if (first) return first;
  }
  return remote;
}

module.exports = { DEFAULT_TRUSTED_PROXY_IPS, resolveTrustedProxies, clientIp };
