const { readIdentity, sameChain } = require("./service-identity");
const NeuraiRPC = require("@neuraiproject/neurai-rpc");

const getConfig = require("./getConfig");
const config = getConfig();
const allNodes = [];
let identity = null;
let checking = null;

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
  allNodes.push({ name: node.name, rpc, neuraiUrl: node.neurai_url });
}

/* Every x seconds, check the status of the nodes */
function healthCheck() {
  if (checking) return checking;
  checking = (async () => {
    for (const node of allNodes) {
      try {
        const found = await readIdentity(node.rpc);
        if (config.genesis_hash && config.genesis_hash !== found.genesis_hash) throw new Error("Configured genesis mismatch");
        if (config.network && config.network !== found.network) throw new Error("Configured network mismatch");
        if (identity && !sameChain(identity, found)) throw new Error("Failover chain mismatch");
        if (!identity) identity = found;
        node.bestblockhash = await node.rpc("getbestblockhash", []);
        node.active = true;
      } catch {
        node.active = false;
      }
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
      name: n.name,
    });
  }
  return list;
}

module.exports = { getRPCNode, getNodes, getIdentity };
