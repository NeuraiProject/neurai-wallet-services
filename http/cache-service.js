const { stringifyRpcJson } = require("@neuraiproject/neurai-rpc");
function create() {
  const cache = new Map();
  const methodsRequested = Object.create(null);
  const cacheable = new Set([
    "getaddressbalance", "getaddressdeltas", "getaddresstxids", "getaddressutxos",
    "getassetdata", "listaddressesbyasset", "listassetbalancesbyaddress", "listassets",
    "decodeblock", "getbestblockhash", "getblock", "getblockchaininfo", "getblockcount",
    "getblockhash", "getblockhashes", "getblockheader", "getchaintxstats", "getdifficulty",
    "getpubkey", "gettxoutproof", "gettxoutsetinfo",
    "preciousblock", "verifychain", "verifytxoutproof", "help", "uptime", "decoderawtransaction",
    "decodescript", "checkaddressrestriction", "checkaddresstag", "checkglobalrestriction",
    "getverifierstring", "isvalidverifierstring", "listaddressesfortag", "listaddressrestrictions",
    "listglobalrestrictions", "listtagsforaddress", "validateaddress", "verifymessage",
    // DePIN chain queries follow blocks like everything else above. Nothing
    // that comes from the message pool is cached: its state is off-chain and
    // every reply is signed with the pool key that is live right now
    // (depingetancestorrecipients included — its recipients are chain data,
    // but the reply carries that poolsig).
    "checkdepinvalidity", "listdepinholders", "listdepinaddresses",
  ]);
  // getspentinfo reads the mempool before the disk index. Like gettxout,
  // it must stay live even when no new block has arrived.
  const key = (method, params) => stringifyRpcJson({ method, params });
  return {
    addMethod(name, date) { methodsRequested[name] = date; },
    getMethods() { return methodsRequested; },
    getKeys() { return [...cache.keys()]; },
    get(method, params) { return cache.get(key(method, params)); },
    put(method, params, value) { cache.set(key(method, params), value); },
    remove(method, params, expected) { const k = key(method, params); if (cache.get(k) === expected) cache.delete(k); },
    clear() { cache.clear(); },
    shouldCache(method) { return cacheable.has(method); },
  };
}

module.exports = { create };
