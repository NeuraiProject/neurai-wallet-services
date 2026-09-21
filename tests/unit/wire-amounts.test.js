const { encodeMessage } = require('../../wss/wire-amounts');
const raw = 10000000000000001n;
const state = { balance: { confirmed: raw, unconfirmed: -raw }, assets: { A: { confirmed: 0n, unconfirmed: 0n } },
  history: [{ height: 1, satoshis: -raw }], mempool: [{ satoshis: -raw }], utxos: [{ vout: 0, satoshis: raw }], asset_utxos: [{ satoshis: raw }] };
test.each(['address.subscribe', 'address.get_state', 'address.subscribe.bulk', 'address.changed'])('%s encodes isolated sessions', method => {
  const message = method === 'address.changed' ? { method, params: state } : { id: 1, result: method.endsWith('bulk') ? { results: [state, { address: 'bad', error: { code: 1003 } }] } : state };
  const unsafe = jest.fn();
  const v1 = JSON.parse(encodeMessage(message, method, 'wss/1', unsafe));
  const v2 = JSON.parse(encodeMessage(message, method, 'wss/2'));
  const row = m => m.params || (method.endsWith('bulk') ? m.result.results[0] : m.result);
  expect(row(v1).balance.confirmed).toBe(Number(raw));
  expect(row(v2).balance).toEqual({ confirmed: String(raw), unconfirmed: String(-raw) });
  expect(row(v2).assets.A.confirmed).toBe('0');
  expect(row(v2).history[0]).toEqual({ height: 1, satoshis: String(-raw) });
  expect(unsafe).toHaveBeenCalledTimes(6);
  expect(state.balance.confirmed).toBe(raw);
  if (method.endsWith('bulk')) expect(v2.result.results[1].error.code).toBe(1003);
});
test('unknown bigint fields fail explicitly', () => {
  expect(() => encodeMessage({ id: 1, result: { height: 1n } }, 'ping', 'wss/2')).toThrow();
});
test('session boundary covers mixed notifications and counts unsafe negative/positive conversions', () => {
  const sessions = require('../../wss/session');
  const subscriptions = require('../../wss/subscriptions');
  const notifications = require('../../wss/notifications');
  const a = sessions.createSession({ readyState: 1, send: jest.fn() });
  const b = sessions.createSession({ readyState: 1, send: jest.fn() });
  a.helloDone = b.helloDone = true; b.protocol = 'wss/2';
  subscriptions.subscribe('a', a); subscriptions.subscribe('a', b);
  const before = sessions.getStats().unsafe_v1_amounts;
  try {
    notifications.notifyAddress('a', 'address.changed', { address: 'a', balance: state.balance });
    expect(JSON.parse(a.ws.send.mock.calls[0][0]).params.balance.confirmed).toBe(Number(raw));
    expect(JSON.parse(b.ws.send.mock.calls[0][0]).params.balance.confirmed).toBe(String(raw));
    expect(sessions.getStats().unsafe_v1_amounts - before).toBe(2);
    notifications.notifyAddress('a', 'address.sync_status', { address: 'a', stale: true });
    expect(a.ws.send).toHaveBeenCalledTimes(1); expect(b.ws.send).toHaveBeenCalledTimes(2);
  } finally { for (const s of [a, b]) { subscriptions.unsubscribeAll(s); sessions.destroySession(s); } }
});
