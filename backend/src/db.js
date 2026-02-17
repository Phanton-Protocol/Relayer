const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function initDbJson(dbPath) {
  const dir = path.dirname(dbPath);
  ensureDir(dir);
  const base = path.basename(dbPath, path.extname(dbPath));
  const dataDir = path.join(dir, base + "_data");
  ensureDir(dataDir);

  const tables = ["intents", "receipts", "quotes", "commitments"];
  const keyCol = { intents: "intentId", receipts: "intentId", quotes: "id", commitments: "commitment" };

  function loadTable(name) {
    const f = path.join(dataDir, name + ".json");
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return [];
    }
  }
  function saveTable(name, rows) {
    const f = path.join(dataDir, name + ".json");
    fs.writeFileSync(f, JSON.stringify(rows, null, 0), "utf8");
  }

  function prepare(sql) {
    const sqlLower = sql.toLowerCase();
    const run = (...args) => {
      if (sqlLower.includes("insert or replace into intents")) {
        const [intentId, userAddress, payload, createdAt] = args;
        const rows = loadTable("intents").filter((r) => r.intentId !== intentId);
        rows.push({ intentId, userAddress, payload, createdAt });
        saveTable("intents", rows);
      } else if (sqlLower.includes("insert or replace into receipts")) {
        const [intentId, userAddress, payload, createdAt] = args;
        const rows = loadTable("receipts").filter((r) => r.intentId !== intentId);
        rows.push({ intentId, userAddress, payload, createdAt });
        saveTable("receipts", rows);
      } else if (sqlLower.includes("insert or replace into quotes")) {
        const [id, userAddress, payload, createdAt] = args;
        const rows = loadTable("quotes").filter((r) => r.id !== id);
        rows.push({ id, userAddress, payload, createdAt });
        saveTable("quotes", rows);
      } else if (sqlLower.includes("insert or replace into commitments")) {
        const [commitment, idx, txHash, createdAt] = args;
        const rows = loadTable("commitments").filter((r) => r.commitment !== commitment);
        rows.push({ commitment, idx, txHash, createdAt });
        saveTable("commitments", rows);
      }
    };
    const get = (...args) => {
      if (sqlLower.includes("from intents where")) {
        const [intentId] = args;
        const row = loadTable("intents").find((r) => r.intentId === intentId);
        return row ? { intentId: row.intentId, userAddress: row.userAddress, payload: row.payload } : undefined;
      }
      if (sqlLower.includes("from receipts where")) {
        const [intentId] = args;
        const row = loadTable("receipts").find((r) => r.intentId === intentId);
        return row ? { payload: row.payload } : undefined;
      }
      if (sqlLower.includes("from commitments where")) {
        const [commitment] = args;
        const row = loadTable("commitments").find((r) => String(r.commitment).toLowerCase() === String(commitment).toLowerCase());
        return row ? { commitment: row.commitment, idx: row.idx } : undefined;
      }
      return undefined;
    };
    const all = (...args) => {
      if (sqlLower.includes("from receipts where") && sqlLower.includes("order by")) {
        const [userAddress, limit] = args;
        return loadTable("receipts")
          .filter((r) => r.userAddress === userAddress)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          .slice(0, limit || 50)
          .map((r) => ({ payload: r.payload }));
      }
      if (sqlLower.includes("from commitments order by")) {
        return loadTable("commitments").sort((a, b) => (a.idx || 0) - (b.idx || 0));
      }
      if (sqlLower.includes("from intents order by")) {
        return loadTable("intents").sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((r) => ({ payload: r.payload }));
      }
      if (sqlLower.includes("from receipts order by")) {
        return loadTable("receipts").sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((r) => ({ payload: r.payload }));
      }
      if (sqlLower.includes("from quotes order by")) {
        return loadTable("quotes").sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((r) => ({ payload: r.payload }));
      }
      if (sqlLower.includes("commitment, idx, txhash, createdat from commitments")) {
        return loadTable("commitments").sort((a, b) => (a.idx || 0) - (b.idx || 0));
      }
      return [];
    };
    return { run, get, all };
  }

  return { pragma: () => {}, exec: () => {}, prepare };
}

function initDb(dbPath) {
  try {
    const Database = require("better-sqlite3");
    const dir = path.dirname(dbPath);
    ensureDir(dir);
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
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
      CREATE TABLE IF NOT EXISTS commitments (
        commitment TEXT PRIMARY KEY,
        idx INTEGER NOT NULL,
        txHash TEXT,
        createdAt INTEGER NOT NULL
      );
    `);
    return db;
  } catch (e) {
    console.warn("Using JSON file storage (better-sqlite3 unavailable on this system).");
    return initDbJson(dbPath);
  }
}

function saveIntent(db, intentId, userAddress, payload) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO intents(intentId, userAddress, payload, createdAt) VALUES (?, ?, ?, ?)"
  );
  stmt.run(intentId, userAddress, JSON.stringify(payload), Date.now());
}

function getIntent(db, intentId) {
  const row = db.prepare("SELECT * FROM intents WHERE intentId = ?").get(intentId);
  if (!row) return null;
  return { intentId: row.intentId, userAddress: row.userAddress, payload: JSON.parse(row.payload) };
}

function saveReceipt(db, intentId, userAddress, payload) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO receipts(intentId, userAddress, payload, createdAt) VALUES (?, ?, ?, ?)"
  );
  stmt.run(intentId, userAddress, JSON.stringify(payload), Date.now());
}

function getReceipt(db, intentId) {
  const row = db.prepare("SELECT * FROM receipts WHERE intentId = ?").get(intentId);
  if (!row) return null;
  return JSON.parse(row.payload);
}

function listReceipts(db, userAddress, limit = 50) {
  const rows = db
    .prepare(
      "SELECT payload FROM receipts WHERE userAddress = ? ORDER BY createdAt DESC LIMIT ?"
    )
    .all(userAddress, limit);
  return rows.map((r) => JSON.parse(r.payload));
}

function saveQuote(db, id, userAddress, payload) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO quotes(id, userAddress, payload, createdAt) VALUES (?, ?, ?, ?)"
  );
  stmt.run(id, userAddress || null, JSON.stringify(payload), Date.now());
}

function saveCommitment(db, idx, commitment, txHash) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO commitments(commitment, idx, txHash, createdAt) VALUES (?, ?, ?, ?)"
  );
  stmt.run(commitment, idx, txHash || null, Date.now());
}

function listCommitments(db) {
  return db.prepare("SELECT commitment, idx FROM commitments ORDER BY idx ASC").all();
}

function getCommitment(db, commitment) {
  return db.prepare("SELECT commitment, idx FROM commitments WHERE commitment = ?").get(commitment);
}

function exportAll(db) {
  const intents = db.prepare("SELECT payload FROM intents ORDER BY createdAt DESC").all();
  const receipts = db.prepare("SELECT payload FROM receipts ORDER BY createdAt DESC").all();
  const quotes = db.prepare("SELECT payload FROM quotes ORDER BY createdAt DESC").all();
  const commitments = db.prepare("SELECT commitment, idx, txHash, createdAt FROM commitments ORDER BY idx ASC").all();
  return {
    intents: intents.map((r) => JSON.parse(r.payload)),
    receipts: receipts.map((r) => JSON.parse(r.payload)),
    quotes: quotes.map((r) => JSON.parse(r.payload)),
    commitments
  };
}

module.exports = {
  initDb,
  saveIntent,
  getIntent,
  saveReceipt,
  getReceipt,
  listReceipts,
  saveQuote,
  exportAll,
  saveCommitment,
  listCommitments,
  getCommitment
};
