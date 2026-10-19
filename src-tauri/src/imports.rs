use crate::db::{hash, Db, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
  collections::VecDeque,
  io::{Read, Seek, SeekFrom},
  path::{Path, PathBuf},
  sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
  },
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::{Mutex, Notify};

const IMAGES: &[&str] = &[
  "jpg", "jpeg", "png", "webp", "bmp", "gif", "avif", "tif", "tiff",
];
static SERIAL: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
  pub name: String,
  pub size: u64,
  #[serde(skip)]
  pub path: PathBuf,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
  pub id: String,
  pub book_id: String,
  pub format: String,
  pub content_type: Option<String>,
  pub sources: Vec<Source>,
  #[serde(skip)]
  pub fingerprint: String,
  #[serde(skip)]
  pub root: PathBuf,
}
#[derive(Default)]
struct Queue {
  pending: VecDeque<Job>,
  active: Option<Job>,
  window: Option<String>,
  closing: bool,
}
pub struct Imports {
  pub db: Db,
  queue: Mutex<Queue>,
  notify: Notify,
}
impl Imports {
  pub fn new(db: Db) -> Arc<Self> {
    Arc::new(Self {
      db,
      queue: Mutex::new(Queue::default()),
      notify: Notify::new(),
    })
  }
  pub async fn enqueue(self: &Arc<Self>, app: &AppHandle, id: String) -> Result<()> {
    let book = self
      .db
      .call({
        let id = id.clone();
        move |r| r.get(&id)?.ok_or("Book not found".into())
      })
      .await?;
    let mut queue = self.queue.lock().await;
    if queue.closing {
      return Err("Application is closing".into());
    }
    if queue.pending.iter().any(|j| j.book_id == id)
      || queue.active.as_ref().is_some_and(|j| j.book_id == id)
    {
      drop(queue);
      return self.ensure_window(app).await;
    }
    let path = PathBuf::from(book["path"].as_str().ok_or("Missing source path")?);
    let root = path.clone();
    let sources = tauri::async_runtime::spawn_blocking(move || source_manifest(&path))
      .await
      .map_err(|e| e.to_string())??;
    let fingerprint = fingerprint(&sources)?;
    let job = Job {
      id: format!(
        "{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
      ),
      book_id: id.clone(),
      format: book["format"].as_str().unwrap_or("txt").into(),
      content_type: if book["contentTypeOverride"] == true {
        book
          .get("requestedContentType")
          .unwrap_or(&book["contentType"])
          .as_str()
          .map(str::to_string)
      } else {
        None
      },
      sources,
      fingerprint,
      root,
    };
    self
      .db
      .call({
        let job = job.clone();
        move |r| r.queue(&job.book_id, &job.id, &job.fingerprint)
      })
      .await?;
    queue.pending.push_back(job);
    drop(queue);
    emit(app, "queued", &id, 0., None);
    self.ensure_window(app).await?;
    self.notify.notify_one();
    Ok(())
  }
  fn ensure_window<'a>(
    self: &'a Arc<Self>,
    app: &'a AppHandle,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
      let mut queue = self.queue.lock().await;
      if queue.closing || queue.window.is_some() || queue.pending.is_empty() {
        return Ok(());
      }
      let label = format!("importer-{}", SERIAL.fetch_add(1, Ordering::Relaxed));
      queue.window = Some(label.clone());
      let handle = app.clone();
      let imports = self.clone();
      let destroyed_label = label.clone();
      let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("import.html".into()))
        .title("Ereader import")
        .data_directory(crate::data_directory().join("webview"))
        .visible(false)
        .skip_taskbar(true)
        .decorations(false)
        .build();
      match window {
        Ok(window) => {
          window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
              let handle = handle.clone();
              let imports = imports.clone();
              let label = destroyed_label.clone();
              tauri::async_runtime::spawn(async move {
                imports.lost_window(&handle, &label).await;
              });
            }
          });
          Ok(())
        }
        Err(error) => {
          queue.window = None;
          Err(error.to_string())
        }
      }
    })
  }
  async fn lost_window(self: &Arc<Self>, app: &AppHandle, label: &str) {
    let mut queue = self.queue.lock().await;
    if queue.window.as_deref() != Some(label) {
      return;
    }
    queue.window = None;
    if let Some(job) = queue.active.take() {
      let id = job.book_id.clone();
      let _ = self
        .db
        .call(move |r| r.abort(&job.id, "error", "导入窗口意外退出"))
        .await;
      emit(app, "error", &id, 0., Some("导入窗口意外退出"));
    }
    drop(queue);
    // Box the future because window creation installs this same recovery callback.
    let _ = Box::pin(self.ensure_window(app)).await;
  }
  pub async fn next(self: &Arc<Self>, app: &AppHandle, label: &str) -> Result<Option<Job>> {
    loop {
      let notified = self.notify.notified();
      let mut queue = self.queue.lock().await;
      if queue.closing || queue.window.as_deref() != Some(label) {
        return Ok(None);
      }
      if queue.active.is_some() {
        return Err("Importer already has an active job".into());
      }
      if let Some(job) = queue.pending.pop_front() {
        self
          .db
          .call({
            let id = job.id.clone();
            move |r| r.start(&id)
          })
          .await?;
        queue.active = Some(job.clone());
        drop(queue);
        emit(app, "started", &job.book_id, 0., None);
        return Ok(Some(job));
      }
      drop(queue);
      if tokio::time::timeout(std::time::Duration::from_secs(30), notified)
        .await
        .is_err()
      {
        let mut queue = self.queue.lock().await;
        if queue.window.as_deref() == Some(label)
          && queue.pending.is_empty()
          && queue.active.is_none()
        {
          queue.window = None;
          drop(queue);
          if let Some(window) = app.get_webview_window(label) {
            let _ = window.destroy();
          }
          return Ok(None);
        }
      }
    }
  }
  pub async fn require(&self, label: &str, job: &str) -> Result<Job> {
    let queue = self.queue.lock().await;
    if queue.window.as_deref() != Some(label) {
      return Err("Invalid import window".into());
    }
    queue
      .active
      .as_ref()
      .filter(|j| j.id == job)
      .cloned()
      .ok_or("Import cancelled or expired".into())
  }
  pub async fn complete(
    &self,
    app: &AppHandle,
    label: &str,
    job: &str,
    error: Option<String>,
  ) -> Result<()> {
    let mut queue = self.queue.lock().await;
    if queue.window.as_deref() != Some(label) || queue.active.as_ref().is_none_or(|j| j.id != job) {
      return Err("Import expired".into());
    }
    let active = queue.active.as_ref().cloned().ok_or("Missing job")?;
    let id = active.book_id.clone();
    let error = error.or_else(|| {
      match source_manifest(&active.root).and_then(|sources| fingerprint(&sources)) {
        Ok(current) if current == active.fingerprint => None,
        _ => Some("源文件在导入期间发生变化，请重试".into()),
      }
    });
    let result = if let Some(message) = error.as_ref() {
      self
        .db
        .call({
          let job = job.to_string();
          let message = message.clone();
          move |r| r.abort(&job, "error", &message)
        })
        .await
    } else {
      self
        .db
        .call({
          let job = job.to_string();
          move |r| r.finish(&job).map(|_| ())
        })
        .await
    };
    if let Err(ref message) = result {
      let _ = self
        .db
        .call({
          let job = job.to_string();
          let message = message.clone();
          move |r| r.abort(&job, "error", &message)
        })
        .await;
    }
    queue.active = None;
    drop(queue);
    let message = error.or_else(|| result.as_ref().err().cloned());
    emit(
      app,
      if message.is_some() {
        "error"
      } else {
        "finished"
      },
      &id,
      if message.is_none() { 1. } else { 0. },
      message.as_deref(),
    );
    self.notify.notify_one();
    result
  }
  pub async fn cancel(self: &Arc<Self>, app: &AppHandle, id: &str) -> Result<()> {
    let mut queue = self.queue.lock().await;
    let mut cancelled = Vec::new();
    queue.pending.retain(|j| {
      if j.book_id == id {
        cancelled.push(j.id.clone());
        false
      } else {
        true
      }
    });
    let active = queue.active.as_ref().is_some_and(|j| j.book_id == id);
    if active {
      if let Some(job) = queue.active.take() {
        cancelled.push(job.id);
      }
    }
    for job in cancelled {
      self
        .db
        .call(move |r| r.abort(&job, "cancelled", "导入已取消"))
        .await?;
    }
    let old = if active { queue.window.take() } else { None };
    drop(queue);
    if let Some(label) = old {
      if let Some(window) = app.get_webview_window(&label) {
        let _ = window.destroy();
      }
    }
    emit(app, "cancelled", id, 0., None);
    self.ensure_window(app).await?;
    self.notify.notify_one();
    Ok(())
  }
  pub async fn shutdown(&self) -> Result<()> {
    let mut queue = self.queue.lock().await;
    queue.closing = true;
    let mut jobs = queue.pending.drain(..).map(|j| j.id).collect::<Vec<_>>();
    if let Some(job) = queue.active.take() {
      jobs.push(job.id);
    }
    for job in jobs {
      self
        .db
        .call(move |r| r.abort(&job, "cancelled", "应用已关闭，导入未完成"))
        .await?;
    }
    queue.window = None;
    drop(queue);
    // Let application exit dispose all windows together. Destroying the importer
    // immediately before requesting exit can race WebView2 controller teardown.
    self.notify.notify_waiters();
    Ok(())
  }
}
pub fn emit(app: &AppHandle, kind: &str, id: &str, progress: f64, message: Option<&str>) {
  let _ = app.emit_to(
    "main",
    "import-state",
    json!({"type":kind,"bookId":id,"progress":progress,"message":message}),
  );
}
pub fn source_manifest(path: &Path) -> Result<Vec<Source>> {
  let paths = if path.is_dir() {
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
      let entry = entry.map_err(|e| e.to_string())?;
      if entry.file_type().map_err(|e| e.to_string())?.is_file() {
        let path = entry.path();
        if path
          .extension()
          .and_then(|e| e.to_str())
          .is_some_and(|e| IMAGES.contains(&e.to_ascii_lowercase().as_str()))
        {
          paths.push(path);
        }
      }
    }
    paths
  } else {
    vec![path.to_path_buf()]
  };
  if paths.is_empty() {
    return Err("No supported images found".into());
  }
  paths
    .into_iter()
    .map(|path| {
      let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
      Ok(Source {
        name: path
          .file_name()
          .unwrap_or_default()
          .to_string_lossy()
          .into(),
        size,
        path,
      })
    })
    .collect()
}
pub fn fingerprint(sources: &[Source]) -> Result<String> {
  let mut entries = sources
    .iter()
    .map(|s| {
      let meta = std::fs::metadata(&s.path).map_err(|e| e.to_string())?;
      let time = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
      Ok(format!("{}:{}:{}", s.path.display(), meta.len(), time))
    })
    .collect::<Result<Vec<_>>>()?;
  entries.sort();
  Ok(hash(entries.join("|").as_bytes()))
}
pub fn read(source: &Source, offset: u64, length: u64) -> Result<Vec<u8>> {
  if length > 4 * 1024 * 1024 || offset > source.size || length > source.size - offset {
    return Err("Invalid source range".into());
  }
  let mut file = std::fs::File::open(&source.path).map_err(|e| e.to_string())?;
  file
    .seek(SeekFrom::Start(offset))
    .map_err(|e| e.to_string())?;
  let mut bytes = vec![0; length as usize];
  file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
  Ok(bytes)
}
