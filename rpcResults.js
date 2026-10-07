// Results that are reduced before they leave the service, shared by HTTP and
// WSS so both transports expose exactly the same fields.
//
// Each entry is an allowlist: a field the node adds in a future release stays
// private until it is reviewed and listed here.

const ALLOWED_FIELDS = {
  // Wallets read relayfee to price transactions (the C6 sponsor sweep in the
  // web wallet). Left out: `networks` (configured proxies, e.g. a Tor
  // endpoint) and `localaddresses` (the node's public IPs and ports).
  getnetworkinfo: [
    "version", "subversion", "protocolversion", "localservices", "localrelay",
    "timeoffset", "networkactive", "connections", "relayfee", "incrementalfee",
    "warnings",
  ],
};

function filterRpcResult(method, result) {
  const fields = Object.prototype.hasOwnProperty.call(ALLOWED_FIELDS, method) ? ALLOWED_FIELDS[method] : null;
  if (!fields || !result || typeof result !== "object" || Array.isArray(result)) return result;
  const reduced = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(result, field)) reduced[field] = result[field];
  }
  return reduced;
}

module.exports = { ALLOWED_FIELDS, filterRpcResult };
