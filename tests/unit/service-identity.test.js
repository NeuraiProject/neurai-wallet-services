const { readIdentity, sameChain } = require('../../service-identity');
test('uses node chain and genesis, never a client supplied network', async () => {
  const rpc = jest.fn(async method => method === 'getblockhash' ? 'a'.repeat(64) : { chain: 'regtest' });
  expect(await readIdentity(rpc)).toEqual({ network: 'regtest', genesis_hash: 'a'.repeat(64) });
  expect(rpc).toHaveBeenCalledWith('getblockhash', [0]);
  expect(sameChain({ network: 'regtest', genesis_hash: 'a' }, { network: 'testnet', genesis_hash: 'a' })).toBe(false);
});
test('rejects missing identity', async () => { await expect(readIdentity(async () => null)).rejects.toThrow(); });

describe('resolveExpectedChain', () => {
  const { resolveExpectedChain } = require('../../service-identity');
  const known = { mainnet: 'A'.repeat(64), testnet: 'b'.repeat(64) };
  test('an explicit genesis_hash wins and is normalized to lowercase', () => {
    expect(resolveExpectedChain({ network: 'testnet', genesis_hash: 'C'.repeat(64) }, known))
      .toEqual({ network: 'testnet', genesis_hash: 'c'.repeat(64) });
  });
  test('mainnet and testnet fall back to the published genesis', () => {
    expect(resolveExpectedChain({ network: 'testnet' }, known)).toEqual({ network: 'testnet', genesis_hash: 'b'.repeat(64) });
    expect(resolveExpectedChain({ network: 'mainnet', genesis_hash: '' }, known)).toEqual({ network: 'mainnet', genesis_hash: 'a'.repeat(64) });
  });
  test('regtest and an unset network have no default pin', () => {
    expect(resolveExpectedChain({ network: 'regtest' }, known)).toEqual({ network: 'regtest', genesis_hash: null });
    expect(resolveExpectedChain({ network: '' }, known)).toEqual({ network: null, genesis_hash: null });
  });
  test('rejects malformed values at startup', () => {
    expect(() => resolveExpectedChain({ network: 'test' }, known)).toThrow(/network/);
    expect(() => resolveExpectedChain({ genesis_hash: 'abc' }, known)).toThrow(/genesis_hash/);
    expect(() => resolveExpectedChain({ genesis_hash: 42 }, known)).toThrow(/genesis_hash/);
  });
});
