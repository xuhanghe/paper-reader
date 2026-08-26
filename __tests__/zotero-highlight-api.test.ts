import assert from "node:assert/strict";
import test from "node:test";
import { standardHighlightRequest } from "../lib/zotero-highlight-api";

test("the standard highlight API needs one text-position object", () => {
  assert.deepEqual(
    standardHighlightRequest("ATTACH01", {
      text: "Figure 4a highlights",
      pageIndex: 3,
      rects: [[58.913, 345.807, 145.695, 354.714]],
    }),
    {
      attachmentKey: "ATTACH01",
      selection: {
        text: "Figure 4a highlights",
        position: { pageIndex: 3, rects: [[58.913, 345.807, 145.695, 354.714]] },
      },
      options: {},
    }
  );
});

test("colour and note remain optional overrides", () => {
  const body = standardHighlightRequest(
    "ATTACH01",
    { text: "TDP", pageIndex: 3, rects: [[1, 2, 3, 4]] },
    { color: "#ffd400", comment: "power limit" }
  );
  assert.deepEqual(body.options, { color: "#ffd400", comment: "power limit" });
});
