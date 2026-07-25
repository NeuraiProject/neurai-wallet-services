const { default: PQueue } = require("p-queue");
const { getRPCNode } = require("../getRPCNode");

let pushQueue = null;

function initQueue(concurrency) {
  if (pushQueue) return pushQueue;
  pushQueue = new PQueue({ concurrency: concurrency || 4 });
  return pushQueue;
}

// All node calls share this queue.  Callers may use a higher priority for
// latency-sensitive work (the WSS event pipeline) so public HTTP traffic
// cannot sit in front of block/address refreshes.
function callRPC(method, params, priority = 0) {
  if (!pushQueue) initQueue(4);
  return pushQueue.add(async () => {
    const node = getRPCNode();
    return node.rpc(method, params == null ? [] : params);
  }, { priority });
}

function getQueueStats() {
  if (!pushQueue) return { size: 0, pending: 0 };
  return { size: pushQueue.size, pending: pushQueue.pending };
}

module.exports = { initQueue, callRPC, getQueueStats };
