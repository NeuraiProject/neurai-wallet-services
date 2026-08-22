const NeuraiRPC = require("@neuraiproject/neurai-rpc");

const getConfig = require("./getConfig");
const config = getConfig();
const allNodes = [];

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
async function healthCheck() {
  for (const node of allNodes) {
    try {
      const a = await node.rpc("getbestblockhash", []);
      node.bestblockhash = a;
      node.active = true;
    } catch {
      node.active = false;
    }
  }
}
setInterval(healthCheck, 10 * 1000);
healthCheck();

function getRPCNode() {
  for (const n of allNodes) {
    if (n.active === true) {
      return {
        rpc: n.rpc,
        name: n.name,
      };
    }
  }
  //We did not find any active node so we return the first
  return {
    name: allNodes[0].name,
    rpc: allNodes[0].rpc,
  };
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

module.exports = { getRPCNode, getNodes };
