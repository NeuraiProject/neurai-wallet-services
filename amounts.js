// Raw satoshis, including signed deltas. Assets use the same 1e8 raw scale.
const MAX_DIGITS = 80;
function parseRawSats(value) {
  if (typeof value === 'bigint') {
    if (value.toString().replace('-', '').length <= MAX_DIGITS) return value;
  } else if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return BigInt(value);
  } else if (typeof value === 'string' && value.length <= MAX_DIGITS + (value.startsWith("-") ? 1 : 0) && /^(0|-?[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  throw new TypeError('Invalid raw amount: expected a bounded canonical integer');
}
function nonNegativeSats(value) {
  const raw = parseRawSats(value);
  if (raw < 0n) throw new RangeError('Negative balance or UTXO');
  return raw;
}
module.exports = { parseRawSats, nonNegativeSats };
