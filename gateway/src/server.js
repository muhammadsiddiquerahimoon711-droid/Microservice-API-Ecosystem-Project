const { Pool } = require('pg');
const amqp = require('amqplib');
const { createClient } = require('redis');
const bcrypt = require('bcryptjs');
const { createApp } = require('./app');
const { retry } = require('./retry');
const { SCHEMA_SQL } = require('./schema');
const { queueOptions, DEAD_LETTER_QUEUE, TRANSACTION_QUEUE } = require('./queues');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('JWT_SECRET is required');
  process.exit(1);
}

async function connectBroker() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  connection.on('close', () => { console.error('RabbitMQ connection closed; exiting so Docker restarts the gateway'); process.exit(1); });
  connection.on('error', (e) => console.error('RabbitMQ error:', e.message));
  const channel = await connection.createConfirmChannel();
  await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
  await channel.assertQueue(TRANSACTION_QUEUE, queueOptions);
  return {
    publish: (queue, obj) => new Promise((resolve, reject) => {
      channel.sendToQueue(queue, Buffer.from(JSON.stringify(obj)), { persistent: true, contentType: 'application/json' }, (err) => (err ? reject(err) : resolve()));
    })
  };
}

// Redis is only a cache: if it is down the API still works (just without caching).
async function connectCache() {
  const noop = { get: async () => null, set: async () => {}, del: async () => {} };
  try {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (e) => console.error('Redis error:', e.message));
    await retry(() => client.connect(), { name: 'redis', attempts: 10 });
    return {
      get: async (k) => { try { return await client.get(k); } catch { return null; } },
      set: async (k, val, ttl) => { try { await client.set(k, val, { EX: ttl }); } catch { /* ignore */ } },
      del: async (k) => { try { await client.del(k); } catch { /* ignore */ } }
    };
  } catch (err) {
    console.error('Redis unavailable, running without cache:', err.message);
    return noop;
  }
}

async function seedAdmin(pool) {
  const { ADMIN_USERNAME, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) return;
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const { rowCount } = await pool.query("INSERT INTO users(username, password_hash, role) VALUES($1, $2, 'admin') ON CONFLICT (username) DO NOTHING", [ADMIN_USERNAME, hash]);
  if (rowCount) console.log(`Seeded admin account "${ADMIN_USERNAME}"`);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
  await retry(() => pool.query('SELECT 1'), { name: 'postgres' });
  await pool.query(SCHEMA_SQL);
  await seedAdmin(pool);

  const broker = await retry(connectBroker, { name: 'rabbitmq' });
  const cache = await connectCache();

  const app = createApp({ db: pool, broker, cache, jwtSecret: JWT_SECRET, jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h' });
  const server = app.listen(PORT, () => console.log(`Gateway running on ${PORT}`));

  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => { console.error(err); process.exit(1); });
