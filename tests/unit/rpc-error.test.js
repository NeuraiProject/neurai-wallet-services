const {
  UPSTREAM_UNAVAILABLE,
  isRPCError,
  isNodeUnreachable,
  isUpstreamFailure,
  getRPCErrorMessage,
  getRPCErrorCode,
  toClientError,
  describeForLog,
} = require("../../rpcError");

// The three shapes @neuraiproject/neurai-rpc rejects with, verbatim from its
// getRPC implementation, plus what the node actually produces for each.
const shape1 = { error: { code: -8, message: "Invalid parameter" }, description: "Invalid parameter" };
const shape2RpcError = { statusText: "Internal Server Error", status: 500, description: undefined, error: { code: -5, message: "Invalid address" } };
const shape2AuthFailed = { statusText: "Bad Request", status: 400, description: undefined, error: { code: -32600, message: "Request authentication failed: stale timestamp" } };
const shape2BadCredentials = { statusText: "Unauthorized", status: 401, description: null, error: null };
const shape2ProxyPage = { statusText: "Bad Gateway", status: 502, description: null, error: null };
const shape3 = { originalError: new Error("ECONNREFUSED"), type: "ServerUnreachable", error: "Could not communicate with Neurai core node", description: "Are you sure that the URL is correct? The URL is usually mainnet = http://127.0.0.1:19001 and testnet =  http://127.0.0.1:19101" };

test("a JSON-RPC error is recognized by its error object, whatever the HTTP status", () => {
  expect(isRPCError(shape1)).toBe(true);
  expect(isRPCError(shape2RpcError)).toBe(true);
  expect(isRPCError(shape2AuthFailed)).toBe(true);
  expect(isRPCError(shape2BadCredentials)).toBe(false);
  expect(isRPCError(shape3)).toBe(false);
  expect(isRPCError(new Error("x"))).toBe(false);
});

test("upstream failures: unreachable node, bad credentials, non-JSON replies", () => {
  expect(isUpstreamFailure(shape3)).toBe(true);
  expect(isUpstreamFailure(shape2BadCredentials)).toBe(true);
  expect(isUpstreamFailure(shape2ProxyPage)).toBe(true);
  expect(isUpstreamFailure(shape1)).toBe(false);
  expect(isUpstreamFailure(shape2RpcError)).toBe(false);
  expect(isUpstreamFailure(shape2AuthFailed)).toBe(false);
  expect(isUpstreamFailure(new Error("x"))).toBe(false);
  expect(isUpstreamFailure(undefined)).toBe(false);
});

test("isNodeUnreachable is narrower than isUpstreamFailure (diagnostics only)", () => {
  expect(isNodeUnreachable(shape3)).toBe(true);
  expect(isNodeUnreachable(shape2BadCredentials)).toBe(false);
});

test("message extraction copes with every shape", () => {
  expect(getRPCErrorMessage(shape1)).toBe("Invalid parameter");
  expect(getRPCErrorMessage(shape2RpcError)).toBe("Invalid address");
  expect(getRPCErrorMessage(shape2BadCredentials)).toBe("Unauthorized");
  expect(getRPCErrorMessage(shape3)).toBe("Could not communicate with Neurai core node");
  expect(getRPCErrorMessage(new Error("plain"))).toBe("plain");
  expect(getRPCErrorMessage("string")).toBe("string");
  expect(getRPCErrorMessage(undefined)).toBe("");
  expect(getRPCErrorMessage({})).toBe("");
});

test("code extraction returns the JSON-RPC code or null", () => {
  expect(getRPCErrorCode(shape1)).toBe(-8);
  expect(getRPCErrorCode(shape2AuthFailed)).toBe(-32600);
  expect(getRPCErrorCode(shape2BadCredentials)).toBe(null);
  expect(getRPCErrorCode(shape3)).toBe(null);
  expect(getRPCErrorCode(Object.assign(new Error("own"), { code: -42 }))).toBe(-42);
  expect(getRPCErrorCode(new Error("own"))).toBe(null);
  expect(getRPCErrorCode(undefined)).toBe(null);
});

test("toClientError keeps node errors and neutralizes upstream failures", () => {
  expect(toClientError(shape2AuthFailed)).toEqual({ upstream: false, code: -32600, message: "Request authentication failed: stale timestamp" });
  expect(toClientError(shape1)).toEqual({ upstream: false, code: -8, message: "Invalid parameter" });
  for (const e of [shape3, shape2BadCredentials, shape2ProxyPage]) {
    expect(toClientError(e)).toEqual({ upstream: true, code: null, message: UPSTREAM_UNAVAILABLE });
  }
  expect(toClientError({}, "fallback")).toEqual({ upstream: false, code: null, message: "fallback" });
});

test("describeForLog never carries the upstream body", () => {
  expect(describeForLog(shape2BadCredentials)).toBe("upstream HTTP 401 Unauthorized");
  expect(describeForLog(shape3)).toMatch(/^node unreachable: /);
  expect(describeForLog(shape2AuthFailed)).toBe("[-32600] Request authentication failed: stale timestamp");
  expect(describeForLog(new Error("own"))).toBe("own");
});
