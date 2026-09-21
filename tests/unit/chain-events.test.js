jest.mock('../../wss/rpc', () => ({ callRPC: jest.fn() }));
jest.mock('../../wss/notifications', () => ({ notifyAddress: jest.fn(), broadcast: jest.fn() }));
const events = require('../../wss/chain-events');
const subscriptions = require('../../wss/subscriptions');
const notifications = require('../../wss/notifications');
const chain = require('../../wss/chain-state');
let client;
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); client = { subs: new Set() }; subscriptions.subscribe('a', client); });
afterEach(() => { events.stop(); subscriptions.unsubscribeAll(client); jest.useRealTimers(); });
test('failed push retries without a block and reports recovery even at the same hash', async () => {
  const fetchAddressState = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ status: 'same', balance: { confirmed: 1n, unconfirmed: 0n } });
  chain.setLastStatus('a', 'same');
  events.configure({ methods: { fetchAddressState }, retry_base_ms: 10 });
  await events.refreshAddress('a', 'block');
  expect(chain.getLastStatus('a')).toBe('same');
  expect(notifications.notifyAddress).toHaveBeenCalledWith('a', 'address.sync_status', { address: 'a', stale: true, reason: 'upstream_unavailable' });
  await jest.advanceTimersByTimeAsync(10);
  expect(fetchAddressState).toHaveBeenCalledTimes(2);
  expect(notifications.notifyAddress).toHaveBeenLastCalledWith('a', 'address.sync_status', { address: 'a', stale: false, reason: 'recovered' });
});
test('unsubscribing cancels pending retry', async () => {
  const fetchAddressState = jest.fn().mockRejectedValue(new Error('offline'));
  events.configure({ methods: { fetchAddressState }, retry_base_ms: 10 });
  await events.refreshAddress('a', 'block');
  subscriptions.unsubscribeAll(client);
  await jest.advanceTimersByTimeAsync(1000);
  expect(fetchAddressState).toHaveBeenCalledTimes(1);
});
