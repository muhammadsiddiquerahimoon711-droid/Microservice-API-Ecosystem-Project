// Idempotent schema, applied when the gateway starts.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','manager','admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS transactions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount       NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processed','failed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, id DESC);
`;

module.exports = { SCHEMA_SQL };
