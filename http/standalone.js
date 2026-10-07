// The HTTP API on its own, without the WebSocket push service, for public
// RPC endpoints. Used when http.enabled is true and wss.enabled is not; with
// WSS on, HTTP shares the WSS listener instead.
//
// No auth token, ZMQ or session machinery is needed. The per-block cache is
// cleared from a getbestblockhash poll (tip_poll_interval_ms, 1 s by default);
// the mempool is not polled because no HTTP response depends on it.

const { createListener } = require("../wss/server");
const poller = require("../wss/poller");

function listenerConfig(raw) {
  const cfg = {
    host: raw.host || "0.0.0.0",
    port: raw.port,
    tls_enabled: raw.tls_enabled !== false,
    ssl_cert: raw.ssl_cert,
    ssl_key: raw.ssl_key,
    tip_poll_interval_ms: raw.tip_poll_interval_ms == null ? 1000 : raw.tip_poll_interval_ms,
  };
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) {
    throw new Error("[HTTP] http.port is required when wss.enabled is false");
  }
  if (cfg.tls_enabled && (!cfg.ssl_cert || !cfg.ssl_key)) {
    throw new Error("[HTTP] http.ssl_cert and http.ssl_key required when http.tls_enabled is true");
  }
  if (!Number.isInteger(cfg.tip_poll_interval_ms) || cfg.tip_poll_interval_ms < 500) {
    throw new Error("[HTTP] http.tip_poll_interval_ms must be an integer of at least 500");
  }
  return cfg;
}

function start(rawCfg, httpService) {
  const cfg = listenerConfig(rawCfg || {});
  const server = createListener(cfg, "[HTTP]");
  server.on("request", httpService.handleRequest);
  poller.start({ poll_interval_ms: cfg.tip_poll_interval_ms }, {
    onBlock: (hash) => httpService.onBlock(hash),
    onInitialTip: (hash) => httpService.onBlock(hash),
  });
  server.listen(cfg.port, cfg.host, () => {
    const scheme = cfg.tls_enabled ? "https" : "http";
    console.log(`[HTTP] listening on ${scheme}://${cfg.host}:${server.address().port}/rpc (WSS disabled)`);
  });
  return server;
}

module.exports = { start, listenerConfig };
