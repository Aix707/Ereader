import { invoke } from "@tauri-apps/api/core";
export interface ByteReader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
export class NativeReader implements ByteReader {
  constructor(readonly job: string, readonly index: number, readonly size: number) {}
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length < 0 || offset < 0 || offset + length > this.size) throw new Error("Invalid source range");
    const output = new Uint8Array(length);
    for (let cursor = 0; cursor < length; cursor += 4 * 1024 * 1024) {
      const count = Math.min(4 * 1024 * 1024, length - cursor);
      const bytes = await invoke<ArrayBuffer>("read_source", { job: this.job, index: this.index, offset: offset + cursor, length: count });
      output.set(new Uint8Array(bytes), cursor);
    }
    return output;
  }
  all() { return this.read(0, this.size); }
}
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
