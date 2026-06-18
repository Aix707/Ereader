const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

async function main() {
  app.setName("ereader");
  await app.whenReady();
  const Database = require("better-sqlite3");
  const dbPath = path.join(process.env.APPDATA || app.getPath("appData"), "ereader", "library.sqlite");

  function fail(message) {
    console.error(message);
    process.exitCode = 1;
  }

  if (!fs.existsSync(dbPath)) {
    fail(`SQLite database not found: ${dbPath}`);
    app.quit();
    return;
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  const required = ["books", "renditions", "reading_units", "assets", "progress", "preferences", "diagnostics"];
  const missing = required.filter((name) => !tables.includes(name));
  if (missing.length) fail(`Missing tables: ${missing.join(", ")}`);

  const stats = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM books) AS books,
    (SELECT COUNT(*) FROM reading_units) AS units,
    (SELECT COUNT(*) FROM assets) AS assets,
    (SELECT COALESCE(SUM(byte_length), 0) FROM assets) AS assetBytes
`).get();

  const books = db.prepare(`
  SELECT b.id, b.title, b.source_path AS path, b.source_format AS format, b.content_type AS contentType,
         b.import_status AS status, b.import_progress AS progress, b.import_error AS error,
         b.unit_count AS unitCount, b.asset_count AS assetCount
  FROM books b
  ORDER BY COALESCE(b.last_opened_at, b.added_at) DESC
`).all();

  console.log(`Database: ${dbPath}`);
  console.log(`Tables: ${tables.join(", ")}`);
  console.log(`Books: ${stats.books}, units: ${stats.units}, assets: ${stats.assets}, asset bytes: ${(stats.assetBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log("");

  for (const book of books) {
    const exists = fs.existsSync(book.path);
    const line = [
      book.status.padEnd(10),
      book.format.padEnd(12),
      book.contentType.padEnd(6),
      `${String(book.unitCount).padStart(5)} units`,
      `${String(book.assetCount).padStart(5)} assets`,
      exists ? "source:ok" : "source:missing",
      book.title
    ].join(" | ");
    console.log(line);
    if (book.error) console.log(`  error: ${book.error}`);
  }

  const errors = db.prepare(`
  SELECT b.title, d.level, d.message, d.created_at AS createdAt
  FROM diagnostics d
  LEFT JOIN books b ON b.id = d.book_id
  WHERE d.level IN ('error', 'warn')
  ORDER BY d.id DESC
  LIMIT 20
`).all();

  if (errors.length) {
    console.log("");
    console.log("Recent warnings/errors:");
    for (const item of errors) {
      console.log(`${item.createdAt} [${item.level}] ${item.title || "System"}: ${item.message}`);
    }
  }

  db.close();
  app.quit();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  app.quit();
});
