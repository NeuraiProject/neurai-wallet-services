const { parseRawSats, nonNegativeSats } = require('../../amounts');
test.each([0, 0n, '0', '-9007199254740993', '10000000000000001', Number.MAX_SAFE_INTEGER])('preserves %s', value => {
  expect(parseRawSats(value)).toBe(BigInt(value));
});
test.each([null, undefined, NaN, Infinity, 1.1, 9007199254740992, '01', '-0', '1e3', '', '1'.repeat(81), { isLosslessNumber: true, value: '1' }])('rejects malformed amount %s', value => {
  expect(() => parseRawSats(value)).toThrow();
});
test('range depends on domain, not the native supply for assets', () => {
  expect(() => nonNegativeSats(-1)).toThrow();
  expect(nonNegativeSats('999999999999999999999')).toBe(999999999999999999999n);
});
