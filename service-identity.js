function networkName(chain) {
  return ({ main: 'mainnet', test: 'testnet', regtest: 'regtest' })[chain] || chain;
}
async function readIdentity(rpc) {
  const [genesis_hash, info] = await Promise.all([rpc('getblockhash', [0]), rpc('getblockchaininfo', [])]);
  const network = networkName(info && info.chain);
  if (!/^[a-f0-9]{64}$/.test(genesis_hash) || !['mainnet', 'testnet', 'regtest'].includes(network)) {
    throw new Error('Invalid upstream chain identity');
  }
  return { genesis_hash, network };
}
function sameChain(a, b) { return a.genesis_hash === b.genesis_hash && a.network === b.network; }
module.exports = { readIdentity, sameChain, networkName };
