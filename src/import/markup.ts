import DOMPurify from "dompurify";

export const cleanText = (value: string | null) => (value || "").replace(/\s+/g, " ").trim();
export function sanitizeReadingHtml(value: string): string {
  return DOMPurify.sanitize(value, { ALLOWED_TAGS: ["p","div","strong","em","b","i","span","br","ruby","rt","h1","h2","h3","h4","h5","h6"], ALLOWED_ATTR: [], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
}
export function parseHtml(value: string): HTMLElement {
  // Never attach this document to a WebView. CSP also disallows remote resources.
  const document = new DOMParser().parseFromString(value, "text/html");
  document.querySelectorAll("script,style,iframe,object,embed,link").forEach((node) => node.remove());
  return document.body;
}
export function resolveZipHref(base: string, href: string): string {
  if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(href)) throw new Error("External EPUB resources are not supported");
  const decoded = decodeURIComponent(href.split("#")[0].split("?")[0]).replace(/\\/g, "/");
  const parts = decoded.startsWith("/") ? [] : base.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (part === "..") { if (!parts.length) throw new Error("EPUB path escapes archive root"); parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
export function sampleIndexes(total: number, count: number): number[] {
  if (total <= 1) return total ? [0] : [];
  if (total <= count + 2) return Array.from({ length: total - 1 }, (_, i) => i + 1);
  const start = Math.max(2, Math.floor(total * 0.2)), end = Math.max(start, Math.floor((total - 1) * 0.7));
  count = Math.min(count, end - start + 1);
  return [...new Set(Array.from({ length: count }, (_, i) => Math.round(start + i * (end - start) / Math.max(1, count - 1))))];
}
export function imageHref(node: Element): string | null { return node.getAttribute("src") || node.getAttribute("href") || node.getAttribute("xlink:href"); }
