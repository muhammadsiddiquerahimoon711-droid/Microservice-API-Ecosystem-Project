const amqp = require('amqplib');
const { Pool } = require('pg');
const { createClient } = require('redis');
const { retry } = require('./retry');
const { handleMessage } = require('./processor');
const { TRANSACTION_QUEUE, DEAD_LETTER_QUEUE, queueOptions } = require('./queues');

async function connectCache() {
  const noop = { del: async () => {} };
  if (!process.env.REDIS_URL) return noop;
  try {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (e) => console.error('Redis error:', e.message));
    await retry(() => client.connect(), { name: 'redis', attempts: 10 });
    return { del: async (k) => { try { await client.del(k); } catch { /* ignore */ } } };
  } catch (err) {
    console.error('Redis unavailable, continuing without cache invalidation:', err.message);
    return noop;
  }
}

async function main() {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  await retry(() => db.query('SELECT 1'), { name: 'postgres' });
  const cache = await connectCache();

  const connection = await retry(() => amqp.connect(process.env.RABBITMQ_URL), { name: 'rabbitmq' });
  connection.on('close', () => { console.error('RabbitMQ connection closed; exiting so Docker restarts the worker'); process.exit(1); });
  connection.on('error', (e) => console.error('RabbitMQ error:', e.message));

  const channel = await connection.createChannel();
  await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
  await channel.assertQueue(TRANSACTION_QUEUE, queueOptions);
  channel.prefetch(10); // up to 10 jobs in flight per worker

  console.log('Transaction worker is running');
  channel.consume(TRANSACTION_QUEUE, async (msg) => {
    if (!msg) return;
    const result = await handleMessage({ db, cache, channel, msg, queue: TRANSACTION_QUEUE });
    console.log(`Job ${msg.content.toString()} -> ${result}`);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
