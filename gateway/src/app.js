const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const v = require('./validate');
const { requireRole, hasRole } = require('./rbac');
const { TRANSACTION_QUEUE } = require('./queues');

const TX_COLUMNS = 'id, user_id, amount, description, status, created_at, processed_at';
const cacheKey = (userId) => `tx:user:${userId}`;

// Dependencies are injected so the app can be tested without Postgres / RabbitMQ / Redis.
//   db     -> { query(text, params) }          (pg Pool)
//   broker -> { publish(queue, object) }       (RabbitMQ confirm channel)
//   cache  -> { get, set(key, value, ttlSec), del }  (Redis, errors swallowed)
function createApp({ db, broker, cache, jwtSecret, jwtExpiresIn = '1h' }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  function authenticate(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Token required' });
    try {
      const p = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
      req.user = { id: Number(p.sub), username: p.username, role: p.role };
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  // ---------- public ----------
  app.get('/health', (req, res) => res.json({ ok: true, service: 'task4-gateway' }));

  app.post('/auth/register', wrap(async (req, res) => {
    const input = v.registerInput(req.body);
    if (!input.ok) return res.status(400).json({ error: input.error });
    const hash = await bcrypt.hash(input.value.password, 10);
    try {
      // Self-registration always creates the lowest tier; only an admin can promote.
      const { rows } = await db.query('INSERT INTO users(username, password_hash) VALUES($1, $2) RETURNING id, username, role', [input.value.username, hash]);
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
      throw err;
    }
  }));

  app.post('/auth/login', wrap(async (req, res) => {
    const input = v.loginInput(req.body);
    if (!input.ok) return res.status(400).json({ error: input.error });
    const { rows } = await db.query('SELECT id, username, password_hash, role FROM users WHERE username = $1', [input.value.username]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(input.value.password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ sub: String(user.id), username: user.username, role: user.role }, jwtSecret, { expiresIn: jwtExpiresIn });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  }));

  // ---------- user tier ----------
  app.post('/transactions', authenticate, requireRole('user'), wrap(async (req, res) => {
    const input = v.transactionInput(req.body);
    if (!input.ok) return res.status(400).json({ error: input.error });

    // 1) record as "queued"  2) hand the heavy work to the broker  3) answer immediately (202).
    const { rows } = await db.query(`INSERT INTO transactions(user_id, amount, description) VALUES($1, $2, $3) RETURNING ${TX_COLUMNS}`, [req.user.id, input.value.amount, input.value.description]);
    const tx = rows[0];

    try {
      await broker.publish(TRANSACTION_QUEUE, { id: tx.id });
    } catch (err) {
      console.error('Publish failed:', err.message);
      await db.query("UPDATE transactions SET status='failed' WHERE id = $1 AND status = 'queued'", [tx.id]);
      await cache.del(cacheKey(req.user.id));
      return res.status(503).json({ error: 'Message broker unavailable; transaction was not queued', transactionId: tx.id });
    }
    await cache.del(cacheKey(req.user.id));
    res.status(202).json({ message: 'Transaction accepted and queued', transaction: tx });
  }));

  app.get('/transactions', authenticate, requireRole('user'), wrap(async (req, res) => {
    const key = cacheKey(req.user.id);
    const cached = await cache.get(key);
    if (cached) {
      res.set('X-Cache', 'HIT');
      return res.json(JSON.parse(cached));
    }
    const { rows } = await db.query(`SELECT ${TX_COLUMNS} FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 100`, [req.user.id]);
    await cache.set(key, JSON.stringify(rows), 30);
    res.set('X-Cache', 'MISS');
    res.json(rows);
  }));

  app.get('/transactions/:id', authenticate, requireRole('user'), wrap(async (req, res) => {
    const id = v.idParam(req.params.id);
    if (!id.ok) return res.status(400).json({ error: id.error });
    const { rows } = await db.query(`SELECT ${TX_COLUMNS} FROM transactions WHERE id = $1`, [id.value]);
    const tx = rows[0];
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.user_id !== req.user.id && !hasRole(req.user.role, 'manager')) return res.status(403).json({ error: 'Forbidden' });
    res.json(tx);
  }));

  // ---------- manager tier ----------
  app.get('/manager/transactions', authenticate, requireRole('manager'), wrap(async (req, res) => {
    const { rows } = await db.query('SELECT t.id, t.user_id, u.username, t.amount, t.description, t.status, t.created_at, t.processed_at FROM transactions t JOIN users u ON u.id = t.user_id ORDER BY t.id DESC LIMIT 200');
    res.json(rows);
  }));

  // ---------- admin tier ----------
  app.get('/admin/users', authenticate, requireRole('admin'), wrap(async (req, res) => {
    const { rows } = await db.query('SELECT id, username, role, created_at FROM users ORDER BY id');
    res.json(rows);
  }));

  app.patch('/admin/users/:id/role', authenticate, requireRole('admin'), wrap(async (req, res) => {
    const id = v.idParam(req.params.id);
    if (!id.ok) return res.status(400).json({ error: id.error });
    const input = v.roleInput(req.body);
    if (!input.ok) return res.status(400).json({ error: input.error });
    if (id.value === req.user.id) return res.status(400).json({ error: 'Admins cannot change their own role' });
    const { rows } = await db.query('UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, role', [input.value.role, id.value]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  }));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
