#!/bin/sh
set -eu

: "${PROXY_SERVICE_ID:=neurai-wallet-service}"
: "${NEURAI_NODE_NAME:=neuraid-testnet}"
: "${NEURAI_NODE_URL:=http://neuraid:19101}"
: "${NEURAI_RPC_USER:=neurai}"
: "${NEURAI_RPC_PASSWORD:=changeme}"
# Chain identity of the node pool (root `network` / `genesis_hash` in
# config.json). NEURAI_NETWORK = mainnet | testnet | regtest; with mainnet or
# testnet and no NEURAI_EXPECTED_GENESIS the service uses the genesis published
# by @neuraiproject/neurai-rpc. Both empty = no pin (the first healthy node
# defines the chain); the supplied compose files set both.
: "${NEURAI_NETWORK:=}"
: "${NEURAI_EXPECTED_GENESIS:=}"
# DePIN protocol 2 is served on the node's RPC port through NEURAI_NODE_URL.
# The protocol 1 gateway settings no longer exist on the proxy side.
if [ -n "${NEURAI_DEPIN_ENABLED:-}${NEURAI_DEPIN_URL:-}" ]; then
  echo "[entrypoint] NOTE: NEURAI_DEPIN_ENABLED/NEURAI_DEPIN_URL are obsolete and ignored (DePIN protocol 2 uses NEURAI_NODE_URL)." >&2
fi
# depin* abuse control by origin IP, shared by HTTP and WSS: requests per IP
# and minute, and how long an IP that went over is blocked (0 = no ban).
: "${PROXY_DEPIN_RATE_LIMIT:=60}"
: "${PROXY_DEPIN_BAN_MINUTES:=10}"
: "${PROXY_WSS_ENABLED:=false}"
: "${PROXY_WSS_PORT:=19020}"
: "${PROXY_WSS_PATH:=/push}"
: "${PROXY_WSS_TLS_ENABLED:=true}"
: "${PROXY_WSS_SSL_CERT:=/app/certs/push.crt}"
: "${PROXY_WSS_SSL_KEY:=/app/certs/push.key}"
: "${PROXY_WSS_AUTH_TRANSPORT:=sec-websocket-protocol}"
: "${PROXY_WSS_AUTH_TOKEN:=change-this-token}"
: "${PROXY_WSS_AUTOGEN_CERT:=false}"
: "${PROXY_WSS_ZMQ_SEQUENCE_ENABLED:=false}"
: "${PROXY_WSS_ZMQ_WATCHDOG_MS:=300000}"
: "${PROXY_WSS_POLL_INTERVAL_MS:=5000}"
: "${PROXY_WSS_MEMPOOL_INTERVAL_MS:=3000}"
: "${PROXY_WSS_MAX_SESSIONS:=5000}"
: "${PROXY_WSS_MAX_SUBSCRIPTIONS_PER_SESSION:=200}"
: "${PROXY_WSS_MAX_NEW_CONNECTIONS_PER_SECOND:=50}"
: "${PROXY_WSS_HISTORY_PAGE_LIMIT:=100}"
: "${PROXY_WSS_UTXO_PAGE_LIMIT:=1000}"
: "${PROXY_WSS_BULK_SUBSCRIBE_LIMIT:=200}"
: "${PROXY_WSS_REORG_INVALIDATE_DEPTH:=60}"
: "${PROXY_WSS_KEEPALIVE_INTERVAL_MS:=25000}"
: "${PROXY_WSS_KEEPALIVE_TIMEOUT_MS:=10000}"
: "${PROXY_WSS_STATS_ENABLED:=false}"
: "${PROXY_WSS_STATS_PORT:=19021}"
: "${PROXY_ZMQ_ENDPOINT:=tcp://neuraid:28332}"
: "${PROXY_HTTP_ENABLED:=false}"
: "${PROXY_HTTP_SERVE_WWW:=true}"
: "${PROXY_HTTP_HEADING:=Neurai RPC}"
: "${PROXY_HTTP_ENVIRONMENT:=Neurai}"
: "${PROXY_HTTP_ENDPOINT:=}"
: "${PROXY_HTTP_CONCURRENCY:=4}"
: "${PROXY_HTTP_MAX_RPS:=100}"
: "${PROXY_HTTP_MAX_RPS_PER_IP:=20}"
: "${PROXY_HTTP_MAX_QUEUE_SIZE:=500}"
: "${PROXY_HTTP_RATE_LIMITER_TTL_MS:=300000}"
: "${PROXY_HTTP_MAX_RATE_LIMITER_IPS:=10000}"
# Opt-in read-only methods for every HTTP client, comma separated. Only
# gettxoutsetinfo, getmininginfo, getconnectioncount and getnettotals are
# accepted; anything else stops the service at start.
: "${PROXY_HTTP_EXTRA_METHODS:=}"
# Trusted HTTP clients as a JSON array (see README, "Trusted clients"), e.g.
# [{"name":"explorer","key":"<secret>","extra_methods":["gettxoutsetinfo"]}]
: "${PROXY_HTTP_CLIENTS:=[]}"
# Only without WSS (PROXY_WSS_ENABLED=false): how often the HTTP-only service
# checks the chain tip to clear its per-block cache.
: "${PROXY_HTTP_TIP_POLL_INTERVAL_MS:=1000}"
export PROXY_HTTP_EXTRA_METHODS PROXY_HTTP_CLIENTS
# Time limit for every call to the node, in milliseconds, and per-method
# overrides as a JSON object (gettxoutsetinfo has 600000 unless overridden).
: "${PROXY_RPC_TIMEOUT_MS:=30000}"
if [ -z "${PROXY_RPC_METHOD_TIMEOUTS_MS:-}" ]; then PROXY_RPC_METHOD_TIMEOUTS_MS='{}'; fi
export PROXY_RPC_METHOD_TIMEOUTS_MS
# Reverse proxies whose X-Forwarded-For is believed, for HTTP and WSS alike.
# PROXY_HTTP_TRUSTED_PROXIES is the former name and still honoured.
: "${PROXY_TRUSTED_PROXIES:=${PROXY_HTTP_TRUSTED_PROXIES:-127.0.0.1,::1,::ffff:127.0.0.1}}"
# A default assigned by `:` is a shell variable, not an exported one: node
# would otherwise read an empty string and emit [] (no proxy trusted).
export PROXY_TRUSTED_PROXIES

PROXY_TRUSTED_PROXY_IPS_JSON="$(node -e 'const values = (process.env.PROXY_TRUSTED_PROXIES || "").split(",").map((value) => value.trim()).filter(Boolean); process.stdout.write(JSON.stringify(values));')"
PROXY_HTTP_EXTRA_METHODS_JSON="$(node -e 'const values = (process.env.PROXY_HTTP_EXTRA_METHODS || "").split(",").map((value) => value.trim()).filter(Boolean); process.stdout.write(JSON.stringify(values));')"
# The value holds client keys: report a malformed one without printing it.
if ! PROXY_HTTP_CLIENTS_JSON="$(node -e 'const value = JSON.parse(process.env.PROXY_HTTP_CLIENTS); if (!Array.isArray(value)) process.exit(1); process.stdout.write(JSON.stringify(value));' 2>/dev/null)"; then
  echo "[entrypoint] PROXY_HTTP_CLIENTS must be a JSON array (in .env, wrap it in single quotes)" >&2
  exit 1
fi

if ! PROXY_RPC_METHOD_TIMEOUTS_JSON="$(node -e 'const value = JSON.parse(process.env.PROXY_RPC_METHOD_TIMEOUTS_MS); if (!value || typeof value !== "object" || Array.isArray(value)) process.exit(1); process.stdout.write(JSON.stringify(value));' 2>/dev/null)"; then
  echo "[entrypoint] PROXY_RPC_METHOD_TIMEOUTS_MS must be a JSON object, e.g. {\"gettxoutsetinfo\":900000}" >&2
  exit 1
fi

# The listener carries WSS, WSS + HTTP, or HTTP alone; a self-signed cert
# is generated for whichever of them runs.
if { [ "${PROXY_WSS_ENABLED}" = "true" ] || [ "${PROXY_HTTP_ENABLED}" = "true" ]; } \
   && [ "${PROXY_WSS_TLS_ENABLED}" = "true" ] \
   && [ "${PROXY_WSS_AUTOGEN_CERT}" = "true" ]; then
  if [ ! -f "${PROXY_WSS_SSL_CERT}" ] || [ ! -f "${PROXY_WSS_SSL_KEY}" ]; then
    mkdir -p "$(dirname "${PROXY_WSS_SSL_CERT}")" "$(dirname "${PROXY_WSS_SSL_KEY}")"
    echo "[entrypoint] generating self-signed cert at ${PROXY_WSS_SSL_CERT} (dev/test only)"
    openssl req -x509 -newkey rsa:2048 \
      -keyout "${PROXY_WSS_SSL_KEY}" \
      -out "${PROXY_WSS_SSL_CERT}" \
      -days 365 -nodes \
      -subj "/CN=neurai-wallet-services-dev" >/dev/null 2>&1
    chmod 600 "${PROXY_WSS_SSL_KEY}"
  else
    echo "[entrypoint] cert already exists at ${PROXY_WSS_SSL_CERT}, skipping autogen"
  fi
fi

cat > /app/config.json <<EOF
{
  "service_id": "${PROXY_SERVICE_ID}",
  "network": "${NEURAI_NETWORK}",
  "genesis_hash": "${NEURAI_EXPECTED_GENESIS}",
  "trusted_proxy_ips": ${PROXY_TRUSTED_PROXY_IPS_JSON},
  "rpc_timeout_ms": ${PROXY_RPC_TIMEOUT_MS},
  "rpc_method_timeouts_ms": ${PROXY_RPC_METHOD_TIMEOUTS_JSON},
  "depin": {
    "rate_limit": ${PROXY_DEPIN_RATE_LIMIT},
    "ban_minutes": ${PROXY_DEPIN_BAN_MINUTES}
  },
  "wss": {
    "enabled": ${PROXY_WSS_ENABLED},
    "host": "0.0.0.0",
    "port": ${PROXY_WSS_PORT},
    "path": "${PROXY_WSS_PATH}",
    "tls_enabled": ${PROXY_WSS_TLS_ENABLED},
    "ssl_cert": "${PROXY_WSS_SSL_CERT}",
    "ssl_key": "${PROXY_WSS_SSL_KEY}",
    "zmq_enabled": true,
    "zmq_sequence_enabled": ${PROXY_WSS_ZMQ_SEQUENCE_ENABLED},
    "zmq_watchdog_ms": ${PROXY_WSS_ZMQ_WATCHDOG_MS},
    "auth_transport": "${PROXY_WSS_AUTH_TRANSPORT}",
    "auth_token": "${PROXY_WSS_AUTH_TOKEN}",
    "poll_interval_ms": ${PROXY_WSS_POLL_INTERVAL_MS},
    "mempool_interval_ms": ${PROXY_WSS_MEMPOOL_INTERVAL_MS},
    "max_sessions": ${PROXY_WSS_MAX_SESSIONS},
    "max_subscriptions_per_session": ${PROXY_WSS_MAX_SUBSCRIPTIONS_PER_SESSION},
    "max_new_connections_per_second": ${PROXY_WSS_MAX_NEW_CONNECTIONS_PER_SECOND},
    "history_page_limit": ${PROXY_WSS_HISTORY_PAGE_LIMIT},
    "utxo_page_limit": ${PROXY_WSS_UTXO_PAGE_LIMIT},
    "bulk_subscribe_limit": ${PROXY_WSS_BULK_SUBSCRIBE_LIMIT},
    "reorg_invalidate_depth": ${PROXY_WSS_REORG_INVALIDATE_DEPTH},
    "keepalive_interval_ms": ${PROXY_WSS_KEEPALIVE_INTERVAL_MS},
    "keepalive_timeout_ms": ${PROXY_WSS_KEEPALIVE_TIMEOUT_MS},
    "stats_enabled": ${PROXY_WSS_STATS_ENABLED},
    "stats_port": ${PROXY_WSS_STATS_PORT},
    "zmq_endpoint": "${PROXY_ZMQ_ENDPOINT}"
  },
  "http": {
    "enabled": ${PROXY_HTTP_ENABLED},
    "serve_www": ${PROXY_HTTP_SERVE_WWW},
    "heading": "${PROXY_HTTP_HEADING}",
    "environment": "${PROXY_HTTP_ENVIRONMENT}",
    "endpoint": "${PROXY_HTTP_ENDPOINT}",
    "concurrency": ${PROXY_HTTP_CONCURRENCY},
    "max_requests_per_second": ${PROXY_HTTP_MAX_RPS},
    "max_requests_per_second_per_ip": ${PROXY_HTTP_MAX_RPS_PER_IP},
    "max_queue_size": ${PROXY_HTTP_MAX_QUEUE_SIZE},
    "rate_limiter_ttl_ms": ${PROXY_HTTP_RATE_LIMITER_TTL_MS},
    "max_rate_limiter_ips": ${PROXY_HTTP_MAX_RATE_LIMITER_IPS},
    "extra_methods": ${PROXY_HTTP_EXTRA_METHODS_JSON},
    "clients": ${PROXY_HTTP_CLIENTS_JSON},
    "host": "0.0.0.0",
    "port": ${PROXY_WSS_PORT},
    "tls_enabled": ${PROXY_WSS_TLS_ENABLED},
    "ssl_cert": "${PROXY_WSS_SSL_CERT}",
    "ssl_key": "${PROXY_WSS_SSL_KEY}",
    "tip_poll_interval_ms": ${PROXY_HTTP_TIP_POLL_INTERVAL_MS}
  },
  "nodes": [
    {
      "name": "${NEURAI_NODE_NAME}",
      "username": "${NEURAI_RPC_USER}",
      "password": "${NEURAI_RPC_PASSWORD}",
      "neurai_url": "${NEURAI_NODE_URL}"
    }
  ]
}
EOF

echo "[entrypoint] config.json generated, starting (wss: ${PROXY_WSS_ENABLED}, http: ${PROXY_HTTP_ENABLED})"
exec npm start
