import assert from "node:assert/strict";
import { test } from "vitest";
import { lastSpreadStartIndex, nextSpreadStart, pageIndexesForPreload, pageIndexesForSpread, previousSpreadStart } from "./comicReading";

test("spread navigation preserves cover and odd/even page behavior", () => {
  for (const spreadSize of [1, 2, 3]) {
    for (let total = 0; total < 40; total += 1) {
      const starts = total ? [0] : [];
      for (let index = 1; index < total; index += spreadSize) starts.push(index);
      assert.equal(lastSpreadStartIndex(total, spreadSize), starts.at(-1) || 0);
      starts.forEach((start, position) => {
        assert.equal(nextSpreadStart(start, total, spreadSize), starts[Math.min(starts.length - 1, position + 1)]);
        assert.equal(previousSpreadStart(start, spreadSize), starts[Math.max(0, position - 1)]);
        const expected = starts.slice(Math.max(0, position - 2), position + 3)
          .flatMap((index) => pageIndexesForSpread(index, spreadSize, total));
        assert.deepEqual(pageIndexesForPreload(start, spreadSize, total, 2), expected);
      });
    }
  }
});

test("preloading a million-page book only enumerates adjacent spreads", () => {
  assert.deepEqual(pageIndexesForPreload(500001, 2, 1000000, 1), [499999, 500000, 500001, 500002, 500003, 500004]);
  assert.equal(nextSpreadStart(999999, 1000000, 2), 999999);
  assert.equal(lastSpreadStartIndex(0, 2), 0);
});
