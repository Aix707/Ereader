use crate::{
  db::{Repository, Result},
  legacy,
};
use serde_json::json;

#[test]
fn wic_decodes_tiff_and_honors_exif_rotation() {
  for (bytes, width, height) in [
    (
      include_bytes!("../../tests/fixtures/image.tiff").as_slice(),
      40u32,
      60u32,
    ),
    (
      include_bytes!("../../tests/fixtures/image-rotated.tiff").as_slice(),
      60,
      40,
    ),
  ] {
    let decoded = crate::platform::tiff(bytes).unwrap();
    assert_eq!(u32::from_le_bytes(decoded[..4].try_into().unwrap()), width);
    assert_eq!(
      u32::from_le_bytes(decoded[4..8].try_into().unwrap()),
      height
    );
    assert_eq!(decoded.len(), 8 + (width * height * 4) as usize);
  }
}

#[test]
fn content_mode_switches_only_when_new_rendition_is_complete() {
  let (_dir, mut repo, id) = fixture();
  start(&repo, &id, "first");
  repo
    .units(
      "first",
      &[json!({"unitIndex":0,"type":"paragraph","text":"Novel"})],
    )
    .unwrap();
  repo.configure("first", "novel").unwrap();
  repo.finish("first").unwrap();
  let previous = repo.get(&id).unwrap().unwrap()["renditionVersion"]
    .as_i64()
    .unwrap();
  repo.patch(&id, &json!({"contentType":"comic"})).unwrap();
  start(&repo, &id, "comic");
  repo.configure("comic", "comic").unwrap();
  assert_eq!(repo.get(&id).unwrap().unwrap()["contentType"], "novel");
  repo
    .units(
      "comic",
      &[json!({"unitIndex":0,"type":"paragraph","text":"New"})],
    )
    .unwrap();
  repo.finish("comic").unwrap();
  let book = repo.get(&id).unwrap().unwrap();
  assert_eq!(book["contentType"], "comic");
  assert!(book["renditionVersion"].as_i64().unwrap() > previous);
}

#[test]
fn deleted_asset_ids_are_never_reused_by_cached_urls() {
  let (dir, mut repo, id) = fixture();
  let meta = json!({"mime":"image/webp","width":1,"height":1});
  start(&repo, &id, "first");
  let first = repo.asset("first", &meta, b"RIFFxxxxWEBPfirst").unwrap();
  repo.abort("first", "cancelled", "test").unwrap();
  repo.remove(&id).unwrap();
  let book = repo.add(&dir.path().join("original.txt")).unwrap();
  let id = book["id"].as_str().unwrap();
  start(&repo, id, "second");
  let second = repo.asset("second", &meta, b"RIFFxxxxWEBPsecond").unwrap();
  assert!(second > first);
}

fn fixture() -> (tempfile::TempDir, Repository, String) {
  let dir = tempfile::tempdir().unwrap();
  let path = dir.path().join("original.txt");
  std::fs::write(&path, "Original book").unwrap();
  let repo = Repository::open(&dir.path().join("data")).unwrap();
  let book = repo.add(&path).unwrap();
  let id = book["id"].as_str().unwrap().to_string();
  (dir, repo, id)
}
fn start(repo: &Repository, id: &str, job: &str) {
  repo.queue(id, job, "source fingerprint").unwrap();
  repo.start(job).unwrap();
}
#[test]
fn progress_patch_and_settings_are_normalized() {
  let (_dir, mut repo, id) = fixture();
  repo.patch(&id,&json!({"progress":{"kind":"page","page":12,"percent":0.2},"preferences":{"pageSpread":"double"}})).unwrap();
  let book = repo
    .patch(&id, &json!({"progress":{"percent":0.3}}))
    .unwrap();
  assert_eq!(book["progress"]["page"], 12);
  assert_eq!(book["preferences"]["pageSpread"], "double");
  let settings=repo.update_settings(&json!({"novelReading":{"fontSize":200,"fontFamily":"a;\"{}"},"appearance":{"backgroundOpacity":3}})).unwrap();
  assert_eq!(settings["novelReading"]["fontSize"], 28.);
  assert_eq!(settings["novelReading"]["fontFamily"], "a");
  assert_eq!(settings["appearance"]["backgroundOpacity"], 1.);
  assert!(repo
    .patch(&id, &json!({"preferences":{"pageSpread":"invalid"}}))
    .is_err());
}
#[test]
fn new_rendition_is_atomic_and_failed_rebuild_retains_old_content() {
  let (_dir, mut repo, id) = fixture();
  start(&repo, &id, "first");
  repo
    .units(
      "first",
      &[json!({"unitIndex":0,"type":"paragraph","text":"Old content"})],
    )
    .unwrap();
  assert_eq!(repo.read_units(&id, false).unwrap(), json!([]));
  repo.finish("first").unwrap();
  start(&repo, &id, "second");
  repo
    .units(
      "second",
      &[json!({"unitIndex":0,"type":"paragraph","text":"Partial new content"})],
    )
    .unwrap();
  assert_eq!(
    repo.read_units(&id, false).unwrap()[0]["text"],
    "Old content"
  );
  repo.abort("second", "cancelled", "cancel").unwrap();
  assert_eq!(
    repo.read_units(&id, false).unwrap()[0]["text"],
    "Old content"
  );
  assert!(repo.units("second", &[]).is_err());
  assert!(repo.finish("second").is_err());
}
#[test]
fn identical_assets_are_deduplicated_and_repeated_pages_survive() {
  let (dir, mut repo, id) = fixture();
  start(&repo, &id, "images");
  let bytes = b"RIFFxxxxWEBPimage";
  let meta = json!({"mime":"image/webp","width":40,"height":60});
  let first = repo.asset("images", &meta, bytes).unwrap();
  let second = repo.asset("images", &meta, bytes).unwrap();
  assert_eq!(first, second);
  for i in 0..3 {
    repo
      .units(
        "images",
        &[json!({"unitIndex":i,"type":"page","assetId":first})],
      )
      .unwrap();
  }
  repo.finish("images").unwrap();
  assert_eq!(
    repo
      .read_units(&id, true)
      .unwrap()
      .as_array()
      .unwrap()
      .len(),
    3
  );
  assert_eq!(repo.diagnostics().unwrap()["stats"]["assets"], 1);
  repo.remove(&id).unwrap();
  assert_eq!(repo.diagnostics().unwrap()["stats"]["assets"], 0);
  assert!(dir.path().join("original.txt").exists());
}
#[test]
fn interrupted_import_recovers_and_next_job_can_complete() {
  let (dir, mut repo, id) = fixture();
  start(&repo, &id, "crash");
  repo
    .units(
      "crash",
      &[json!({"unitIndex":0,"type":"paragraph","text":"partial"})],
    )
    .unwrap();
  drop(repo);
  let mut repo = Repository::open(&dir.path().join("data")).unwrap();
  assert_eq!(repo.get(&id).unwrap().unwrap()["importStatus"], "error");
  assert!(repo.finish("crash").is_err());
  start(&repo, &id, "next");
  repo
    .units(
      "next",
      &[json!({"unitIndex":0,"type":"paragraph","text":"complete"})],
    )
    .unwrap();
  repo.finish("next").unwrap();
  assert_eq!(repo.diagnostics().unwrap()["stats"]["orphanAssets"], 0);
}
#[test]
fn deletion_invalidates_all_stale_jobs() {
  let (_dir, mut repo, id) = fixture();
  start(&repo, &id, "deleted");
  repo.remove(&id).unwrap();
  assert!(repo
    .units(
      "deleted",
      &[json!({"unitIndex":0,"type":"paragraph","text":"late"})]
    )
    .is_err());
  assert!(repo.finish("deleted").is_err());
  assert_eq!(repo.list().unwrap()["books"], json!([]));
}
#[test]
fn diagnostics_are_read_only_and_do_not_cancel_running_jobs() {
  let (dir, mut repo, id) = fixture();
  start(&repo, &id, "active");
  let readonly = Repository::readonly(&dir.path().join("data")).unwrap();
  readonly.diagnostics().unwrap();
  assert!(repo.active("active").is_ok());
  repo
    .units(
      "active",
      &[json!({"unitIndex":0,"type":"paragraph","text":"complete"})],
    )
    .unwrap();
  repo.finish("active").unwrap();
}
#[test]
fn legacy_reset_preserves_sources_and_only_runs_once() -> Result<()> {
  let dir = tempfile::tempdir().unwrap();
  let old = dir.path().join("old");
  let new = dir.path().join("new");
  std::fs::create_dir_all(old.join("Cache")).unwrap();
  let original = old.join("Cache").join("original.txt");
  std::fs::write(&original, "Keep me").unwrap();
  let conn = rusqlite::Connection::open(old.join("library.sqlite")).unwrap();
  conn
    .execute_batch("CREATE TABLE books(source_path TEXT)")
    .unwrap();
  conn
    .execute(
      "INSERT INTO books VALUES(?)",
      [original.to_string_lossy().as_ref()],
    )
    .unwrap();
  drop(conn);
  std::fs::write(old.join("library.json"), "history").unwrap();
  std::fs::write(old.join("library.json.bak"), "backup").unwrap();
  legacy::reset(&old, &new)?;
  assert!(original.exists());
  assert!(!old.join("library.sqlite").exists());
  assert!(!old.join("library.json.bak").exists());
  std::fs::write(old.join("library.json"), "created later").unwrap();
  legacy::reset(&old, &new)?;
  assert!(old.join("library.json").exists());
  Ok(())
}
#[test]
fn stats_track_open_and_progress_without_per_scroll_activity_spam() {
  let (_dir, mut repo, id) = fixture();
  repo
    .patch(&id, &json!({"lastOpenedAt":crate::db::now()}))
    .unwrap();
  repo
    .patch(&id, &json!({"progress":{"kind":"scroll","percent":0.1}}))
    .unwrap();
  repo
    .patch(&id, &json!({"progress":{"percent":0.101}}))
    .unwrap();
  let stats = repo.stats().unwrap();
  assert_eq!(stats["overview"]["readBooks"], 1);
  assert_eq!(stats["overview"]["activeDays30"], 1);
  assert_eq!(
    repo
      .conn
      .query_row("SELECT COUNT(*) FROM activity", [], |r| r.get::<_, i64>(0))
      .unwrap(),
    2
  );
}
