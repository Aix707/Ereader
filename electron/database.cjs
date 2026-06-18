const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const DEFAULT_PREFS = {
  fontSize: 18,
  lineHeight: 1.8,
  pageSpread: "single",
  readingDirection: "ltr",
  fitMode: "contain"
};

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sourceStats(sourcePath, kind) {
  if (!fs.existsSync(sourcePath)) {
    return {
      exists: false,
      size: null,
      mtimeMs: null,
      fingerprint: null
    };
  }
  if (kind === "folder") {
    const entries = fs
      .readdirSync(sourcePath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filePath = path.join(sourcePath, entry.name);
        const stat = fs.statSync(filePath);
        return `${entry.name}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
      })
      .sort();
    return {
      exists: true,
      size: entries.length,
      mtimeMs: fs.statSync(sourcePath).mtimeMs,
      fingerprint: sha256(entries.join("|"))
    };
  }
  const stat = fs.statSync(sourcePath);
  return {
    exists: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    fingerprint: sha256(`${sourcePath}:${stat.size}:${Math.floor(stat.mtimeMs)}`)
  };
}

function defaultContentType(format) {
  return format === "image-folder" ? "comic" : "novel";
}

function normalizeProgress(progress = {}) {
  return {
    kind: progress.kind || "none",
    percent: Number(progress.percent || 0),
    page: progress.page ?? null,
    totalPages: progress.totalPages ?? progress.total_pages ?? null,
    unitIndex: progress.unitIndex ?? progress.unit_index ?? null,
    scrollRatio: progress.scrollRatio ?? progress.scroll_ratio ?? null,
    locator: progress.locator ?? null
  };
}

function normalizePrefs(preferences = {}) {
  return {
    fontSize: preferences.fontSize ?? preferences.font_size ?? DEFAULT_PREFS.fontSize,
    lineHeight: preferences.lineHeight ?? preferences.line_height ?? DEFAULT_PREFS.lineHeight,
    pageSpread: preferences.pageSpread ?? preferences.page_spread ?? DEFAULT_PREFS.pageSpread,
    readingDirection: preferences.readingDirection ?? preferences.reading_direction ?? DEFAULT_PREFS.readingDirection,
    fitMode: preferences.fitMode ?? preferences.fit_mode ?? DEFAULT_PREFS.fitMode
  };
}

function createRepository(userDataPath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  const dbPath = path.join(userDataPath, "library.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_format TEXT NOT NULL,
      content_type TEXT NOT NULL,
      added_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_opened_at TEXT,
      source_size INTEGER,
      source_mtime_ms REAL,
      source_sha256 TEXT,
      import_status TEXT NOT NULL DEFAULT 'queued',
      import_progress REAL NOT NULL DEFAULT 0,
      import_error TEXT,
      unit_count INTEGER NOT NULL DEFAULT 0,
      asset_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS preferences (
      book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      font_size INTEGER NOT NULL,
      line_height REAL NOT NULL,
      page_spread TEXT NOT NULL,
      reading_direction TEXT NOT NULL,
      fit_mode TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS progress (
      book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      percent REAL NOT NULL DEFAULT 0,
      page INTEGER,
      total_pages INTEGER,
      unit_index INTEGER,
      scroll_ratio REAL,
      locator TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS renditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source_fingerprint TEXT
    );

    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL,
      mime TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      byte_length INTEGER NOT NULL,
      data BLOB NOT NULL,
      source_ref TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reading_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      rendition_id INTEGER NOT NULL REFERENCES renditions(id) ON DELETE CASCADE,
      unit_index INTEGER NOT NULL,
      unit_type TEXT NOT NULL,
      title TEXT,
      text TEXT,
      html TEXT,
      asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
      metadata_json TEXT,
      UNIQUE(book_id, rendition_id, unit_index)
    );

    CREATE TABLE IF NOT EXISTS diagnostics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id TEXT REFERENCES books(id) ON DELETE CASCADE,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS import_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      message TEXT,
      started_at TEXT,
      finished_at TEXT
    );
  `);

  const statements = {
    bookById: db.prepare("SELECT * FROM books WHERE id = ?"),
    prefsById: db.prepare("SELECT * FROM preferences WHERE book_id = ?"),
    progressById: db.prepare("SELECT * FROM progress WHERE book_id = ?"),
    coverById: db.prepare(
      `SELECT a.id AS coverAssetId, a.width AS coverWidth, a.height AS coverHeight
       FROM reading_units ru
       JOIN assets a ON a.id = ru.asset_id
       WHERE ru.book_id = ?
         AND ru.asset_id IS NOT NULL
         AND ru.unit_type IN ('page', 'image')
       ORDER BY
         CASE ru.unit_type WHEN 'page' THEN 0 WHEN 'image' THEN 1 ELSE 2 END,
         ru.unit_index
       LIMIT 1`
    ),
    insertDiagnostic: db.prepare(
      "INSERT INTO diagnostics (book_id, level, message, details_json, created_at) VALUES (?, ?, ?, ?, ?)"
    ),
    updateBookStatus: db.prepare(
      `UPDATE books
       SET import_status = ?, import_progress = ?, import_error = ?, updated_at = ?
       WHERE id = ?`
    ),
    updateCounts: db.prepare(
      `UPDATE books
       SET unit_count = (SELECT COUNT(*) FROM reading_units WHERE book_id = ?),
           asset_count = (SELECT COUNT(*) FROM assets WHERE book_id = ?),
           updated_at = ?
       WHERE id = ?`
    )
  };

  function rowToBook(row) {
    const prefs = normalizePrefs(statements.prefsById.get(row.id) || {});
    const progress = normalizeProgress(statements.progressById.get(row.id) || {});
    const cover = statements.coverById.get(row.id);
    const stats = sourceStats(row.source_path, row.source_kind);
    const stale =
      row.import_status === "ready" &&
      stats.exists &&
      row.source_sha256 &&
      stats.fingerprint &&
      row.source_sha256 !== stats.fingerprint;
    return {
      id: row.id,
      title: row.title,
      path: row.source_path,
      kind: row.source_kind,
      format: row.source_format,
      contentType: row.content_type,
      coverAssetId: cover?.coverAssetId || null,
      coverWidth: cover?.coverWidth || null,
      coverHeight: cover?.coverHeight || null,
      coverKind: cover ? "asset" : "generated",
      addedAt: row.added_at,
      updatedAt: row.updated_at,
      lastOpenedAt: row.last_opened_at,
      size: row.source_size,
      sourceExists: stats.exists,
      importStatus: stale ? "stale" : row.import_status,
      importProgress: row.import_progress,
      importError: row.import_error,
      unitCount: row.unit_count,
      assetCount: row.asset_count,
      preferences: prefs,
      progress
    };
  }

  function getBook(id) {
    const row = statements.bookById.get(id);
    return row ? rowToBook(row) : null;
  }

  function getRawBook(id) {
    return statements.bookById.get(id);
  }

  function listBooks() {
    const rows = db.prepare("SELECT * FROM books ORDER BY COALESCE(last_opened_at, added_at) DESC").all();
    return { version: 2, dbPath, books: rows.map(rowToBook) };
  }

  function upsertBook(source) {
    const stats = sourceStats(source.path, source.kind);
    const existing = statements.bookById.get(source.id);
    const timestamp = nowIso();
    db.prepare(
      `INSERT INTO books (
        id, title, source_path, source_kind, source_format, content_type, added_at, updated_at,
        last_opened_at, source_size, source_mtime_ms, source_sha256, import_status, import_progress,
        import_error, unit_count, asset_count
      )
      VALUES (
        @id, @title, @source_path, @source_kind, @source_format, @content_type, @added_at, @updated_at,
        @last_opened_at, @source_size, @source_mtime_ms, @source_sha256, @import_status, @import_progress,
        @import_error, @unit_count, @asset_count
      )
      ON CONFLICT(id) DO UPDATE SET
        title = COALESCE(books.title, excluded.title),
        source_path = excluded.source_path,
        source_kind = excluded.source_kind,
        source_format = excluded.source_format,
        source_size = excluded.source_size,
        source_mtime_ms = excluded.source_mtime_ms,
        source_sha256 = excluded.source_sha256,
        import_status = CASE WHEN books.source_sha256 IS NOT excluded.source_sha256 THEN 'queued' ELSE books.import_status END,
        import_progress = CASE WHEN books.source_sha256 IS NOT excluded.source_sha256 THEN 0 ELSE books.import_progress END,
        import_error = CASE WHEN books.source_sha256 IS NOT excluded.source_sha256 THEN NULL ELSE books.import_error END,
        updated_at = excluded.updated_at`
    ).run({
      id: source.id,
      title: source.title,
      source_path: source.path,
      source_kind: source.kind,
      source_format: source.format,
      content_type: existing?.content_type || source.contentType || defaultContentType(source.format),
      added_at: existing?.added_at || timestamp,
      updated_at: timestamp,
      last_opened_at: existing?.last_opened_at || null,
      source_size: stats.size,
      source_mtime_ms: stats.mtimeMs,
      source_sha256: stats.fingerprint,
      import_status: "queued",
      import_progress: 0,
      import_error: null,
      unit_count: existing?.unit_count || 0,
      asset_count: existing?.asset_count || 0
    });
    upsertPreferences(source.id, normalizePrefs(existing ? statements.prefsById.get(source.id) : source.preferences));
    upsertProgress(source.id, normalizeProgress(existing ? statements.progressById.get(source.id) : source.progress));
    return getBook(source.id);
  }

  function upsertPreferences(bookId, preferences) {
    const prefs = normalizePrefs(preferences);
    db.prepare(
      `INSERT INTO preferences (book_id, font_size, line_height, page_spread, reading_direction, fit_mode)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(book_id) DO UPDATE SET
        font_size = excluded.font_size,
        line_height = excluded.line_height,
        page_spread = excluded.page_spread,
        reading_direction = excluded.reading_direction,
        fit_mode = excluded.fit_mode`
    ).run(bookId, prefs.fontSize, prefs.lineHeight, prefs.pageSpread, prefs.readingDirection, prefs.fitMode);
  }

  function upsertProgress(bookId, progress) {
    const next = normalizeProgress(progress);
    db.prepare(
      `INSERT INTO progress (book_id, kind, percent, page, total_pages, unit_index, scroll_ratio, locator, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(book_id) DO UPDATE SET
        kind = excluded.kind,
        percent = excluded.percent,
        page = excluded.page,
        total_pages = excluded.total_pages,
        unit_index = excluded.unit_index,
        scroll_ratio = excluded.scroll_ratio,
        locator = excluded.locator,
        updated_at = excluded.updated_at`
    ).run(
      bookId,
      next.kind,
      next.percent,
      next.page,
      next.totalPages,
      next.unitIndex,
      next.scrollRatio,
      next.locator,
      nowIso()
    );
  }

  function updateBook(bookId, patch) {
    const current = getBook(bookId);
    if (!current) throw new Error("Book not found");
    if (patch.contentType) {
      db.prepare("UPDATE books SET content_type = ?, import_status = 'queued', import_progress = 0, updated_at = ? WHERE id = ?").run(
        patch.contentType,
        nowIso(),
        bookId
      );
    }
    if (patch.title || patch.lastOpenedAt) {
      db.prepare(
        `UPDATE books
         SET title = COALESCE(?, title),
             last_opened_at = COALESCE(?, last_opened_at),
             updated_at = ?
         WHERE id = ?`
      ).run(patch.title || null, patch.lastOpenedAt || null, nowIso(), bookId);
    }
    if (patch.preferences) upsertPreferences(bookId, { ...current.preferences, ...patch.preferences });
    if (patch.progress) upsertProgress(bookId, { ...current.progress, ...patch.progress });
    return getBook(bookId);
  }

  function removeBook(bookId) {
    db.prepare("DELETE FROM books WHERE id = ?").run(bookId);
    return listBooks();
  }

  function setStatus(bookId, status, progress = 0, error = null) {
    statements.updateBookStatus.run(status, progress, error, nowIso(), bookId);
  }

  function addDiagnostic(bookId, level, message, details = null) {
    statements.insertDiagnostic.run(bookId, level, message, details ? JSON.stringify(details) : null, nowIso());
  }

  function beginRendition(bookId, kind, sourceFingerprint) {
    db.prepare("DELETE FROM reading_units WHERE book_id = ?").run(bookId);
    db.prepare("DELETE FROM assets WHERE book_id = ?").run(bookId);
    db.prepare("DELETE FROM renditions WHERE book_id = ?").run(bookId);
    const result = db
      .prepare("INSERT INTO renditions (book_id, kind, created_at, source_fingerprint) VALUES (?, ?, ?, ?)")
      .run(bookId, kind, nowIso(), sourceFingerprint || null);
    return Number(result.lastInsertRowid);
  }

  function insertAsset(bookId, asset) {
    const data = Buffer.isBuffer(asset.data) ? asset.data : Buffer.from(asset.data);
    const hash = sha256(data);
    const result = db
      .prepare(
        `INSERT INTO assets (book_id, sha256, mime, width, height, byte_length, data, source_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        bookId,
        hash,
        asset.mime,
        asset.width || null,
        asset.height || null,
        data.length,
        data,
        asset.sourceRef || null,
        nowIso()
      );
    return Number(result.lastInsertRowid);
  }

  function insertUnit(bookId, renditionId, unit) {
    db.prepare(
      `INSERT INTO reading_units (
        book_id, rendition_id, unit_index, unit_type, title, text, html, asset_id, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      bookId,
      renditionId,
      unit.index,
      unit.type,
      unit.title || null,
      unit.text || null,
      unit.html || null,
      unit.assetId || null,
      unit.metadata ? JSON.stringify(unit.metadata) : null
    );
  }

  function writeTransaction(work) {
    return db.transaction(work)();
  }

  function refreshCounts(bookId) {
    statements.updateCounts.run(bookId, bookId, nowIso(), bookId);
  }

  function finishContent(bookId) {
    refreshCounts(bookId);
    setStatus(bookId, "ready", 1, null);
  }

  function getTextUnits(bookId) {
    return db
      .prepare(
        `SELECT ru.id, ru.unit_index AS unitIndex, ru.unit_type AS type, ru.title, ru.text, ru.html,
                ru.asset_id AS assetId, ru.metadata_json AS metadataJson,
                a.mime, a.width, a.height, a.byte_length AS byteLength
         FROM reading_units ru
         LEFT JOIN assets a ON a.id = ru.asset_id
         WHERE ru.book_id = ? AND ru.unit_type IN ('heading', 'paragraph', 'html', 'image')
         ORDER BY ru.unit_index`
      )
      .all(bookId)
      .map((row) => ({
        ...row,
        metadata: row.metadataJson ? JSON.parse(row.metadataJson) : null
      }));
  }

  function getPageUnits(bookId) {
    return db
      .prepare(
        `SELECT ru.id, ru.unit_index AS unitIndex, ru.unit_type AS type, ru.title,
                ru.asset_id AS assetId, ru.metadata_json AS metadataJson,
                a.mime, a.width, a.height, a.byte_length AS byteLength
         FROM reading_units ru
         JOIN assets a ON a.id = ru.asset_id
         WHERE ru.book_id = ? AND ru.unit_type = 'page'
         ORDER BY ru.unit_index`
      )
      .all(bookId)
      .map((row) => ({
        ...row,
        metadata: row.metadataJson ? JSON.parse(row.metadataJson) : null
      }));
  }

  function getAsset(assetId) {
    return db.prepare("SELECT id, mime, width, height, data FROM assets WHERE id = ?").get(assetId);
  }

  function diagnosticsSummary() {
    const books = db
      .prepare(
        `SELECT b.id, b.title, b.source_path AS path, b.source_format AS format, b.content_type AS contentType,
                b.import_status AS importStatus, b.import_progress AS importProgress, b.import_error AS importError,
                b.unit_count AS unitCount, b.asset_count AS assetCount,
                (SELECT COUNT(*) FROM diagnostics d WHERE d.book_id = b.id) AS diagnosticCount
         FROM books b
         ORDER BY COALESCE(b.last_opened_at, b.added_at) DESC`
      )
      .all()
      .map((book) => ({ ...book, sourceExists: fs.existsSync(book.path) }));
    const recentDiagnostics = db
      .prepare(
        `SELECT d.id, d.book_id AS bookId, b.title, d.level, d.message, d.details_json AS detailsJson, d.created_at AS createdAt
         FROM diagnostics d
         LEFT JOIN books b ON b.id = d.book_id
         ORDER BY d.id DESC
         LIMIT 80`
      )
      .all()
      .map((row) => ({ ...row, details: row.detailsJson ? JSON.parse(row.detailsJson) : null }));
    const stats = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM books) AS books,
          (SELECT COUNT(*) FROM reading_units) AS units,
          (SELECT COUNT(*) FROM assets) AS assets,
          (SELECT COALESCE(SUM(byte_length), 0) FROM assets) AS assetBytes`
      )
      .get();
    const integrity = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM assets a
           WHERE NOT EXISTS (SELECT 1 FROM reading_units ru WHERE ru.asset_id = a.id)) AS orphanAssets,
          (SELECT COUNT(*) FROM reading_units ru
           WHERE ru.asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = ru.asset_id)) AS missingAssets,
          (SELECT COUNT(*) FROM books b WHERE b.import_status = 'ready' AND b.unit_count = 0) AS readyWithoutUnits,
          (SELECT COALESCE(MAX(byte_length), 0) FROM assets) AS largestAssetBytes`
      )
      .get();
    return { dbPath, stats: { ...stats, ...integrity }, books, recentDiagnostics };
  }

  function migrateFromJson(jsonPath) {
    const existingCount = db.prepare("SELECT COUNT(*) AS count FROM books").get().count;
    if (existingCount > 0 || !fs.existsSync(jsonPath)) return;
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    if (!Array.isArray(parsed.books)) return;
    const migrate = db.transaction((books) => {
      for (const book of books) {
        upsertBook({
          id: book.id,
          title: book.title,
          path: book.path,
          kind: book.kind,
          format: book.format,
          contentType: book.contentType,
          preferences: book.preferences,
          progress: book.progress
        });
        if (book.lastOpenedAt) {
          db.prepare("UPDATE books SET last_opened_at = ? WHERE id = ?").run(book.lastOpenedAt, book.id);
        }
      }
    });
    migrate(parsed.books);
    fs.copyFileSync(jsonPath, `${jsonPath}.bak`);
  }

  function booksNeedingImport() {
    return db
      .prepare("SELECT id FROM books WHERE import_status IN ('queued', 'error', 'stale')")
      .all()
      .map((row) => row.id);
  }

  return {
    db,
    dbPath,
    listBooks,
    getBook,
    getRawBook,
    upsertBook,
    updateBook,
    removeBook,
    setStatus,
    addDiagnostic,
    beginRendition,
    insertAsset,
    insertUnit,
    writeTransaction,
    refreshCounts,
    finishContent,
    getTextUnits,
    getPageUnits,
    getAsset,
    diagnosticsSummary,
    migrateFromJson,
    booksNeedingImport,
    sourceStats
  };
}

module.exports = {
  createRepository,
  DEFAULT_PREFS,
  sha256,
  sourceStats
};
