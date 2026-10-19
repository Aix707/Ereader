import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status) throw result.error || new Error(result.stderr);
  return result.stdout;
}
const read = file => JSON.parse(readFileSync(file, "utf8"));
const { version } = read("package.json");
assert.equal(read("src-tauri/tauri.conf.json").version, version);
assert.equal(git("status", "--porcelain").trim(), "", "Commit reviewed source changes before preparing release archives");
const commit = git("rev-parse", "HEAD").trim();
const tree = git("ls-tree", "-r", "-z", "HEAD").split("\0").filter(Boolean).map(value => {
  const match = value.match(/^\d+ blob ([a-f0-9]+)\t([\s\S]+)$/);
  assert.ok(match, "Only regular files belong in the source release");
  return { sha: match[1], file: match[2] };
});
for (const { file } of tree) {
  assert.ok(!/^(?:output|dist|release|node_modules|\.playwright-cli|src-tauri\/(?:target|gen))\//.test(file), `Generated data in source: ${file}`);
  assert.ok(!/(?:^|\/)\.env(?:\.|$)|\.(?:sqlite(?:-wal|-shm)?|db|log|map)$/.test(file), `Local data in source: ${file}`);
  if (!/\.(?:png|ico|jpe?g|webp|gif|tiff?|avif)$/i.test(file)) {
    const content = git("show", `HEAD:${file}`);
    assert.ok(!/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content), `Potential credential in ${file}`);
    assert.ok(!/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+/i.test(content), `Local profile path in ${file}`);
  }
}
const size = read("release/size-report.json");
const installer = `Ereader-${version}-Setup-x64.exe`;
const portable = "Ereader.exe";
const source = `Ereader-${version}-Source.zip`;
const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");
assert.equal(sha256(path.join("release", installer)), size.sha256, "Installer must match the build report");
assert.ok(size.installerBytes <= size.limits.installerBytes);
copyFileSync("src-tauri/target/release/ereader.exe", path.join("release", portable));
git("-c", "core.autocrlf=false", "archive", "--format=zip", `--prefix=Ereader-${version}/`, `--output=release/${source}`, "HEAD");
const reader = new ZipReader(new Uint8ArrayReader(readFileSync(path.join("release", source))), { useWebWorkers: false });
try {
  const entries = (await reader.getEntries()).filter(entry => !entry.directory);
  const expected = new Map(tree.map(entry => [entry.file, entry.sha]));
  assert.equal(entries.length, expected.size);
  for (const entry of entries) {
    const file = entry.filename.replace(`Ereader-${version}/`, "");
    const bytes = await entry.getData(new Uint8ArrayWriter());
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    assert.equal(blob, expected.get(file), `Source archive differs from Git: ${file}`);
    expected.delete(file);
  }
  assert.equal(expected.size, 0);
} finally {
  await reader.close();
}
const assets = [installer, portable, source].map(name => ({ name, bytes: readFileSync(path.join("release", name)).length, sha256: sha256(path.join("release", name)) }));
writeFileSync("release/SHA256SUMS.txt", assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(""));
writeFileSync("release/release-manifest.json", JSON.stringify({ version, commit, sourceFiles: tree.length, assets }, null, 2));
console.log(JSON.stringify({ version, commit, sourceFiles: tree.length, assets }, null, 2));
