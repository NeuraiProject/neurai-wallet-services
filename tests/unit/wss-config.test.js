jest.mock('../../getRPCNode', () => ({ getRPCNode: () => ({ rpc: jest.fn() }), getNodes: () => [], getIdentity: async () => ({}) }));
const { fillDefaults } = require('../../wss');

// Reorg detection needs a stored hash for every height it walks back, so the
// block index must outgrow reorg_invalidate_depth (120 on the reset testnet).
test('block index covers twice the reorg depth, never fewer than 120 blocks', () => {
  expect(fillDefaults({}).reorg_invalidate_depth).toBe(60);
  expect(fillDefaults({}).block_index_size).toBe(120);
  expect(fillDefaults({ reorg_invalidate_depth: 120 }).block_index_size).toBe(240);
  expect(fillDefaults({ reorg_invalidate_depth: 120, block_index_size: 500 }).block_index_size).toBe(500);
  expect(fillDefaults({ block_index_size: 10 }).block_index_size).toBe(120);
});
