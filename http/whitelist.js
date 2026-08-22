const whitelist = [
  //== Addressindex ==
  "getaddressbalance",
  "getaddressdeltas",
  "getaddressmempool",
  "getaddresstxids",
  "getaddressutxos",

  //== Assets ==
  "getassetdata",
  // "getcacheinfo",
  //"getsnapshot",
  //"issue",
  //"issueunique",
  "listaddressesbyasset",
  "listassetbalancesbyaddress",
  "listassets",
  //"listmyassets",
  //"purgesnapshot",
  //"reissue",
  //"transfer",
  //"transferfromaddress",
  //"transferfromaddresses",

  //== Blockchain ==
  //"clearmempool",
  "decodeblock",
  "getbestblockhash",
  "getblock",
  "getblockchaininfo",
  "getblockcount",
  "getblockhash",
  // "getblockhashes", //This can kill the service if you ask for all block hashes years back
  "getblockheader",
  "getchaintips",
  "getchaintxstats",
  "getdifficulty",
  "getmempoolancestors",
  "getmempooldescendants",
  "getmempoolentry",
  "getmempoolinfo",
  "getrawmempool",
  "getspentinfo",
  "gettxout",
  "gettxoutproof",
  // "gettxoutsetinfo", this method is not "dangerous" but it takes TOO long time
  //"preciousblock",
  //"pruneblockchain",
  //"savemempool",
  //"verifychain",
  //"verifytxoutproof",

  //== Control ==
  //"getinfo",
  //"getmemoryinfo",
  //"getrpcinfo",
  "help",
  //"stop",
  //"uptime",

  //== Generating ==
  //"generate",
  //"generatetoaddress",
  //"getgenerate",
  //"setgenerate",

  //== Messages ==
  //"clearmessages",
  //"sendmessage",
  //"subscribetochannel",
  //"unsubscribefromchannel",
  //"viewallmessagechannels",
  //"viewallmessages",

  //== Mining ==
  // "getblocktemplate",
  //"getkawpowhash",
  //"getmininginfo",
  "getnetworkhashps",
  //"pprpcsb",
  //"prioritisetransaction",
  //"submitblock",

  //== Network ==
  //"addnode",
  //"clearbanned",
  //"disconnectnode",
  //"getaddednodeinfo",
  //"getconnectioncount",
  //"getnettotals",
  //"getnetworkinfo",
  //"getpeerinfo",
  //"listbanned",
  //"ping",
  //"setban",
  //"setnetworkactive",

  //== Rawtransactions ==
  "combinerawtransaction",
  "createrawtransaction",
  "decoderawtransaction",
  "decodescript",
  //"fundrawtransaction",
  "getrawtransaction",
  "sendrawtransaction",
  "signrawtransaction",
  "testmempoolaccept",

  //== Restricted assets ==
  // "addtagtoaddress",
  "checkaddressrestriction",
  "checkaddresstag",
  "checkglobalrestriction",
  //"freezeaddress",
  //"freezerestrictedasset",
  "getverifierstring",
  //"issuequalifierasset",
  //"issuerestrictedasset",
  "isvalidverifierstring",
  "listaddressesfortag",
  "listaddressrestrictions",
  "listglobalrestrictions",
  "listtagsforaddress",
  //"reissuerestrictedasset",
  //"removetagfromaddress",
  //"transferqualifier",
  //"unfreezeaddress",
  //"unfreezerestrictedasset",

  //== Restricted ==
  /*
    "viewmyrestrictedaddresses",
    "viewmytaggedaddresses",
    */

  //== Rewards ==
  /*
    "cancelsnapshotrequest",
    "distributereward",
    "getdistributestatus",
    "getsnapshotrequest",
    "listsnapshotrequests",
    "requestsnapshot",

    */

  //== Util ==
  //"createmultisig",
  "estimatefee",
  "estimatesmartfee",
  "validateaddress",
  "verifymessage",

  //== Depin asset (chain queries; cached per block) ==
  "getpubkey",
  "checkdepinvalidity",
  //"freezedepin",
  "depingetancestorrecipients",
  "listdepinholders",
  "listdepinaddresses",
  //"listpqaddresses",   // lists the node wallet's PQ addresses
  //"selfrevokedepin",
  //"unfreezedepin",

  //== Depin messaging (protocol 2, served on the node's RPC port) ==
  // The client signs challenge requests and challenges, decrypts bound
  // replies, verifies poolsig against its pinned pool key and wraps
  // depinsubmitmsg in an ECIES envelope for that key. Nothing here needs the
  // node's wallet, and nothing derived from the pool is cached.
  "depinchallenge",
  "depinclearmsg",     // owner-level, challenge-authenticated
  "depingetmsginfo",   // publishes the pool key (clients pin it on first use)
  "depinlistsections", // 0 args: public section names; 4 args: address mode
  "depinmcpstatus",
  "depinpoolstats",
  "depinreceivemsg",
  "depinsubmitmsg",    // write, but non-custodial: {sender, encrypted} only
  // depingetpoolcontent no longer exists in the node.

  //== Depin — the node's OWN wallet; never exposed (spec §8.5) ==
  //"depingetmsg",        // decrypts with the node's wallet keys
  //"depinsendmsg",       // fromaddress must be a wallet address (signs+encrypts)
  //"depinsignrequest",   // signs a challenge request with the node's wallet keys
  //"depinsignchallenge", // signs a challenge with the node's wallet keys
  //"depindecrypt",       // opens an encrypted reply with the node's wallet keys
  //"depinpoolpkey",      // operator bootstrap; depingetmsginfo publishes the key

  //== Diagnostics not exposed ==
  //"getibdstatus",       // header-sync timings; absent from the v1.0.6 mainnet node

  //== Wallet ==
  /*
    "abandontransaction",
    "abortrescan",
    "addmultisigaddress",
    "addwitnessaddress",
    "backupwallet",
    "bumpfee",
    "dumpprivkey",
    "dumpwallet",
    "encryptwallet",
    "getaccount",
    "getaccountaddress",
    "getaddressesbyaccount",
    "getbalance",
    "getmasterkeyinfo",
    "getmywords",
    "getnewaddress",
    "getrawchangeaddress",
    "getreceivedbyaccount",
    "getreceivedbyaddress",
    "gettransaction",
    "getunconfirmedbalance",
    "getwalletinfo",
    "importaddress",
    "importmulti",
    "importprivkey",
    "importprunedfunds",
    "importpubkey",
    "importwallet",
    "keypoolrefill",
    "listaccounts",
    "listaddressgroupings",
    "listlockunspent",
    "listreceivedbyaccount",
    "listreceivedbyaddress",
    "listsinceblock",
    "listtransactions",
    "listunspent",
    "listwallets",
    "lockunspent",
    "move",
    "removeprunedfunds",
    "rescanblockchain",
    "sendfrom",
    "sendfromaddress",
    "sendmany",
    "sendtoaddress",
    "setaccount",
    "settxfee",
    "signmessage",
     */
];

function isWhitelisted(method) {
  const inc = whitelist.includes(method);
  return inc;
}
module.exports = {
  whitelist,
  isWhitelisted,
};
