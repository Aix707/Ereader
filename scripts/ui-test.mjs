import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createFixtures } from "./fixtures.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = path.join(root, "output/playwright/ui-refresh", `check-${Date.now()}`);
const fixture = await createFixtures(path.join(directory, "sources"));
const pkg = JSON.parse(readFileSync(path.join(root, "node_modules/@playwright/cli/package.json"), "utf8"));
const cliEntry = path.join(root, "node_modules/@playwright/cli", pkg.bin["playwright-cli"]);
const session = `ereader-ui-${process.pid}`;
const report = { directory, checks: [], matrix: [], scaling: "Native WebView2 zoom; viewport sizes are measured CSS pixels. This does not change Windows display settings." };
let child;
let debugEndpoint;
function cli(...args) {
  const run = (values) => spawnSync(process.execPath, [cliEntry, `-s=${session}`, ...values], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 12 * 1024 * 1024 });
  let result = run(args);
  // The external CDP client can lose its session independently of the app.
  // Reattach only for a missing client session while the native app is alive;
  // never replay an element action whose refs would have changed on attachment.
  if (result.status && /is not open, please run open first/.test(result.stdout + result.stderr) && debugEndpoint && ["snapshot", "eval", "mousemove"].includes(args[0])) {
    process.kill(child.pid, 0);
    const attached = run(["attach", `--cdp=${debugEndpoint}`]);
    if (attached.status || attached.error) throw attached.error || new Error(attached.stderr + attached.stdout);
    report.debugReconnects = (report.debugReconnects || 0) + 1;
    result = run(args);
  }
  if (result.error || result.status) throw result.error || new Error(result.stderr || result.stdout);
  return result.stdout;
}
function evaluate(code) {
  const output = cli("eval", code);
  const result = output.match(/### Result\r?\n([\s\S]*?)(?:\r?\n###|$)/)?.[1];
  if (result === undefined) throw new Error(output);
  return JSON.parse(result);
}
function resultOf(output) {
  const result = output.match(/### Result\r?\n([\s\S]*?)(?:\r?\n###|$)/)?.[1];
  if (result === undefined) throw new Error(output);
  return JSON.parse(result);
}
function click(pattern) {
  if (state().isFullScreen) cli("mousemove", "100", "20");
  const snapshot = cli("snapshot");
  const buttons = [...snapshot.matchAll(/button "([^"]+)"[^\r\n]*?\[ref=(e\d+)\]/g)].filter((match) => pattern.test(match[1]));
  assert.equal(buttons.length, 1, `Expected one button for ${pattern}, got ${buttons.map((b) => b[1]).join(", ")}`);
  cli("click", buttons[0][2]);
}
function passed(name) { report.checks.push(name); console.log(`PASS ${name}`); }
function capture(name) {
  // Playwright's calculated clip double-applies WebView2 zoom. Capture the native
  // surface directly so high-zoom evidence includes the entire viewport.
  const shot = resultOf(cli("run-code", 'async page=>{const client=await page.context().newCDPSession(page);try{return {...await client.send("Page.captureScreenshot",{format:"png",fromSurface:true,captureBeyondViewport:false}),native:await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke("api",{method:"testWindow",args:{}}))};}finally{await client.detach();}}'));
  const bytes=Buffer.from(shot.data,"base64");
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  assert.ok(Math.abs(width-shot.native.width)<=2&&Math.abs(height-shot.native.height)<=2,`Incomplete screenshot ${name}: ${width}x${height}, native ${shot.native.width}x${shot.native.height}`);
  writeFileSync(path.join(directory, `${name}.png`),bytes);
  (report.frames ||= []).push({name,width,height});
}
const native = (args = {}) => evaluate(`async()=>await window.__TAURI_INTERNALS__.invoke("api",{method:"testWindow",args:${JSON.stringify(args)}})`);
const state = () => evaluate("async()=>await window.ereader.windowControls.getState()");
async function waitState(fullscreen, maximized) {
  for (let i = 0; i < 60; i++) {
    const value = state();
    if (value.isFullScreen === fullscreen && (maximized === undefined || value.isMaximized === maximized)) {
      if (fullscreen) {
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.join(root,"scripts/window-metrics.ps1"), "-ReaderProcessId", String(child.pid)], { windowsHide: true, encoding: "utf8", timeout: 15000 });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const bounds = JSON.parse(result.stdout);
        for (const key of ["X", "Y", "Width", "Height"]) assert.ok(Math.abs(bounds.Client[key] - bounds.Monitor[key]) <= 1, `Fullscreen client does not cover the monitor: ${JSON.stringify(bounds)}`);
        (report.fullscreenBounds ||= []).push(bounds);
      }
      return value;
    }
    await delay(80);
  }
  throw new Error(`Window did not reach fullscreen=${fullscreen}, maximized=${maximized}`);
}
async function viewport(width, height, zoom = 1) {
  return evaluate(`async()=>{
    const call=args=>window.__TAURI_INTERNALS__.invoke("api",{method:"testWindow",args});
    const pause=()=>new Promise(r=>setTimeout(r,120));
    const initial=await call({zoom:${zoom}});await pause();
    let factor=devicePixelRatio/initial.scaleFactor;
    for(let i=0;i<3;i++){
      await call({width:${width}*factor,height:${height}*factor,x:0,y:0});await pause();
      const actual={width:innerWidth,height:innerHeight,dpr:devicePixelRatio};
      if(Math.abs(actual.width-${width})<=1&&Math.abs(actual.height-${height})<=1)return actual;
      factor*=${width}/actual.width;
    }
    throw Error("Cannot set viewport ${width}x${height} at ${zoom}");
  }`);
}
async function settle() {
  for (let i = 0; i < 120; i++) {
    const library = evaluate("async()=>await window.ereader.listLibrary()");
    if (!library.books.some((book) => ["processing", "queued"].includes(book.importStatus))) return library;
    await delay(500);
  }
  throw new Error("UI fixture import did not settle");
}
function importFiles(paths) {
  return evaluate(`async()=>{await window.__TAURI_INTERNALS__.invoke("api",{method:"testImport",args:{paths:${JSON.stringify(paths)}}});window.dispatchEvent(new Event("focus"));return true;}`);
}
function refresh() { evaluate('()=>{window.dispatchEvent(new Event("focus"));return true;}'); }
function metrics() {
  return evaluate(`()=>{
    const box=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
    const visible=n=>n.getClientRects().length>0&&getComputedStyle(n).visibility!=="hidden";
    const fonts=[...new Set([...document.querySelectorAll("body *")].filter(n=>visible(n)&&[...n.childNodes].some(c=>c.nodeType===3&&c.textContent.trim())).map(n=>getComputedStyle(n).fontSize))];
    const cards=[...document.querySelectorAll(".book-card")].map(n=>{const r=box(n),badge=box(n.querySelector(".book-summary-island"));return {...r,badge,offset:Math.abs(r.x+r.width/2-badge.x-badge.width/2)};});
    return {width:innerWidth,height:innerHeight,fonts,cards,controls:[...document.querySelectorAll(".window-controls button,.titlebar-actions .toolbar-button,.search-box,.continue-action")].map(box),overview:[...document.querySelectorAll(".stats-overview-card")].map(box),columns:document.querySelector(".stats-grid")?getComputedStyle(document.querySelector(".stats-grid")).gridTemplateColumns.split(" ").length:0,overflow:document.documentElement.scrollWidth>innerWidth+1||[...document.querySelectorAll(".library-main,.stats-shell")].some(n=>n.scrollWidth>n.clientWidth+1)};
  }`);
}
function assertMetrics(value) {
  report.lastMetrics = value;
  assert.ok(!value.overflow, "No horizontal layout overflow");
  assert.ok(value.fonts.every((font) => ["12px", "14px", "20px"].includes(font)), JSON.stringify(value.fonts));
  for (const control of value.controls) assert.ok(Math.abs(control.height - 32) < 0.2, JSON.stringify(control));
  for (const card of value.cards) { assert.ok(card.offset <= 1, JSON.stringify(card)); assert.ok(Math.abs(card.badge.height - 24) < 0.2); }
  if (value.overview.length) {
    assert.equal(value.columns, 2);
    assert.equal(value.overview.length, 4);
    assert.ok(value.overview.every((card) => Math.abs(card.height - 88) < 0.2));
    assert.ok(Math.max(...value.overview.map((card) => card.width)) - Math.min(...value.overview.map((card) => card.width)) <= 1);
  }
}
async function close() {
  if (!child || child.exitCode !== null) return;
  try { evaluate("()=>{setTimeout(()=>window.ereader.windowControls.close(),300);return true;}"); } catch { /* window closed */ }
  for (let i = 0; i < 100 && child.exitCode === null; i++) await delay(100);
  assert.notEqual(child.exitCode, null, "UI test app must exit normally");
}
async function startApp() {
  const server = createServer(); await new Promise((resolve) => server.listen(0,"127.0.0.1",resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve));
  debugEndpoint = `http://127.0.0.1:${port}`;
  child = spawn(path.join(root,"src-tauri/target/debug/ereader.exe"), [], { cwd: root, windowsHide: true, env: { ...process.env, EREADER_USER_DATA_DIR: path.join(directory,"data"), EREADER_TEST_INPUT_ROOT: fixture.root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: ["ignore","pipe","pipe"] });
  child.stderr.on("data", (chunk) => { report.stderr=(report.stderr||"")+chunk; });
  child.stdout.on("data", (chunk) => { report.stdout=(report.stdout||"")+chunk; });
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error("UI app exited");try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{/* starting */}await delay(200);}
  cli("attach",`--cdp=http://127.0.0.1:${port}`); cli("snapshot");
}
if (!process.argv.includes("--skip-build")) {
  const build = spawnSync(process.execPath, [path.join(root,"node_modules/@tauri-apps/cli/tauri.js"), "build", "--debug", "--no-bundle"], { cwd: root, stdio: "inherit", windowsHide: true });
  if (build.status) process.exit(build.status || 1);
}
try {
  await startApp(); await viewport(1180,780);
  capture("empty-library"); cli("press","F11"); assert.equal(state().isFullScreen,false);
  cli("run-code",'async page=>{await page.locator(".app-titlebar").dblclick({position:{x:400,y:3}});}');await waitState(false,true);
  cli("run-code",'async page=>{await page.locator(".app-titlebar").dblclick({position:{x:400,y:3}});}');await waitState(false,false);
  click(/^统计$/); capture("empty-stats"); assertMetrics(metrics()); click(/^返回书架$/);
  passed("Compact empty states, three window controls and F11 limited to reading");
  const longTitle=path.join(fixture.root,"这是用于检查省略和对齐的很长书名《旅行、阅读与生活》.txt");copyFileSync(fixture.txt,longTitle);
  importFiles([fixture.txt,fixture.gbk,fixture.utf16,fixture.utf32,fixture.epub,fixture.comicEpub,fixture.mobi,fixture.comicMobi,fixture.pdf,fixture.images,fixture.broken,longTitle]);
  let library=await settle();
  const titles=["长篇中文阅读","中文编码示例","阅读札记","生活随笔","图文小说","短篇合集","漫画第一卷","漫画第二卷"];
  evaluate(`async()=>{const books=(await window.ereader.listLibrary()).books.filter(b=>b.importStatus==="ready"&&!b.title.startsWith("这是"));for(let i=0;i<books.length;i++)await window.ereader.updateBook(books[i].id,{title:${JSON.stringify(titles)}[i]||books[i].title,lastOpenedAt:new Date(Date.now()-i*3600000).toISOString(),progress:{percent:i/12}});return true;}`);
  refresh(); await delay(200);
  for(const [width,height] of [[880,600],[1180,780],[1440,900]])for(const zoom of [1,1.25,1.5]){
    await viewport(width,height,zoom);const value=metrics();assertMetrics(value);capture(`library-${width}-${height}-${zoom}`);
    click(/^统计$/);const stats=metrics();assertMetrics(stats);capture(`stats-${width}-${height}-${zoom}`);click(/^返回书架$/);
    report.matrix.push({width,height,zoom,actual:{width:value.width,height:value.height},fonts:value.fonts,columns:stats.columns});
    console.log(`PASS layout ${width}x${height} ${zoom*100}%`);
  }
  passed("Nine size/zoom combinations: aligned controls, centered badges, three font sizes, compact statistics");
  await viewport(1180,780);
  const slow=path.join(fixture.root,"连续导入漫画");mkdirSync(slow);for(let i=0;i<5000;i++)copyFileSync(path.join(root,"tests/fixtures/image.png"),path.join(slow,`page${i}.png`));
  const queued=path.join(fixture.root,"排队中的长标题中文书籍.txt");writeFileSync(queued,"排队后正常导入\n\n中文内容");importFiles([slow,queued]);await delay(100);refresh();
  assertMetrics(metrics());capture("processing-library");
  const pending=evaluate('async()=>{const books=(await window.ereader.listLibrary()).books.filter(b=>["processing","queued"].includes(b.importStatus));return books.map(b=>({id:b.id,status:b.importStatus}));}');
  assert.ok(pending.length>0,"Capture active imports");
  const badges=evaluate('()=>[...document.querySelectorAll(".book-summary-island.processing,.book-summary-island.queued")].map(n=>n.textContent)');assert.ok(badges.length>0&&badges.every(text=>text==="处理中"));
  await viewport(880,600);cli("snapshot");
  cli("run-code",'async page=>{const card=page.locator(".book-card").filter({has:page.getByRole("heading",{name:"连续导入漫画",exact:true})});await card.hover();await card.getByRole("button",{name:"取消导入",exact:true}).click();}');
  evaluate(`async()=>{for(const b of ${JSON.stringify(pending)})await window.ereader.cancelImport(b.id);return true;}`);await settle();refresh();capture("cancelled-library");assertMetrics(metrics());
  passed("Queued/processing/cancelled/error cards keep their frames and centered status labels");
  await viewport(1180,780);
  library=evaluate("async()=>await window.ereader.listLibrary()");
  const novel=library.books.find(b=>b.format==="txt"&&b.unitCount>1000&&!b.title.startsWith("这是"));
  click(new RegExp(`^${novel.title} `));await delay(200);
  click(/^小说排版$/);const inputWindow=native();
  cli("run-code",'async page=>{await page.getByPlaceholder("搜索系统字体").fill("serif");await page.getByPlaceholder("搜索系统字体").dblclick();await page.locator(".typography-range input").first().click();}');
  const afterInput=native();for(const key of ["width","height","x","y"])assert.equal(afterInput[key],inputWindow[key],`Input dragged or maximized window: ${key}`);
  cli("press","Escape");capture("novel-reader");
  const before=native({x:60,y:60});cli("press","F11");await waitState(true);
  assert.equal(evaluate('()=>document.querySelector(".window-controls button:nth-child(2)").disabled'),true);
  click(/^小说排版$/);await delay(2000);assert.equal(evaluate('()=>document.querySelector(".reader-shell").classList.contains("chrome-hidden")'),false);
  cli("press","Escape");assert.equal(evaluate('()=>!!document.querySelector(".typography-popover")'),false);assert.equal(state().isFullScreen,true);
  cli("press","Escape");await waitState(false,false);const restored=native();
  for(const key of ["width","height","x","y"])assert.ok(Math.abs(before[key]-restored[key])<=1,`${key}: ${before[key]} vs ${restored[key]}`);
  passed("Fullscreen restores normal geometry; Escape closes the menu before exiting fullscreen");
  click(/^最大化窗口$/);await waitState(false,true);cli("press","F11");await waitState(true);
  cli("run-code",'async page=>{await page.locator(".reader-toolbar").dblclick({position:{x:400,y:3}});}');assert.equal(state().isFullScreen,true);
  evaluate('async()=>{await window.ereader.windowControls.minimize();return true;}');assert.equal(native().isMinimized,true);native({restore:true});assert.equal(state().isFullScreen,true);
  cli("press","F11");await waitState(false,true);
  evaluate('async()=>{await window.ereader.windowControls.setFullScreen(true);await window.ereader.windowControls.setFullScreen(true);await window.ereader.windowControls.setFullScreen(false);await window.ereader.windowControls.setFullScreen(false);return true;}');await waitState(false,true);
  cli("run-code",'async page=>{await page.keyboard.down("F11");await page.keyboard.down("F11");await page.keyboard.up("F11");}');await waitState(true);
  cli("run-code",'async page=>{await page.mouse.click(600,400);await page.mouse.move(600,400);}');await delay(2100);
  assert.equal(evaluate('()=>document.querySelector(".reader-shell").classList.contains("chrome-hidden")'),true);
  const textInsets = evaluate('()=>{const scroll=document.querySelector(".text-reader-scroll"),r=scroll.getBoundingClientRect();return {top:r.top,scrollTop:scroll.scrollTop,gap:parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--gap-md")),uncovered:!!document.elementFromPoint(r.x+r.width/2,r.top+2)?.closest(".text-reader-scroll")};}');
  assert.ok(Math.abs(textInsets.top-textInsets.gap)<=1,"Hidden toolbar must release its reserved reading space");
  assert.equal(textInsets.uncovered,true,"Nothing covers the top of the novel viewport");
  capture("novel-fullscreen-hidden");
  cli("mousemove","100","20");assert.equal(evaluate('()=>document.querySelector(".reader-shell").classList.contains("chrome-hidden")'),false);
  const revealedInsets=evaluate('()=>{const scroll=document.querySelector(".text-reader-scroll");return {top:scroll.getBoundingClientRect().top,scrollTop:scroll.scrollTop,toolbarBottom:document.querySelector(".reader-toolbar").getBoundingClientRect().bottom};}');
  assert.ok(revealedInsets.top>=revealedInsets.toolbarBottom+textInsets.gap-1,"Visible toolbar must stay above the novel viewport");
  assert.ok(Math.abs(revealedInsets.scrollTop-textInsets.scrollTop)<=1,"Revealing the toolbar preserves the reading offset");
  click(/^返回书架$/);await waitState(false,true);assert.equal(evaluate('()=>!!document.querySelector(".reader-shell")'),false);cli("press","F11");assert.equal(state().isFullScreen,false);
  passed("Maximized restore, fullscreen minimization, idempotent requests, repeated F11 and leaving the reader");
  click(/^还原窗口$/);await waitState(false,false);
  const unmaximized=native();for(const key of ["width","height","x","y"])assert.ok(Math.abs(before[key]-unmaximized[key])<=1,`Normal restore after maximized fullscreen: ${key}`);
  await viewport(1180,780);
  const comic=library.books.find(b=>b.contentType==="comic"&&b.importStatus==="ready");click(new RegExp(`^${comic.title} `));await delay(200);cli("press","F11");await waitState(true);
  click(/^跳转页码$/);cli("press","Escape");assert.equal(state().isFullScreen,true);assert.equal(evaluate('()=>!!document.querySelector("input[aria-label=跳转页码]")'),false);
  cli("press","Escape");await waitState(false,false);capture("comic-reader");click(/^返回书架$/);
  report.diagnostics=evaluate("async()=>(await window.ereader.getDiagnostics()).stats");for(const key of ["orphanAssets","missingAssets","readyWithoutUnits"])assert.equal(report.diagnostics[key],0);
  passed("Comic page-jump Escape, reading controls and database integrity");
  const beforeRestart=native();await close();try{cli("detach");}catch{/* closed */}await startApp();const afterRestart=native();
  for(const key of ["width","height"])assert.ok(Math.abs(beforeRestart[key]-afterRestart[key])<=1,`Window grew after restart: ${key}, ${beforeRestart[key]} -> ${afterRestart[key]}`);
  report.windowRestart={before:beforeRestart,after:afterRestart};passed("Saved window dimensions do not grow when the application restarts");
  await close();
} catch(error) { report.failure=String(error);report.processExitAtFailure=child?.exitCode;try{capture("failure");}catch{/* page gone */}throw error; }
finally {
  writeFileSync(path.join(directory,"report.json"),JSON.stringify(report,null,2));
  writeFileSync(path.join(root,"output/playwright/ui-refresh/report.json"),JSON.stringify(report,null,2));
  if(child&&child.exitCode===null)await close().catch(()=>child.kill());
  try{cli("detach");}catch{/* disconnected */}
  console.log(`UI verification report: ${directory}`);
}
