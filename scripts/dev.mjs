import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const devUrl = "http://127.0.0.1:5173";
const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
const electronCli = path.join(root, "node_modules", "electron", "cli.js");

const children = [];

function spawnChild(command, args, options = {}) {
  const { shutdownOnExit = false, ...spawnOptions } = options;
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...spawnOptions
  });
  children.push(child);
  child.on("exit", (code) => {
    if (shutdownOnExit) shutdown(code || 0);
    if (code && code !== 0) shutdown(code);
  });
  return child;
}

function waitForServer(url, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
        } else {
          setTimeout(check, 250);
        }
      });
      request.setTimeout(1000, () => {
        request.destroy();
      });
    };
    check();
  });
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

spawnChild(process.execPath, [viteBin, "--host", "127.0.0.1"]);
await waitForServer(devUrl);
spawnChild(process.execPath, [electronCli, "."], {
  shutdownOnExit: true,
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: devUrl
  }
});
