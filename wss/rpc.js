const { default: PQueue } = require("p-queue");
const { getRPCNode, getIdentity } = require("../getRPCNode");
const { isFlushingRead, getSharedFlushingLimiter, FlushingReadThrottledError } = require("../flushingReads");

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
    await getIdentity();
    const node = getRPCNode();
    // Reads that flush the node's state (flushingReads.js) ask the limiter
    // here, with the call about to reach the node: a call waiting in a queue
    // has spent nothing yet, and HTTP and WSS share one budget.
    let permit = null;
    if (isFlushingRead(method)) {
      permit = getSharedFlushingLimiter().tryAcquire();
      if (!permit.allowed) throw new FlushingReadThrottledError(method, permit.retryAfterSeconds);
    }
    try {
      return await node.rpc(method, params == null ? [] : params);
    } finally {
      // Also on error and on timeout (a timed-out call may still be running
      // on the node, which cannot be cancelled from here).
      if (permit) permit.release();
    }
  }, { priority });
}

function getQueueStats() {
  if (!pushQueue) return { size: 0, pending: 0 };
  return { size: pushQueue.size, pending: pushQueue.pending };
}

module.exports = { initQueue, callRPC, getQueueStats };
