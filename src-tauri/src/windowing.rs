use crate::db::Result;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, PhysicalPosition, PhysicalSize, WebviewWindow};

pub enum Action {
  Minimize,
  ToggleMaximize,
  ToggleFullscreen,
  SetFullscreen(bool),
}

struct Restore {
  maximized: bool,
  position: PhysicalPosition<i32>,
  size: PhysicalSize<u32>,
}

#[derive(Default)]
pub struct WindowManager {
  restore: tokio::sync::Mutex<Option<Restore>>,
  changing: AtomicBool,
}

struct Transition<'a>(&'a AtomicBool);
impl Drop for Transition<'_> {
  fn drop(&mut self) {
    self.0.store(false, Ordering::SeqCst);
  }
}

pub fn state(window: &WebviewWindow) -> Value {
  json!({"isMaximized":window.is_maximized().unwrap_or(false),"isFullScreen":window.is_fullscreen().unwrap_or(false)})
}

async fn wait_for(window: &WebviewWindow, fullscreen: bool, maximized: Option<bool>) -> Result<()> {
  for _ in 0..90 {
    if window.is_fullscreen().map_err(|e| e.to_string())? == fullscreen
      && maximized.is_none_or(|value| window.is_maximized().ok() == Some(value))
    {
      // Tao updates its fullscreen flag before Windows resizes the client area.
      // A fullscreen frame alone can still contain a maximized, work-area client.
      let bounds_ready = if fullscreen {
        window
          .current_monitor()
          .map_err(|e| e.to_string())?
          .is_some_and(|monitor| {
            window.inner_size().ok().as_ref() == Some(monitor.size())
              && window.inner_position().ok().as_ref() == Some(monitor.position())
          })
      } else {
        true
      };
      if bounds_ready {
        return Ok(());
      }
    }
    tokio::time::sleep(std::time::Duration::from_millis(16)).await;
  }
  Err("Window transition did not complete".into())
}

impl WindowManager {
  pub fn is_transitioning(&self) -> bool {
    self.changing.load(Ordering::SeqCst)
  }

  pub async fn apply(&self, window: &WebviewWindow, action: Action) -> Result<Value> {
    let mut restore = self.restore.lock().await;
    self.changing.store(true, Ordering::SeqCst);
    let _transition = Transition(&self.changing);
    let fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
    match action {
      Action::Minimize => window.minimize().map_err(|e| e.to_string())?,
      Action::ToggleMaximize => {
        // Maximization is never an implicit way to leave reading fullscreen.
        if !fullscreen {
          let maximized = window.is_maximized().map_err(|e| e.to_string())?;
          if maximized {
            window.unmaximize().map_err(|e| e.to_string())?;
          } else {
            window.maximize().map_err(|e| e.to_string())?;
          }
          wait_for(window, false, Some(!maximized)).await?;
        }
      }
      Action::ToggleFullscreen | Action::SetFullscreen(_) => {
        let enabled = match action {
          Action::SetFullscreen(value) => value,
          _ => !fullscreen,
        };
        if enabled && !fullscreen {
          *restore = Some(Restore {
            maximized: window.is_maximized().map_err(|e| e.to_string())?,
            position: window.outer_position().map_err(|e| e.to_string())?,
            size: window.inner_size().map_err(|e| e.to_string())?,
          });
          // Clear WS_MAXIMIZE first: otherwise the undecorated Windows client
          // stays constrained to the work area even after the frame goes fullscreen.
          if window.is_maximized().map_err(|e| e.to_string())? {
            window.unmaximize().map_err(|e| e.to_string())?;
            wait_for(window, false, Some(false)).await?;
          }
          window.set_fullscreen(true).map_err(|e| e.to_string())?;
          wait_for(window, true, None).await?;
        } else if !enabled && (fullscreen || restore.is_some()) {
          window.set_fullscreen(false).map_err(|e| e.to_string())?;
          wait_for(window, false, None).await?;
          if let Some(previous) = restore.as_ref() {
            if previous.maximized {
              window.maximize().map_err(|e| e.to_string())?;
            } else {
              window.unmaximize().map_err(|e| e.to_string())?;
              window
                .set_position(previous.position)
                .map_err(|e| e.to_string())?;
              window.set_size(previous.size).map_err(|e| e.to_string())?;
            }
            wait_for(window, false, Some(previous.maximized)).await?;
          }
          *restore = None;
        }
      }
    }
    let value = state(window);
    let _ = window.emit("window-state", &value);
    Ok(value)
  }
}
