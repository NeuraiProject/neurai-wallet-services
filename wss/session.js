const { encodeMessage } = require("./wire-amounts");
const counters = { negotiations: { "wss/1": 0, "wss/2": 0 }, unsafe_v1_amounts: 0, encoding_errors: 0 };
let nextId = 1;
const allSessions = new Set();

function createSession(ws, ip) {
  const session = {
    id: nextId++,
    ws,
    ip: ip || null,
    helloDone: false,
    protocol: "wss/1",
    closed: false,
    subs: new Set(),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    msgCount: 0,
  };
  allSessions.add(session);
  return session;
}

function destroySession(session) {
  session.closed = true;
  allSessions.delete(session);
}

function getStats() {
  const active = { "wss/1": 0, "wss/2": 0 };
  for (const s of allSessions) if (s.helloDone) active[s.protocol]++;
  return { sessionCount: allSessions.size, active, ...counters, negotiations: { ...counters.negotiations } };
}

function getAllSessions() {
  return allSessions;
}

function sendJson(session, obj, method) {
  if (!session || !session.ws) return false;
  if (session.ws.readyState !== 1) return false;
  try {
    session.ws.send(encodeMessage(obj, method, session.protocol, () => counters.unsafe_v1_amounts++));
    return true;
  } catch (error) {
    counters.encoding_errors++;
    console.error("[WSS] encoding/send failed", method || obj.method, error.message);
    return false;
  }
}

module.exports = {
  negotiated(protocol) { counters.negotiations[protocol]++; },
  createSession,
  destroySession,
  getStats,
  getAllSessions,
  sendJson,
};
