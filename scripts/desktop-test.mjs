import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createFixtures } from "./fixtures.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = path.join(root, "output", "migration", `desktop-${Date.now()}`);
const fixture = await createFixtures(path.join(directory, "sources"));
const cliPackage = JSON.parse(readFileSync(path.join(root, "node_modules/@playwright/cli/package.json"), "utf8"));
const cliEntry = path.join(root, "node_modules/@playwright/cli", cliPackage.bin["playwright-cli"]);
const session = `ereader-test-${process.pid}`;
const binary = path.join(root, "src-tauri/target/debug/ereader.exe");
const report = { directory, checks: [], pdfHasChineseFont: fixture.pdfHasChineseFont };
let child;
function cli(...args) {
  const result = spawnSync(process.execPath, [cliEntry, `-s=${session}`, ...args], { cwd: root, encoding: "utf8", timeout: 240000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status) throw result.error || new Error(result.stderr || result.stdout);
  return result.stdout;
}
function evaluate(code) {
  const output = cli("eval", code);
  const result = output.match(/### Result\r?\n([\s\S]*?)(?:\r?\n###|$)/)?.[1];
  if (result === undefined) throw new Error(output);
  return JSON.parse(result);
}
function passed(name) { report.checks.push(name); console.log(`PASS ${name}`); }
async function waitForEndpoint(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Reader exited during startup");
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; } catch { /* starting */ }
    await delay(100);
  }
  throw new Error("WebView2 debugging endpoint did not start");
}
async function start() {
  const server = createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve));
  child = spawn(binary, [], { cwd: root, windowsHide: true, env: { ...process.env, EREADER_USER_DATA_DIR: path.join(directory, "data"), EREADER_TEST_INPUT_ROOT: fixture.root, EREADER_TEST_BACKGROUND: path.join(fixture.images,"page7.tiff"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { report.stdout = (report.stdout || "") + chunk; });
  child.stderr.on("data", (chunk) => { report.stderr = (report.stderr || "") + chunk; });
  await waitForEndpoint(port); cli("attach", `--cdp=http://127.0.0.1:${port}`); cli("snapshot");
  evaluate('async () => {for(let i=0;i<100;i++){if(window.ereader)return true;await new Promise(r=>setTimeout(r,100));}throw new Error("Bridge did not initialize");}');
}
async function close() {
  if (!child || child.exitCode !== null) return;
  try { cli("eval", '() => {setTimeout(()=>window.ereader.windowControls.close(),1000);return true;}'); } catch { /* closing */ }
  const deadline = Date.now() + 10000;
  while (child.exitCode === null && Date.now() < deadline) await delay(100);
  assert.notEqual(child.exitCode, null, "Reader must exit after closing its main window");
  try { cli("detach"); } catch { /* already disconnected */ }
}
function importFiles(paths) {
  return evaluate(`async()=>{window.startedImports=new Set();window.ereader.onImportStateChanged(s=>{if(s.type==="started")window.startedImports.add(s.bookId);});await window.__TAURI_INTERNALS__.invoke("api",{method:"testImport",args:{paths:${JSON.stringify(paths)}}});window.dispatchEvent(new Event("focus"));return true;}`);
}
function settled() {
  return evaluate('async()=>{for(let i=0;i<1800;i++){const store=await window.ereader.listLibrary();if(!store.books.some(b=>["queued","processing"].includes(b.importStatus)))return store;await new Promise(r=>setTimeout(r,100));}throw new Error("Import queue did not settle");}');
}
if (!process.argv.includes("--skip-build")) {
  const build = spawnSync(process.execPath, [path.join(root,"node_modules/@tauri-apps/cli/tauri.js"), "build", "--debug", "--no-bundle"], { cwd: root, stdio: "inherit", windowsHide: true });
  if (build.status) process.exit(build.status || 1);
}
try {
  await start();
  const paths = [fixture.txt, fixture.gbk, fixture.utf16, fixture.utf32, fixture.epub, fixture.comicEpub, fixture.mobi, fixture.comicMobi, fixture.pdf, fixture.images, fixture.broken];
  importFiles(paths);
  let library = settled();
  assert.equal(library.books.filter((b) => b.importStatus === "ready").length, 10);
  assert.equal(library.books.find((b) => b.title === "broken").importStatus, "error");
  assert.equal(library.books.find((b) => b.format === "pdf").unitCount, 2);
  assert.equal(library.books.find((b) => b.format === "image-folder").unitCount, 7);
  assert.equal(library.books.find((b) => b.format === "epub" && b.contentType === "comic").assetCount, 1);
  assert.equal(library.books.find((b) => b.format === "mobi" && b.contentType === "comic").unitCount, 3);
  passed("TXT/PDF/EPUB/MOBI/image-folder imports, including compressed MOBI trailers, TIFF/AVIF and duplicate comic images");
  const contents = evaluate('async()=>{const books=(await window.ereader.listLibrary()).books;const result={};for(const b of books.filter(b=>b.format==="txt")){result[b.title]=(await window.ereader.getTextUnits(b.id)).slice(0,2).map(u=>u.text).join(" ");}return result;}');
  for (const key of ["gbk","utf16","utf32","novel"]) assert.match(contents[key], /中文/);
  const novel = library.books.find((b) => b.format === "epub" && b.contentType === "novel" && b.importStatus === "ready");
  const html = evaluate(`async()=>{const units=await window.ereader.getTextUnits(${JSON.stringify(novel.id)});return {length:units.length,html:units[1].html};}`);
  assert.equal(html.length, 651); assert.doesNotMatch(html.html, /onclick|script|danger/);
  passed("Chinese encodings, 650-paragraph EPUB batches and sanitized HTML");
  const after = path.join(fixture.root,"after-error.txt"); writeFileSync(after,"After broken EPUB\n\nQueue remains usable"); importFiles([after]); assert.equal(settled().books.find((b)=>b.title==="after-error").importStatus,"ready");
  passed("Malformed input does not stop subsequent imports");
  const pdf = library.books.find((b) => b.format === "pdf");
  const originalDigest = createHash("sha256").update(readFileSync(fixture.pdf)).digest("hex");
  renameSync(fixture.pdf, `${fixture.pdf}.offline`);
  try {
    const offline = evaluate(`async()=>{const pages=await window.ereader.getPageUnits(${JSON.stringify(pdf.id)});const image=new Image();image.src=window.ereader.getAssetUrl(pages[0].assetId);await image.decode();return {pages:pages.length,width:image.naturalWidth,height:image.naturalHeight};}`);
    assert.equal(offline.pages,2); assert.equal(Math.max(offline.width,offline.height),2800);
  } finally { renameSync(`${fixture.pdf}.offline`,fixture.pdf); }
  assert.equal(createHash("sha256").update(readFileSync(fixture.pdf)).digest("hex"),originalDigest);
  passed("PDF pages remain readable with the original file absent");
  const retained = evaluate(`async()=>{const book=(await window.ereader.listLibrary()).books.find(b=>b.format==="txt"&&b.unitCount>1000);await window.ereader.rebuildBook(book.id);await window.ereader.cancelImport(book.id);return {book:await window.ereader.getBook(book.id),units:(await window.ereader.getTextUnits(book.id)).length};}`);
  assert.equal(retained.units,5001); assert.ok(retained.book.unitCount>0); settled();
  passed("Cancel/rebuild preserves the last complete rendition");
  const deleted = path.join(fixture.root,"delete-active.txt"); writeFileSync(deleted,Array.from({length:30000},(_,i)=>`Paragraph ${i}: active cancellation test`).join("\n\n")); importFiles([deleted]);
  evaluate('async()=>{const book=(await window.ereader.listLibrary()).books.find(b=>b.title==="delete-active");await window.ereader.removeBook(book.id);return true;}');
  assert.ok(!settled().books.some((b)=>b.title==="delete-active"));
  passed("Deleting a queued/active import invalidates stale writes");
  const thousand = path.join(fixture.root,"thousand-pages"); mkdirSync(thousand); for(let i=1;i<=1000;i++)copyFileSync(path.join(root,"tests/fixtures/image.png"),path.join(thousand,`page${i}.png`));
  importFiles([thousand]);library=settled();const manga=library.books.find((b)=>b.title==="thousand-pages");assert.equal(manga.unitCount,1000);assert.equal(manga.assetCount,1);
  passed("1000-page manga import uses one asset for identical images");
  const state = evaluate('async()=>{const fonts=await window.ereader.listSystemFonts();await window.ereader.windowControls.toggleMaximize();const maximized=await window.ereader.windowControls.getState();await window.ereader.windowControls.toggleMaximize();await window.ereader.windowControls.toggleFullScreen();const fullscreen=await window.ereader.windowControls.getState();await window.ereader.windowControls.toggleFullScreen();return {fonts:fonts.length,maximized,fullscreen};}');
  assert.ok(state.fonts>0);assert.equal(state.maximized.isMaximized,true);assert.equal(state.fullscreen.isFullScreen,true);
  passed("System fonts, maximization and fullscreen controls");
  const background=evaluate('async()=>{const first=await window.ereader.chooseBackgroundImage();const second=await window.ereader.chooseBackgroundImage();const image=new Image();image.src=window.ereader.getBackgroundImageUrl()+"?v="+second.appearance.backgroundImageVersion;await image.decode();await window.ereader.removeBackground();const removed=await window.ereader.getAppSettings();return {first:first.appearance.backgroundImageVersion,second:second.appearance.backgroundImageVersion,width:image.naturalWidth,mode:removed.appearance.backgroundLayerMode};}');
  assert.ok(background.second>background.first);assert.equal(background.width,40);assert.equal(background.mode,"none");
  passed("TIFF custom background, atomic replacement, cache version and removal");
  evaluate(`async()=>{await window.ereader.updateBook(${JSON.stringify(manga.id)},{progress:{kind:"page",page:500,totalPages:1000,percent:0.5},preferences:{pageSpread:"double",readingDirection:"ltr"}});await window.ereader.updateAppSettings({novelReading:{fontSize:22,fontFamily:"serif",lineHeight:1.8,paragraphSpacing:1.1,pageWidth:800}});return true;}`);
  const diagnostics = evaluate('async()=>(await window.ereader.getDiagnostics()).stats');
  assert.equal(diagnostics.orphanAssets,0);assert.equal(diagnostics.missingAssets,0);assert.equal(diagnostics.readyWithoutUnits,0);report.diagnostics=diagnostics;
  passed("Database integrity after import cancellation and deletion");
  await close();await start();
  const restored = evaluate(`async()=>({book:await window.ereader.getBook(${JSON.stringify(manga.id)}),settings:await window.ereader.getAppSettings()})`);
  assert.equal(restored.book.progress.page,500);assert.equal(restored.book.preferences.readingDirection,"ltr");assert.equal(restored.settings.novelReading.fontSize,22);
  passed("Library, reading progress, preferences and settings survive restart");
  const forge = evaluate(`async()=>{try{await window.ereader.importDroppedPaths([${JSON.stringify(fixture.txt)}]);return false;}catch{return true;}}`); assert.equal(forge,true);
  passed("Arbitrary renderer paths are rejected outside native file selection/drop");
  const shutdownSmall = path.join(fixture.root,"shutdown-small.txt"); writeFileSync(shutdownSmall,"New import before application exit"); importFiles([shutdownSmall]); settled();
  await close(); await start();
  assert.equal(settled().books.find((b)=>b.title==="shutdown-small").importStatus,"ready");
  passed("Closing with a recently idle import WebView exits without residual tasks");
  evaluate(`async()=>{await window.ereader.rebuildBook(${JSON.stringify(manga.id)});return true;}`);
  await close(); await start();
  const interrupted = evaluate(`async()=>({book:await window.ereader.getBook(${JSON.stringify(manga.id)}),stats:(await window.ereader.getDiagnostics()).stats})`);
  assert.equal(interrupted.book.unitCount,1000); assert.ok(!["queued","processing"].includes(interrupted.book.importStatus));
  assert.equal(interrupted.stats.orphanAssets,0); assert.equal(interrupted.stats.missingAssets,0); assert.equal(interrupted.stats.readyWithoutUnits,0);
  passed("Closing during import cancels the task and preserves the complete rendition");
  evaluate(`async()=>{await window.ereader.rebuildBook(${JSON.stringify(manga.id)});for(let i=0;i<100;i++){const b=await window.ereader.getBook(${JSON.stringify(manga.id)});if(b.importStatus==="processing"&&b.importProgress>0)return true;await new Promise(r=>setTimeout(r,50));}throw Error("Import did not start before interruption");}`);
  child.kill();
  await new Promise((resolve)=>child.exitCode===null?child.once("exit",resolve):resolve());
  try { cli("detach"); } catch { /* crashed process */ }
  await start();
  const recovered = evaluate(`async()=>({book:await window.ereader.getBook(${JSON.stringify(manga.id)}),stats:(await window.ereader.getDiagnostics()).stats})`);
  assert.equal(recovered.book.unitCount,1000); assert.ok(!["queued","processing"].includes(recovered.book.importStatus));
  assert.equal(recovered.stats.orphanAssets,0); assert.equal(recovered.stats.missingAssets,0); assert.equal(recovered.stats.readyWithoutUnits,0);
  passed("Forced process interruption recovers the complete rendition without orphan assets");
  await close();
  writeFileSync(path.join(directory,"report.json"),JSON.stringify(report,null,2));
  writeFileSync(path.join(root,"output/migration/desktop-report.json"),JSON.stringify(report,null,2));
  console.log(`Desktop integration report: ${directory}`);
} catch (error) {
  report.failure=String(error);writeFileSync(path.join(directory,"report.json"),JSON.stringify(report,null,2));throw error;
} finally {
  if(child&&child.exitCode===null)child.kill();
  try{cli("detach");}catch{/* disconnected */}
}
