const { isWhitelisted, EXTRA_METHODS } = require("../../http/whitelist");
const cacheServiceMod = require("../../http/cache-service");

/*
DePIN protocol 2 is served on the node's RPC port, so depin* methods go through
/rpc and the whitelist like any other method. Pin down the decisions that are
easy to regress:
  1. which depin* methods are exposed (anything needing the node's wallet is out)
  2. nothing derived from the message pool is cached (the cache follows blocks,
     the pool does not, and every pool reply is signed with the live pool key)
*/

const exposed = [
  "depinchallenge", "depinclearmsg", "depingetmsginfo", "depinlistsections", "depinmcpstatus",
  "depinpoolstats", "depinreceivemsg", "depinsubmitmsg", "depingetancestorrecipients",
  "checkdepinvalidity", "listdepinholders", "listdepinaddresses", "getpubkey",
];
const rejected = [
  ["depingetmsg", "decrypts with the node's wallet keys"],
  ["depinsendmsg", "signs with a wallet address"],
  ["depinsignrequest", "signs a challenge request with the node's wallet keys"],
  ["depinsignchallenge", "signs a challenge with the node's wallet keys"],
  ["depindecrypt", "opens an encrypted reply with the node's wallet keys"],
  ["depinpoolpkey", "operator bootstrap of the service wallet"],
  ["listpqaddresses", "lists PQ addresses in the wallet"],
  ["depingetpoolcontent", "removed from the node"],
  ["getibdstatus", "diagnostics, absent from the mainnet node"],
  ["dumpextkeypq", "post-quantum key material"],
  ["exportxpqpub", "post-quantum key material"],
  ["signmessagewithprivkey", "clients sign locally"],
  ["opendepin", "DePIN transfer state: owner-only wallet write"],
  ["closedepin", "DePIN transfer state: owner-only wallet write"],
  ["sealdepin", "DePIN transfer state: owner-only wallet write"],
  ["walletpassphrase", "unlocks the node wallet"],
  ["walletlock", "node wallet control"],
  ["getblockdeltas", "heavy per-block address deltas"],
];

test.each(exposed)("%s is whitelisted", (method) => {
  expect(isWhitelisted(method)).toBe(true);
});

test.each(rejected)("%s is NOT whitelisted (%s)", (method) => {
  expect(isWhitelisted(method)).toBe(false);
});

test("nothing from the message pool is cached; DePIN chain queries are", () => {
  const cache = cacheServiceMod.create();
  for (const method of exposed.filter((m) => m.startsWith("depin"))) {
    expect([method, cache.shouldCache(method)]).toEqual([method, false]);
  }
  for (const method of ["checkdepinvalidity", "listdepinholders", "listdepinaddresses", "getpubkey"]) {
    expect([method, cache.shouldCache(method)]).toEqual([method, true]);
  }
});

test("getnetworkinfo is public (reduced by rpcResults.js); slow or operator methods are opt-in only", () => {
  expect(isWhitelisted("getnetworkinfo")).toBe(true);
  expect(EXTRA_METHODS).toEqual(["gettxoutsetinfo", "getmininginfo", "getconnectioncount", "getnettotals"]);
  for (const method of EXTRA_METHODS) expect([method, isWhitelisted(method)]).toEqual([method, false]);
  const cache = cacheServiceMod.create();
  for (const method of ["getnetworkinfo", "gettxoutsetinfo", "getmininginfo"]) {
    expect([method, cache.shouldCache(method)]).toEqual([method, true]);
  }
});
