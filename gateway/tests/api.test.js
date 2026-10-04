// In-process API tests: the real Express app + real JWT/bcrypt, with fake Postgres, RabbitMQ and Redis.
// Needs `npm install` (express, jsonwebtoken, bcryptjs). Does not need Docker.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');

const SECRET = 'test-secret';

function makeFakeDb() {
  const users = []; const txs = [];
  let uid = 1; let tid = 1;
  return {
    users, txs,
    async query(sql, p = []) {
      if (sql.startsWith('INSERT INTO users')) {
        if (users.some((u) => u.username === p[0])) { const e = new Error('duplicate'); e.code = '23505'; throw e; }
        const u = { id: uid++, username: p[0], password_hash: p[1], role: 'user', created_at: new Date() };
        users.push(u);
        return { rows: [{ id: u.id, username: u.username, role: u.role }] };
      }
      if (sql.startsWith('SELECT id, username, password_hash, role FROM users')) return { rows: users.filter((u) => u.username === p[0]) };
      if (sql.startsWith('INSERT INTO transactions')) {
        const t = { id: tid++, user_id: p[0], amount: p[1], description: p[2], status: 'queued', created_at: new Date(), processed_at: null };
        txs.push(t);
        return { rows: [{ ...t }] };
      }
      if (sql.startsWith("UPDATE transactions SET status='failed'")) {
        const t = txs.find((x) => x.id === p[0] && x.status === 'queued'); if (t) t.status = 'failed';
        return { rows: [] };
      }
      if (sql.includes('JOIN users')) return { rows: txs.map((t) => ({ ...t, username: users.find((u) => u.id === t.user_id).username })).reverse() };
      if (/FROM transactions WHERE user_id/.test(sql)) return { rows: txs.filter((t) => t.user_id === p[0]).reverse() };
      if (/FROM transactions WHERE id/.test(sql)) return { rows: txs.filter((t) => t.id === p[0]) };
      if (sql.startsWith('SELECT id, username, role, created_at FROM users')) return { rows: users.map(({ password_hash, ...rest }) => rest) };
      if (sql.startsWith('UPDATE users SET role')) {
        const u = users.find((x) => x.id === p[1]); if (!u) return { rows: [] };
        u.role = p[0]; return { rows: [{ id: u.id, username: u.username, role: u.role }] };
      }
      throw new Error(`Unexpected SQL in fake db: ${sql}`);
    }
  };
}

describe('Gateway API', () => {
  let server, base, db, published, brokerDown, cache, cacheStore;

  before(async () => {
    db = makeFakeDb();
    published = []; brokerDown = false; cacheStore = new Map();
    const broker = { publish: async (queue, obj) => { if (brokerDown) throw new Error('broker down'); published.push({ queue, obj }); } };
    cache = {
      get: async (k) => cacheStore.get(k) ?? null,
      set: async (k, val) => { cacheStore.set(k, val); },
      del: async (k) => { cacheStore.delete(k); }
    };
    db.users.push({ id: 1000, username: 'root_admin', password_hash: bcrypt.hashSync('adminpass1', 4), role: 'admin', created_at: new Date() });
    const app = createApp({ db, broker, cache, jwtSecret: SECRET });
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  async function call(method, path, { token, body, raw } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
    });
    let json = null; try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: json, headers: res.headers };
  }
  async function loginAs(username, password) {
    const r = await call('POST', '/auth/login', { body: { username, password } });
    assert.equal(r.status, 200, `login failed for ${username}`);
    return r.body.token;
  }

  let userToken, userId, otherToken;

  test('GET /health -> 200', async () => {
    const r = await call('GET', '/health');
    assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  });

  test('POST /auth/register creates a user with role "user"', async () => {
    const r = await call('POST', '/auth/register', { body: { username: 'alice', password: 'password123' } });
    assert.equal(r.status, 201); assert.equal(r.body.role, 'user'); userId = r.body.id;
    await call('POST', '/auth/register', { body: { username: 'bob', password: 'password123' } });
  });

  test('register cannot be used to self-assign admin', async () => {
    const r = await call('POST', '/auth/register', { body: { username: 'mallory', password: 'password123', role: 'admin' } });
    assert.equal(r.status, 201); assert.equal(r.body.role, 'user');
  });

  test('register: duplicate username -> 409, invalid input -> 400', async () => {
    assert.equal((await call('POST', '/auth/register', { body: { username: 'alice', password: 'password123' } })).status, 409);
    assert.equal((await call('POST', '/auth/register', { body: { username: 'x', password: 'password123' } })).status, 400);
    assert.equal((await call('POST', '/auth/register', { body: { username: 'validname', password: 'short' } })).status, 400);
  });

  test('POST /auth/login: success returns a JWT, bad credentials -> 401', async () => {
    const ok = await call('POST', '/auth/login', { body: { username: 'alice', password: 'password123' } });
    assert.equal(ok.status, 200);
    const claims = jwt.verify(ok.body.token, SECRET);
    assert.equal(claims.role, 'user'); assert.equal(claims.username, 'alice');
    assert.equal((await call('POST', '/auth/login', { body: { username: 'alice', password: 'wrong-pass' } })).status, 401);
    assert.equal((await call('POST', '/auth/login', { body: { username: 'nobody', password: 'password123' } })).status, 401);
    assert.equal((await call('POST', '/auth/login', { body: { username: 'alice' } })).status, 400);
    userToken = ok.body.token;
    otherToken = await loginAs('bob', 'password123');
  });

  test('protected routes reject missing, malformed and forged tokens (401)', async () => {
    assert.equal((await call('POST', '/transactions', { body: { amount: 5 } })).status, 401);
    assert.equal((await call('GET', '/transactions', { token: 'garbage' })).status, 401);
    const forged = jwt.sign({ sub: '1', username: 'x', role: 'admin' }, 'another-secret');
    assert.equal((await call('GET', '/admin/users', { token: forged })).status, 401);
  });

  test('a token with an unknown role claim is forbidden', async () => {
    const t = jwt.sign({ sub: '1', username: 'x', role: 'superuser' }, SECRET);
    assert.equal((await call('GET', '/transactions', { token: t })).status, 403);
  });

  test('POST /transactions validates the amount (400)', async () => {
    for (const amount of [0, -5, 'abc', null]) {
      assert.equal((await call('POST', '/transactions', { token: userToken, body: { amount } })).status, 400, `amount ${amount}`);
    }
    assert.equal(published.length, 0);
  });

  test('POST /transactions -> 202, stored as queued and published to the broker', async () => {
    const r = await call('POST', '/transactions', { token: userToken, body: { amount: 49.99, description: 'order #1' } });
    assert.equal(r.status, 202);
    assert.equal(r.body.transaction.status, 'queued');
    assert.deepEqual(published.at(-1), { queue: 'transactions', obj: { id: r.body.transaction.id } });
  });

  test('GET /transactions is cached (MISS then HIT) and invalidated by a new transaction', async () => {
    cacheStore.clear();
    const a = await call('GET', '/transactions', { token: userToken });
    assert.equal(a.status, 200); assert.equal(a.headers.get('x-cache'), 'MISS');
    const b = await call('GET', '/transactions', { token: userToken });
    assert.equal(b.headers.get('x-cache'), 'HIT');
    await call('POST', '/transactions', { token: userToken, body: { amount: 5 } });
    const c = await call('GET', '/transactions', { token: userToken });
    assert.equal(c.headers.get('x-cache'), 'MISS');
    assert.equal(c.body.length, 2);
  });

  test('users only see their own transactions', async () => {
    const r = await call('GET', '/transactions', { token: otherToken });
    assert.deepEqual(r.body, []);
  });

  test('GET /transactions/:id enforces ownership (403) and 404/400 handling', async () => {
    const id = db.txs[0].id;
    assert.equal((await call('GET', `/transactions/${id}`, { token: userToken })).status, 200);
    assert.equal((await call('GET', `/transactions/${id}`, { token: otherToken })).status, 403);
    assert.equal((await call('GET', '/transactions/99999', { token: userToken })).status, 404);
    assert.equal((await call('GET', '/transactions/abc', { token: userToken })).status, 400);
  });

  test('broker outage -> 503 and the transaction is marked failed', async () => {
    brokerDown = true;
    const r = await call('POST', '/transactions', { token: userToken, body: { amount: 12 } });
    brokerDown = false;
    assert.equal(r.status, 503);
    assert.equal(db.txs.find((t) => t.id === r.body.transactionId).status, 'failed');
  });

  test('RBAC: user is forbidden from manager and admin endpoints (403)', async () => {
    assert.equal((await call('GET', '/manager/transactions', { token: userToken })).status, 403);
    assert.equal((await call('GET', '/admin/users', { token: userToken })).status, 403);
    assert.equal((await call('PATCH', `/admin/users/${userId}/role`, { token: userToken, body: { role: 'admin' } })).status, 403);
  });

  test('RBAC: admin can list users and view all transactions', async () => {
    const adminToken = await loginAs('root_admin', 'adminpass1');
    const users = await call('GET', '/admin/users', { token: adminToken });
    assert.equal(users.status, 200);
    assert.ok(users.body.every((u) => u.password_hash === undefined), 'password hashes must never be exposed');
    assert.equal((await call('GET', '/manager/transactions', { token: adminToken })).status, 200);
  });

  test('RBAC: admin promotes a user to manager; manager sees all transactions but not admin routes', async () => {
    const adminToken = await loginAs('root_admin', 'adminpass1');
    const promote = await call('PATCH', `/admin/users/${userId}/role`, { token: adminToken, body: { role: 'manager' } });
    assert.equal(promote.status, 200); assert.equal(promote.body.role, 'manager');

    const managerToken = await loginAs('alice', 'password123'); // new login carries the new role
    const all = await call('GET', '/manager/transactions', { token: managerToken });
    assert.equal(all.status, 200); assert.ok(all.body.length >= 2);
    assert.equal((await call('GET', '/admin/users', { token: managerToken })).status, 403);
    // a manager may read another user's transaction
    assert.equal((await call('GET', `/transactions/${db.txs[0].id}`, { token: managerToken })).status, 200);
  });

  test('admin role changes: validation, self-change and unknown user', async () => {
    const adminToken = await loginAs('root_admin', 'adminpass1');
    assert.equal((await call('PATCH', `/admin/users/${userId}/role`, { token: adminToken, body: { role: 'root' } })).status, 400);
    assert.equal((await call('PATCH', '/admin/users/1000/role', { token: adminToken, body: { role: 'user' } })).status, 400);
    assert.equal((await call('PATCH', '/admin/users/424242/role', { token: adminToken, body: { role: 'user' } })).status, 404);
  });

  test('invalid JSON -> 400, unknown route -> 404', async () => {
    assert.equal((await call('POST', '/auth/login', { raw: '{bad json' })).status, 400);
    assert.equal((await call('GET', '/nope')).status, 404);
  });
});
