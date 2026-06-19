const fs = require("node:fs");
const path = require("node:path");

const releaseDir = path.join(__dirname, "..", "release");

fs.rmSync(releaseDir, {
  force: true,
  maxRetries: 3,
  recursive: true,
  retryDelay: 100
});

