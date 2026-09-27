const NETWORKS = ['mainnet', 'testnet', 'regtest'];
const GENESIS_RE = /^[a-f0-9]{64}$/;

function networkName(chain) {
  return ({ main: 'mainnet', test: 'testnet', regtest: 'regtest' })[chain] || chain;
}
async function readIdentity(rpc) {
  const [genesis_hash, info] = await Promise.all([rpc('getblockhash', [0]), rpc('getblockchaininfo', [])]);
  const network = networkName(info && info.chain);
  if (!GENESIS_RE.test(genesis_hash) || !NETWORKS.includes(network)) {
    throw new Error('Invalid upstream chain identity');
  }
  return { genesis_hash, network };
}
function sameChain(a, b) { return a.genesis_hash === b.genesis_hash && a.network === b.network; }

// Chain the configured node pool must serve, from the root `network` and
// `genesis_hash` of config.json. An explicit genesis_hash wins; otherwise
// mainnet and testnet fall back to `knownGenesis` (the hashes exported by
// @neuraiproject/neurai-rpc). Regtest has no default: every regtest chain has
// its own genesis. Empty strings count as unset so the Docker entrypoint can
// always emit both keys.
function resolveExpectedChain(config, knownGenesis = {}) {
  const network = (config && config.network) || null;
  if (network !== null && !NETWORKS.includes(network)) {
    throw new Error(`[config] network must be one of ${NETWORKS.join(', ')}`);
  }
  let genesis = (config && config.genesis_hash) || null;
  if (genesis !== null) {
    genesis = typeof genesis === 'string' ? genesis.toLowerCase() : genesis;
    if (!GENESIS_RE.test(genesis)) throw new Error('[config] genesis_hash must be a 64-character hex block hash');
  } else if (network && typeof knownGenesis[network] === 'string') {
    genesis = knownGenesis[network].toLowerCase();
  }
  return { network, genesis_hash: genesis };
}

module.exports = { readIdentity, sameChain, networkName, resolveExpectedChain };
