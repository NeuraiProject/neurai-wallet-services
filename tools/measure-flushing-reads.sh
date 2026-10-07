#!/usr/bin/env bash
# Measures the node reads that flushingReads.js limits, to settle its values
# (README, "Limit on reads that flush the node"). Run it against a synced
# mainnet node, ideally the v1.0.6 node the limit protects, at a quiet time:
# each call to these methods makes v1.0.6 write its whole state to disk.
#
# For every method it reports how long the call takes and, measured at the
# same time, the worst latency of getblockcount, which needs cs_main like block
# validation does: that is how long the read kept validation waiting.
#
# Usage:
#   RPC_URL=http://127.0.0.1:19001 RPC_USER=neurai RPC_PASSWORD=... \
#     tools/measure-flushing-reads.sh [--runs N] [--with-gettxoutsetinfo]
#
# gettxoutsetinfo scans the whole UTXO set (minutes on mainnet); it only runs
# with --with-gettxoutsetinfo. Needs curl and python3.
set -euo pipefail

RUNS=3
WITH_TXOUTSET=0
while [[ $# -gt 0 ]]; do
    case $1 in
        --runs) RUNS=$2; shift 2 ;;
        --with-gettxoutsetinfo) WITH_TXOUTSET=1; shift ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done
: "${RPC_URL:?set RPC_URL, e.g. http://127.0.0.1:19001}"
: "${RPC_USER:?set RPC_USER}"
: "${RPC_PASSWORD:?set RPC_PASSWORD}"

WORK=$(mktemp -d)
trap 'kill "${PROBE_PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

now_ms() { date +%s%3N; }

# rpc METHOD PARAMS_JSON: prints the JSON reply; fails on an RPC error.
rpc() {
    local reply
    reply=$(curl -sS --max-time 1800 --user "$RPC_USER:$RPC_PASSWORD" \
        -H 'content-type: text/plain;' \
        --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"measure\",\"method\":\"$1\",\"params\":$2}" "$RPC_URL")
    python3 -c 'import json,sys; r=json.loads(sys.argv[1]); sys.exit(0 if r.get("error") is None else 1)' "$reply" \
        || { echo "RPC $1 failed: $reply" >&2; return 1; }
    printf '%s' "$reply"
}

# First value of a JSON reply's result (list item or object key), or empty.
first_of() {
    python3 -c '
import json,sys
r = json.loads(sys.argv[1])["result"]
skip = sys.argv[2] if len(sys.argv) > 2 else ""
items = list(r) if isinstance(r, (list, dict)) else []
items = [i for i in items if not (skip and i.endswith(skip))]
print(items[0] if items else "")' "$@"
}

echo "Node: $(rpc getnetworkinfo '[]' | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["subversion"])'), height $(rpc getblockcount '[]' | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"])')"

# Parameters taken from the node itself.
ASSET=$(first_of "$(rpc listassets '["*", false, 50]')" '!')
ADDRESS=$([[ -n $ASSET ]] && first_of "$(rpc listaddressesbyasset "[\"$ASSET\"]")" || true)
TAG=$(first_of "$(rpc listassets '["#*", false, 10]')")
echo "Sample asset: ${ASSET:-none}, address: ${ADDRESS:-none}, tag: ${TAG:-none}"
echo

# getblockcount in a loop for the whole run: "start end" in ms per call.
probe() {
    while true; do
        local t0; t0=$(now_ms)
        rpc getblockcount '[]' > /dev/null || true
        echo "$t0 $(now_ms)"
        sleep 0.05
    done
}

# Idle baseline for the probe.
probe > "$WORK/baseline" & PROBE_PID=$!
sleep 3; kill $PROBE_PID; wait $PROBE_PID 2>/dev/null || true

touch "$WORK/calls"
probe > "$WORK/probe" & PROBE_PID=$!

measure() {
    local label=$1 method=$2 params=$3 i t0 t1
    for ((i = 0; i < RUNS; i++)); do
        t0=$(now_ms)
        if rpc "$method" "$params" > /dev/null; then
            t1=$(now_ms)
            echo "$label $t0 $t1" >> "$WORK/calls"
        fi
        sleep 1
    done
}

measure "listassets(*,50)"            listassets '["*", false, 50]'
measure "listassets(*,verbose,50)"    listassets '["*", true, 50]'
measure "listglobalrestrictions"      listglobalrestrictions '[]'
[[ -n $ASSET ]]   && measure "listaddressesbyasset"       listaddressesbyasset "[\"$ASSET\"]"
[[ -n $ADDRESS ]] && measure "listassetbalancesbyaddress" listassetbalancesbyaddress "[\"$ADDRESS\"]"
[[ -n $ADDRESS ]] && measure "listtagsforaddress"         listtagsforaddress "[\"$ADDRESS\"]"
[[ -n $ADDRESS ]] && measure "listaddressrestrictions"    listaddressrestrictions "[\"$ADDRESS\"]"
[[ -n $TAG ]]     && measure "listaddressesfortag"        listaddressesfortag "[\"$TAG\"]"
[[ $WITH_TXOUTSET == 1 ]] && measure "gettxoutsetinfo"    gettxoutsetinfo '[]'

kill $PROBE_PID; wait $PROBE_PID 2>/dev/null || true

python3 - "$WORK" <<'EOF'
import statistics, sys
work = sys.argv[1]
def pairs(name):
    with open(f"{work}/{name}") as f:
        return [tuple(map(int, line.split())) for line in f if line.strip()]
base = [e - s for s, e in pairs("baseline")] or [0]
probe = pairs("probe")
calls = {}
with open(f"{work}/calls") as f:
    for line in f:
        label, s, e = line.split()
        calls.setdefault(label, []).append((int(s), int(e)))
print(f"getblockcount when idle: median {statistics.median(base):.0f} ms, max {max(base)} ms\n")
print(f"{'method':30} {'runs':>4} {'min ms':>8} {'median':>8} {'max ms':>8} {'getblockcount max ms':>21}")
for label, spans in calls.items():
    took = [e - s for s, e in spans]
    # worst probe call that overlapped any run of this method
    worst = max([pe - ps for ps, pe in probe for s, e in spans if ps < e and pe > s] or [0])
    print(f"{label:30} {len(took):>4} {min(took):>8} {statistics.median(took):>8.0f} {max(took):>8} {worst:>21}")
EOF
