import { invoke } from "@tauri-apps/api/core";
import type { TextUnit } from "../types";
import { normalizeImage, type EncodedImage } from "./image";

export type ImportUnit = Omit<Partial<TextUnit>, "type"> & { unitIndex: number; type: TextUnit["type"] | "page" };
export interface UnitSink {
  add(unit: ImportUnit): Promise<void>;
  flush(): Promise<void>;
  progress(value: number): Promise<void>;
  image(bytes: Uint8Array): Promise<number>;
  encoded(image: EncodedImage): Promise<number>;
}
export function importCall<T>(method: string, args: Record<string, unknown> = {}): Promise<T> { return invoke("import_api", { method, args }); }
export function createSink(job: string): UnitSink {
  let units: ImportUnit[] = [], characters = 0, updated = 0;
  const sink: UnitSink = {
    async add(unit) { units.push(unit); characters += (unit.text?.length || 0) + (unit.html?.length || 0); if (units.length >= 300 || characters >= 2 * 1024 * 1024) await sink.flush(); },
    async flush() { if (!units.length) return; await importCall("units", { job, units }); units = []; characters = 0; },
    async progress(value) { if (performance.now() - updated < 100 && value < 0.99) return; updated = performance.now(); await importCall("progress", { job, progress: value }); },
    async image(bytes) { return sink.encoded(await normalizeImage(bytes, job)); },
    encoded: (image) => invoke<number>("write_asset", image.bytes, { headers: { "x-meta": JSON.stringify({ job, ...image.meta }) } })
  };
  return sink;
}
