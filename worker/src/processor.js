// Message handling logic, kept free of RabbitMQ/Postgres imports so it is easy to unit test.
//
// "No database locks": each job is ONE atomic, conditional UPDATE. There is no SELECT ... FOR UPDATE and
// no long transaction, so many workers/messages can run in parallel without blocking each other, and
// a redelivered message is harmless (it matches 0 rows because the status is no longer 'queued').
const MAX_RETRIES = 3;

async function handleMessage({ db, cache, channel, msg, queue, maxRetries = MAX_RETRIES }) {
  let payload;
  try {
    payload = JSON.parse(msg.content.toString());
    if (!Number.isInteger(payload.id)) throw new Error('payload.id must be an integer');
  } catch {
    channel.nack(msg, false, false); // malformed -> dead-letter queue
    return 'dead-lettered';
  }

  try {
    const { rows } = await db.query("UPDATE transactions SET status = 'processed', processed_at = NOW() WHERE id = $1 AND status = 'queued' RETURNING user_id", [payload.id]);
    if (rows[0]) {
      try { await cache.del(`tx:user:${rows[0].user_id}`); } catch { /* cache is optional */ }
    }
    channel.ack(msg);
    return rows[0] ? 'processed' : 'skipped';
  } catch (err) {
    const retries = Number((msg.properties && msg.properties.headers && msg.properties.headers['x-retries']) || 0);
    if (retries < maxRetries) {
      channel.sendToQueue(queue, msg.content, { persistent: true, headers: { 'x-retries': retries + 1 } });
      channel.ack(msg);
      return 'retried';
    }
    try { await db.query("UPDATE transactions SET status = 'failed' WHERE id = $1 AND status = 'queued'", [payload.id]); } catch { /* best effort */ }
    channel.nack(msg, false, false); // give up -> dead-letter queue
    return 'dead-lettered';
  }
}

module.exports = { handleMessage, MAX_RETRIES };
