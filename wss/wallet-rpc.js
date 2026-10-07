// Node access needed by local wallet builders. Never expose node wallet/admin
// commands: private keys and transaction construction stay on the client.
const { callRPC } = require('./rpc');
const { requireHello, requireSynced, MethodError } = require('./common');
const { ERROR_CODES } = require('./protocol');
const { toClientError } = require('../rpcError');
const { filterRpcResult } = require('../rpcResults');
const METHODS = Object.freeze([
  'getblockchaininfo', 'getblockcount', 'getblockhash', 'getblockheader',
  // Pool recovery reads the confirmed state chain and independently checks
  // the spent index. No proof generation or private wallet data is relayed.
  'getbestblockhash', 'getblock', 'getspentinfo', 'getrawmempool', 'decoderawtransaction',
  'getaddressbalance', 'getaddressdeltas', 'getaddressutxos', 'getaddressmempool',
  'getrawtransaction', 'gettxout', 'estimatesmartfee', 'getassetdata',
  'listassets', 'listassetbalancesbyaddress', 'listaddressesbyasset',
  'checkaddresstag', 'listtagsforaddress', 'listaddressesfortag',
  'checkaddressrestriction', 'checkglobalrestriction', 'getverifierstring',
  'isvalidverifierstring', 'listdepinaddresses', 'listdepinholders', 'checkdepinvalidity',
  'validateaddress', 'getpubkey', 'testmempoolaccept',
  // Reduced like over HTTP (rpcResults.js): wallets read relayfee to price transactions.
  'getnetworkinfo',
]);
const capability = { methods: METHODS, amounts: 'rpc-native-units', numeric_encoding: 'safe-number-or-string' };
async function handle(session, params) {
  requireHello(session);
  if (session.protocol !== 'wss/2') throw new MethodError(ERROR_CODES.UNSUPPORTED_PROTOCOL, 'wallet RPC requires wss/2');
  requireSynced();
  if (!params || !METHODS.includes(params.method)) throw new MethodError(ERROR_CODES.METHOD_NOT_FOUND, 'Unsupported wallet RPC method');
  if (!Array.isArray(params.params)) throw new MethodError(ERROR_CODES.INVALID_PARAMS, 'RPC params must be an array');
  try { return filterRpcResult(params.method, await callRPC(params.method, params.params)); }
  catch (error) {
    const detail = toClientError(error, 'wallet RPC failed');
    throw new MethodError(ERROR_CODES.INTERNAL_ERROR, detail.message, { node_code: detail.code });
  }
}
module.exports = { capability, handle };
