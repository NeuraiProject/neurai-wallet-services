// The reset testnet keeps the "test" chain name, ports and address prefixes of
// the previous testnet: only getblockhash(0) tells them apart. A service
// configured with `network: "testnet"` must refuse a node still on the old
// chain, using the genesis published by @neuraiproject/neurai-rpc.
const OLD_TESTNET_GENESIS = '0000009697907b2aa409d4b1f10da0fa14f5a52a2e31faf3886c0444b3c85e84';
const RESET_TESTNET_GENESIS = '0000008b384aeffecdab182575dc4e86c9f07f90318c65088532660ed9a8a021';

function loadNodes(config) {
  let nodes;
  jest.isolateModules(() => {
    jest.doMock('../../getConfig', () => () => config);
    jest.doMock('@neuraiproject/neurai-rpc', () => ({
      ...jest.requireActual('@neuraiproject/neurai-rpc'),
      getRPC: (_user, _password, url) => async (method) => {
        if (method === 'getblockchaininfo') return { chain: 'test' };
        if (method === 'getblockhash') return url === 'old' ? OLD_TESTNET_GENESIS : RESET_TESTNET_GENESIS;
        return 'c'.repeat(64);
      },
    }));
    nodes = require('../../getRPCNode');
  });
  return nodes;
}

beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); });

test('neurai-rpc publishes the reset testnet genesis', () => {
  expect(jest.requireActual('@neuraiproject/neurai-rpc').TESTNET_GENESIS_HASH).toBe(RESET_TESTNET_GENESIS);
});

test('network "testnet" alone pins the reset genesis and skips a node on the old testnet', async () => {
  const nodes = loadNodes({ service_id: 'test', network: 'testnet',
    nodes: [{ name: 'old', neurai_url: 'old' }, { name: 'reset', neurai_url: 'reset' }] });
  expect(nodes.expectedChain).toEqual({ network: 'testnet', genesis_hash: RESET_TESTNET_GENESIS });
  expect(await nodes.getIdentity()).toEqual({ service_id: 'test', network: 'testnet', genesis_hash: RESET_TESTNET_GENESIS });
  expect(nodes.getRPCNode().name).toBe('reset');
  const old = nodes.getNodes().find((n) => n.name === 'old');
  expect(old.active).toBe(false);
  expect(old.healthError).toMatch(/unexpected genesis/);
});

test('with only an old-testnet node the service refuses to answer', async () => {
  const nodes = loadNodes({ service_id: 'test', network: 'testnet', nodes: [{ name: 'old', neurai_url: 'old' }] });
  await expect(nodes.getIdentity()).rejects.toThrow(/No healthy node/);
});

test('a malformed genesis_hash aborts the start', () => {
  expect(() => loadNodes({ network: 'testnet', genesis_hash: 'not-a-hash', nodes: [] })).toThrow(/genesis_hash/);
});
