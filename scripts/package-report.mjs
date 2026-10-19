import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
function inspectFrontend(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.name === "node_modules" || /\.(map|ts|tsx|cjs)$/i.test(entry.name)) throw new Error(`Development-only content in distribution: ${file}`);
    return entry.isDirectory() ? inspectFrontend(file) : [file];
  });
}
const frontendFiles = inspectFrontend("dist");
const source = "src-tauri/target/release/bundle/nsis";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const installer = `Ereader_${version}_x64-setup.exe`;
mkdirSync("release", { recursive: true });
const target = `release/Ereader-${version}-Setup-x64.exe`;
copyFileSync(path.join(source, installer), target);
const size = statSync(target).size;
const binarySize = statSync("src-tauri/target/release/ereader.exe").size;
const report = { version, installer: target, sha256: createHash("sha256").update(readFileSync(target)).digest("hex"), installerBytes: size, executableBytes: binarySize, frontendFiles: frontendFiles.length, frontendBytes: frontendFiles.reduce((sum, file) => sum + statSync(file).size, 0), sourceMaps: 0, limits: { installerBytes: 30 * 1024 * 1024, installedBytes: 80 * 1024 * 1024 }, baseline: { installerBytes: 125798418, installedBytes: 493907241 }, webview2: "Shared Evergreen runtime; downloadBootstrapper", library: "Stored separately; excluded from program size" };
writeFileSync("release/size-report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (size > report.limits.installerBytes || binarySize > report.limits.installedBytes) process.exitCode = 1;
