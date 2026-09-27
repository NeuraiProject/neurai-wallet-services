const { readIdentity, sameChain, resolveExpectedChain } = require("./service-identity");
const NeuraiRPC = require("@neuraiproject/neurai-rpc");

const getConfig = require("./getConfig");
const config = getConfig();
const allNodes = [];
let identity = null;
let checking = null;

// Chain the node pool must serve. `network` alone is not enough: the reset
// testnet keeps the "test" chain name, ports and address prefixes of the
// previous one, so only getblockhash(0) tells them apart. The expected genesis
// comes from config.genesis_hash or, for mainnet/testnet, from the hashes
// published by @neuraiproject/neurai-rpc (>= 0.7.0). Invalid values abort the
// start instead of silently rejecting every node later.
const expected = resolveExpectedChain(config, {
  mainnet: NeuraiRPC.MAINNET_GENESIS_HASH,
  testnet: NeuraiRPC.TESTNET_GENESIS_HASH,
});
if (expected.genesis_hash) {
  console.log(`[config] node pool pinned to ${expected.network || "chain"} genesis ${expected.genesis_hash}`);
} else {
  console.log("[config] WARNING: no network/genesis_hash configured; the first healthy node defines the chain");
}

// DePIN protocol 2 is served on the node's own RPC port: there is no DePIN
// URL, port or gateway any more. The protocol 1 keys are ignored with a notice.
const OBSOLETE_NODE_KEYS = ["depin_enabled", "depin_url"];

//At startup initialize all RPCs, you can have one or multiple Neurai nodes
for (const node of config.nodes) {
  const obsolete = OBSOLETE_NODE_KEYS.filter((key) => node[key] !== undefined);
  if (obsolete.length > 0) {
    console.log(`[config] node "${node.name}": ${obsolete.join(", ")} are obsolete (DePIN protocol 2 goes through neurai_url) and ignored`);
  }
  const rpc = NeuraiRPC.getRPC(node.username, node.password, node.neurai_url);
  allNodes.push({ name: node.name, rpc, neuraiUrl: node.neurai_url, active: false, healthError: null });
}

// Keep the reason a node was excluded (exposed by getNodes / GET /getCache)
// and log only transitions, so a node left on the previous testnet is visible
// without flooding the log every 10 seconds.
function setHealth(node, active, healthError) {
  if (node.healthError !== healthError && healthError) {
    console.log(`[nodes] "${node.name}" excluded: ${healthError}`);
  } else if (!node.active && active && node.healthError) {
    console.log(`[nodes] "${node.name}" healthy again`);
  }
  node.active = active;
  node.healthError = healthError;
}

/* Every x seconds, check the status of the nodes */
function healthCheck() {
  if (checking) return checking;
  checking = (async () => {
    for (const node of allNodes) {
      let found;
      try {
        found = await readIdentity(node.rpc);
      } catch {
        setHealth(node, false, "RPC health check failed");
        continue;
      }
      if (expected.genesis_hash && expected.genesis_hash !== found.genesis_hash) {
        setHealth(node, false, `unexpected genesis ${found.genesis_hash}`);
        continue;
      }
      if (expected.network && expected.network !== found.network) {
        setHealth(node, false, `unexpected network ${found.network}`);
        continue;
      }
      if (identity && !sameChain(identity, found)) {
        setHealth(node, false, "failover chain mismatch");
        continue;
      }
      try {
        node.bestblockhash = await node.rpc("getbestblockhash", []);
      } catch {
        setHealth(node, false, "RPC health check failed");
        continue;
      }
      if (!identity) identity = found;
      setHealth(node, true, null);
    }
  })().finally(() => { checking = null; });
  return checking;
}
const healthTimer = setInterval(healthCheck, 10 * 1000);
healthTimer.unref();
healthCheck();

function getRPCNode() {
  const node = allNodes.find(n => n.active);
  if (!node) throw new Error("No healthy node with validated chain identity");
  return { rpc: node.rpc, name: node.name };
}
async function getIdentity() {
  if (!allNodes.some(n => n.active)) await healthCheck();
  getRPCNode();
  return { ...identity, service_id: config.service_id || null };
}
function getNodes() {
  const list = [];
  for (const n of allNodes) {
    list.push({
      active: n.active,
      bestblockhash: n.bestblockhash,
      healthError: n.healthError,
      name: n.name,
    });
  }
  return list;
}

module.exports = { getRPCNode, getNodes, getIdentity, expectedChain: expected };
