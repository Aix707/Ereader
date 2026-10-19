import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const binaryIndex = process.argv.indexOf("--binary");
const binary = binaryIndex < 0 ? path.join(root, "src-tauri/target/debug/ereader.exe") : path.resolve(process.argv[binaryIndex + 1]);
const libraryIndex = process.argv.indexOf("--library");
const probe = process.argv.includes("--probe");
const directory = path.join(root, "output/playwright/fullscreen", `${probe ? "before" : "check"}-${Date.now()}`);
const data = path.join(directory, "data"); mkdirSync(data, { recursive: true });
if (libraryIndex >= 0) {
  const fixtureData = path.resolve(process.argv[libraryIndex + 1]);
  const relative = path.relative(path.join(root, "output"), fixtureData);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Use a closed isolated library under output/");
  for (const file of ["library.sqlite", "library.sqlite-wal"]) {
    const source = path.join(fixtureData, file); if (existsSync(source)) copyFileSync(source, path.join(data, file));
  }
} else {
  assert.ok(binaryIndex < 0, "Release checks require --library <closed isolated library under output/>");
}
const sourceDirectory = path.join(directory, "sources"); mkdirSync(sourceDirectory);
const sourceFile = path.join(sourceDirectory, "window-regression.txt");
writeFileSync(sourceFile, "第一章 窗口回归\n\n最大化与阅读全屏需要覆盖不同的原生屏幕区域。\n\n阅读完成后保留原窗口状态。");
const pkg = JSON.parse(readFileSync(path.join(root, "node_modules/@playwright/cli/package.json"), "utf8"));
const entry = path.join(root, "node_modules/@playwright/cli", pkg.bin["playwright-cli"]);
const session = `ereader-window-${process.pid}`;
const report = { directory, binary, mode: probe ? "observe" : "verify", checks: [], frames: [] };
let child;
function cli(...args) {
  const result = spawnSync(process.execPath, [entry, `-s=${session}`, ...args], { cwd: root, windowsHide: true, encoding: "utf8", timeout: 45000, maxBuffer: 12 * 1024 * 1024 });
  if (result.error || result.status) throw result.error || Error(result.stdout + result.stderr);
  return result.stdout;
}
function resultOf(output) {
  const value = output.match(/### Result\r?\n([\s\S]*?)(?:\r?\n###|$)/)?.[1];
  if (value === undefined) throw Error(output); return JSON.parse(value);
}
const evaluate = code => resultOf(cli("eval", code));
const state = () => evaluate("async()=>await window.ereader.windowControls.getState()");
function click(pattern) {
  if (state().isFullScreen) cli("mousemove", "100", "20");
  const snapshot = cli("snapshot");
  const matches = [...snapshot.matchAll(/button "([^"]+)"[^\r\n]*?\[ref=(e\d+)\]/g)].filter(match => pattern.test(match[1]));
  assert.equal(matches.length, 1, `Expected one button for ${pattern}: ${matches.map(match => match[1])}`);
  cli("click", matches[0][2]);
}
function native() {
  const value = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.join(root, "scripts/window-metrics.ps1"), "-ReaderProcessId", String(child.pid)], { windowsHide: true, encoding: "utf8", timeout: 15000 });
  if (value.error || value.status) throw value.error || Error(value.stdout + value.stderr);
  return JSON.parse(value.stdout);
}
function capture(name) {
  const shot = resultOf(cli("run-code", 'async page=>{const client=await page.context().newCDPSession(page);try{return await client.send("Page.captureScreenshot",{format:"png",fromSurface:true,captureBeyondViewport:false});}finally{await client.detach();}}'));
  writeFileSync(path.join(directory, `${name}.png`), Buffer.from(shot.data, "base64"));
  const frame = { name, state: state(), ...native(), viewport: evaluate("()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})") };
  report.frames.push(frame); console.log(JSON.stringify(frame)); return frame;
}
async function waitState(fullscreen, maximized) {
  for (let i = 0; i < 50; i++) {
    const value = state(); if (value.isFullScreen === fullscreen && (maximized === undefined || value.isMaximized === maximized)) { await delay(250); return; }
    await delay(100);
  }
  throw Error(`Unexpected window state ${JSON.stringify(state())}`);
}
function fullscreen(frame) {
  for (const key of ["X", "Y", "Width", "Height"]) assert.ok(Math.abs(frame.Client[key] - frame.Monitor[key]) <= 1, `Fullscreen client must cover the whole monitor: ${key}, ${JSON.stringify(frame)}`);
}
function restored(actual, before) {
  for (const key of ["X", "Y", "Width", "Height"]) assert.ok(Math.abs(actual.Client[key] - before.Client[key]) <= 1, `Restore ${key}: ${JSON.stringify(actual.Client)} vs ${JSON.stringify(before.Client)}`);
}
function passed(name) {
  if (probe) { (report.observations ||= []).push(name); console.log(`OBSERVE ${name}`); }
  else { report.checks.push(name); console.log(`PASS ${name}`); }
}
async function close() {
  if (!child || child.exitCode !== null) return;
  evaluate("()=>{setTimeout(()=>window.ereader.windowControls.close(),200);return true;}");
  for (let i = 0; i < 100 && child.exitCode === null; i++) await delay(100);
  assert.notEqual(child.exitCode, null, "Reader must close normally");
}
try {
  if (binaryIndex < 0 && !process.argv.includes("--skip-build")) {
    const build = spawnSync(process.execPath, [path.join(root, "node_modules/@tauri-apps/cli/tauri.js"), "build", "--debug", "--no-bundle"], { cwd: root, windowsHide: true, stdio: "inherit" });
    assert.equal(build.status, 0, "Debug build failed");
  }
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  child = spawn(binary, [], { cwd: root, windowsHide: true, env: { ...process.env, EREADER_USER_DATA_DIR: data, EREADER_TEST_INPUT_ROOT: sourceDirectory, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", bytes => { report.stderr = (report.stderr || "") + bytes; });
  let connected = false;
  for (let i = 0; i < 150; i++) {
    assert.equal(child.exitCode, null); try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { connected = true; break; } } catch { /* starting */ } await delay(200);
  }
  assert.ok(connected); cli("attach", `--cdp=http://127.0.0.1:${port}`); cli("snapshot");
  evaluate('async()=>{for(let i=0;i<100;i++){if(window.ereader)return true;await new Promise(r=>setTimeout(r,100));}throw Error("Bridge did not load");}');
  if (libraryIndex < 0) {
    evaluate(`async()=>{await window.__TAURI_INTERNALS__.invoke("api",{method:"testImport",args:{paths:[${JSON.stringify(sourceFile)}]}});return true;}`);
  }
  evaluate('async()=>{for(let i=0;i<300;i++){const books=(await window.ereader.listLibrary()).books;if(books.some(b=>b.importStatus==="ready")&&document.querySelector(".book-card"))return true;window.dispatchEvent(new Event("focus"));await new Promise(r=>setTimeout(r,100));}throw Error("Synthetic library did not load");}');
  const library = evaluate("async()=>await window.ereader.listLibrary()");
  const book = library.books.find(book => book.contentType === "novel" && book.importStatus === "ready"); assert.ok(book);
  const escaped = book.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); click(new RegExp(`^${escaped} `));
  const normal = capture("normal"); click(/^最大化窗口$/); await waitState(false, true); const maximized = capture("maximized");
  click(/^阅读全屏 \(F11\)$/); await waitState(true); const fromMax = capture("maximized-to-fullscreen");
  if (!probe) fullscreen(fromMax);
  cli("press", "Escape"); await waitState(false, true); const maxRestored = capture("restored-maximized"); if (!probe) restored(maxRestored, maximized);
  click(/^还原窗口$/); await waitState(false, false); const normalRestored = capture("restored-normal"); if (!probe) restored(normalRestored, normal);
  passed("Toolbar fullscreen from maximized covers the monitor and restores both maximized and normal geometry");
  cli("press", "F11"); await waitState(true); const fromNormal = capture("normal-to-fullscreen"); if (!probe) fullscreen(fromNormal);
  cli("press", "Escape"); await waitState(false, false); if (!probe) restored({ Client: native().Client }, normal);
  passed("F11 from a normal window covers the monitor and restores the previous normal geometry");
  click(/^最大化窗口$/); await waitState(false, true); cli("press", "F11"); await waitState(true); const repeated = capture("maximized-f11-fullscreen"); if (!probe) fullscreen(repeated);
  click(/^返回书架$/); await waitState(false, true); if (!probe) restored({ Client: native().Client }, maximized);
  passed("F11 from maximized covers the monitor; leaving reading restores maximized geometry");
  report.console = cli("console"); await close(); report.exitCode = child.exitCode;
} catch (error) { report.failure = String(error); throw error; }
finally {
  if (child?.exitCode === null) await close().catch(() => child.kill());
  try { cli("detach"); } catch { /* disconnected */ }
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Window regression report: ${directory}`);
}
