# neurai-wallet-services

Backend services for Neurai mobile and light wallets. Holds a persistent
WebSocket per client, lets it subscribe to addresses, and pushes events when
balances, mempool state, the chain tip or the node's sync state change — so
the wallet never polls. Also relays the Neurai DePIN messaging RPCs
(protocol 2) over the same connection and over HTTP. Future home for native
address indexing.

This is **not** a generic Electrum/ElectrumX-compatible server. The wire
protocol is custom and small, intended to be paired with one mobile wallet
that speaks the same protocol.

## What's in here

- A WSS endpoint at `/push` that speaks a JSON-RPC-like protocol over WebSocket.
- Optional public HTTP RPC endpoints on the same listener: `POST /rpc` and
  `GET /settings`, `/whitelist`, `/getCache`. Enable them with `http.enabled`.
  (`POST /depin` and `POST /depin/challenge` belonged to DePIN protocol 1 and
  answer `410 Gone` for one release.)
  Public HTTP calls are whitelisted, rate-limited and queued behind WSS RPC work.

### Optional public HTTP RPC

HTTP shares the WSS port and TLS configuration; it cannot start independently.
Leave it disabled unless the listener is intended to publish the RPC API.

```json
"http": {
  "enabled": false,
  "serve_www": true,
  "concurrency": 4,
  "max_requests_per_second": 100,
  "max_requests_per_second_per_ip": 20,
  "max_queue_size": 500
}
```

`concurrency` limits HTTP work admitted to the shared node queue. WSS work has
priority in that queue. `max_requests_per_second` is global;
`max_requests_per_second_per_ip` is the individual-client budget.
`max_queue_size` returns `503` when the HTTP backlog is full (waiting work
only; executing work is not included). Per-IP buckets expire after five
minutes of inactivity and are capped at 10,000 entries.

`trusted_proxy_ips` (root of `config.json`, shared by HTTP and WSS)
determines which immediate peers may supply `X-Forwarded-For`; do not add
untrusted IPs. For Docker behind Hestia/nginx on the host, the peer is normally
the Docker bridge gateway, not `127.0.0.1`. Set `PROXY_TRUSTED_PROXIES` to a
comma-separated list including that gateway (find it with
`docker network inspect <network-name>`), for example `172.19.0.1,127.0.0.1,::1`.
The reverse proxy must **overwrite** the header
(`proxy_set_header X-Forwarded-For $remote_addr;`), never append to it
(`$proxy_add_x_forwarded_for`): the service reads the first element, and with
an appending proxy that element is whatever the client sent. The former
`http.trusted_proxy_ips` / `PROXY_HTTP_TRUSTED_PROXIES` are still honoured.

For intentional compatibility with the retired proxy, most error bodies are
preserved. Node JSON-RPC errors are `500` with
`{ "error": { "message", "code" } }`, where `code` is the node's JSON-RPC code
(for DePIN: `-32600` authentication, `-8` parameter, `-5` address or missing
public key, `-22`/`-25` envelope, `-1` service/quota) so clients can branch on
it. An upstream failure — node unreachable, RPC credentials refused, a non-JSON
reply — is `502` with the neutral `{ "error": { "message": "upstream RPC
unavailable", "code": null } }`; the detail goes to the log only.
`signmessagewithprivkey` is deliberately not exposed; clients must sign
locally. `sendrawtransaction` remains available for wallet broadcasting. Every
POST-only route answers `GET` with `405` and `Allow: POST`.
- Auth in the HTTP upgrade via `Sec-WebSocket-Protocol: wss, auth.<token>`.
- Built-in rate limiting (`503 Retry-After`) and session/subscription caps.
- ZMQ subscriber to the Neurai node (`hashblock` + `rawtx`) with polling
  fallback. Real-time `address.changed` / `chain.tip` / `chain.reorg` events.
- Deterministic reorg detection backed by an in-memory `Map<height, hash>`
  of the last 120 blocks, pre-populated at startup from the chain.
- Node-health monitoring: a 10s poll of `getblockchaininfo` gates methods
  that depend on a synced chain and emits `node.synced` / `node.syncing`
  on transitions.
- DePIN protocol 2 relay: `depin.*` over WSS and `depin*` over `POST /rpc`,
  with one per-IP quota shared by both transports.
- Docker setup for the testnet service stack, with tests kept under `tests/`.

## Status

**Phases 1, 2, 3, 4, 5 + 6 implemented and verified against a live testnet node**:

- `hello`, `ping`
- `address.subscribe`, `address.unsubscribe`, `address.subscribe.bulk`,
  `address.unsubscribe.bulk` (with optional `assets` filter)
- `address.get_state` with composite cursor pagination (history + UTXOs),
  assets projection, and per-asset history rows
- `tx.broadcast`
- `depin.*` — DePIN protocol 2 name translations over the node RPC
- Push events: `chain.tip`, `chain.reorg`, `address.changed` (with
  `touched_assets` in delta), `node.synced`, `node.syncing`
- ZMQ subscriber (`zeromq` optional dep) + mempool polling fallback
- Sync gating: methods that need a synced chain return `1008` with progress
- WS-level ping/pong keepalive (configurable, default 25s interval / 10s timeout)
- Auth, rate limit, session limits, cert hot-reload, block-index warmup

Pending: per-block "candidate addresses" refresh (optional improvement).

## Protocol overview

Wire-level subprotocol identifier: `wss`.
Application-level version (reported in `hello`): `wss/1`.

### Handshake

```json
// client → server (over WSS, after a 101 upgrade)
{ "id": 1, "method": "hello",
  "params": { "client": "my-wallet", "version": "0.1.0",
              "network": "mainnet", "protocol": "wss/1" } }

// server → client
{ "id": 1, "result": {
    "server": "neurai-wallet-services",
    "protocol": "wss/1",
    "protocol_min": "wss/1",
    "protocol_max": "wss/1",
    "network": "mainnet",
    "tip_height": 75880,
    "tip_hash": "000048f1998e6f45...",
    "syncing": false,
    "verification_progress": 1.0,
    "blocks": 75880,
    "headers": 75880
  } }
```

`syncing` and friends let the wallet show a progress UI before subscribing.

### Methods

| Method | Params | Returns | Gated while syncing |
|---|---|---|---|
| `hello` | `{client, version, network, protocol}` | server info + tip + sync state | no |
| `ping` | none | `"pong"` | no |
| `address.subscribe` | `{address, assets?}` | `{address, status, balance, height, assets?}` | **yes** |
| `address.subscribe.bulk` | `{addresses: [...], assets?}` | `{results: [{address, status?, balance?, height?, assets?, error?}]}` | **yes** |
| `address.unsubscribe` | `{address}` | `true` | no |
| `address.unsubscribe.bulk` | `{addresses: [...]}` | `{count}` | no |
| `address.get_state` | `{address, include_history?, include_utxos?, cursor?, limit?, utxo_cursor?, utxo_limit?, assets?, from_height?}` | `{address, status, balance, mempool, history, utxos, page, utxo_page, assets?, asset_utxos?}` | **yes** |
| `tx.broadcast` | `{rawtx}` | `{txid}` | **yes** |
| `depin.check_validity` | `[asset, address]` or `{args:[...]}` | `checkdepinvalidity` result | **yes** |
| `depin.list_holders` | `[asset]` | `listdepinholders` result | **yes** |
| `depin.list_addresses` | `[asset, count?, start?]` | `listdepinaddresses` result | **yes** |
| `depin.get_pubkey` | `[address]` | `getpubkey` result | **yes** |
| `depin.ancestor_recipients` | `[token, max_results?, stop_at?]` | `depingetancestorrecipients` reply | **yes** |
| `depin.msg_info` | `[]` | `{body, poolsig}` | no |
| `depin.pool_stats` | `[]` | `{body, poolsig}` | no |
| `depin.mcp_status` | `[]` | `{body, poolsig}` | no |
| `depin.challenge` | `[token, address, timestamp_ms, signature, type?]` | `{encrypted, poolsig}` | no |
| `depin.receive_msg` | `[token, address, challenge, signature, timestamp?, after_hash?, limit?]` | `{encrypted, poolsig}` | no |
| `depin.sections` | `[]` (public names) or `[address, scope, challenge, signature]` | `{body, poolsig}` / `{encrypted, poolsig}` | no |
| `depin.clear_msg` | `[scope, address, challenge, signature, mode?]` | `{encrypted, poolsig}` | no |
| `depin.submit_msg` | `[{sender, encrypted}]` | `{encrypted, poolsig}` | no |

Every `depin.*` method is a name translation over the corresponding node RPC:
params are forwarded positionally and untouched (`[...]` or `{args: [...]}`),
and the reply is the node's. The pool methods are not gated by this
service's sync state because the node decides access against its own index.
Retired with protocol 2 and answered with `1004`: `depin.send_msg`,
`depin.get_msg`, `depin.pool_pkey`, `depin.pool_content`,
`depin.list_pq_addresses`. The protocol 1 param shapes `{address}` and
`{address, signature, args}` are refused with `1003`.

DePIN node errors arrive as `1005` with the node's `message` and its JSON-RPC
`code`; an upstream failure is `1005` with `"upstream RPC unavailable"` and
`code: null`. Over the per-IP quota (see below) the answer is `1007` with
`retry_after_seconds`.

#### `address.get_state` and pagination

`address.get_state` returns the full per-address snapshot the wallet needs
to render a screen: balance, mempool entries, recent history, and UTXOs.
History is **always paginated** using a composite opaque cursor (`height:tx_index:asset`):

```json
// request
{ "id": 4, "method": "address.get_state",
  "params": {
    "address": "tnq1p9tdg76plsuss5lguphhm76t0faf2hy8vmefrq39ctsk0t5fqygzsz2dm40",
    "include_history": true,
    "include_utxos": true,
    "limit": 100,
    "cursor": null
  } }

// response
{ "id": 4, "result": {
    "address": "...",
    "status": "d9385809c15265e9...",
    "balance": { "confirmed": 500000000000, "unconfirmed": 0 },
    "mempool": [ { "txid": "...", "satoshis": 100000, "prev_txid": null, "prev_vout": null } ],
    "history": [ { "txid": "471e4d...", "height": 75841, "tx_index": 1, "asset": "XNA", "satoshis": 500000000000 } ],
    "utxos":   [ { "txid": "...", "vout": 0, "satoshis": 500000000000, "height": 75841 } ],
    "page":      { "cursor": null, "limit": 100, "has_more": true, "next_cursor": "75900:3:XNA" },
    "utxo_page": { "cursor": null, "limit": 100, "has_more": false, "next_cursor": null }
  } }
```

To fetch the next history page, the wallet sends `params.cursor: "75900:3:XNA"`
(the exact value returned in `next_cursor`). The cursor is opaque — the
client must not parse or construct it. Legacy two-part cursors
(`"height:tx_index"`) issued before per-asset history was added are still
accepted as a one-time compatibility shim. `include_history` and
`include_utxos` default to `true`; set them to `false` for a cheaper
response when the wallet only needs the balance + status. `from_height` is
accepted as a shortcut for the first page only — subsequent pages must use
`next_cursor`.

History entries aggregate per (height, tx_index, txid, asset). Every entry
has an `asset` field (`"XNA"` for native). If a single tx pays the same
address multiple times in the same asset, those outputs collapse into one
entry with the summed satoshis. If a tx touches multiple assets (e.g. a
swap of XNA → TRON), it produces one entry per asset — they share the
same `txid` but appear as distinct history rows.

UTXOs are paginated independently from history. By default `utxo_limit` is
**100** to keep mobile payloads sane — an address with thousands of UTXOs
(coinbase miner addresses, exchange hot wallets) would otherwise produce
multi-MB responses. The wallet has two ways to get more:

- `utxo_limit: <N>` — at most N UTXOs in this page; use `utxo_cursor`
  (returned as `utxo_page.next_cursor`) to fetch the next page.
- `utxo_limit: 0` — explicit opt-in for the **full set**, no cap. Use only
  when the wallet is prepared to handle large responses.

The server-side cap is `wss.utxo_page_limit` (default 1000); requests
above this clamp silently to the cap unless `utxo_limit: 0`.

### Assets

Neurai supports tokens (assets) on the same chain. By default the proxy
returns only the native XNA balance and UTXOs — wallets that don't care
about tokens see nothing new. To opt in, pass an `assets` filter:

| `assets` value | Behavior |
|---|---|
| `false`, `null`, or omitted | Native XNA only (default). Response unchanged. |
| `true` | Include every asset the address holds. |
| `["TRON", "BROM"]` | Include only these specific asset names (zero-filled if absent). |

When `assets` is set, the response gains:

```jsonc
// address.subscribe / address.subscribe.bulk[i]
{ "address": "...", "status": "...", "balance": {...}, "height": 75900,
  "assets": {
    "TRON":  { "confirmed": 100700000000, "unconfirmed": 0 },
    "TRON!": { "confirmed": 100000000,    "unconfirmed": 0 }
  } }

// address.get_state additionally returns:
{ "...": "...",
  "assets": { "TRON": {...}, ... },
  "asset_utxos": [
    { "txid": "...", "vout": 1, "satoshis": 42000000000, "height": 13973, "asset": "TRON" }
  ] }
```

Key points:

- The **status hash always includes asset balances + asset UTXOs** regardless
  of the filter. This means a token transfer to a subscribed address fires
  `address.changed` even if the wallet only requested `assets: false`. The
  wallet decides whether to refetch with the assets filter based on
  `delta.touched_assets` in the event.
- **Ownership tokens** (`NAME!`) are returned as separate entries from the
  underlying asset (`NAME`) — they're distinct on Neurai. The wallet can
  show or hide them as needed.
- **Asset history** in `address.get_state` follows the `assets` filter:
  - `assets: false` (default) → history contains only XNA rows.
  - `assets: true` → history mixes XNA and every asset row the address
    received, sorted by `(height, tx_index, asset)`. One row per asset
    per tx (see the aggregation note above).
  - `assets: ["FOO"]` → history contains XNA plus only the listed asset
    names. XNA is always included so wallets can render the native ledger
    alongside the filtered tokens.

  Requires a Neurai node built with the `getaddressdeltas` wildcard fix
  (`assetName: "*"`). Older nodes return an empty asset history; native
  history still works on those.

### Bulk subscribe for HD wallets

HD wallets derive many addresses (one per index) and need to subscribe them
all at session open. `address.subscribe.bulk` saves the round-trip cost of
issuing N individual subscribes:

```json
// request
{ "id": 10, "method": "address.subscribe.bulk",
  "params": { "addresses": ["addr1", "addr2", "addr3"] } }

// response — per-entry results, in input order
{ "id": 10, "result": { "results": [
    { "address": "addr1", "status": "ab12...", "balance": {...}, "height": 75900 },
    { "address": "addr2", "error": { "code": 1003, "message": "invalid address" } },
    { "address": "addr3", "status": "cd34...", "balance": {...}, "height": 75900 }
] } }
```

Per-entry errors do not abort the batch. The batch as a whole fails (1003)
if `addresses` is missing/non-array, or (1006) if it would push the session
over `max_subscriptions_per_session`. The max batch size defaults to **200**
(configurable via `wss.bulk_subscribe_limit`).

`address.unsubscribe.bulk({addresses: [...]})` symmetrically removes many.
It silently ignores empty/non-string entries and returns `{count}`.

### Resilient ZMQ subscriber

The ZMQ subscriber runs in a reconnecting loop with exponential backoff
(1s → 2s → 4s → ... → 30s capped). It survives:

- **Neuraid restarts** — the publisher comes back, the next reconnect
  attempt re-establishes the subscription.
- **Socket teardown / iterator errors** — the outer loop catches and retries.
- **Silent disconnects (NAT teardown, idle TCP)** — a watchdog (default
  5 min, `zmq_watchdog_ms`) recycles the socket if no message arrives for
  too long, forcing a fresh subscription.

Backoff resets to 1s after any connection that stayed up for >30s.

During reconnect gaps the polling fallback continues to detect new tips and
mempool changes, so the wallet still gets `chain.tip` and `address.changed`
events — just with the polling-interval latency (default 5s for blocks, 3s
for mempool) instead of ZMQ's near-real-time.

ZMQ status is exposed via `wss.getStats().zmq`:

```json
{ "connected": true, "attempts": 3,
  "last_message_at": 1734568914123,
  "last_connected_at": 1734568900456,
  "last_disconnected_at": 1734568700123 }
```

### WS-level keepalive

The server sends a WebSocket `ping` frame to every active session every
`keepalive_interval_ms` (default **25s** — safely below the typical
30-second NAT timeout that kills idle mobile WS connections). If the
client doesn't respond with a `pong` within `keepalive_timeout_ms`
(default **10s**), the server calls `ws.terminate()` and runs the normal
close cleanup (`unsubscribeAll`, `destroySession`, `keepalive.stop`).

Both values are configurable in `wss` config or via env:

```
PROXY_WSS_KEEPALIVE_INTERVAL_MS=25000
PROXY_WSS_KEEPALIVE_TIMEOUT_MS=10000
```

Tuning hints:

- **Lower `interval_ms`** (e.g. 15000) if your reverse proxy / NAT has an
  aggressive idle timeout — when in doubt, halve it.
- **Lower `timeout_ms`** (e.g. 5000) if you want faster dead-peer detection,
  at the cost of being less tolerant of slow mobile networks.
- **Raise `interval_ms`** (e.g. 60000) if you want to reduce traffic and
  your network has no idle timeouts (LAN/datacenter only).

The wallet doesn't need application-level handling — the `ws` client
library auto-responds to ping frames. The application-level `ping` method
(returning `"pong"`) is a separate request/response, useful for the wallet
to actively verify the proxy is responsive.

### Server-to-client events

Pushed without prior request once `hello` is done. The wallet must be
event-driven — events can interleave with normal request/response.

| Event | Payload | When |
|---|---|---|
| `chain.tip` | `{height, hash}` | New best block. Fired before any `address.changed` for the same block. |
| `chain.reorg` | `{from_height, old_tip, new_tip, new_height, invalidate_depth}` | A block at height ≤ current tip got replaced. The wallet should invalidate cache from `from_height`. |
| `address.changed` | `{address, status, reason, height, balance, delta}` | A subscribed address's state changed. `reason ∈ {"block","mempool","resync","manual"}`. `delta = {added_txids, confirmed_txids, removed_txids, touched_assets}`. |
| `node.synced` | `{height, verification_progress}` | The Neurai node finished syncing. Wallets that were waiting can now subscribe. |
| `node.syncing` | `{blocks, headers, verification_progress}` | The node fell out of sync (uncommon — deep reorg, RPC unreachable). |

#### `address.changed` example

```json
{ "method": "address.changed",
  "params": {
    "address": "tnq1p9tdg76plsuss5lguphhm76t0faf2hy8vmefrq39ctsk0t5fqygzsz2dm40",
    "status": "d9385809c15265e9...",
    "reason": "block",
    "height": 75841,
    "balance": { "confirmed": 500000000000, "unconfirmed": 0 },
    "delta": {
      "added_txids": ["471e4da0ee1ded98ec8e6c20840763dcae7fd8151fab95f9d05c33c9c69bd5dd"],
      "confirmed_txids": [],
      "removed_txids": [],
      "touched_assets": []
    } } }
```

### Sync gating

If the Neurai node isn't fully synced, methods that need a coherent chain
view return a structured `1008` error:

```json
{ "id": 2, "error": {
    "code": 1008,
    "message": "node syncing, retry when synced",
    "retry_after_seconds": 30,
    "verification_progress": 0.4231,
    "blocks": 32000,
    "headers": 75800
  } }
```

The wallet can display a real progress bar and retry every `retry_after_seconds`.
When the node finishes syncing, the server pushes `node.synced` to all
connected sessions — no need to keep polling.

### DePIN protocol 2

DePIN messaging protocol 2 is served by the node on its **own RPC port**: there
is no DePIN port, gateway or URL any more. This service relays the
whitelisted `depin*` RPCs over WSS (`depin.*`) and over `POST /rpc`; it holds no
keys and no challenges. The full specification is
`doc/depin-messaging-protocol.md` in the node repository; in short, the client:

1. Calls `depingetmsginfo`, refuses `protocol != 2`, and pins
   `(service, token, depinpoolpkey)` — on first contact as TOFU material,
   afterwards verified. A changed key is an alert, never a silent re-pin.
2. Verifies `poolsig` on **every** reply against the pinned key
   (`DEPIN-RESP|method|token|address|challenge|sha256hex(body or encrypted)`)
   before decoding or decrypting anything.
3. Signs `DEPIN-REQ|<type>|<token>|<address>|<unix ms>` with the holder key
   (`signmessage`-compatible) and calls `depinchallenge`; decrypts the bound
   reply locally (ECIES for its revealed public key) to get the challenge.
4. Signs `DEPIN-GET|<token>|<address>|<challenge>` (or `DEPIN-CLEAR|…` for an
   owner purge) and calls `depinreceivemsg` / `depinlistsections` /
   `depinclearmsg`; keeps `next_challenge` from each reply to chain reads.
5. Publishes with `depinsubmitmsg({sender, encrypted})`: the serialized,
   signed message, encrypted for the recipients from
   `depingetancestorrecipients`, wrapped in an ECIES envelope for the pool
   key. Bare hex is not accepted by the node.

Over WSS:

```text
client → depin.msg_info([])                                   → {body, poolsig}
client → depin.challenge([token, address, ms, sigReq, "receive"])
                                                              → {encrypted, poolsig}
client verifies poolsig, decrypts → {challenge, expires_in, type}
client → depin.receive_msg([token, address, challenge, sigGet, 0, "", 50])
                                                              → {encrypted, poolsig}
client verifies poolsig, decrypts → {messages, has_more, next_challenge, ...}
```

Over HTTP the same calls are `POST /rpc` bodies
(`{"method":"depinchallenge","params":[token, address, ms, sig, "receive"]}`).

The node's wallet helpers (`depinsignrequest`, `depinsignchallenge`,
`depindecrypt`, `depinsendmsg`, `depingetmsg`, `depinpoolpkey`) are never
exposed: they exist for `neurai-cli` on a node that holds the keys, and a
remote client implements the same signing and ECIES operations itself (a
JavaScript implementation lives in `@neuraiproject/neurai-depin-msg`).

**Abuse control** is split. The node limits challenges issued and messages
accepted per *address* and minute (`depinratelimit`, counting only requests
signed by that address). This service limits `depin*` requests per *origin
IP* and minute (`depin.rate_limit`, default 60) and blocks the IP for
`depin.ban_minutes` (default 10) when it goes over: HTTP answers `429` with
`Retry-After`, WSS answers `1007` with `retry_after_seconds`. One limiter is
shared by both transports, keyed by the IP derived through
`trusted_proxy_ips`, so switching transport does not reset the count. The
cached chain queries (`checkdepinvalidity`, `listdepinholders`,
`listdepinaddresses`, `getpubkey`) do not count. Nothing that comes from the
pool is cached: its state is off-chain and every reply is signed with the
pool key that is live right now.

**Upgrading from the protocol 1 gateway:** the DePIN port (19002/19102),
`depin_enabled`/`depin_url` in `config.json`, `NEURAI_DEPIN_ENABLED`/
`NEURAI_DEPIN_URL` on the proxy, `POST /depin`, `POST /depin/challenge` and
the WSS methods `depin.send_msg`, `depin.get_msg`, `depin.pool_pkey`,
`depin.pool_content` are gone. `depin.challenge`, `depin.receive_msg`,
`depin.submit_msg` and `depin.clear_msg` keep their names but take the
protocol 2 positional contracts above. `@neuraiproject/neurai-rpc` 0.6.0
removed its `/depin` TCP entry and `getDePinRPC`, and rejects JSON-RPC errors
that previously resolved `undefined`.

### Local stats endpoint (optional)

For ops/monitoring there is an optional HTTP endpoint that exposes a JSON
snapshot of sessions, subscriptions, chain tip, node health, ZMQ status and
RPC queue depth. **Disabled by default.** Activate with:

```json
"wss": {
  "stats_enabled": true,
  "stats_port": 19021
}
```

Or via env vars in Docker:

```yaml
PROXY_WSS_STATS_ENABLED: "true"
PROXY_WSS_STATS_PORT: "19021"
```

The server always binds to `127.0.0.1` regardless of any host setting — the
response is unauthenticated and reveals internal state, so it must never be
reachable from the public network. To consume it from the host, exec into
the container or add a localhost port mapping in your compose file.

```text
$ docker compose -f docker/testnet/docker-compose.yml exec rpc-proxy wget -qO- http://127.0.0.1:19021/stats
{"uptime_s":1234,"sessions":{"sessionCount":3},"subscriptions":{"distinctAddresses":7,...},
 "chain":{"tip":{"height":76820,...},...},"node":{"syncing":false,...},"zmq":{...}}
```

Only `GET /stats` is served; other paths return 404 and non-GET returns 405.

## Running locally (docker)

The docker stack runs a Neurai node and the wss server. There are two
self-contained compose files, one per network — they use distinct project
names, volumes and Docker networks so they can run side-by-side on the
same host. Test-only assets live under `tests/`.

```bash
# Deployment-specific values live in a .env next to each compose file
# (ignored by git, so it survives updates to the compose file)
cp docker/testnet/.env.example docker/testnet/.env   # then edit it
cp docker/mainnet/.env.example docker/mainnet/.env

# Testnet (build and start)
docker compose -f docker/testnet/docker-compose.yml up -d --build

# Mainnet (build and start)
docker compose -f docker/mainnet/docker-compose.yml up -d --build

# Run the Phase 1 + 2 acceptance suite (testnet only)
docker compose -f docker/testnet/docker-compose.yml -f tests/docker-compose.yml --profile test run --rm wss-test
```

`.env` holds what changes per deployment or is secret: RPC credentials and
port (one value feeds both the node and the proxy's upstream URL), the node
branch/image tag, the WSS auth token, the published port and bind interface,
the public HTTP endpoint, `PROXY_TRUSTED_PROXIES`, the `depin*` quota and, on
testnet, the DePIN pool token and wallet. Everything structural (indexes, ZMQ
wiring, paths, healthchecks) stays in the compose file. Every variable has the
same default in `.env.example` and in the compose file, so a stack starts
without a `.env`; the template is what gets updated when a variable appears.
On mainnet the RPC credentials in `.env` configure only the proxy and must
match `docker/mainnet/neurai.conf`, which the official image reads.
The acceptance suite picks `PROXY_WSS_PORT` and `PROXY_WSS_AUTH_TOKEN` from
the same testnet `.env`.

Defaults (all overridable in `.env`):

- Testnet WSS push listens on `127.0.0.1:19020/push`, mainnet on
  `127.0.0.1:19010/push`, both plain WS (TLS off). A host reverse proxy
  is expected to terminate TLS.
- Testnet auth token: `testnet-wss-token-do-not-use-in-production`.
  Mainnet ships with a `CHANGE-ME-mainnet-wss-token` placeholder —
  set `PROXY_WSS_AUTH_TOKEN` in `.env` before any internet-facing run.
- Testnet builds the node's `DePIN-Test` branch with DePIN protocol 2 enabled
  (`NEURAI_DEPIN_ENABLED=1`, `NEURAI_DEPIN_TOKEN`, wallet on); the proxy
  relays `depin*` through the RPC port with `PROXY_DEPIN_RATE_LIMIT=60` /
  `PROXY_DEPIN_BAN_MINUTES=10`. Mainnet runs the official `v1.0.6` image,
  which has no protocol 2: the node answers `depin*` with an error.
- ZMQ subscriber connects to `tcp://neuraid:28332` automatically inside
  the Docker network. The `zeromq` npm package is in `optionalDependencies`;
  if it can't install (rare, glibc x64 has prebuilt binaries), the proxy
  falls back to pure-polling and logs the reason.

## Deployment behind HestiaCP (or any nginx)

The proxy listens plain WS internally. Your nginx terminates TLS with a
Let's Encrypt cert and reverse-proxies to it.

**1. Add the (sub)domain in HestiaCP and enable Let's Encrypt** in the UI.

**2. Drop this snippet at** `/home/<user>/conf/web/<domain>/nginx.ssl.conf_wss`:

```nginx
location /push {
    proxy_pass http://127.0.0.1:19020/push;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 3600s;
}
```

**3. Restart web:**

```bash
v-restart-web
```

**4. Start the docker stack:**

```bash
# Testnet
docker compose -f docker/testnet/docker-compose.yml up -d
# or mainnet (port 19010 on the host instead of 19020)
docker compose -f docker/mainnet/docker-compose.yml up -d
```

The wallet then connects to `wss://<your-domain>/push`. HestiaCP handles
the cert and its 60-day renewal automatically.

If you put Cloudflare in front, use **DNS-only (grey cloud)** for this
subdomain: CF's 100-second idle WS timeout and CF-Connecting-IP rewrites
get in the way of persistent mobile-wallet connections.

### If you prefer the proxy to terminate TLS itself

Set in the proxy service environment:

```
PROXY_WSS_TLS_ENABLED=true
PROXY_WSS_SSL_CERT=/path/to/fullchain.pem
PROXY_WSS_SSL_KEY=/path/to/privkey.pem
```

The proxy watches both files and hot-reloads via `setSecureContext` when
they change (e.g. when a renewal writes new files), so external renewal
tools work without restarting the container.

For local dev only, `PROXY_WSS_AUTOGEN_CERT=true` generates a
self-signed cert in-container at startup.

## Project layout

```
.
├── index.js                  # entry point — validates root config, boots http + wss
├── getConfig.js              # config loader
├── getRPCNode.js             # Neurai node selection / health checks
├── rpcError.js               # normalizes @neuraiproject/neurai-rpc rejections
├── clientIp.js               # trusted_proxy_ips + X-Forwarded-For (HTTP and WSS)
├── depinRateLimit.js         # per-IP depin* quota shared by HTTP and WSS
├── wss/
│   ├── index.js              # config validation + start() + stats
│   ├── server.js             # https/http + ws upgrade, auth, rate limit
│   ├── protocol.js           # message framing, error codes, version constants
│   ├── methods.js            # core handlers (hello/ping/address.*/tx.broadcast)
│   ├── depin-methods.js      # depin.* → node RPC name translations (protocol 2)
│   ├── common.js             # MethodError, requireHello, requireSynced
│   ├── session.js            # per-connection state
│   ├── subscriptions.js      # address → sessions fan-out map
│   ├── notifications.js      # broadcast() + notifyAddress() helpers
│   ├── status.js             # stable status hash (fixed-order string)
│   ├── rpc.js                # separate PQueue for WSS-originated RPCs
│   ├── cursor.js             # opaque cursor codecs (history + utxo)
│   ├── keepalive.js          # WS-level ping/pong per session
│   ├── node-health.js        # getblockchaininfo poller + node.synced/syncing
│   ├── chain-state.js        # tip + Map<height,hash> + lastStatus per address
│   ├── chain-events.js       # onBlock/onRawTx orchestrator + warmup + reorg detection
│   ├── zmq-watcher.js        # resilient ZMQ subscriber (backoff + watchdog)
│   ├── poller.js             # bestblockhash + mempool polling fallback
│   └── prevout-cache.js      # bounded outpoint → address LRU for input resolution
├── docker/
│   ├── testnet/
│   │   └── docker-compose.yml    # testnet node + proxy stack
│   ├── mainnet/
│   │   └── docker-compose.yml    # mainnet node + proxy stack
│   ├── rpc-proxy/                # proxy image (shared)
│   └── node/                     # Neurai node image (shared)
└── tests/
    ├── docker-compose.yml    # E2E test compose overlay
    ├── unit/                  # Jest unit tests
    └── wss-test/             # E2E test client
```

## Tests

```bash
npm install
npm test                                                          # unit tests
docker compose -f docker/testnet/docker-compose.yml -f tests/docker-compose.yml --profile test run --rm wss-test   # E2E
```

## License

MIT — see [LICENSE](LICENSE).

## 1.1.1: exact amounts and paired wallet transports

The service uses `@neuraiproject/neurai-rpc` **0.6.1** and `lossless-json`
with a locked dependency tree. Address balances, UTXOs, history and mempool
are normalized and summed as `bigint`. Missing/invalid monetary data or an
upstream failure returns an error instead of a fabricated zero balance.
Asset amounts are raw integers at scale 1e8, regardless of asset `units`.
Asset mempool is not queried yet (`asset_mempool: false` in hello); asset
unconfirmed zeros are placeholders, not verified pending balances.

WebSocket still uses the HTTP subprotocol `wss` (plus `auth.<token>`).
Send `hello` with `protocol: "wss/2"` for `exact_amounts: true` and
`amounts: "string-sats"`. All monetary fields in subscribe, bulk subscribe,
get_state and address.changed are canonical integer strings, including zero
and negative deltas. Heights, indices, IDs and error codes keep their types.
Omitting the version selects `wss/1`, which deliberately converts amounts to
numbers and advertises `exact_amounts: false`. Unknown versions get application
error 1001, then WebSocket close 1002. A second hello cannot change the session.
A small legacy result does not prove that its upstream arithmetic was exact.

`POST /rpc` preserves numeric parameter tokens, including nested decimals and
large integers. Responses retain native RPC units: address balances are sats,
transaction output values are XNA, fee rates are XNA/kB. Values are safe numbers
or exact strings according to the RPC parser, **not uniformly string sats**.
`GET /rpc` remains 405. Cache keys preserve parameter types, and `gettxout`
bypasses the block cache because mempool spends change its result.

Configure root `service_id` as a stable identifier shared by WSS/HTTP and all
replicas of this logical service. Docker accepts `PROXY_SERVICE_ID` (default
`neurai-wallet-service`; set a distinct value for each deployment). Optional
root `network` (`mainnet`, `testnet`, `regtest`) and `genesis_hash` pin the node
pool. Nodes with a different validated chain cannot be selected for failover;
if none is available, requests fail. The service no longer silently selects an
unhealthy first node. `hello` and `GET /settings` expose actual node network,
genesis hash and service ID. Missing `service_id` is returned as null, so a
wallet cannot certify an unconfigured pair. Settings retains its existing
fields and adds `exact_amounts`, `amounts: "rpc-native-units"`, and
`numeric_encoding: "safe-number-or-string"`.

The wallet engine should use the explicitly configured companion HTTP `/rpc`
for full RPC semantics and signing scripts; WSS supplies state and pushes.
Before construction, check HTTP capabilities and chain identity against WSS
and the expected network. Never silently replace a custom endpoint with a
public RPC. Direct node RPC is a separate mode and does not require `/settings`.

On a failed initial subscription, only a new subscription is rolled back;
existing subscriptions remain. A failed refresh preserves the last status,
retries with bounded exponential backoff (1–30 seconds), and emits v2-only
`address.sync_status` with `{address, stale: true, reason: "upstream_unavailable"}`.
Recovery emits `stale: false, reason: "recovered"` even if the monetary hash is
unchanged. Clients keep their previous data visibly stale until recovery.
Unsubscribing the last client cancels pending retries. Session statistics now
include active and cumulative negotiations by version, unsafe v1 amount
conversions (both signs), and encoding/send failures.

The Docker proxy now builds the **local repository** with `npm ci --omit=dev`:

```sh
docker build -f docker/rpc-proxy/Dockerfile -t neurai-wallet-services:1.1.1 .
npm test -- --runInBand
```

Both supplied compose files use the repository root as build context. Builds
no longer clone GitHub or fall back from `npm ci` to `npm install`.

### Wallet construction using WSS only

The mobile client no longer needs an HTTP companion. After `hello` negotiates
`wss/2`, `hello.wallet_rpc` advertises `methods`, `amounts: "rpc-native-units"`
and `numeric_encoding: "safe-number-or-string"`. A client can request:

```json
{"id":2,"method":"rpc.call","params":{"method":"getaddressutxos","params":[{"addresses":["ADDRESS"]}]}}
```

The response has the node's native schema, including prevout scripts. Unsafe
integers and decimals remain exact strings; these are **native RPC units**,
not uniformly satoshis. Address-state messages still use `string-sats`.
The whitelist lives in `wss/wallet-rpc.js`; node wallet/private-key/admin
commands are excluded. Transaction construction and signing remain local;
broadcast uses the existing `tx.broadcast`. DePIN uses the existing `depin.*`
methods with `{args: [...]}`, preserving protocol-2 signatures and rate limits.
No HTTP server is required (`http.enabled: false` is supported).

Deploy this service extension before the WSS-only mobile client. Older services
can still provide balances, but clients must refuse unavailable construction
methods rather than contact an unrelated HTTP RPC. Existing v1 clients are
unchanged. This transport change does not activate PQ on mainnet.
