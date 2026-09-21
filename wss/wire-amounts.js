const { parseRpcJson, stringifyRpcJson } = require("@neuraiproject/neurai-rpc");
const { parseRawSats } = require('../amounts');

// Schema-directed copy: never mutate a shared notification or stringify unknown bigints.
function encodeMessage(message, method, protocol, onUnsafe = () => {}) {
  const amount = value => {
    const raw = parseRawSats(value);
    if (protocol === 'wss/2') return raw.toString();
    if (raw > BigInt(Number.MAX_SAFE_INTEGER) || raw < -BigInt(Number.MAX_SAFE_INTEGER)) onUnsafe();
    return Number(raw);
  };
  const balance = value => value == null ? value : Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key, ['confirmed', 'unconfirmed'].includes(key) ? amount(v) : v]),
  );
  const state = value => {
    if (!value || value.error) return value;
    const out = { ...value };
    if (out.balance) out.balance = balance(out.balance);
    if (out.assets) out.assets = Object.fromEntries(Object.entries(out.assets).map(([name, v]) => [name, balance(v)]));
    for (const key of ['mempool', 'history', 'utxos', 'asset_utxos']) {
      if (out[key]) out[key] = out[key].map(row => ({ ...row, satoshis: amount(row.satoshis) }));
    }
    return out;
  };
  let out = { ...message };
  if (!out.error) {
    const kind = message.method || method;
    if (kind === 'rpc.call') out.result = parseRpcJson(stringifyRpcJson(out.result));
    else if (kind === 'address.changed') out.params = state(out.params);
    else if (kind === 'address.subscribe' || kind === 'address.get_state') out.result = state(out.result);
    else if (kind === 'address.subscribe.bulk' && out.result) {
      out.result = { ...out.result, results: out.result.results.map(state) };
    }
  }
  // A bigint outside the schema is a contract error, not a new implicit wire field.
  return JSON.stringify(out);
}
module.exports = { encodeMessage };
