const { readIdentity, sameChain } = require('../../service-identity');
test('uses node chain and genesis, never a client supplied network', async () => {
  const rpc = jest.fn(async method => method === 'getblockhash' ? 'a'.repeat(64) : { chain: 'regtest' });
  expect(await readIdentity(rpc)).toEqual({ network: 'regtest', genesis_hash: 'a'.repeat(64) });
  expect(rpc).toHaveBeenCalledWith('getblockhash', [0]);
  expect(sameChain({ network: 'regtest', genesis_hash: 'a' }, { network: 'testnet', genesis_hash: 'a' })).toBe(false);
});
test('rejects missing identity', async () => { await expect(readIdentity(async () => null)).rejects.toThrow(); });
