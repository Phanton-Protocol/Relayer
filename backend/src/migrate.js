const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "relayer.db");
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function runMigrations() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY)");

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const id = file;
    const applied = db.prepare("SELECT id FROM _migrations WHERE id = ?").get(id);
    if (applied) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.exec(sql);
    db.prepare("INSERT INTO _migrations(id) VALUES (?)").run(id);
  }

  db.close();
}

runMigrations();
