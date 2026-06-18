const { parentPort, workerData } = require("node:worker_threads");
const { createRepository } = require("./database.cjs");
const { createImporter } = require("./importer.cjs");

const repo = createRepository(workerData.userDataPath);
const importer = createImporter(repo, {
  onStarted(bookId) {
    parentPort.postMessage({ type: "started", bookId });
  },
  onFinished(bookId) {
    parentPort.postMessage({ type: "finished", bookId });
  },
  onProgress(bookId, progress) {
    parentPort.postMessage({ type: "progress", bookId, progress });
  },
  onCancelled(bookId) {
    parentPort.postMessage({ type: "cancelled", bookId });
  },
  onError(bookId, error) {
    parentPort.postMessage({
      type: "error",
      bookId,
      message: String(error?.message || error)
    });
  }
});

parentPort.on("message", (message) => {
  if (message?.type === "enqueue" && message.bookId) {
    importer.enqueue(message.bookId);
  }
  if (message?.type === "cancel" && message.bookId) {
    importer.cancel(message.bookId);
  }
});
