/*
Normalize whatever @neuraiproject/neurai-rpc rejects with.

The library never rejects with a plain Error, so `error.message` is undefined
for every node failure. It uses three shapes:

  1. {error: {code, message}, description}      JSON-RPC error returned with
                                                HTTP 200 (0.5.0+ rejects these;
                                                0.4.7 resolved `undefined`)
  2. {statusText, status, description, error}   HTTP response other than 200.
                                                The node answers JSON-RPC errors
                                                this way (500 for most codes, 400
                                                for -32600, 404 for -32601), so
                                                `error` is usually the JSON-RPC
                                                error object. It is null when the
                                                body was not JSON (401 with bad
                                                credentials, a reverse proxy page).
  3. {originalError, type: "ServerUnreachable", error, description}
                                                network failure; `error` is a string

rpcTimeout.js adds a fourth, of our own: an Error with type "Timeout" when
the node took longer than the configured limit. flushingReads.js adds a fifth:
an Error with type "Throttled" when the service refused the call before it
reached the node. That one is not an upstream failure.

A node JSON-RPC error is therefore "an object `error` with a numeric `code`",
whatever the HTTP status. Everything else that is not a plain Error thrown by
our own code is an upstream failure: the node could not be reached, refused
our credentials, or answered something that is not JSON-RPC.
*/

const UPSTREAM_UNAVAILABLE = "upstream RPC unavailable";

function isObject(e) {
  return e !== null && typeof e === "object";
}

function isRPCError(e) {
  return isObject(e) && isObject(e.error) && typeof e.error.code === "number";
}

function isNodeUnreachable(e) {
  return isObject(e) && e.type === "ServerUnreachable";
}

function isNodeTimeout(e) {
  return isObject(e) && e.type === "Timeout";
}

// Refused by this service (flushingReads.js); the node never saw the call.
function isThrottled(e) {
  return isObject(e) && e.type === "Throttled";
}

// Shape 2 without a JSON-RPC error body, shape 3 or a timeout. Diagnostics should use
// isNodeUnreachable; this one decides the HTTP status (502) and is deliberately
// broader: a 401 from misconfigured credentials is an upstream failure too.
function isUpstreamFailure(e) {
  if (!isObject(e) || isRPCError(e) || isThrottled(e)) return false;
  if (isNodeUnreachable(e) || isNodeTimeout(e)) return true;
  return typeof e.status === "number" && e.status !== 200;
}

function getRPCErrorMessage(e) {
  if (!e) return "";
  if (typeof e === "string") return e;
  if (!isObject(e)) return String(e);
  const candidates = [
    e.error && e.error.message,
    typeof e.error === "string" ? e.error : null,
    e.description,
    e.message,
    e.statusText,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return "";
}

// JSON-RPC error code, or null when the failure carries none.
function getRPCErrorCode(e) {
  if (!isObject(e)) return null;
  if (isObject(e.error) && typeof e.error.code === "number") return e.error.code;
  if (typeof e.code === "number") return e.code;
  return null;
}

// What a client may see. Upstream failures get a neutral message: the status
// line or body of the node's reply must not travel to the public side.
function toClientError(e, fallback = "RPC request failed") {
  if (isUpstreamFailure(e)) return { upstream: true, code: null, message: UPSTREAM_UNAVAILABLE };
  const message = getRPCErrorMessage(e);
  return { upstream: false, code: getRPCErrorCode(e), message: message || fallback };
}

// One line for the operator's log. Never includes credentials or the body of
// the upstream response.
function describeForLog(e) {
  if (isNodeUnreachable(e)) return `node unreachable: ${getRPCErrorMessage(e) || "no details"}`;
  if (isNodeTimeout(e)) return `node timeout: ${e.message}`;
  if (isThrottled(e)) return `throttled: ${e.message}`;
  if (isUpstreamFailure(e)) return `upstream HTTP ${e.status}${e.statusText ? ` ${e.statusText}` : ""}`;
  const code = getRPCErrorCode(e);
  const message = getRPCErrorMessage(e) || "unknown error";
  return code === null ? message : `[${code}] ${message}`;
}

module.exports = {
  UPSTREAM_UNAVAILABLE,
  isRPCError,
  isNodeUnreachable,
  isNodeTimeout,
  isThrottled,
  isUpstreamFailure,
  getRPCErrorMessage,
  getRPCErrorCode,
  toClientError,
  describeForLog,
};
