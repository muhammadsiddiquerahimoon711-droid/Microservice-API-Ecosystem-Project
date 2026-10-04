const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { handleMessage } = require('../src/processor');

const makeMsg = (obj, headers) => ({ content: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)), properties: { headers } });
function makeChannel() {
  const calls = { ack: 0, nack: [], sent: [] };
  return {
    calls,
    ack() { calls.ack++; },
    nack(msg, all, requeue) { calls.nack.push({ all, requeue }); },
    sendToQueue(queue, content, opts) { calls.sent.push({ queue, content, opts }); }
  };
}
const makeCache = () => { const deleted = []; return { deleted, del: async (k) => { deleted.push(k); } }; };

describe('worker: handleMessage', () => {
  test('processes a queued transaction, acks, and clears that user\'s cache', async () => {
    const db = { query: async (sql, p) => { assert.match(sql, /status = 'queued'/); return { rows: [{ user_id: 7 }] }; } };
    const channel = makeChannel(); const cache = makeCache();
    const result = await handleMessage({ db, cache, channel, msg: makeMsg({ id: 42 }), queue: 'transactions' });
    assert.equal(result, 'processed');
    assert.equal(channel.calls.ack, 1);
    assert.deepEqual(cache.deleted, ['tx:user:7']);
  });

  test('uses one atomic conditional UPDATE (no row locks)', async () => {
    const seen = [];
    const db = { query: async (sql) => { seen.push(sql); return { rows: [{ user_id: 1 }] }; } };
    await handleMessage({ db, cache: makeCache(), channel: makeChannel(), msg: makeMsg({ id: 1 }), queue: 'transactions' });
    assert.equal(seen.length, 1);
    assert.doesNotMatch(seen[0], /FOR UPDATE/i);
    assert.match(seen[0], /^UPDATE/);
  });

  test('duplicate delivery is idempotent: acked and skipped, cache untouched', async () => {
    const db = { query: async () => ({ rows: [] }) };
    const channel = makeChannel(); const cache = makeCache();
    const result = await handleMessage({ db, cache, channel, msg: makeMsg({ id: 42 }), queue: 'transactions' });
    assert.equal(result, 'skipped');
    assert.equal(channel.calls.ack, 1);
    assert.deepEqual(cache.deleted, []);
  });

  test('malformed JSON goes to the dead-letter queue without requeue', async () => {
    const channel = makeChannel();
    const result = await handleMessage({ db: { query: async () => ({ rows: [] }) }, cache: makeCache(), channel, msg: makeMsg('not json'), queue: 'transactions' });
    assert.equal(result, 'dead-lettered');
    assert.deepEqual(channel.calls.nack, [{ all: false, requeue: false }]);
    assert.equal(channel.calls.ack, 0);
  });

  test('payload without an integer id is dead-lettered', async () => {
    const channel = makeChannel();
    const result = await handleMessage({ db: { query: async () => ({ rows: [] }) }, cache: makeCache(), channel, msg: makeMsg({ id: 'abc' }), queue: 'transactions' });
    assert.equal(result, 'dead-lettered');
  });

  test('database error re-publishes with an incremented retry counter', async () => {
    const db = { query: async () => { throw new Error('db down'); } };
    const channel = makeChannel();
    const result = await handleMessage({ db, cache: makeCache(), channel, msg: makeMsg({ id: 5 }, { 'x-retries': 1 }), queue: 'transactions' });
    assert.equal(result, 'retried');
    assert.equal(channel.calls.sent.length, 1);
    assert.equal(channel.calls.sent[0].opts.headers['x-retries'], 2);
    assert.equal(channel.calls.ack, 1);
  });

  test('after max retries the job is marked failed and dead-lettered', async () => {
    const sql = [];
    const db = { query: async (s) => { sql.push(s); if (/status = 'processed'/.test(s)) throw new Error('db down'); return { rows: [] }; } };
    const channel = makeChannel();
    const result = await handleMessage({ db, cache: makeCache(), channel, msg: makeMsg({ id: 5 }, { 'x-retries': 3 }), queue: 'transactions' });
    assert.equal(result, 'dead-lettered');
    assert.ok(sql.some((s) => /status = 'failed'/.test(s)));
    assert.deepEqual(channel.calls.nack, [{ all: false, requeue: false }]);
  });

  test('a failing cache does not stop the message from being acked', async () => {
    const db = { query: async () => ({ rows: [{ user_id: 3 }] }) };
    const cache = { del: async () => { throw new Error('redis down'); } };
    const channel = makeChannel();
    const result = await handleMessage({ db, cache, channel, msg: makeMsg({ id: 9 }), queue: 'transactions' });
    assert.equal(result, 'processed');
    assert.equal(channel.calls.ack, 1);
  });

  test('handles many messages concurrently', async () => {
    const db = { query: async (_s, p) => { await new Promise((r) => setTimeout(r, 2)); return { rows: [{ user_id: p[0] % 5 }] }; } };
    const channel = makeChannel(); const cache = makeCache();
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => handleMessage({ db, cache, channel, msg: makeMsg({ id: i + 1 }), queue: 'transactions' })));
    assert.ok(results.every((r) => r === 'processed'));
    assert.equal(channel.calls.ack, 200);
  });
});
