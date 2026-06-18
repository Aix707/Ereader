const path = require("node:path");
const { Worker } = require("node:worker_threads");

function createWorkerImporter(userDataPath, repo, options = {}) {
  let worker = null;
  const pending = new Set();

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(path.join(__dirname, "import-worker.cjs"), {
      workerData: { userDataPath }
    });

    worker.on("message", (message) => {
      if (!message?.bookId) return;
      if (message.type === "finished" || message.type === "error" || message.type === "cancelled") {
        pending.delete(message.bookId);
      }
      options.onStateChanged?.(message);
    });

    worker.on("error", (error) => {
      repo.addDiagnostic(null, "error", "Import worker crashed", {
        message: String(error?.message || error),
        stack: error?.stack || null
      });
    });

    worker.on("exit", (code) => {
      worker = null;
      if (code === 0) return;
      for (const bookId of pending) {
        repo.setStatus(bookId, "error", 0, `Import worker exited with code ${code}`);
      }
      pending.clear();
      repo.addDiagnostic(null, "error", "Import worker exited unexpectedly", { code });
    });

    return worker;
  }

  function enqueue(bookId) {
    pending.add(bookId);
    repo.setStatus(bookId, "queued", 0, null);
    options.onStateChanged?.({ type: "queued", bookId, progress: 0 });
    ensureWorker().postMessage({ type: "enqueue", bookId });
  }

  function cancel(bookId) {
    if (!pending.has(bookId)) return false;
    pending.delete(bookId);
    repo.setStatus(bookId, "cancelled", 0, "Import cancelled");
    options.onStateChanged?.({ type: "cancelled", bookId, progress: 0 });
    ensureWorker().postMessage({ type: "cancel", bookId });
    return true;
  }

  return {
    enqueue,
    cancel,
    enqueueMany(bookIds) {
      for (const bookId of bookIds) enqueue(bookId);
    },
    isActive() {
      return pending.size > 0;
    },
    dispose() {
      if (worker) worker.terminate();
      worker = null;
      pending.clear();
    }
  };
}

module.exports = { createWorkerImporter };
