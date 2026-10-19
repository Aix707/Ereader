import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookCard } from "../components/BookCard";
import type { BookItem, ImportStatus } from "../types";

const book: BookItem = {
  id: "test", title: "长标题的测试书籍", path: "fixture.mobi", kind: "file", format: "mobi", contentType: "comic",
  addedAt: "2026-10-19T00:00:00Z", progress: { kind: "page", percent: 0.25 },
  preferences: { fontSize: 18, lineHeight: 1.8, pageSpread: "double", readingDirection: "rtl" }
};
function card(status: ImportStatus, units = 0) {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(createElement(BookCard, {
    book: { ...book, importStatus: status, unitCount: units, importProgress: 0.67, importError: status === "error" ? "Full import diagnostic" : null },
    onOpen() {}, async onRemove() {}, async onUpdateBook() { return book; }, async onRebuild() {}, async onCancelImport() {}
  }));
  return root;
}

describe("book card import and reading state", () => {
  it("shows import state instead of provisional category or reading percent", () => {
    for (const status of ["queued", "processing"] as const) {
      const root = card(status);
      expect(root.querySelector(".book-summary-island")?.textContent).toBe("处理中");
      expect(root.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("67");
      expect(root.querySelector(".book-open-area")?.hasAttribute("disabled")).toBe(true);
    }
  });
  it("shows only category and reading progress for ready books", () => {
    const root = card("ready", 197);
    expect(root.querySelector(".book-summary-island")?.textContent).toBe("漫画·25%");
    expect(root.querySelector("[role='progressbar']")).toBeNull();
    expect(root.querySelector(".book-open-area")?.hasAttribute("disabled")).toBe(false);
  });
  it("keeps completed content readable during rebuild and confines diagnostics to details", () => {
    expect(card("processing", 197).querySelector(".book-open-area")?.hasAttribute("disabled")).toBe(false);
    const root = card("error", 197);
    expect(root.querySelector(".book-summary-island")?.textContent).toBe("处理失败");
    expect(root.querySelector(".book-open-area .card-error")).toBeNull();
    expect(root.querySelector(".book-hover-panel .card-error")?.textContent).toBe("Full import diagnostic");
    for (const [status, label] of [["cancelled", "已取消"], ["stale", "需重建"]] as const) {
      expect(card(status, 197).querySelector(".book-summary-island")?.textContent).toBe(label);
    }
  });
});
