import { invoke } from "@tauri-apps/api/core";

export interface EncodedImage { bytes: ArrayBuffer; meta: { width: number; height: number; mime: "image/webp" } }
export async function encodeCanvas(canvas: HTMLCanvasElement, quality = 0.92): Promise<EncodedImage> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Image encoding failed")), "image/webp", quality));
  if (blob.type !== "image/webp") throw new Error("WebP encoding is unavailable");
  return { bytes: await blob.arrayBuffer(), meta: { width: canvas.width, height: canvas.height, mime: "image/webp" } };
}
export async function normalizeImage(bytes: Uint8Array, job: string, limit = 3200, quality = 0.92): Promise<EncodedImage> {
  const canvas = document.createElement("canvas");
  let bitmap: ImageBitmap | undefined;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    const tiff = (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[3] === 42);
    if (tiff) {
      const raw = await invoke<ArrayBuffer>("decode_tiff", bytes, { headers: { "x-meta": JSON.stringify({ job }) } });
      const view = new DataView(raw);
      const width = view.getUint32(0, true), height = view.getUint32(4, true);
      const staging = document.createElement("canvas");
      try {
        staging.width = width; staging.height = height;
        staging.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(raw, 8), width, height), 0, 0);
        const scale = Math.min(1, limit / Math.max(width, height));
        canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
        context.drawImage(staging, 0, 0, canvas.width, canvas.height);
      } finally { staging.width = 0; staging.height = 0; }
    } else {
      bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: "from-image" });
      const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    }
    return await encodeCanvas(canvas, quality);
  } finally { bitmap?.close(); canvas.width = 0; canvas.height = 0; }
}
