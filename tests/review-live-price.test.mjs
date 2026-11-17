import test from 'node:test';
import assert from 'node:assert/strict';

test('a Deepcoin ticker push of several swaps is read per instrument, with the 24h change from O', async () => {
  const { deepcoinTickerQuotes } = await import('../jesse/static/review/live-price.mjs');
  const quotes = deepcoinTickerQuotes({ a: 'PO', r: [
    { d: { I: 'BTCUSDT', N: 64032.1, O: 64083.2 } },
    { d: { I: 'ETHUSDT', N: '1783.33', O: '0' } },
    { d: { I: 'SOLUSDT', N: 'x' } },
  ] });
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].code, 'BTCUSDT');
  assert.ok(Math.abs(quotes[0].change - (64032.1 - 64083.2) / 64083.2) < 1e-12);
  assert.equal(quotes[1].change, null);
  assert.deepEqual(deepcoinTickerQuotes({ a: 'RecvTopicAction' }), []);
});
