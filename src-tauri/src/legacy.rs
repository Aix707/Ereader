use crate::db::Result;
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};

// Delete only known application-owned data. Sources referenced by the old library
// are protected, including a book/folder accidentally placed inside its profile.
pub fn reset(old: &Path, new: &Path) -> Result<Vec<PathBuf>> {
  let marker = new.join("electron-reset-v2.json");
  if marker.exists() {
    return Ok(vec![]);
  }
  if old == new || old.parent().is_none() {
    return Err("Invalid legacy data directory".into());
  }
  let database = old.join("library.sqlite");
  let journal = new.join("legacy-preserved-sources.json");
  let mut sources: Vec<PathBuf> = if journal.exists() {
    serde_json::from_slice(&std::fs::read(&journal).map_err(|e| e.to_string())?)
      .map_err(|e| e.to_string())?
  } else {
    vec![]
  };
  if database.exists() {
    let db = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)
      .map_err(|e| e.to_string())?;
    let mut stmt = db
      .prepare("SELECT source_path FROM books")
      .map_err(|e| e.to_string())?;
    sources = stmt
      .query_map([], |r| r.get::<_, String>(0))
      .map_err(|e| e.to_string())?
      .map(|p| p.map(PathBuf::from))
      .collect::<rusqlite::Result<_>>()
      .map_err(|e| e.to_string())?;
  }
  std::fs::create_dir_all(new).map_err(|e| e.to_string())?;
  std::fs::write(
    &journal,
    serde_json::to_vec(&sources).map_err(|e| e.to_string())?,
  )
  .map_err(|e| e.to_string())?;
  let mut removed = Vec::new();
  for name in [
    "library.sqlite",
    "library.sqlite-wal",
    "library.sqlite-shm",
    "library.json",
    "library.json.bak",
    "background",
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "Local Storage",
    "Session Storage",
    "Service Worker",
    "logs",
    "cache",
    "import-cache",
    "blob_storage",
    "Network",
    "Preferences",
    "Local State",
    "DIPS",
    "DIPS-wal",
    "DIPS-shm",
    "Cookies",
    "Cookies-journal",
    "TransportSecurity",
    "Trust Tokens",
    "Trust Tokens-journal",
    "SharedStorage",
    "SharedStorage-wal",
    "Shared Dictionary",
    "DevToolsActivePort",
  ] {
    let path = old.join(name);
    if !path.exists() {
      continue;
    }
    if sources
      .iter()
      .any(|source| inside(source, &path) || inside(&path, source))
    {
      continue;
    }
    // A profile subdirectory must never be a junction/symlink into user content.
    let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
      use std::os::windows::fs::MetadataExt;
      if metadata.file_attributes() & 0x400 != 0 {
        continue;
      }
    }
    if metadata.is_dir() {
      remove_tree(&path, &sources)?;
    } else {
      std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    removed.push(path);
  }
  std::fs::create_dir_all(new).map_err(|e| e.to_string())?;
  std::fs::write(
    marker,
    serde_json::to_vec_pretty(&serde_json::json!({"removed":removed,"protectedSources":sources}))
      .map_err(|e| e.to_string())?,
  )
  .map_err(|e| e.to_string())?;
  Ok(removed)
}
fn inside(path: &Path, root: &Path) -> bool {
  let path = path.to_string_lossy().replace('/', "\\").to_lowercase();
  let root = root
    .to_string_lossy()
    .replace('/', "\\")
    .trim_end_matches('\\')
    .to_lowercase();
  path == root || path.starts_with(&(root + "\\"))
}
fn remove_tree(path: &Path, protected: &[PathBuf]) -> Result<()> {
  for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
    let entry = entry.map_err(|e| e.to_string())?;
    let child = entry.path();
    if protected
      .iter()
      .any(|p| inside(p, &child) || inside(&child, p))
    {
      continue;
    }
    let meta = std::fs::symlink_metadata(&child).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
      use std::os::windows::fs::MetadataExt;
      if meta.file_attributes() & 0x400 != 0 {
        continue;
      }
    }
    if meta.is_dir() {
      remove_tree(&child, protected)?;
    } else {
      std::fs::remove_file(child).map_err(|e| e.to_string())?;
    }
  }
  if std::fs::read_dir(path)
    .map_err(|e| e.to_string())?
    .next()
    .is_none()
  {
    std::fs::remove_dir(path).map_err(|e| e.to_string())?;
  }
  Ok(())
}
