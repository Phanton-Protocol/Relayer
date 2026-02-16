CREATE TABLE IF NOT EXISTS intents (
  intentId TEXT PRIMARY KEY,
  userAddress TEXT NOT NULL,
  payload TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  intentId TEXT PRIMARY KEY,
  userAddress TEXT NOT NULL,
  payload TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  userAddress TEXT,
  payload TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
