jest.mock('../../getConfig', () => () => ({ service_id: 'test', network: 'regtest', genesis_hash: 'a'.repeat(64),
  nodes: [{ name: 'wrong', neurai_url: 'wrong' }, { name: 'right', neurai_url: 'right' }] }));
jest.mock('@neuraiproject/neurai-rpc', () => ({ getRPC: (_user, _password, url) => async method => {
  if (method === 'getblockchaininfo') return { chain: 'regtest' };
  if (method === 'getblockhash') return (url === 'right' ? 'a' : 'b').repeat(64);
  return 'c'.repeat(64);
} }));
const nodes = require('../../getRPCNode');
test('startup waits for identity and a wrong-chain node is never a fallback', async () => {
  expect(await nodes.getIdentity()).toEqual({ service_id: 'test', network: 'regtest', genesis_hash: 'a'.repeat(64) });
  expect(nodes.getRPCNode().name).toBe('right');
  expect(nodes.getNodes().find(n => n.name === 'wrong').active).toBe(false);
});
