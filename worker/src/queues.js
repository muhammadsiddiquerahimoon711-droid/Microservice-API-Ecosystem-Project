// Queue names/options are shared by gateway (producer) and worker (consumer).
// Keep this file identical in both services.
const TRANSACTION_QUEUE = 'transactions';
const DEAD_LETTER_QUEUE = 'transactions.dlq';

const queueOptions = {
  durable: true,
  arguments: {
    'x-dead-letter-exchange': '',
    'x-dead-letter-routing-key': DEAD_LETTER_QUEUE
  }
};

module.exports = { TRANSACTION_QUEUE, DEAD_LETTER_QUEUE, queueOptions };
