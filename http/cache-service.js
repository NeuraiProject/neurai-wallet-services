function create() {
  const cache = new Map();
  const methodsRequested = Object.create(null);
  const cacheable = new Set([
    "getaddressbalance", "getaddressdeltas", "getaddresstxids", "getaddressutxos",
    "getassetdata", "listaddressesbyasset", "listassetbalancesbyaddress", "listassets",
    "decodeblock", "getbestblockhash", "getblock", "getblockchaininfo", "getblockcount",
    "getblockhash", "getblockhashes", "getblockheader", "getchaintxstats", "getdifficulty",
    "getpubkey", "getspentinfo", "gettxout", "gettxoutproof", "gettxoutsetinfo",
    "preciousblock", "verifychain", "verifytxoutproof", "help", "uptime", "decoderawtransaction",
    "decodescript", "checkaddressrestriction", "checkaddresstag", "checkglobalrestriction",
    "getverifierstring", "isvalidverifierstring", "listaddressesfortag", "listaddressrestrictions",
    "listglobalrestrictions", "listtagsforaddress", "validateaddress", "verifymessage",
    "checkdepinvalidity", "listdepinholders", "listdepinaddresses", "depingetmsg",
    "depingetmsginfo", "depingetpoolcontent", "depinmcpstatus", "depinpoolstats", "depinpoolpkey",
  ]);
  const key = (method, params) => JSON.stringify({ method, params });
  return {
    addMethod(name, date) { methodsRequested[name] = date; },
    getMethods() { return methodsRequested; },
    getKeys() { return [...cache.keys()]; },
    get(method, params) { return cache.get(key(method, params)); },
    put(method, params, value) { cache.set(key(method, params), value); },
    remove(method, params) { cache.delete(key(method, params)); },
    clear() { cache.clear(); },
    shouldCache(method) { return cacheable.has(method); },
  };
}

module.exports = { create };
