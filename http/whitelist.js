const whitelist = [
  //== Addressindex ==
  'getaddressbalance',
  'getaddressdeltas',
  'getaddressmempool',
  'getaddresstxids',
  'getaddressutxos',

  //== Assets ==
  'getassetdata',
  // "getcacheinfo",
  //"getsnapshot",
  //"issue",
  //"issueunique",
  'listaddressesbyasset',
  'listassetbalancesbyaddress',
  'listassets',
  //"listmyassets",
  //"purgesnapshot",
  //"reissue",
  //"transfer",
  //"transferfromaddress",
  //"transferfromaddresses",

  //== Blockchain ==
  //"clearmempool",
  'decodeblock',
  'getbestblockhash',
  'getblock', // verbosity 3 adds each input's prevout from undo data (audits silent-payment records)
  'getblockchaininfo',
  'getblockcount',
  //"getblockdeltas", // per-block address deltas: heavy on large blocks, not needed by wallets
  'getblockhash',
  // "getblockhashes", //This can kill the service if you ask for all block hashes years back
  'getblockheader',
  'getchaintips',
  'getchaintxstats',
  'getdifficulty',
  'getmempoolancestors',
  'getmempooldescendants',
  'getmempoolentry',
  'getmempoolinfo',
  'getrawmempool',
  'getspentinfo',
  // Privacy-pool state threads (the node needs -spentindex -txindex). Pages are
  // bounded by the node: 1000 transitions and 1 MiB of raw transactions.
  'getprivacypoolinfo',
  'getprivacypoolupdates',
  // NIP-047 light-client data (the node needs -silentpaymentindex): public
  // tweaks and native v3 outputs per block. A receiver scans them with its own
  // scan key, so the node learns nothing. Range pages are bounded by the node:
  // 1000 blocks and 4 MB.
  'getsilentpaymentindexinfo',
  'getsilentpaymenttweaks',
  'getsilentpaymenttweaksrange',
  'gettxout',
  'gettxoutproof',
  // "gettxoutsetinfo", // not dangerous but slow: opt-in, see EXTRA_METHODS
  //"preciousblock",
  //"pruneblockchain",
  //"savemempool",
  //"verifychain",
  //"verifytxoutproof",

  //== Control ==
  //"getinfo",
  //"getmemoryinfo",
  //"getrpcinfo",
  'help',
  //"stop",
  //"uptime",

  //== Generating ==
  //"generate",
  //"generatetoaddress",
  //"getgenerate",
  //"setgenerate",

  //== Messages ==
  //"clearmessages",
  // NIP-048 chain-wide channel index (the node needs -channelmessageindex), not
  // the node wallet's messages. Pages are bounded by the node (limit, max 10000).
  'getchannelmessages',
  //"sendmessage",
  //"subscribetochannel",
  //"unsubscribefromchannel",
  //"viewallmessagechannels",
  //"viewallmessages",

  //== Mining ==
  // "getblocktemplate",
  //"getkawpowhash",
  //"getmininginfo", // opt-in, see EXTRA_METHODS
  'getnetworkhashps',
  //"pprpcsb",
  //"prioritisetransaction",
  //"submitblock",

  //== Network ==
  //"addnode",
  //"clearbanned",
  //"disconnectnode",
  //"getaddednodeinfo",
  //"getconnectioncount", // opt-in, see EXTRA_METHODS
  //"getnettotals",       // opt-in, see EXTRA_METHODS
  'getnetworkinfo', // reduced by rpcResults.js: no proxies, no local addresses
  //"getpeerinfo",
  //"listbanned",
  //"ping",
  //"setban",
  //"setnetworkactive",

  //== Rawtransactions ==
  'combinerawtransaction',
  'createrawtransaction',
  'decoderawtransaction',
  'decodescript',
  //"fundrawtransaction",
  'getrawtransaction',
  'sendrawtransaction',
  'signrawtransaction',
  'testmempoolaccept',

  //== Restricted assets ==
  // "addtagtoaddress",
  'checkaddressrestriction',
  'checkaddresstag',
  'checkglobalrestriction',
  //"freezeaddress",
  //"freezerestrictedasset",
  'getverifierstring',
  //"issuequalifierasset",
  //"issuerestrictedasset",
  'isvalidverifierstring',
  'listaddressesfortag',
  'listaddressrestrictions',
  'listglobalrestrictions',
  'listtagsforaddress',
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
  // Operator tooling for NIP-048 reward plans: snapshot management, plan
  // computation over every holder, and createdistributionbatch, which funds and
  // signs from the node wallet. replaysnapshot reads every block since asset
  // activation. None of it is wallet data.
  /*
    "cancelsnapshotrequest",
    "createdistributionbatch",
    "distributereward",
    "getdistributestatus",
    "getdistributionbatches",
    "getdistributionplan",
    "getdistributionproof",
    "getsnapshotannouncement",
    "getsnapshotrecipients",
    "getsnapshotrequest",
    "listsnapshotrequests",
    "replaysnapshot",
    "requestsnapshot",
    "verifydistribution",
    */

  //== Util ==
  //"createmultisig",
  'estimatefee',
  'estimatesmartfee',
  //"signmessagewithprivkey", // takes a private key: clients sign locally
  'validateaddress', // also reports AuthScript witness v1/v2/v3 fields (isauthscript, witness_version, family)
  'verifymessage',

  //== Depin asset (chain queries; cached per block) ==
  'getpubkey',
  'checkdepinvalidity',
  //"closedepin",  // DePIN transfer state (open/close/seal): owner-only wallet writes
  //"freezedepin",
  'depingetancestorrecipients',
  'listdepinholders',
  'listdepinaddresses',
  //"listpqaddresses",   // lists the node wallet's PQ addresses
  //"opendepin",
  //"sealdepin",
  //"selfrevokedepin",
  //"unfreezedepin",

  //== Depin messaging (protocol 2, served on the node's RPC port) ==
  // The client signs challenge requests and challenges, decrypts bound
  // replies, verifies poolsig against its pinned pool key and wraps
  // depinsubmitmsg in an ECIES envelope for that key. Nothing here needs the
  // node's wallet, and nothing derived from the pool is cached.
  'depinchallenge',
  'depinclearmsg', // owner-level, challenge-authenticated
  'depingetmsginfo', // publishes the pool key (clients pin it on first use)
  'depinlistsections', // 0 args: public section names; 4 args: address mode
  'depinmcpstatus',
  'depinpoolstats',
  'depinreceivemsg',
  'depinreceiveseq',
  'depinsubmitmsg', // write, but non-custodial: {sender, encrypted} only
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
    "decodesilentpaymentcode",
    "dumpextkeypq",
    "dumpprivkey",
    "dumpwallet",
    "encryptwallet",
    "exportsilentpaymentviewkey",
    "exportxpqpub",
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
    "getsilentpaymentcode",
    "getsilentpaymentinfo",
    "gettransaction",
    "getunconfirmedbalance",
    "getwalletinfo",
    "importaddress",
    "importmulti",
    "importprivkey",
    "importprunedfunds",
    "importpubkey",
    "importsilentpaymentviewkey",
    "importwallet",
    "keypoolrefill",
    "listaccounts",
    "listaddressgroupings",
    "listlockunspent",
    "listpqaddresses",
    "listreceivedbyaccount",
    "listreceivedbyaddress",
    "listsilentpayments",
    "listsinceblock",
    "listtransactions",
    "listunspent",
    "listwallets",
    "lockunspent",
    "move",
    "removeprunedfunds",
    "repairsilentpaymentidentity",
    "rescanblockchain",
    "rescansilentpayments",
    "sendfrom",
    "sendfromaddress",
    "sendmany",
    "sendsilentpayments",
    "sendtoaddress",
    "setaccount",
    "settxfee",
    "signmessage",
    "walletlock",
    "walletpassphrase",
    "walletpassphrasechange",
     */
];

/*
  Read-only methods a deployment may add on top of the whitelist, for every
  client (http.extra_methods) or for one client key (http.clients[].extra_methods).
  They are left out of the public list because they are slow or only useful
  to operators, not because they are unsafe. Nothing outside this list can be
  added by configuration: a typo or a pasted list must never open stop,
  dumpprivkey or a wallet call.
*/
const EXTRA_METHODS = [
  'gettxoutsetinfo', // scans the whole UTXO set (coins in circulation); cached per block
  'getmininginfo',
  'getconnectioncount',
  'getnettotals',
];

function isWhitelisted(method) {
  const inc = whitelist.includes(method);
  return inc;
}
module.exports = {
  whitelist,
  isWhitelisted,
  EXTRA_METHODS,
};
