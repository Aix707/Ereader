use chrono::{Duration, Local, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
  path::{Path, PathBuf},
  sync::mpsc,
  time::Instant,
};

pub type Result<T> = std::result::Result<T, String>;
pub fn now() -> String {
  Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn hash(bytes: &[u8]) -> String {
  format!("{:x}", Sha256::digest(bytes))
}
pub fn merge(target: &mut Value, patch: &Value) {
  if let (Some(dst), Some(src)) = (target.as_object_mut(), patch.as_object()) {
    for (key, value) in src {
      if value.is_object() {
        merge(dst.entry(key).or_insert(json!({})), value);
      } else {
        dst.insert(key.clone(), value.clone());
      }
    }
  }
}
pub fn settings() -> Value {
  json!({"novelReading":{"fontSize":18,"fontFamily":"serif","lineHeight":1.8,"paragraphSpacing":1.1,"pageWidth":800},"appearance":{"backgroundOpacity":0.18,"backgroundLayerMode":"default","backgroundImageVersion":0}})
}
pub fn preferences(comic: bool) -> Value {
  json!({"fontSize":18,"lineHeight":1.8,"pageSpread":if comic {"double"} else {"single"},"readingDirection":"rtl"})
}

type Task = Box<dyn FnOnce(&mut Repository) + Send>;
#[derive(Clone)]
pub struct Db {
  tx: mpsc::Sender<Task>,
}
impl Db {
  pub fn open(directory: PathBuf) -> Result<Self> {
    let (tx, rx) = mpsc::channel::<Task>();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    std::thread::Builder::new()
      .name("library-database".into())
      .spawn(move || match Repository::open(&directory) {
        Ok(mut repo) => {
          let _ = ready_tx.send(Ok(()));
          loop {
            let task = if repo.needs_reclaim {
              match rx.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(task) => task,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                  let _ = repo.reclaim();
                  continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
              }
            } else {
              match rx.recv() {
                Ok(task) => task,
                Err(_) => break,
              }
            };
            task(&mut repo);
          }
        }
        Err(error) => {
          let _ = ready_tx.send(Err(error));
        }
      })
      .map_err(|e| e.to_string())?;
    ready_rx.recv().map_err(|e| e.to_string())??;
    Ok(Self { tx })
  }
  pub async fn call<T: Send + 'static>(
    &self,
    task: impl FnOnce(&mut Repository) -> Result<T> + Send + 'static,
  ) -> Result<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    self
      .tx
      .send(Box::new(move |repo| {
        let _ = tx.send(task(repo));
      }))
      .map_err(|_| "Database stopped")?;
    rx.await.map_err(|_| "Database stopped".to_string())?
  }
}

pub struct Repository {
  pub conn: Connection,
  pub path: PathBuf,
  needs_reclaim: bool,
}
impl Repository {
  pub fn readonly(directory: &Path) -> Result<Self> {
    let path = directory.join("library.sqlite");
    let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
      .map_err(|e| e.to_string())?;
    Ok(Self {
      conn,
      path,
      needs_reclaim: false,
    })
  }
  pub fn open(directory: &Path) -> Result<Self> {
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let path = directory.join("library.sqlite");
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn
      .busy_timeout(std::time::Duration::from_secs(5))
      .map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY, path_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL, active_rendition INTEGER);
      CREATE TABLE IF NOT EXISTS renditions(id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS assets(id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, hash TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes BLOB NOT NULL, UNIQUE(book_id,hash));
      CREATE TABLE IF NOT EXISTS units(id INTEGER PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, rendition_id INTEGER NOT NULL REFERENCES renditions(id) ON DELETE CASCADE, unit_index INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT, text TEXT, html TEXT, asset_id INTEGER REFERENCES assets(id), metadata TEXT, UNIQUE(rendition_id,unit_index));
      CREATE INDEX IF NOT EXISTS units_book ON units(book_id,rendition_id,unit_index);
      CREATE INDEX IF NOT EXISTS units_asset ON units(asset_id);
      CREATE INDEX IF NOT EXISTS renditions_book ON renditions(book_id);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, rendition_id INTEGER REFERENCES renditions(id) ON DELETE CASCADE, status TEXT NOT NULL, fingerprint TEXT NOT NULL, content_type TEXT);
      CREATE INDEX IF NOT EXISTS jobs_book ON jobs(book_id);
      CREATE TABLE IF NOT EXISTS diagnostics(id INTEGER PRIMARY KEY, book_id TEXT REFERENCES books(id) ON DELETE CASCADE, message TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, kind TEXT NOT NULL, at TEXT NOT NULL, percent REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_time ON activity(at);
      CREATE INDEX IF NOT EXISTS activity_book ON activity(book_id,kind,id);
      PRAGMA user_version=2;").map_err(|e| e.to_string())?;
    if !conn
      .query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('jobs') WHERE name='content_type')",
        [],
        |r| r.get::<_, bool>(0),
      )
      .map_err(|e| e.to_string())?
    {
      conn
        .execute_batch("ALTER TABLE jobs ADD COLUMN content_type TEXT")
        .map_err(|e| e.to_string())?;
    }
    let mut repo = Self {
      conn,
      path,
      needs_reclaim: true,
    };
    let pending: Vec<String> = repo
      .conn
      .prepare("SELECT id FROM jobs WHERE status IN ('processing','queued')")
      .map_err(|e| e.to_string())?
      .query_map([], |r| r.get(0))
      .map_err(|e| e.to_string())?
      .collect::<rusqlite::Result<_>>()
      .map_err(|e| e.to_string())?;
    for id in pending {
      repo.abort(&id, "error", "导入被中断，请重新导入或重建")?;
    }
    Ok(repo)
  }
  pub fn get(&self, id: &str) -> Result<Option<Value>> {
    let data: Option<String> = self
      .conn
      .prepare_cached("SELECT data FROM books WHERE id=?")
      .map_err(|e| e.to_string())?
      .query_row([id], |r| r.get(0))
      .optional()
      .map_err(|e| e.to_string())?;
    data
      .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
      .transpose()
  }
  pub fn save(&self, book: &Value) -> Result<()> {
    self
      .conn
      .prepare_cached("UPDATE books SET data=? WHERE id=?")
      .map_err(|e| e.to_string())?
      .execute(params![
        book.to_string(),
        book["id"].as_str().ok_or("Missing book ID")?
      ])
      .map_err(|e| e.to_string())?;
    Ok(())
  }
  pub fn list(&self) -> Result<Value> {
    let books: Vec<Value> = self.conn.prepare_cached("SELECT data FROM books ORDER BY COALESCE(json_extract(data,'$.lastOpenedAt'),json_extract(data,'$.addedAt')) DESC").map_err(|e| e.to_string())?.query_map([], |r| r.get::<_,String>(0)).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string()).and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))).collect::<Result<_>>()?;
    Ok(json!({"version":2,"dbPath":self.path,"books":books}))
  }
  pub fn add(&self, path: &Path) -> Result<Value> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let key = path
      .to_string_lossy()
      .trim_start_matches("\\\\?\\")
      .to_lowercase();
    let id = hash(key.as_bytes())[..20].to_string();
    if let Some(book) = self.get(&id)? {
      return Ok(book);
    }
    let format = if metadata.is_dir() {
      "image-folder"
    } else {
      match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
      {
        "txt" => "txt",
        "pdf" => "pdf",
        "epub" => "epub",
        "mobi" | "azw" | "azw3" => "mobi",
        _ => return Err("不支持的书籍格式".into()),
      }
    };
    let comic = format == "image-folder";
    let book = json!({"id":id,"title":if metadata.is_dir(){path.file_name().unwrap_or_default().to_string_lossy()}else{path.file_stem().unwrap_or_default().to_string_lossy()},"path":path,"kind":if metadata.is_dir(){"folder"}else{"file"},"format":format,"contentType":if comic{"comic"}else{"novel"},"addedAt":now(),"updatedAt":now(),"size":metadata.len(),"sourceExists":true,"importStatus":"queued","importProgress":0,"unitCount":0,"assetCount":0,"progress":{"kind":"none"},"preferences":preferences(comic),"coverKind":"generated"});
    self
      .conn
      .execute(
        "INSERT INTO books(id,path_key,data) VALUES(?,?,?)",
        params![id, key, book.to_string()],
      )
      .map_err(|e| e.to_string())?;
    Ok(book)
  }
  pub fn patch(&mut self, id: &str, patch: &Value) -> Result<Value> {
    let mut book = self.get(id)?.ok_or("Book not found")?;
    for key in ["title", "lastOpenedAt"] {
      if let Some(value) = patch.get(key).and_then(Value::as_str) {
        book[key] = json!(value);
      }
    }
    if let Some(kind) = patch.get("contentType").and_then(Value::as_str) {
      if !["comic", "novel"].contains(&kind) {
        return Err("Invalid content type".into());
      }
      book["requestedContentType"] = json!(kind);
      book["contentTypeOverride"] = json!(true);
    }
    if let Some(prefs) = patch.get("preferences") {
      for (key, choices) in [
        ("pageSpread", &["single", "double"][..]),
        ("readingDirection", &["ltr", "rtl"][..]),
      ] {
        if let Some(value) = prefs.get(key).and_then(Value::as_str) {
          if !choices.contains(&value) {
            return Err("Invalid preference".into());
          }
          book["preferences"][key] = json!(value);
        }
      }
      for (key, min, max) in [("fontSize", 12., 48.), ("lineHeight", 1., 3.)] {
        if let Some(n) = prefs.get(key).and_then(Value::as_f64) {
          book["preferences"][key] = json!(n.clamp(min, max));
        }
      }
    }
    let mut event = None;
    if let Some(progress) = patch.get("progress") {
      if let Some(kind) = progress.get("kind").and_then(Value::as_str) {
        if !["none", "scroll", "page", "cfi"].contains(&kind) {
          return Err("Invalid progress kind".into());
        }
      }
      for key in [
        "kind",
        "percent",
        "page",
        "totalPages",
        "unitIndex",
        "scrollRatio",
        "locator",
      ] {
        if let Some(value) = progress.get(key) {
          book["progress"][key] = value.clone();
        }
      }
      for key in ["percent", "scrollRatio"] {
        if let Some(n) = book["progress"][key].as_f64() {
          book["progress"][key] = json!(n.clamp(0., 1.));
        }
      }
      let last: Option<(String,f64)> = self.conn.query_row("SELECT at,percent FROM activity WHERE book_id=? AND kind='progress' ORDER BY id DESC LIMIT 1",[id],|r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e| e.to_string())?;
      let percent = book["progress"]["percent"].as_f64().unwrap_or(0.);
      if last
        .map(|(at, p)| {
          (percent - p).abs() >= 0.02
            || chrono::DateTime::parse_from_rfc3339(&at)
              .map(|t| Utc::now().signed_duration_since(t).num_seconds() >= 300)
              .unwrap_or(true)
        })
        .unwrap_or(true)
      {
        event = Some("progress");
      }
    } else if patch.get("lastOpenedAt").is_some() {
      event = Some("open");
    }
    book["updatedAt"] = json!(now());
    let tx = self.conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
      "UPDATE books SET data=? WHERE id=?",
      params![book.to_string(), id],
    )
    .map_err(|e| e.to_string())?;
    if let Some(kind) = event {
      tx.execute(
        "INSERT INTO activity(book_id,kind,at,percent) VALUES(?,?,?,?)",
        params![
          id,
          kind,
          now(),
          book["progress"]["percent"].as_f64().unwrap_or(0.)
        ],
      )
      .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(book)
  }
  pub fn setting(&self) -> Result<Value> {
    let data: Option<String> = self
      .conn
      .query_row("SELECT data FROM settings WHERE key='app'", [], |r| {
        r.get(0)
      })
      .optional()
      .map_err(|e| e.to_string())?;
    data
      .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
      .unwrap_or_else(|| Ok(settings()))
  }
  pub fn update_settings(&self, patch: &Value) -> Result<Value> {
    if !patch.is_object()
      || ["novelReading", "appearance"]
        .iter()
        .any(|key| patch.get(key).is_some_and(|value| !value.is_object()))
    {
      return Err("Invalid settings patch".into());
    }
    let mut value = self.setting()?;
    merge(&mut value, patch);
    for (key, min, max, default) in [
      ("fontSize", 16., 28., 18.),
      ("lineHeight", 1.45, 2.2, 1.8),
      ("paragraphSpacing", 0.4, 2.2, 1.1),
      ("pageWidth", 620., 980., 800.),
    ] {
      value["novelReading"][key] = json!(value["novelReading"][key]
        .as_f64()
        .unwrap_or(default)
        .clamp(min, max));
    }
    let family: String = value["novelReading"]["fontFamily"]
      .as_str()
      .unwrap_or("serif")
      .chars()
      .filter(|c| !c.is_control() && !";\"{}".contains(*c))
      .take(120)
      .collect();
    value["novelReading"]["fontFamily"] = json!(if family.trim().is_empty() {
      "serif"
    } else {
      family.trim()
    });
    value["appearance"]["backgroundOpacity"] = json!(value["appearance"]["backgroundOpacity"]
      .as_f64()
      .unwrap_or(0.18)
      .clamp(0., 1.));
    if !["default", "image", "none"].contains(
      &value["appearance"]["backgroundLayerMode"]
        .as_str()
        .unwrap_or(""),
    ) {
      value["appearance"]["backgroundLayerMode"] = json!("default");
    }
    self.conn.execute("INSERT INTO settings(key,data) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",[value.to_string()]).map_err(|e| e.to_string())?;
    Ok(value)
  }
  pub fn queue(&self, id: &str, job: &str, fingerprint: &str) -> Result<()> {
    let mut book = self.get(id)?.ok_or("Book not found")?;
    book["importStatus"] = json!("queued");
    book["importProgress"] = json!(0);
    book["importError"] = Value::Null;
    self.save(&book)?;
    self
      .conn
      .execute(
        "INSERT INTO jobs(id,book_id,status,fingerprint) VALUES(?,?,'queued',?)",
        params![job, id, fingerprint],
      )
      .map_err(|e| e.to_string())?;
    Ok(())
  }
  pub fn start(&self, job: &str) -> Result<()> {
    let id: String = self
      .conn
      .query_row(
        "SELECT book_id FROM jobs WHERE id=? AND status='queued'",
        [job],
        |r| r.get(0),
      )
      .map_err(|e| e.to_string())?;
    self
      .conn
      .execute("INSERT INTO renditions(book_id) VALUES(?)", [&id])
      .map_err(|e| e.to_string())?;
    self
      .conn
      .execute(
        "UPDATE jobs SET rendition_id=?,status='processing' WHERE id=?",
        params![self.conn.last_insert_rowid(), job],
      )
      .map_err(|e| e.to_string())?;
    self.status(&id, "processing", 0., None)
  }
  pub fn active(&self, job: &str) -> Result<(String, i64)> {
    self
      .conn
      .prepare_cached("SELECT book_id,rendition_id FROM jobs WHERE id=? AND status='processing'")
      .map_err(|e| e.to_string())?
      .query_row([job], |r| Ok((r.get(0)?, r.get(1)?)))
      .map_err(|_| "Import cancelled or expired".into())
  }
  pub fn configure(&self, job: &str, kind: &str) -> Result<()> {
    self.active(job)?;
    if !["novel", "comic"].contains(&kind) {
      return Err("Invalid content type".into());
    }
    self
      .conn
      .execute(
        "UPDATE jobs SET content_type=? WHERE id=?",
        params![kind, job],
      )
      .map_err(|e| e.to_string())?;
    Ok(())
  }
  pub fn status(&self, id: &str, status: &str, progress: f64, error: Option<&str>) -> Result<()> {
    if let Some(mut book) = self.get(id)? {
      book["importStatus"] = json!(status);
      book["importProgress"] = json!(progress.clamp(0., 1.));
      book["importError"] = json!(error);
      book["updatedAt"] = json!(now());
      self.save(&book)?;
    }
    Ok(())
  }
  pub fn asset(&self, job: &str, meta: &Value, bytes: &[u8]) -> Result<i64> {
    let (id, _) = self.active(job)?;
    if meta["mime"] != "image/webp"
      || !bytes.starts_with(b"RIFF")
      || bytes.get(8..12) != Some(b"WEBP")
    {
      return Err("Invalid encoded asset".into());
    }
    let width = meta["width"].as_u64().ok_or("Missing image width")?;
    let height = meta["height"].as_u64().ok_or("Missing image height")?;
    if width == 0 || height == 0 || width.max(height) > 3200 || bytes.len() > 64 * 1024 * 1024 {
      return Err("Image budget exceeded".into());
    }
    let digest = hash(bytes);
    self.conn.prepare_cached("INSERT OR IGNORE INTO assets(book_id,hash,mime,width,height,bytes) VALUES(?,?,'image/webp',?,?,?)").map_err(|e|e.to_string())?.execute(params![id,digest,width as i64,height as i64,bytes]).map_err(|e|e.to_string())?;
    self
      .conn
      .query_row(
        "SELECT id FROM assets WHERE book_id=? AND hash=?",
        params![id, digest],
        |r| r.get(0),
      )
      .map_err(|e| e.to_string())
  }
  pub fn units(&mut self, job: &str, units: &[Value]) -> Result<()> {
    let (id, rendition) = self.active(job)?;
    if units.len() > 500 {
      return Err("Unit batch exceeds budget".into());
    }
    let tx = self.conn.transaction().map_err(|e| e.to_string())?;
    for unit in units {
      let kind = unit["type"].as_str().ok_or("Invalid unit")?;
      if !["heading", "paragraph", "html", "image", "page"].contains(&kind) {
        return Err("Invalid unit type".into());
      }
      let asset = unit["assetId"].as_i64();
      if let Some(asset) = asset {
        if !tx
          .query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE id=? AND book_id=?)",
            params![asset, id],
            |r| r.get::<_, bool>(0),
          )
          .map_err(|e| e.to_string())?
        {
          return Err("Asset belongs to another book".into());
        }
      } else if ["image", "page"].contains(&kind) {
        return Err("Missing page asset".into());
      }
      tx.prepare_cached("INSERT INTO units(book_id,rendition_id,unit_index,kind,title,text,html,asset_id,metadata) VALUES(?,?,?,?,?,?,?,?,?)").map_err(|e|e.to_string())?.execute(params![id,rendition,unit["unitIndex"].as_i64().filter(|n| *n >= 0).ok_or("Missing unit index")?,kind,unit["title"].as_str(),unit["text"].as_str(),unit["html"].as_str(),asset,unit["metadata"].to_string()]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
  }
  pub fn finish(&mut self, job: &str) -> Result<String> {
    let (id, rendition) = self.active(job)?;
    let count: i64 = self
      .conn
      .query_row(
        "SELECT COUNT(*) FROM units WHERE rendition_id=?",
        [rendition],
        |r| r.get(0),
      )
      .map_err(|e| e.to_string())?;
    if count == 0 {
      return Err("No readable content found".into());
    }
    let mut book = self.get(&id)?.ok_or("Book not found")?;
    let (kind, fingerprint): (Option<String>, String) = self
      .conn
      .query_row(
        "SELECT content_type,fingerprint FROM jobs WHERE id=?",
        [job],
        |r| Ok((r.get(0)?, r.get(1)?)),
      )
      .map_err(|e| e.to_string())?;
    if let Some(kind) = kind {
      if book["contentType"] != kind {
        book["preferences"] = preferences(kind == "comic");
      }
      book["contentType"] = json!(kind);
    }
    book["sourceFingerprint"] = json!(fingerprint);
    book["renditionVersion"] = json!(rendition);
    let cover: Option<(i64,i64,i64)> = self.conn.query_row("SELECT a.id,a.width,a.height FROM units u JOIN assets a ON a.id=u.asset_id WHERE u.rendition_id=? ORDER BY CASE u.kind WHEN 'page' THEN 0 ELSE 1 END,u.unit_index LIMIT 1",[rendition],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
    let excerpt: Option<String> = self.conn.query_row("SELECT substr(group_concat(text,' '),1,280) FROM (SELECT text FROM units WHERE rendition_id=? AND text IS NOT NULL ORDER BY unit_index LIMIT 8)",[rendition],|r|r.get(0)).map_err(|e|e.to_string())?;
    book["unitCount"] = json!(count);
    book["coverExcerpt"] = json!(excerpt);
    book["coverKind"] = json!(if cover.is_some() {
      "asset"
    } else {
      "generated"
    });
    book["coverAssetId"] = json!(cover.map(|c| c.0));
    book["coverWidth"] = json!(cover.map(|c| c.1));
    book["coverHeight"] = json!(cover.map(|c| c.2));
    book["importStatus"] = json!("ready");
    book["importProgress"] = json!(1);
    book["importError"] = Value::Null;
    book["updatedAt"] = json!(now());
    let tx = self.conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
      "UPDATE books SET active_rendition=?,data=? WHERE id=?",
      params![rendition, book.to_string(), id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM jobs WHERE book_id=?", [&id])
      .map_err(|e| e.to_string())?;
    tx.execute(
      "DELETE FROM renditions WHERE book_id=? AND id<>?",
      params![id, rendition],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM assets WHERE book_id=? AND NOT EXISTS(SELECT 1 FROM units WHERE asset_id=assets.id)",[&id]).map_err(|e|e.to_string())?;
    let assets: i64 = tx
      .query_row("SELECT COUNT(*) FROM assets WHERE book_id=?", [&id], |r| {
        r.get(0)
      })
      .map_err(|e| e.to_string())?;
    book["assetCount"] = json!(assets);
    tx.execute(
      "UPDATE books SET data=? WHERE id=?",
      params![book.to_string(), id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    self.needs_reclaim = true;
    Ok(id)
  }
  pub fn abort(&mut self, job: &str, status: &str, message: &str) -> Result<()> {
    let data: Option<(String, Option<i64>)> = self
      .conn
      .query_row(
        "SELECT book_id,rendition_id FROM jobs WHERE id=?",
        [job],
        |r| Ok((r.get(0)?, r.get(1)?)),
      )
      .optional()
      .map_err(|e| e.to_string())?;
    if let Some((id, rendition)) = data {
      let tx = self.conn.transaction().map_err(|e| e.to_string())?;
      tx.execute("DELETE FROM jobs WHERE id=?", [job])
        .map_err(|e| e.to_string())?;
      if let Some(rendition) = rendition {
        tx.execute("DELETE FROM renditions WHERE id=? AND id NOT IN(SELECT active_rendition FROM books WHERE active_rendition IS NOT NULL)",[rendition]).map_err(|e|e.to_string())?;
      }
      tx.execute("DELETE FROM assets WHERE book_id=? AND NOT EXISTS(SELECT 1 FROM units WHERE asset_id=assets.id)",[&id]).map_err(|e|e.to_string())?;
      tx.execute(
        "INSERT INTO diagnostics(book_id,message,created_at) VALUES(?,?,?)",
        params![id, message, now()],
      )
      .map_err(|e| e.to_string())?;
      tx.commit().map_err(|e| e.to_string())?;
      self.status(&id, status, 0., Some(message))?;
      self.needs_reclaim = true;
    }
    Ok(())
  }
  pub fn read_units(&self, id: &str, pages: bool) -> Result<Value> {
    let mut stmt = self.conn.prepare_cached("SELECT u.id,u.unit_index,u.kind,u.title,u.text,u.html,u.asset_id,u.metadata,a.mime,a.width,a.height,length(a.bytes) FROM units u JOIN books b ON b.active_rendition=u.rendition_id LEFT JOIN assets a ON a.id=u.asset_id WHERE u.book_id=? ORDER BY u.unit_index").map_err(|e|e.to_string())?;
    let rows=stmt.query_map([id],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"unitIndex":r.get::<_,i64>(1)?,"type":r.get::<_,String>(2)?,"title":r.get::<_,Option<String>>(3)?,"text":r.get::<_,Option<String>>(4)?,"html":r.get::<_,Option<String>>(5)?,"assetId":r.get::<_,Option<i64>>(6)?,"metadata":serde_json::from_str::<Value>(&r.get::<_,String>(7)?).unwrap_or(Value::Null),"mime":r.get::<_,Option<String>>(8)?,"width":r.get::<_,Option<i64>>(9)?,"height":r.get::<_,Option<i64>>(10)?,"byteLength":r.get::<_,Option<i64>>(11)?}))).map_err(|e|e.to_string())?;
    let units = rows
      .collect::<rusqlite::Result<Vec<_>>>()
      .map_err(|e| e.to_string())?
      .into_iter()
      .filter(|u| !pages || u["type"] == "page")
      .collect::<Vec<_>>();
    Ok(json!(units))
  }
  pub fn read_asset(&self, id: i64) -> Result<Vec<u8>> {
    self.conn.prepare_cached("SELECT bytes FROM assets WHERE id=? AND EXISTS(SELECT 1 FROM units u JOIN books b ON b.active_rendition=u.rendition_id WHERE u.asset_id=assets.id)").map_err(|e|e.to_string())?.query_row([id],|r|r.get(0)).map_err(|e|e.to_string())
  }
  pub fn remove(&mut self, id: &str) -> Result<()> {
    self
      .conn
      .execute("DELETE FROM books WHERE id=?", [id])
      .map_err(|e| e.to_string())?;
    self.needs_reclaim = true;
    Ok(())
  }
  fn reclaim(&mut self) -> Result<()> {
    let free: i64 = self
      .conn
      .query_row("PRAGMA freelist_count", [], |r| r.get(0))
      .map_err(|e| e.to_string())?;
    if free == 0 {
      self.needs_reclaim = false;
      return Ok(());
    }
    self
      .conn
      .execute_batch("PRAGMA incremental_vacuum(2048);")
      .map_err(|e| e.to_string())?;
    Ok(())
  }
  pub fn diagnostics(&self) -> Result<Value> {
    let mut books = self.list()?["books"]
      .as_array()
      .cloned()
      .unwrap_or_default();
    for book in &mut books {
      book["sourceExists"] = json!(Path::new(book["path"].as_str().unwrap_or("")).exists());
      book["diagnosticCount"] = json!(self
        .conn
        .query_row(
          "SELECT COUNT(*) FROM diagnostics WHERE book_id=?",
          [book["id"].as_str().unwrap_or("")],
          |r| r.get::<_, i64>(0)
        )
        .map_err(|e| e.to_string())?);
    }
    let scalar = |sql: &str| {
      self
        .conn
        .query_row(sql, [], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())
    };
    let diagnostics=self.conn.prepare("SELECT id,book_id,message,created_at FROM diagnostics ORDER BY id DESC LIMIT 80").map_err(|e|e.to_string())?.query_map([],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"bookId":r.get::<_,Option<String>>(1)?,"level":"error","message":r.get::<_,String>(2)?,"createdAt":r.get::<_,String>(3)?}))).map_err(|e|e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e|e.to_string())?;
    Ok(
      json!({"dbPath":self.path,"stats":{"books":books.len(),"units":scalar("SELECT COUNT(*) FROM units")?,"assets":scalar("SELECT COUNT(*) FROM assets")?,"assetBytes":scalar("SELECT COALESCE(SUM(length(bytes)),0) FROM assets")?,"orphanAssets":scalar("SELECT COUNT(*) FROM assets WHERE NOT EXISTS(SELECT 1 FROM units WHERE asset_id=assets.id)")?,"missingAssets":scalar("SELECT COUNT(*) FROM units WHERE asset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assets WHERE id=units.asset_id)")?,"readyWithoutUnits":scalar("SELECT COUNT(*) FROM books WHERE json_extract(data,'$.importStatus')='ready' AND NOT EXISTS(SELECT 1 FROM units WHERE rendition_id=books.active_rendition)")?,"largestAssetBytes":scalar("SELECT COALESCE(MAX(length(bytes)),0) FROM assets")?},"books":books,"recentDiagnostics":diagnostics}),
    )
  }
  pub fn stats(&self) -> Result<Value> {
    let library = self.list()?;
    let books = library["books"].as_array().ok_or("Invalid library")?;
    let total = books.len();
    let ratio = |n: usize| n as f64 / total.max(1) as f64;
    let percent = |b: &Value| {
      b["progress"]["percent"]
        .as_f64()
        .unwrap_or(0.)
        .clamp(0., 1.)
    };
    let groups = |field: &str, keys: &[&str]| {
      keys
        .iter()
        .map(|key| {
          let count = books.iter().filter(|b| b[field] == *key).count();
          json!({"key":key,"count":count,"ratio":ratio(count)})
        })
        .filter(|g| g["count"].as_u64().unwrap_or(0) > 0)
        .collect::<Vec<_>>()
    };
    let content = groups("contentType", &["novel", "comic"]);
    let formats = groups("format", &["txt", "epub", "mobi", "pdf", "image-folder"]);
    let mut daily = (0..30)
      .map(|i| {
        let date = (Local::now().date_naive() - Duration::days(29 - i)).to_string();
        json!({"day":date,"events":0,"opens":0,"progressEvents":0})
      })
      .collect::<Vec<_>>();
    let mut opens = std::collections::HashSet::new();
    let mut stmt = self
      .conn
      .prepare("SELECT book_id,kind,at FROM activity WHERE at>=? ORDER BY id")
      .map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map([daily[0]["day"].as_str().unwrap_or("")], |r| {
        Ok((
          r.get::<_, String>(0)?,
          r.get::<_, String>(1)?,
          r.get::<_, String>(2)?,
        ))
      })
      .map_err(|e| e.to_string())?;
    for row in rows {
      let (id, kind, at) = row.map_err(|e| e.to_string())?;
      let day = chrono::DateTime::parse_from_rfc3339(&at)
        .map(|d| d.with_timezone(&Local).date_naive().to_string())
        .unwrap_or_default();
      if let Some(bucket) = daily.iter_mut().find(|d| d["day"] == day) {
        if kind == "open" && !opens.insert((id, day)) {
          continue;
        }
        bucket["events"] = json!(bucket["events"].as_u64().unwrap_or(0) + 1);
        let key = if kind == "open" {
          "opens"
        } else {
          "progressEvents"
        };
        bucket[key] = json!(bucket[key].as_u64().unwrap_or(0) + 1);
      }
    }
    let active = daily
      .iter()
      .filter(|d| d["events"].as_u64().unwrap_or(0) > 0)
      .count();
    let streak = daily
      .iter()
      .rev()
      .take_while(|d| d["events"].as_u64().unwrap_or(0) > 0)
      .count();
    let favorite = |groups: &Vec<Value>| {
      groups
        .iter()
        .max_by_key(|g| g["count"].as_u64().unwrap_or(0))
        .map(|g| g["key"].clone())
    };
    let bands = [
      ("not-started", "未开始"),
      ("reading", "阅读中"),
      ("near-done", "接近完成"),
      ("completed", "已完成"),
    ]
    .iter()
    .enumerate()
    .map(|(i, (key, label))| {
      let count = books
        .iter()
        .filter(|b| {
          let p = percent(b);
          let band = if p >= 0.98 {
            3
          } else if p >= 0.8 {
            2
          } else if p > 0. {
            1
          } else {
            0
          };
          band == i
        })
        .count();
      json!({"key":key,"label":label,"count":count,"ratio":ratio(count)})
    })
    .collect::<Vec<_>>();
    let recent = books
      .iter()
      .filter(|b| b["lastOpenedAt"].is_string() || percent(b) > 0.)
      .take(6)
      .map(|b| {
        let mut b = b.clone();
        b["progressPercent"] = json!(percent(&b));
        b
      })
      .collect::<Vec<_>>();
    Ok(
      json!({"generatedAt":now(),"overview":{"totalBooks":total,"readBooks":books.iter().filter(|b|percent(b)>0.||b["lastOpenedAt"].is_string()).count(),"completedBooks":books.iter().filter(|b|percent(b)>=0.98).count(),"averageProgress":books.iter().map(percent).sum::<f64>()/total.max(1) as f64,"activeDays30":active,"currentStreakDays":streak},"habits":{"activeDays30":active,"currentStreakDays":streak,"recentOpenCount":daily.iter().skip(23).map(|d|d["opens"].as_u64().unwrap_or(0)).sum::<u64>(),"favoriteContentType":favorite(&content),"favoriteFormat":favorite(&formats)},"progressBands":bands,"activityByDay":&daily[16..],"contentTypes":content,"formats":formats,"recentBooks":recent}),
    )
  }
}

pub fn benchmark() -> Result<Value> {
  let directory = std::env::temp_dir().join(format!("ereader-benchmark-{}", std::process::id()));
  let mut repo = Repository::open(&directory)?;
  for i in 0..140 {
    let path = directory.join(format!("book-{i}.txt"));
    std::fs::write(&path, b"benchmark").map_err(|e| e.to_string())?;
    let b = repo.add(&path)?;
    let id = b["id"].as_str().unwrap_or("");
    repo.queue(id, &i.to_string(), "benchmark")?;
    repo.start(&i.to_string())?;
    let units = (0..200)
      .map(|n| json!({"unitIndex":n,"type":"paragraph","text":"Benchmark content"}))
      .collect::<Vec<_>>();
    repo.units(&i.to_string(), &units)?;
    repo.finish(&i.to_string())?;
  }
  let measure = |method: fn(&Repository) -> Result<Value>| -> Result<f64> {
    let start = Instant::now();
    for _ in 0..100 {
      method(&repo)?;
    }
    Ok(start.elapsed().as_secs_f64() * 10.)
  };
  let result = json!({"books":140,"units":28000,"libraryListMs":measure(Repository::list)?,"statsMs":measure(Repository::stats)?});
  drop(repo);
  Ok(result)
}
