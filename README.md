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
  They can also run alone, without WSS, as a drop-in for the retired
  neurai-rpc-proxy.
  (`POST /depin` and `POST /depin/challenge` belonged to DePIN protocol 1 and
  answer `410 Gone` for one release.)
  Public HTTP calls are whitelisted, rate-limited and queued behind WSS RPC work.

### Optional public HTTP RPC

With WSS enabled, HTTP shares the WSS listener (port, host and TLS). With
`wss.enabled: false` the HTTP API runs alone — see
[HTTP without WSS](#http-without-wss). Leave HTTP disabled unless the listener
is intended to publish the RPC API.

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
  of the last `max(120, 2 × reorg_invalidate_depth)` blocks (120 on mainnet,
  240 on the reset testnet), pre-populated at startup from the chain.
- Node-health monitoring: a 10s poll of `getblockchaininfo` gates methods
  that depend on a synced chain and emits `node.synced` / `node.syncing`
  on transitions.
- DePIN protocol 2 relay: `depin.*` over WSS and `depin*` over `POST /rpc`,
  with one per-IP quota shared by both transports.
- Docker setup for the testnet service stack, with tests kept under `tests/`.

### Trusted HTTP clients

Backends that call `/rpc` from one address — an explorer, a faucet, a swap,
an indexer — exhaust the public per-IP budget
(`max_requests_per_second_per_ip`, 20 by default) at once. List them in
`http.clients`:

```json
"clients": [
  { "name": "explorer", "key": "<32+ random characters>", "max_requests_per_second": 200, "extra_methods": ["gettxoutsetinfo"] },
  { "name": "internal", "ips": ["172.16.0.0/12"] }
]
```

- A request belongs to a client when it carries the client's `key` or comes
  from one of its `ips` (addresses or CIDR ranges). The client IP honours
  `X-Forwarded-For` only from `trusted_proxy_ips`.
- The key is the password of HTTP Basic auth, which is what
  `@neuraiproject/neurai-rpc`'s `getRPC(username, password, url)` already
  sends, so a client only changes its configuration. `Authorization: Bearer
  <key>` works too. The username is ignored; keys need at least 16 characters.
- Credentials that match no key are not refused: clients that send
  `anonymous` stay on the public tier. A recognised request gets an
  `x-rpc-client: <name>` response header, so a mistyped key is easy to spot.
- A client spends its own budget (`max_requests_per_second`, none when unset)
  instead of the per-IP and global public ones, is not refused by
  `max_queue_size`, and goes ahead of waiting public requests. WSS work still
  comes first in the node queue, and the `depin*` per-IP quota applies to
  everyone.
- In Docker, put the JSON array in `PROXY_HTTP_CLIENTS` in `.env`, wrapped in
  single quotes.

### Opt-in methods and `getnetworkinfo`

`gettxoutsetinfo`, `getmininginfo`, `getconnectioncount` and `getnettotals`
are read-only but stay out of the public whitelist: they are slow or only
useful to operators. Open them for every client with `http.extra_methods`
(`PROXY_HTTP_EXTRA_METHODS`, comma separated) or for one client with its
`extra_methods`. Any other name stops the service at start. `gettxoutsetinfo`
scans the whole UTXO set: it is cached per block, but while it runs it holds
one slot of the node queue that WSS shares, so grant it to the client that
needs it rather than to everyone.

`getnetworkinfo` is public and reduced to `version`, `subversion`,
`protocolversion`, `localservices`, `localrelay`, `timeoffset`,
`networkactive`, `connections`, `relayfee`, `incrementalfee` and `warnings`.
`networks` (configured proxies, such as a Tor endpoint) and `localaddresses`
(the node's public addresses) never leave the service, and a field a future
node adds stays out until it is reviewed. WSS `rpc.call` returns the same
reduced result, and `hello.wallet_rpc.methods` lists it.

### HTTP without WSS

With `http.enabled: true` and `wss.enabled: false` the service serves only
the HTTP API: a drop-in for the retired `neurai-rpc-proxy`, with the same
routes (`POST /rpc`, `GET /settings`, `/whitelist`, `/getCache`) and error
bodies. It needs no auth token and no ZMQ. The listener comes from the
`http` block:

```json
"http": { "enabled": true, "host": "0.0.0.0", "port": 19020, "tls_enabled": false, "tip_poll_interval_ms": 1000 }
```

As for WSS, `tls_enabled` defaults to `true`, and then `ssl_cert` and
`ssl_key` are required. The per-block cache is cleared from a
`getbestblockhash` poll every `tip_poll_interval_ms` (1 s by default, at least
500); the mempool is not polled. With WSS enabled these keys are ignored. In
Docker, set `PROXY_WSS_ENABLED=false` in `.env`: the listener keeps
`PROXY_WSS_PORT`, `PROXY_BIND`, `PROXY_WSS_TLS_ENABLED` and the certificate
settings.

### Time limit for node calls

`@neuraiproject/neurai-rpc` gives its requests no time limit, so a node that
stopped answering used to keep each call pending, holding a slot of the node
queue that HTTP and WSS share, and a hung health check blocked every request
waiting for a healthy node. Every call to a node, health checks included, now
has a limit: `rpc_timeout_ms` at the root of `config.json` (30 s by default) and
`rpc_method_timeouts_ms` for single methods (`gettxoutsetinfo` gets 600000
unless overridden). A call over the limit is an upstream failure: HTTP answers
`502` with `upstream RPC unavailable`, WSS `1005`, and the log names the method
(`node timeout: getblock timed out after 30000 ms`). The request may still
finish on the node; only the caller is released. In Docker: `PROXY_RPC_TIMEOUT_MS`
and `PROXY_RPC_METHOD_TIMEOUTS_MS` (a JSON object, in single quotes in `.env`).

### Limit on reads that flush the node (mainnet)

Mainnet runs node v1.0.6, which writes its whole state to disk on every call
to `listassets`, `listaddressesbyasset`, `listassetbalancesbyaddress`,
`listtagsforaddress`, `listaddressesfortag`, `listaddressrestrictions`,
`listglobalrestrictions` and `gettxoutsetinfo`, holding `cs_main`, the lock
block validation needs. A burst of them with varied parameters (so the
per-block cache does not help) stalls the node.

`flushing_reads` at the root of `config.json` limits how many of these calls
reach the node, for HTTP and WSS `rpc.call` together (not per IP):

- `per_second` (default 2) and `burst` (default 20): a token bucket, not a
  cap per second. After a quiet spell the stored `burst` calls can go through
  within moments (at most `max_in_flight` at a time); after that, calls come
  back at `per_second`;
- `max_in_flight` (default 4): how many of these calls the service has
  outstanding at once. 4 is the node queue's own limit, so by default nothing
  is refused for concurrency: the explorer asks for three of these at once on
  an asset page, and `gettxoutsetinfo` holds its slot for minutes on mainnet
  (its scan runs after the flush, without the lock). A call that runs past its
  [time limit](#time-limit-for-node-calls) frees its slot although the node may
  still be working on it, so for a while the node can have more than this.

The check runs in the node queue right before the call is sent: a reply from
the HTTP cache costs nothing, and a request waiting in a queue spends nothing
until its turn. Trusted clients count too, though they keep their priority.
A refused call gets HTTP `503` with `Retry-After`, or WSS `1007` with
`retry_after_seconds`; it is not an upstream failure. `per_second: 0` turns
both limits off; without the section, the defaults apply.

The defaults are provisional until measured against a synced mainnet node:
a regtest burst shows that the limiter works as described, not that a burst
of 20 suits mainnet.
The testnet compose turns the limit off: its node flushes these reads at most
once per chain state. Remove the limit once mainnet runs a node release
with that fix (DePIN-Test `b96c49f` and `a9f7ca5` for the asset reads,
`1e32522` for `gettxoutsetinfo`). In Docker: `PROXY_FLUSHING_READS_PER_SECOND`,
`PROXY_FLUSHING_READS_BURST` and `PROXY_FLUSHING_READS_MAX_IN_FLIGHT`.

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
Application-level version (reported in `hello`): `wss/2`. New clients must
ask for it explicitly.

`wss/1` is **deprecated** and kept only so released wallet builds keep
working; it will be retired. It sends amounts as JS numbers (lossy above 2^53
raw units, about 90,071,992.55 XNA or asset units), has no `rpc.call` and gets
no `address.sync_status`. It is still the default when `hello` omits
`protocol`, and its `hello` carries a `deprecated` notice. Retiring it will
make `wss/2` the default and refuse `wss/1` with `1001`.

### Handshake

```json
// client → server (over WSS, after a 101 upgrade)
{ "id": 1, "method": "hello",
  "params": { "client": "my-wallet", "version": "0.1.0",
              "network": "mainnet", "protocol": "wss/2" } }

// server → client
{ "id": 1, "result": {
    "server": "neurai-wallet-services",
    "protocol": "wss/2",
    "exact_amounts": true,
    "amounts": "string-sats",
    "protocol_min": "wss/1",
    "protocol_max": "wss/2",
    "network": "mainnet",
    "genesis_hash": "00000044d33c0c0ba019be5c0249730424a69cb4c222153322f68c6104484806",
    "service_id": "neurai-mainnet-wallet-service",
    "tip_height": 75880,
    "tip_hash": "000048f1998e6f45...",
    "syncing": false,
    "verification_progress": 1.0,
    "blocks": 75880,
    "headers": 75880
  } }
```

`syncing` and friends let the wallet show a progress UI before subscribing.
With `wss/2` every amount in address messages (`balance`, `assets`,
`history`, `utxos`, `asset_utxos`, `mempool`) is a canonical integer string
of raw units (`"100000000"` = 1 XNA or 1 asset unit), including `"0"`, small
values and negative deltas; parse them as `BigInt`. The examples below use
`wss/2`; the deprecated `wss/1` sends the same fields as JS numbers.
`network` and `genesis_hash` are read from the node, never from the client.
`genesis_hash` is what identifies the chain: every Neurai testnet reports
`network: "testnet"`.

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

#### Address types

`address.*` methods accept every address the node validates (the check is
the node's `validateaddress`, and its address index covers all of them):
legacy P2PKH (`N…`/`t…`), generic AuthScript witness v1 (`nc1p…`/`tnc1p…`),
post-quantum witness v2 (`pq1z…`/`tpq1z…`) and strict ECDSA witness v3
(`nq1r…`/`tnq1r…`). The node accepts only those HRP/version pairs, so a
`tnq1p…` address (HRP `tnq` with witness v1) is `invalid address` (`1003`). Nodes that predate these address types report them as invalid.
DePIN messaging works with legacy P2PKH addresses only; `getpubkey` also
answers for AuthScript v1 and rejects v2/v3.

#### `address.get_state` and pagination

`address.get_state` returns the full per-address snapshot the wallet needs
to render a screen: balance, mempool entries, recent history, and UTXOs.
History is **always paginated** using a composite opaque cursor (`height:tx_index:asset`):

```json
// request
{ "id": 4, "method": "address.get_state",
  "params": {
    "address": "tnq1r0c9zl485wv7wcfutxfyv8k2ltpfk5hdyp3s7g4chlphx8d2m6npqwxvjya",
    "include_history": true,
    "include_utxos": true,
    "limit": 100,
    "cursor": null
  } }

// response
{ "id": 4, "result": {
    "address": "...",
    "status": "d9385809c15265e9...",
    "balance": { "confirmed": "500000000000", "unconfirmed": "0" },
    "mempool": [ { "txid": "...", "satoshis": "100000", "prev_txid": null, "prev_vout": null } ],
    "history": [ { "txid": "471e4d...", "height": 75841, "tx_index": 1, "asset": "XNA", "satoshis": "500000000000" } ],
    "utxos":   [ { "txid": "...", "vout": 0, "satoshis": "500000000000", "height": 75841 } ],
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
    "TRON":  { "confirmed": "100700000000", "unconfirmed": "0" },
    "TRON!": { "confirmed": "100000000",    "unconfirmed": "0" }
  } }

// address.get_state additionally returns:
{ "...": "...",
  "assets": { "TRON": {...}, ... },
  "asset_utxos": [
    { "txid": "...", "vout": 1, "satoshis": "42000000000", "height": 13973, "asset": "TRON" }
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
    "address": "tnq1r0c9zl485wv7wcfutxfyv8k2ltpfk5hdyp3s7g4chlphx8d2m6npqwxvjya",
    "status": "d9385809c15265e9...",
    "reason": "block",
    "height": 75841,
    "balance": { "confirmed": "500000000000", "unconfirmed": "0" },
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
$ docker compose -f docker/testnet/docker-compose.yml exec wallet-services wget -qO- http://127.0.0.1:19021/stats
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
branch and source commit (testnet) or image tag (mainnet), the WSS auth token,
the published port and bind interface, the public HTTP endpoint,
`PROXY_TRUSTED_PROXIES`, the `depin*` quota, the service mode
(`PROXY_WSS_ENABLED`), the HTTP opt-in methods and trusted clients and, on
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
- Testnet builds the node's `DePIN-Test` branch at `NODE_SOURCE_COMMIT`
  (default `1e325225c65a1de4905147062fed1dd25d9d61c6`, the reviewed C6-capable
  node with the database read fixes) with DePIN protocol 2 enabled
  (`NEURAI_DEPIN_ENABLED=1`, `NEURAI_DEPIN_TOKEN`, wallet on); the proxy
  relays `depin*` through the RPC port with `PROXY_DEPIN_RATE_LIMIT=60` /
  `PROXY_DEPIN_BAN_MINUTES=10`. Mainnet runs the official `v1.0.6` image,
  which has no protocol 2: the node answers `depin*` with an error.
- ZMQ subscriber connects to `tcp://neuraid:28332` automatically inside
  the Docker network. The `zeromq` npm package is in `optionalDependencies`;
  if it can't install (rare, glibc x64 has prebuilt binaries), the proxy
  falls back to pure-polling and logs the reason.

- Each proxy is pinned to its chain: `NEURAI_NETWORK` and
  `NEURAI_EXPECTED_GENESIS` in the compose file become the root `network` and
  `genesis_hash` of the generated `config.json`. A node with another genesis
  is never used; `GET /getCache` lists it with `healthError: "unexpected
  genesis …"`. Testnet also sets `PROXY_WSS_REORG_INVALIDATE_DEPTH=120` (see
  [1.2.0](#120-reset-testnet)).
- The node image records its source: `docker image inspect` shows the
  `org.opencontainers.image.revision` label, and
  `docker compose exec neuraid cat /usr/local/share/neurai/source-commit`
  prints the full SHA it was built from. `neuraid -version` shows the short
  SHA with a `-dirty` suffix because `autogen.sh` regenerates build files that
  the node repository tracks; that suffix does not mean modified sources.

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
├── service-identity.js       # node chain identity (network + genesis) and the expected-chain pin
├── rpcError.js               # normalizes @neuraiproject/neurai-rpc rejections
├── rpcTimeout.js             # time limit for every node call (rpc_timeout_ms)
├── clientIp.js               # trusted_proxy_ips + X-Forwarded-For (HTTP and WSS)
├── depinRateLimit.js         # per-IP depin* quota shared by HTTP and WSS
├── flushingReads.js          # service-wide limit on reads that flush the node (mainnet v1.0.6)
├── rpcResults.js             # results reduced before they leave (getnetworkinfo), HTTP and WSS
├── http/
│   ├── index.js              # POST /rpc: whitelist, rate limits, queue, per-block cache
│   ├── router.js             # routes, JSON body parsing, CORS
│   ├── clients.js            # trusted clients: key (Basic/Bearer) or IP/CIDR
│   ├── whitelist.js          # public methods + opt-in EXTRA_METHODS
│   ├── cache-service.js      # methods cached until the next block
│   ├── standalone.js         # HTTP listener without WSS (tip poll clears the cache)
│   └── static.js             # www/ files
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
│   ├── wallet-services/          # service image (shared)
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

The E2E suite checks that `hello` reports the reset-testnet genesis
(`TEST_EXPECTED_GENESIS`, empty to skip). The happy-path address and asset
tests need funded addresses on the reset testnet: set `TEST_ADDRESS`,
`TEST_ASSET_ADDRESS` and `TEST_ASSET_NAME` in `docker/testnet/.env`; they are
skipped while empty.

## License

MIT — see [LICENSE](LICENSE).

## 1.1.1: exact amounts and paired wallet transports

The service uses `@neuraiproject/neurai-rpc` (**0.6.1** in 1.1.1, **0.7.0**
since [1.2.0](#120-reset-testnet)) and `lossless-json`
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
numbers and advertises `exact_amounts: false` (deprecated since
[1.2.0](#120-reset-testnet)). Unknown versions get application error 1001,
then WebSocket close 1002. A second hello cannot change the session.
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
conversions (both signs), and encoding/send failures. Watch `negotiations`
and `unsafe_v1_amounts` to decide when `wss/1` can be retired.

The Docker proxy now builds the **local repository** with `npm ci --omit=dev`:

```sh
docker build -f docker/wallet-services/Dockerfile -t neurai-wallet-services:1.1.1 .
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
methods rather than contact an unrelated HTTP RPC. Existing v1 clients were
unchanged in 1.1.1. This transport change does not activate PQ on mainnet.

## 1.2.0: reset testnet

Neurai reset its testnet on 2026-09-26 (node `DePIN-Test`, commit
`0fe5a74943210508ec3be34c78e0f9192b7fefec`). The new chain keeps the chain
name `test`, ports `19100`/`19101`, magic and address prefixes of the previous
one; its genesis is
`0000008b384aeffecdab182575dc4e86c9f07f90318c65088532660ed9a8a021`. From
height 10 blocks come every 30 s, reorgs may reach 120 blocks (NIP-028), the
asset marker switches from `rvn` to `xna` and the three AuthScript families
(v1 generic, v2 PQ, v3 ECDSA) activate. Mainnet is unchanged.

What changed in the service:

- `@neuraiproject/neurai-rpc` **0.7.0**. It exports `MAINNET_GENESIS_HASH` and
  `TESTNET_GENESIS_HASH`.
- Chain pin: root `network: "mainnet"` or `"testnet"` now also pins the
  genesis published by neurai-rpc, unless `genesis_hash` overrides it. A node
  on another chain (for example one not rebuilt for the reset) is excluded
  and, with no other node, every request fails instead of serving the wrong
  chain. A malformed `network` or
  `genesis_hash` aborts the start. Regtest needs an explicit `genesis_hash`,
  and with neither key set the first healthy node still defines the chain (a
  warning is logged). Excluded nodes carry a `healthError` in `GET /getCache`
  and on the statistics page, and each exclusion is logged once.
- Reorg window: the block index keeps `max(120, 2 × reorg_invalidate_depth)`
  hashes (it was fixed at 120, and `block_index_size` had no effect). Set
  `reorg_invalidate_depth: 120` on the reset testnet, as `config.example.json`
  and the testnet compose do; keep 60 on mainnet.
- Docker: the testnet node is built at `NODE_SOURCE_COMMIT`, and both
  compose files pin network and genesis (see
  [Running locally](#running-locally-docker)). Without the commit pin, a
  rebuild could reuse a cached clone of `DePIN-Test` from before the reset.
  When a source host is down, `depends/` now falls back to
  `bitcoincore.org/depends-sources` and still checks each file's pinned
  sha256. samba.org, the only source of `ccache-3.3.4`, was unreachable and
  broke the build.
- **`wss/1` deprecated.** It works exactly as in 1.1.1 so released wallets
  keep connecting, and its `hello` now includes a `deprecated` notice. New and
  updated clients must use `wss/2`: exact string amounts, `rpc.call` and
  `address.sync_status`. `wss/1` will be retired in a later release, once
  `negotiations` shows no `wss/1` sessions; the default for a `hello` without
  `protocol` will then become `wss/2`.
- The HTTP whitelist documents the new node RPCs (`getblockdeltas`,
  `opendepin`/`closedepin`/`sealdepin`, PQ wallet commands, wallet
  passphrase commands); none of them is exposed.

**Deploying.** The reset testnet is a new chain with no users to carry over,
so the node starts on an empty volume. A data directory from the previous
testnet is refused ("Incorrect or no genesis block found") and holds nothing
worth keeping; this service keeps no state on disk.

```sh
docker compose -f docker/testnet/docker-compose.yml down -v   # deletes the old node volume
docker compose -f docker/testnet/docker-compose.yml up -d --build
```

The node creates a fresh dedicated wallet and, from it, a new DePIN pool key
that clients pin on first use; back that wallet up from now on (see
`NEURAI_DEPIN_WALLET`). Before routing traffic, check on the node itself that
`neurai-cli -datadir=/data getblockhash 0` prints the genesis above and that
`/usr/local/share/neurai/source-commit` matches `NODE_SOURCE_COMMIT`.
Through the service `getnetworkinfo` is reduced and does not show the source
commit.

### Privacy-pool RPC over HTTP and WSS

HTTP `/rpc` and WSS `rpc.call` expose the pool's read, scan and preflight
queries. WSS now advertises `getbestblockhash`, `getblock`, `getspentinfo`,
`getrawmempool` and `decoderawtransaction` in `hello.wallet_rpc.methods`.
The service relays native schemas, scripts, witnesses and exact amounts;
it never decrypts private notes or builds proofs. `address.get_state` reports
transparent address data, not a user's private balance.

`gettxout` and `getspentinfo` bypass HTTP caching because their results can
change with the mempool before a new block arrives. `chain.tip` and
`chain.reorg` can trigger a client refresh, but clients must still check the
pinned instance and their scan checkpoints, especially after reconnection.

For `@neuraiproject/neurai-privacy`, use its `createWalletServiceRpc` client
adapter with a negotiated `wss/2` handshake and an independently pinned
genesis. The application supplies a correlated `request(method, params)`
function that resolves the complete `{id, result}` or `{id, error}` wire
reply and rejects on timeout/disconnection. The adapter maps the
one-argument `sendrawtransaction(raw)` to `tx.broadcast({rawtx})`, unwraps
`{txid}`, and maps the original negative `node_code` to `Error.code`.
It never retries a publication or switches endpoints. Recreate it after
each connection and handshake. Additional `sendrawtransaction` arguments
are rejected rather than silently ignored.

With `wss/2`, both `rpc.call` and `tx.broadcast` report node errors as
`{code: 1005, node_code: <negative-code-or-null>, message}`. This keeps a
missing transaction (`node_code: -5`) distinct from a transport or upstream
failure. The released `wss/1` broadcast error shape is unchanged.

The testnet compose now builds the C6-capable commit shown above, with C6
active from block 100. If an existing `.env` still sets an older
`NODE_SOURCE_COMMIT`, update that value before rebuilding; changing the
template or compose default cannot override it. Check
`getblockchaininfo.zk_portable_tree.active_for_next_block` and ensure every
failover node has the required validation rules, history and indexes.
Same genesis alone does not prove pool capability. This does not activate
privacy profiles on mainnet or change either network's ports.

## Unreleased: HTTP API without neurai-rpc-proxy

Everything the retired `neurai-rpc-proxy` offered is now here, so the services
still pointed at it can move:

- [HTTP without WSS](#http-without-wss): `wss.enabled: false` serves the HTTP
  API alone (`PROXY_WSS_ENABLED=false` in Docker), with no auth token or ZMQ.
- [Trusted HTTP clients](#trusted-http-clients): a key (Basic auth password
  or Bearer token) or an address range gives a backend its own budget,
  priority over public requests and optional extra methods
  (`PROXY_HTTP_CLIENTS`).
- [Opt-in methods](#opt-in-methods-and-getnetworkinfo): `gettxoutsetinfo`,
  `getmininginfo`, `getconnectioncount` and `getnettotals`, for everyone
  (`PROXY_HTTP_EXTRA_METHODS`) or per client. Unknown names stop the start.
- `getnetworkinfo` is exposed over HTTP and WSS `rpc.call`, without
  `networks` and `localaddresses`. The web wallet reads its `relayfee`.
- [Time limit for node calls](#time-limit-for-node-calls): 30 s by default,
  10 min for `gettxoutsetinfo`, configurable per method.
- [Limit on reads that flush the node](#limit-on-reads-that-flush-the-node-mainnet):
  mainnet's v1.0.6 node writes its state to disk on every asset or
  restricted-asset list and `gettxoutsetinfo`; uncached calls to those draw
  from a bucket of 20 that refills at 2 per second, with 4 outstanding at
  most. Off in the testnet compose.

Moving a client from the proxy:

- Routes, request format and the `Not in whitelist` error are unchanged.
  Node JSON-RPC errors are `{error: {message, code}}`; the proxy nested the
  library's rejection one level deeper (`{error: {error: {message, code}}}`).
- The proxy had no general rate limit. A backend that calls from one address
  needs a [trusted client](#trusted-http-clients) entry; its existing RPC
  password becomes the key.
- `signmessagewithprivkey` stays out: clients sign locally.
- DePIN protocol 2 goes through `POST /rpc`, so one service per network can
  serve the hosts that used to point at separate DePIN proxies.

Deploying this version: the Compose service is now `wallet-services` (it was
`rpc-proxy`) and its image is built from `docker/wallet-services/`. The first
`up` after updating must remove the old container, which still holds the
published port:

```sh
docker compose -f docker/testnet/docker-compose.yml up -d --build --remove-orphans
```

Use `docker compose exec wallet-services …` from now on. The host reverse
proxy needs no change: it points at the published port, not at the container.
