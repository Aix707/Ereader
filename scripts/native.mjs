import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
const executable = "src-tauri/target/release/ereader.exe";
const result = existsSync(executable)
  ? spawnSync(executable, process.argv.slice(2), { stdio: "inherit", windowsHide: true })
  : spawnSync("cargo", ["run", "--manifest-path", "src-tauri/Cargo.toml", "--", ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
