// Docker starts containers in parallel; retry until Postgres / RabbitMQ / Redis accept connections.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, { name, attempts = 30, delayMs = 2000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      console.log(`[retry] ${name} not ready (${i}/${attempts}): ${err.message}`);
      await sleep(delayMs);
    }
  }
}

module.exports = { retry, sleep };
