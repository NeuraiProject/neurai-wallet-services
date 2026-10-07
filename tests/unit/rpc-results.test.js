const { filterRpcResult } = require("../../rpcResults");

test("getnetworkinfo keeps only reviewed fields; a new node field stays private", () => {
  const info = { relayfee: "0.01000000", subversion: "/Neurai:1.0.6/", networks: [], localaddresses: [], somethingnew: 1 };
  expect(filterRpcResult("getnetworkinfo", info)).toEqual({ relayfee: "0.01000000", subversion: "/Neurai:1.0.6/" });
});

test("other methods and non-object results pass through untouched", () => {
  const block = { hash: "a", networks: [] };
  expect(filterRpcResult("getblock", block)).toBe(block);
  expect(filterRpcResult("getnetworkinfo", null)).toBeNull();
  expect(filterRpcResult("getnetworkinfo", ["x"])).toEqual(["x"]);
  expect(filterRpcResult("constructor", { a: 1 })).toEqual({ a: 1 });
});
