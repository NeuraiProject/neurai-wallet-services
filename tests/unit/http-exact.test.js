const http = require('http');
const { getRPC, parseRpcJson } = require('@neuraiproject/neurai-rpc');
const { create } = require('../../http');
const { parse } = require('lossless-json');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
const nodeDeps = { getNodes: () => [], getIdentity: async () => ({ service_id: 'test', network: 'regtest', genesis_hash: 'a'.repeat(64) }) };
test('raw HTTP parameters survive proxy and real RPC client; replies and cache stay exact', async () => {
  const captured = [];
  const upstream = http.createServer((req, res) => {
    let text = ''; req.on('data', chunk => text += chunk); req.on('end', () => {
      captured.push(text);
      res.setHeader('content-type', 'application/json');
      res.end('{"result":{"balance":10000000000000001,"value":100000000.00000001},"error":null}');
    });
  });
  await listen(upstream);
  const rpc = getRPC('test', 'test', `http://127.0.0.1:${upstream.address().port}`);
  const service = create({ enabled: true }, {}, { nodeDeps, rpc });
  const server = http.createServer(service.handleRequest); await listen(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const params = '[100000000.00000001,9007199254740993,1e-8,{"nested":[true,null,"1",1]}]';
    const body = '{"method":"getaddressbalance","params":' + params + '}';
    const send = async body => parseRpcJson(await (await fetch(url + '/rpc', { method: 'POST', body })).text());
    const first = await send(body);
    expect(first.result).toEqual({ balance: '10000000000000001', value: '100000000.00000001' });
    expect(await send(body)).toEqual(first);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('"params":' + params);
    await send('{"method":"getaddressbalance","params":[1]}');
    await send('{"method":"getaddressbalance","params":["1"]}');
    expect(captured).toHaveLength(3);
    service.onBlock('new'); await send(body); expect(captured).toHaveLength(4);
    const settings = await (await fetch(url + '/settings')).json();
    expect(settings).toMatchObject({ exact_amounts: true, amounts: 'rpc-native-units', network: 'regtest' });
    expect((await fetch(url + '/rpc')).status).toBe(405);
  } finally { await close(server); await close(upstream); }
});
test('live coin/spend queries bypass cache and old rejected promise cannot remove replacement', () => {
  const cache = require('../../http/cache-service').create();
  expect(cache.shouldCache('gettxout')).toBe(false);
  expect(cache.shouldCache('getspentinfo')).toBe(false);
  const old = Promise.resolve(1), fresh = Promise.resolve(2);
  cache.put('getaddressbalance', parse('[1]'), old); cache.clear();
  cache.put('getaddressbalance', parse('[1]'), fresh);
  cache.remove('getaddressbalance', parse('[1]'), old);
  expect(cache.get('getaddressbalance', parse('[1]'))).toBe(fresh);
});

test('spent index observes replacement, confirmation and eviction without a block notification', async () => {
  let current = { txid: 'b'.repeat(64), index: 0, height: -1 }, calls = 0;
  const rpc = async () => {
    calls++;
    if (!current) throw Object.assign(new Error('Unable to get spent info'), { code: -5 });
    return structuredClone(current);
  };
  const service = create({ enabled: true }, {}, { nodeDeps, rpc });
  const server = http.createServer(service.handleRequest); await listen(server);
  const url = `http://127.0.0.1:${server.address().port}/rpc`;
  const request = async () => {
    const reply = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getspentinfo', params: [{ txid: 'a'.repeat(64), index: 0 }] }) });
    return { status: reply.status, body: await reply.json() };
  };
  try {
    expect((await request()).body.result).toEqual(current);
    current = { txid: 'c'.repeat(64), index: 0, height: -1 };
    expect((await request()).body.result).toEqual(current);
    current.height = 120;
    expect((await request()).body.result).toEqual(current);
    current = null;
    expect(await request()).toEqual({ status: 500, body: { error: { message: 'Unable to get spent info', code: -5 } } });
    current = { txid: 'd'.repeat(64), index: 0, height: -1 };
    expect((await request()).body.result).toEqual(current);
    expect(calls).toBe(5);
  } finally { await close(server); }
});
