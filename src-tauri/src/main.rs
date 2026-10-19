#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod db;
mod imports;
mod legacy;
mod platform;
#[cfg(test)]
mod tests;
mod windowing;

use db::{Db, Result};
use imports::{Imports, Source};
use serde_json::{json, Value};
use std::{
  path::PathBuf,
  sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
  },
};
use tauri::{
  ipc::{InvokeBody, Request, Response},
  Emitter, Manager, State, WebviewWindow,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct AppState {
  _instance_lock: std::fs::File,
  db: Db,
  imports: Arc<Imports>,
  directory: PathBuf,
  background: Mutex<Option<Source>>,
  dropped: Mutex<Vec<PathBuf>>,
  fonts: Mutex<Option<Value>>,
  closing: AtomicBool,
  window_bounds: Mutex<Option<Value>>,
  initial_window_size: Mutex<Option<(f64, f64)>>,
  windows: windowing::WindowManager,
  source_refresh: tokio::sync::Mutex<std::time::Instant>,
}
fn data_directory() -> PathBuf {
  std::env::var_os("EREADER_USER_DATA_DIR")
    .map(PathBuf::from)
    .unwrap_or_else(|| {
      PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("com.aix707.ereader")
    })
}
fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
  args[key].as_str().ok_or_else(|| format!("Missing {key}"))
}
fn window_state(window: &WebviewWindow) -> Value {
  windowing::state(window)
}
fn metadata(request: &Request<'_>) -> Result<Value> {
  serde_json::from_str(
    request
      .headers()
      .get("x-meta")
      .and_then(|h| h.to_str().ok())
      .ok_or("Missing binary metadata")?,
  )
  .map_err(|e| e.to_string())
}
fn binary<'a>(request: &'a Request<'_>) -> Result<&'a [u8]> {
  match request.body() {
    InvokeBody::Raw(bytes) if bytes.len() <= 64 * 1024 * 1024 => Ok(bytes),
    _ => Err("Invalid binary payload".into()),
  }
}

#[tauri::command]
async fn read_source(
  window: WebviewWindow,
  state: State<'_, AppState>,
  job: String,
  index: usize,
  offset: u64,
  length: u64,
) -> Result<Response> {
  let source = if window.label() == "main" && job == "background" {
    state
      .background
      .lock()
      .map_err(|e| e.to_string())?
      .clone()
      .ok_or("Background selection expired")?
  } else {
    let active = state.imports.require(window.label(), &job).await?;
    active
      .sources
      .get(index)
      .cloned()
      .ok_or("Invalid source index")?
  };
  let bytes = tauri::async_runtime::spawn_blocking(move || imports::read(&source, offset, length))
    .await
    .map_err(|e| e.to_string())??;
  Ok(Response::new(bytes))
}
#[tauri::command]
async fn decode_tiff(
  window: WebviewWindow,
  state: State<'_, AppState>,
  request: Request<'_>,
) -> Result<Response> {
  let meta = metadata(&request)?;
  let job = text(&meta, "job")?;
  if window.label() == "main" && job == "background" {
    if state
      .background
      .lock()
      .map_err(|e| e.to_string())?
      .is_none()
    {
      return Err("Background selection expired".into());
    }
  } else {
    state.imports.require(window.label(), job).await?;
  }
  let bytes = binary(&request)?.to_vec();
  let output = tauri::async_runtime::spawn_blocking(move || platform::tiff(&bytes))
    .await
    .map_err(|e| e.to_string())??;
  Ok(Response::new(output))
}
#[tauri::command]
async fn write_asset(
  window: WebviewWindow,
  state: State<'_, AppState>,
  request: Request<'_>,
) -> Result<Value> {
  let meta = metadata(&request)?;
  let job = text(&meta, "job")?.to_string();
  let bytes = binary(&request)?.to_vec();
  if window.label() == "main" && job == "background" {
    if state
      .background
      .lock()
      .map_err(|e| e.to_string())?
      .is_none()
    {
      return Err("Background selection expired".into());
    }
    if meta["mime"] != "image/webp"
      || !bytes.starts_with(b"RIFF")
      || bytes.get(8..12) != Some(b"WEBP")
      || bytes.len() > 32 * 1024 * 1024
    {
      return Err("Invalid background image".into());
    }
    let target = state.directory.join("background.webp");
    let temporary = state.directory.join("background.pending");
    std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    // std::fs::rename uses replace-existing semantics on Windows.
    std::fs::rename(temporary, target).map_err(|e| e.to_string())?;
    state.background.lock().map_err(|e| e.to_string())?.take();
    return state
      .db
      .call(|r| {
        let mut settings = r.setting()?;
        let version = settings["appearance"]["backgroundImageVersion"]
          .as_u64()
          .unwrap_or(0)
          + 1;
        settings["appearance"]["backgroundImageVersion"] = json!(version);
        settings["appearance"]["backgroundLayerMode"] = json!("image");
        r.update_settings(&settings)
      })
      .await;
  }
  state.imports.require(window.label(), &job).await?;
  state
    .db
    .call(move |r| r.asset(&job, &meta, &bytes).map(|id| json!(id)))
    .await
}

#[tauri::command]
async fn import_api(
  window: WebviewWindow,
  state: State<'_, AppState>,
  method: String,
  args: Value,
) -> Result<Value> {
  if !window.label().starts_with("importer-") {
    return Err("Importer-only command".into());
  }
  let app = window.app_handle();
  if method == "next" {
    return serde_json::to_value(state.imports.next(app, window.label()).await?)
      .map_err(|e| e.to_string());
  }
  let job = text(&args, "job")?.to_string();
  let active = state.imports.require(window.label(), &job).await?;
  match method.as_str() {
    "configure" => {
      state
        .db
        .call(move |r| {
          let kind = text(&args, "contentType")?;
          r.configure(&job, kind)?;
          Ok(Value::Null)
        })
        .await
    }
    "units" => {
      state
        .db
        .call(move |r| {
          r.units(&job, args["units"].as_array().ok_or("Missing units")?)?;
          Ok(Value::Null)
        })
        .await
    }
    "progress" => {
      let progress = args["progress"].as_f64().unwrap_or(0.).clamp(0., 0.99);
      let id = active.book_id.clone();
      state
        .db
        .call(move |r| {
          r.active(&job)?;
          r.status(&id, "processing", progress, None)
        })
        .await?;
      imports::emit(app, "progress", &active.book_id, progress, None);
      Ok(Value::Null)
    }
    "complete" => {
      state
        .imports
        .complete(
          app,
          window.label(),
          &job,
          args["error"].as_str().map(str::to_string),
        )
        .await?;
      Ok(Value::Null)
    }
    _ => Err("Unknown import command".into()),
  }
}

async fn import_paths(
  state: &AppState,
  app: &tauri::AppHandle,
  paths: Vec<PathBuf>,
) -> Result<Value> {
  for path in paths {
    let path = dunce::canonicalize(path).map_err(|e| e.to_string())?;
    let book = state.db.call(move |r| r.add(&path)).await?;
    let id = text(&book, "id")?.to_string();
    if book["importStatus"] != "ready" {
      state.imports.enqueue(app, id).await?;
    }
  }
  state.db.call(|r| r.list()).await
}

#[tauri::command]
async fn api(
  window: WebviewWindow,
  state: State<'_, AppState>,
  method: String,
  args: Value,
) -> Result<Value> {
  if window.label() != "main" {
    return Err("Main-window-only command".into());
  }
  let app = window.app_handle();
  match method.as_str() {
    #[cfg(debug_assertions)]
    "testWindow" => {
      if std::env::var_os("EREADER_USER_DATA_DIR").is_none() {
        return Err("Tests require an isolated library".into());
      }
      if args["restore"].as_bool() == Some(true) {
        window.unminimize().map_err(|e| e.to_string())?;
      }
      if let Some(zoom) = args["zoom"].as_f64() {
        if !(0.5..=2.).contains(&zoom) {
          return Err("Invalid test zoom".into());
        }
        window.set_zoom(zoom).map_err(|e| e.to_string())?;
      }
      if let (Some(width), Some(height)) = (args["width"].as_f64(), args["height"].as_f64()) {
        if !(880.0..=5000.).contains(&width) || !(600.0..=5000.).contains(&height) {
          return Err("Invalid test size".into());
        }
        window
          .set_size(tauri::LogicalSize::new(width, height))
          .map_err(|e| e.to_string())?;
      }
      if let (Some(x), Some(y)) = (args["x"].as_i64(), args["y"].as_i64()) {
        if !(-5000..=5000).contains(&x) || !(-5000..=5000).contains(&y) {
          return Err("Invalid test position".into());
        }
        window
          .set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
          .map_err(|e| e.to_string())?;
      }
      let size = window.inner_size().map_err(|e| e.to_string())?;
      let position = window.outer_position().map_err(|e| e.to_string())?;
      Ok(
        json!({"state":window_state(&window),"width":size.width,"height":size.height,"x":position.x,"y":position.y,"scaleFactor":window.scale_factor().map_err(|e|e.to_string())?,"isMinimized":window.is_minimized().map_err(|e|e.to_string())?}),
      )
    }
    #[cfg(debug_assertions)]
    "testImport" => {
      if std::env::var_os("EREADER_USER_DATA_DIR").is_none() {
        return Err("Tests require an isolated library".into());
      }
      let root = std::fs::canonicalize(
        std::env::var_os("EREADER_TEST_INPUT_ROOT").ok_or("Missing test fixture root")?,
      )
      .map_err(|e| e.to_string())?;
      let paths = args["paths"]
        .as_array()
        .ok_or("Missing fixture paths")?
        .iter()
        .map(|v| {
          let p = std::fs::canonicalize(v.as_str().ok_or("Invalid fixture path")?)
            .map_err(|e| e.to_string())?;
          if !p.starts_with(&root) {
            return Err("Fixture path escapes test directory".into());
          }
          Ok(p)
        })
        .collect::<Result<Vec<_>>>()?;
      import_paths(&state, app, paths).await
    }
    "ready" => {
      window.show().map_err(|e| e.to_string())?;
      // Windows can adjust the hidden undecorated frame while showing it. Apply
      // saved client dimensions afterwards to avoid growing on every restart.
      let initial = state
        .initial_window_size
        .lock()
        .map_err(|e| e.to_string())?
        .take();
      if let Some((width, height)) = initial {
        window
          .set_size(tauri::LogicalSize::new(width, height))
          .map_err(|e| e.to_string())?;
      }
      Ok(window_state(&window))
    }
    "listLibrary" => {
      let refresh = {
        let mut last = state.source_refresh.lock().await;
        let refresh = last.elapsed().as_secs() >= 5;
        if refresh {
          *last = std::time::Instant::now();
        }
        refresh
      };
      if refresh {
        let library = state.db.call(|r| r.list()).await?;
        let books = library["books"].as_array().cloned().unwrap_or_default();
        let sources = tauri::async_runtime::spawn_blocking(move || {
          books
            .into_iter()
            .map(|book| {
              let path = PathBuf::from(book["path"].as_str().unwrap_or(""));
              let exists = path.exists();
              let fingerprint = imports::source_manifest(&path)
                .and_then(|sources| imports::fingerprint(&sources))
                .ok();
              (
                book["id"].as_str().unwrap_or("").to_string(),
                exists,
                fingerprint,
              )
            })
            .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| e.to_string())?;
        state
          .db
          .call(move |r| {
            for (id, exists, fingerprint) in sources {
              if let Some(mut book) = r.get(&id)? {
                let mut changed = book["sourceExists"] != exists;
                book["sourceExists"] = json!(exists);
                if let Some(fingerprint) = fingerprint {
                  if book["sourceFingerprint"].is_string()
                    && book["sourceFingerprint"] != fingerprint
                    && book["importStatus"] == "ready"
                  {
                    book["importStatus"] = json!("stale");
                    changed = true;
                  }
                }
                if changed {
                  r.save(&book)?;
                }
              }
            }
            Ok(())
          })
          .await?;
      }
      state.db.call(|r| r.list()).await
    }
    "getBook" => {
      let id = text(&args, "id")?.to_string();
      state
        .db
        .call(move |r| Ok(r.get(&id)?.unwrap_or(Value::Null)))
        .await
    }
    "importFiles" | "importFolder" => {
      let dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("导入书籍");
      let paths = if method == "importFolder" {
        dialog
          .blocking_pick_folder()
          .into_iter()
          .filter_map(|f| f.into_path().ok())
          .collect()
      } else {
        dialog
          .add_filter("书籍", &["txt", "pdf", "epub", "mobi", "azw", "azw3"])
          .blocking_pick_files()
          .unwrap_or_default()
          .into_iter()
          .filter_map(|f| f.into_path().ok())
          .collect()
      };
      import_paths(&state, app, paths).await
    }
    "importDroppedPaths" => {
      let requested = args["paths"].as_array().ok_or("Invalid dropped paths")?;
      let paths = {
        let mut allowed = state.dropped.lock().map_err(|e| e.to_string())?;
        let mut paths = Vec::new();
        for path in requested {
          let path = PathBuf::from(path.as_str().ok_or("Invalid path")?);
          if !allowed.contains(&path) {
            return Err("Path was not received from a native drop".into());
          }
          paths.push(path);
        }
        allowed.clear();
        paths
      };
      import_paths(&state, app, paths).await
    }
    "updateBook" => {
      let id = text(&args, "id")?.to_string();
      let patch = args["patch"].clone();
      let changed = patch.get("contentType").is_some();
      let result = state
        .db
        .call({
          let id = id.clone();
          move |r| r.patch(&id, &patch)
        })
        .await?;
      if changed {
        state.imports.cancel(app, &id).await?;
        state.imports.enqueue(app, id).await?;
      }
      Ok(result)
    }
    "removeBook" => {
      let id = text(&args, "id")?.to_string();
      state.imports.cancel(app, &id).await?;
      state
        .db
        .call(move |r| {
          r.remove(&id)?;
          r.list()
        })
        .await
    }
    "rebuildBook" | "cancelImport" => {
      let id = text(&args, "id")?.to_string();
      state.imports.cancel(app, &id).await?;
      if method == "rebuildBook" {
        state.imports.enqueue(app, id.clone()).await?;
      }
      state
        .db
        .call(move |r| Ok(r.get(&id)?.unwrap_or(Value::Null)))
        .await
    }
    "revealBook" => {
      let id = text(&args, "id")?.to_string();
      let book = state
        .db
        .call(move |r| r.get(&id)?.ok_or("Book not found".into()))
        .await?;
      app
        .opener()
        .reveal_item_in_dir(text(&book, "path")?)
        .map_err(|e| e.to_string())?;
      Ok(Value::Null)
    }
    "getTextUnits" | "getPageUnits" => {
      let id = text(&args, "id")?.to_string();
      let pages = method == "getPageUnits";
      state.db.call(move |r| r.read_units(&id, pages)).await
    }
    "getAppSettings" => {
      let exists = state.directory.join("background.webp").exists();
      state
        .db
        .call(move |r| {
          let settings = r.setting()?;
          if !exists && settings["appearance"]["backgroundLayerMode"] == "image" {
            r.update_settings(&json!({"appearance":{"backgroundLayerMode":"default"}}))
          } else {
            Ok(settings)
          }
        })
        .await
    }
    "updateAppSettings" => {
      state
        .db
        .call(move |r| r.update_settings(&args["patch"]))
        .await
    }
    "chooseBackgroundImage" => {
      let selected = || {
        app
          .dialog()
          .file()
          .set_parent(&window)
          .set_title("选择背景图片")
          .add_filter(
            "图片",
            &[
              "jpg", "jpeg", "png", "webp", "avif", "bmp", "gif", "tif", "tiff",
            ],
          )
          .blocking_pick_file()
          .and_then(|p| p.into_path().ok())
      };
      #[cfg(debug_assertions)]
      let path = if let Some(path) = std::env::var_os("EREADER_TEST_BACKGROUND") {
        if std::env::var_os("EREADER_USER_DATA_DIR").is_none() {
          return Err("Background tests require an isolated library".into());
        }
        let root = std::fs::canonicalize(
          std::env::var_os("EREADER_TEST_INPUT_ROOT").ok_or("Missing test root")?,
        )
        .map_err(|e| e.to_string())?;
        let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        if !path.starts_with(root) {
          return Err("Test background escapes fixture directory".into());
        }
        Some(path)
      } else {
        selected()
      };
      #[cfg(not(debug_assertions))]
      let path = selected();
      if let Some(path) = path {
        let mut sources = imports::source_manifest(&path)?;
        let source = sources.pop().ok_or("Missing image")?;
        let result = json!({"name":source.name,"size":source.size});
        *state.background.lock().map_err(|e| e.to_string())? = Some(source);
        Ok(result)
      } else {
        Ok(Value::Null)
      }
    }
    "resetBackground" | "removeBackground" => {
      let path = state.directory.join("background.webp");
      if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
      }
      let mode = if method == "resetBackground" {
        "default"
      } else {
        "none"
      };
      state
        .db
        .call(move |r| r.update_settings(&json!({"appearance":{"backgroundLayerMode":mode}})))
        .await
    }
    "listSystemFonts" => {
      if let Some(fonts) = state.fonts.lock().map_err(|e| e.to_string())?.clone() {
        return Ok(fonts);
      }
      let fonts = tauri::async_runtime::spawn_blocking(platform::fonts)
        .await
        .map_err(|e| e.to_string())??;
      *state.fonts.lock().map_err(|e| e.to_string())? = Some(fonts.clone());
      Ok(fonts)
    }
    "getDiagnostics" => state.db.call(|r| r.diagnostics()).await,
    "getStats" => state.db.call(|r| r.stats()).await,
    "windowState" => Ok(window_state(&window)),
    "minimize" => {
      state
        .windows
        .apply(&window, windowing::Action::Minimize)
        .await
    }
    "toggleMaximize" => {
      state
        .windows
        .apply(&window, windowing::Action::ToggleMaximize)
        .await
    }
    "toggleFullScreen" => {
      state
        .windows
        .apply(&window, windowing::Action::ToggleFullscreen)
        .await
    }
    "setFullScreen" => {
      state
        .windows
        .apply(
          &window,
          windowing::Action::SetFullscreen(
            args["enabled"]
              .as_bool()
              .ok_or("Missing fullscreen state")?,
          ),
        )
        .await
    }
    "close" => {
      state.closing.store(true, Ordering::SeqCst);
      state.imports.shutdown().await?;
      if let Some(bounds) = state
        .window_bounds
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
      {
        std::fs::write(state.directory.join("window.json"), bounds.to_string())
          .map_err(|e| e.to_string())?;
      }
      state
        .db
        .call(|r| {
          r.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|e| e.to_string())?;
          Ok(())
        })
        .await?;
      app.exit(0);
      Ok(Value::Null)
    }
    _ => Err("Unknown application command".into()),
  }
}

fn main() {
  let directory = data_directory();
  let args = std::env::args().collect::<Vec<_>>();
  if args.iter().any(|s| s == "--doctor" || s == "--benchmark") {
    let result = if args.iter().any(|s| s == "--benchmark") {
      db::benchmark()
    } else {
      db::Repository::readonly(&directory).and_then(|r| r.diagnostics())
    };
    match result {
      Ok(value) => println!(
        "{}",
        serde_json::to_string_pretty(&value).unwrap_or_default()
      ),
      Err(error) => {
        eprintln!("{error}");
        std::process::exit(1);
      }
    }
    return;
  }
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![api,import_api,read_source,write_asset,decode_tiff])
    .register_asynchronous_uri_scheme_protocol("ereader-asset",|context,request,responder|{
      let app=context.app_handle().clone();let path=request.uri().path().to_string();
      tauri::async_runtime::spawn(async move{
        let state=app.state::<AppState>();let result=if path=="/background"{std::fs::read(state.directory.join("background.webp")).map_err(|e|e.to_string())}else if let Some(id)=path.strip_prefix("/asset/").and_then(|s|s.parse::<i64>().ok()){state.db.call(move|r|r.read_asset(id)).await}else{Err("Unknown asset".into())};
        let response=match result{Ok(bytes)=>tauri::http::Response::builder().header("Content-Type","image/webp").header("Access-Control-Allow-Origin","*").header("Cache-Control","private, max-age=31536000, immutable").body(bytes),Err(_)=>tauri::http::Response::builder().status(404).body(vec![])};if let Ok(response)=response{responder.respond(response);}
      });
    })
    .setup(move|app|{
      let directory=data_directory();std::fs::create_dir_all(&directory)?;
      let mut lock_options = std::fs::OpenOptions::new();
      lock_options.read(true).write(true).create(true).truncate(false);
      #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; lock_options.share_mode(0); }
      let instance_lock = lock_options.open(directory.join("app.lock"))?;
      if std::env::var_os("EREADER_USER_DATA_DIR").is_none(){if let Some(appdata)=std::env::var_os("APPDATA"){if let Err(error)=legacy::reset(&PathBuf::from(appdata).join("ereader"),&directory){std::fs::write(directory.join("legacy-cleanup.log"),error)?;}}}
      let db=Db::open(directory.clone()).map_err(std::io::Error::other)?;
      let imports=Imports::new(db.clone());
      let initial_size=std::fs::read(directory.join("window.json")).ok().and_then(|bytes|serde_json::from_slice::<Value>(&bytes).ok()).and_then(|value|Some((value["width"].as_f64()?.clamp(880.,4000.),value["height"].as_f64()?.clamp(600.,2400.)))).unwrap_or((1180.,780.));
      app.manage(AppState{_instance_lock:instance_lock,db,imports,directory:directory.clone(),background:Mutex::new(None),dropped:Mutex::new(vec![]),fonts:Mutex::new(None),closing:AtomicBool::new(false),window_bounds:Mutex::new(None),initial_window_size:Mutex::new(Some(initial_size)),windows:windowing::WindowManager::default(),source_refresh:tokio::sync::Mutex::new(std::time::Instant::now()-std::time::Duration::from_secs(6))});
      tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::App("index.html".into())).title("Ereader").data_directory(directory.join("webview")).inner_size(initial_size.0,initial_size.1).min_inner_size(880.,600.).decorations(false).transparent(true).visible(false).build()?;
      Ok(())
    })
    .on_window_event(|window,event|{
      if window.label()!="main"{return;}
      let state=window.state::<AppState>();
      match event{
        tauri::WindowEvent::CloseRequested{api,..}=>{if !state.closing.load(Ordering::SeqCst){api.prevent_close();let _=window.emit("closing",());}},
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop{paths,..})=>{if let Ok(mut allowed)=state.dropped.lock(){*allowed=paths.clone();}let _=window.emit("native-drop",json!({"type":"drop","paths":paths}));},
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Enter{..})=>{let _=window.emit("native-drop",json!({"type":"enter","paths":[]}));},
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Leave)=>{let _=window.emit("native-drop",json!({"type":"leave","paths":[]}));},
        tauri::WindowEvent::Resized(size)=>{
          if state.windows.is_transitioning(){return;}
          let _=window.emit("window-state",json!({"isMaximized":window.is_maximized().unwrap_or(false),"isFullScreen":window.is_fullscreen().unwrap_or(false)}));
          if !window.is_maximized().unwrap_or(false)&&!window.is_fullscreen().unwrap_or(false){let scale=window.scale_factor().unwrap_or(1.);if let Ok(mut bounds)=state.window_bounds.lock(){*bounds=Some(json!({"width":size.width as f64/scale,"height":size.height as f64/scale}));}}
        },_=>{}
      }
    })
    .run(tauri::generate_context!()).expect("Failed to start Ereader");
}
