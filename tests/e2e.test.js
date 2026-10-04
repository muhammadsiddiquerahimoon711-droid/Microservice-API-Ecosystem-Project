// End-to-end verification against the RUNNING Docker stack (gateway -> RabbitMQ -> worker -> Postgres).
//   docker compose up --build -d
//   node --test tests/e2e.test.js
// Uses only Node 22 built-ins (fetch, node:test) - nothing to install.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe-Admin-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

async function waitForStatus(token, id, wanted, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await call('GET', `/transactions/${id}`, { token });
    if (r.body && r.body.status === wanted) return r.body;
    await sleep(300);
  }
  throw new Error(`transaction ${id} did not reach "${wanted}" within ${timeoutMs}ms`);
}

describe('End-to-end: full stack', () => {
  const username = `e2e_${Date.now()}`;
  const password = 'e2e-password-1';
  let userToken, userId, adminToken, txId;

  test('gateway is healthy', async () => {
    assert.equal((await call('GET', '/health')).status, 200);
  });

  test('unauthenticated transaction is rejected (401)', async () => {
    assert.equal((await call('POST', '/transactions', { body: { amount: 10 } })).status, 401);
  });

  test('register + duplicate register + login', async () => {
    const reg = await call('POST', '/auth/register', { body: { username, password } });
    assert.equal(reg.status, 201); assert.equal(reg.body.role, 'user'); userId = reg.body.id;
    assert.equal((await call('POST', '/auth/register', { body: { username, password } })).status, 409);
    assert.equal((await call('POST', '/auth/login', { body: { username, password: 'wrong-password' } })).status, 401);
    const login = await call('POST', '/auth/login', { body: { username, password } });
    assert.equal(login.status, 200); userToken = login.body.token; assert.ok(userToken);
  });

  test('invalid amount is rejected (400)', async () => {
    assert.equal((await call('POST', '/transactions', { token: userToken, body: { amount: -1 } })).status, 400);
  });

  test('transaction is accepted (202) and then processed asynchronously by the worker', async () => {
    const r = await call('POST', '/transactions', { token: userToken, body: { amount: 99.5, description: 'e2e' } });
    assert.equal(r.status, 202); txId = r.body.transaction.id;
    const done = await waitForStatus(userToken, txId, 'processed');
    assert.ok(done.processed_at);
  });

  test('user can list own transactions', async () => {
    const r = await call('GET', '/transactions', { token: userToken });
    assert.equal(r.status, 200); assert.ok(r.body.some((t) => t.id === txId));
  });

  test('RBAC: normal user is forbidden from manager/admin endpoints (403)', async () => {
    assert.equal((await call('GET', '/manager/transactions', { token: userToken })).status, 403);
    assert.equal((await call('GET', '/admin/users', { token: userToken })).status, 403);
  });

  test('RBAC: seeded admin can see all transactions and users', async () => {
    const login = await call('POST', '/auth/login', { body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
    assert.equal(login.status, 200, 'admin login failed - check ADMIN_USERNAME / ADMIN_PASSWORD'); adminToken = login.body.token;
    const all = await call('GET', '/manager/transactions', { token: adminToken });
    assert.equal(all.status, 200); assert.ok(all.body.some((t) => t.id === txId));
    assert.equal((await call('GET', '/admin/users', { token: adminToken })).status, 200);
  });

  test('RBAC: admin promotes the user to manager', async () => {
    assert.equal((await call('PATCH', `/admin/users/${userId}/role`, { token: adminToken, body: { role: 'manager' } })).status, 200);
    const login = await call('POST', '/auth/login', { body: { username, password } });
    assert.equal(login.body.user.role, 'manager');
    assert.equal((await call('GET', '/manager/transactions', { token: login.body.token })).status, 200);
    assert.equal((await call('GET', '/admin/users', { token: login.body.token })).status, 403);
  });

  test('load: 50 concurrent transactions are all accepted and all processed', async () => {
    const login = await call('POST', '/auth/login', { body: { username, password } });
    const token = login.body.token;
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => call('POST', '/transactions', { token, body: { amount: i + 1 } })));
    assert.ok(results.every((r) => r.status === 202), 'every request should return 202');
    const ids = results.map((r) => r.body.transaction.id);
    await Promise.all(ids.map((id) => waitForStatus(token, id, 'processed', 30000)));
  });
});
