jest.mock('../../wss/rpc', () => ({ callRPC: jest.fn() }));
jest.mock('../../wss/node-health', () => ({ isSyncing: () => false }));
const { callRPC } = require('../../wss/rpc');
const { handle, capability } = require('../../wss/wallet-rpc');
const { encodeMessage } = require('../../wss/wire-amounts');
const session = { helloDone: true, protocol: 'wss/2' };
beforeEach(() => callRPC.mockReset());
test('exact raw and decimal values survive the WSS codec, including scripts', async () => {
  const result = { satoshis: '10000000000000001', value: '100000000.00000001', script: '5120', delta: -10000000000000001n };
  callRPC.mockResolvedValue(result);
  const reply = await handle(session, { method: 'getaddressutxos', params: [{ addresses: ['address'] }] });
  const wire = JSON.parse(encodeMessage({ id: 1, result: reply }, 'rpc.call', 'wss/2'));
  expect(wire.result).toEqual({ ...result, delta: '-10000000000000001' });
  expect(capability.numeric_encoding).toBe('safe-number-or-string');
});
test.each(['dumpprivkey', 'stop', 'sendtoaddress', 'signrawtransaction', 'createrawtransaction', 'sendrawtransaction'])(
  'does not expose node wallet/admin command %s', async method => {
    await expect(handle(session, { method, params: [] })).rejects.toThrow('Unsupported');
    expect(callRPC).not.toHaveBeenCalled();
  },
);
test.each([{ helloDone: false, protocol: 'wss/2' }, { helloDone: true, protocol: 'wss/1' }])('requires exact handshake %s', async state => {
  await expect(handle(state, { method: 'gettxout', params: [] })).rejects.toThrow();
  expect(callRPC).not.toHaveBeenCalled();
});
test('rejects already unsafe upstream numbers', () => {
  expect(() => encodeMessage({ id: 1, result: { satoshis: Number('10000000000000001') } }, 'rpc.call', 'wss/2')).toThrow();
});
test('preserves node rejection without exposing upstream credentials', async () => {
  callRPC.mockRejectedValue({ error: { code: -5, message: 'Invalid address' } });
  await expect(handle(session, { method: 'getaddressutxos', params: [] })).rejects.toMatchObject({ message: 'Invalid address' });
});

test.each(['getbestblockhash', 'getblock', 'getspentinfo', 'getrawmempool', 'decoderawtransaction'])(
  'advertises and forwards pool query %s without changing its parameters', async method => {
    const params = [{ txid: 'a'.repeat(64), index: 0 }, 2];
    const result = { script: '5120', witness: ['10', 'ab'], zk_portable_tree: { active_for_next_block: true } };
    callRPC.mockResolvedValue(result);
    expect(capability.methods).toContain(method);
    expect(await handle(session, { method, params })).toBe(result);
    expect(callRPC).toHaveBeenCalledWith(method, params);
  },
);

test('missing transaction keeps the node code distinct from the WSS service code', async () => {
  callRPC.mockRejectedValue({ error: { code: -5, message: 'No such transaction' } });
  await expect(handle(session, { method: 'getrawtransaction', params: ['a'.repeat(64), true] }))
    .rejects.toMatchObject({ code: 1005, extra: { node_code: -5 } });
});

test('advertises getnetworkinfo without proxies or local addresses', async () => {
  callRPC.mockResolvedValue({
    version: 1000600, relayfee: 0.01, incrementalfee: 0.00001,
    networks: [{ name: 'onion', proxy: '127.0.0.1:9050' }],
    localaddresses: [{ address: '203.0.113.9', port: 19000, score: 4 }],
  });
  expect(capability.methods).toContain('getnetworkinfo');
  expect(await handle(session, { method: 'getnetworkinfo', params: [] })).toEqual({ version: 1000600, relayfee: 0.01, incrementalfee: 0.00001 });
});
