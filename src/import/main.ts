import { NativeReader } from "./source";
import { createSink, importCall } from "./units";

interface Job { id: string; bookId: string; format: string; contentType: string | null; sources: { name: string; size: number }[] }
async function run(job: Job) {
  const sink = createSink(job.id), source = new NativeReader(job.id, 0, job.sources[0].size);
  const configure = (contentType: "novel" | "comic") => importCall("configure", { job: job.id, contentType });
  if (job.format === "txt") { await configure("novel"); await (await import("./text")).processTxt(source, sink); }
  else if (job.format === "pdf") await (await import("./pdf")).processPdf(source, sink, job.contentType, configure);
  else if (job.format === "epub") await (await import("./epub")).processEpub(source, sink, job.contentType, configure);
  else if (job.format === "mobi") await (await import("./mobi")).processMobi(source, sink, job.contentType, configure);
  else if (job.format === "image-folder") {
    await configure("comic");
    const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
    const files = job.sources.map((source, index) => ({ ...source, index })).sort((a, b) => collator.compare(a.name, b.name));
    for (let index = 0; index < files.length; index++) {
      const file = files[index]; const bytes = await new NativeReader(job.id, file.index, file.size).all();
      const assetId = await sink.image(bytes);
      await sink.add({ unitIndex: index, type: "page", assetId, title: file.name, metadata: { sourceType: "image-folder" } });
      await sink.flush(); await sink.progress((index + 1) / files.length);
    }
  } else throw new Error("Unsupported format");
  await sink.flush();
}
async function main() {
  while (true) {
    const job = await importCall<Job | null>("next"); if (!job) return;
    try { await run(job); await importCall("complete", { job: job.id }); }
    catch (error) { console.error("Import failed", error); await importCall("complete", { job: job.id, error: String(error) }).catch(() => undefined); }
  }
}
main().catch(console.error);
