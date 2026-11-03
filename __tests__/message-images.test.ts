import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { imageExtension, imageFields, MAX_ATTACHED_IMAGES, messageImages, parseImageDataUrl, requestImages } from "../lib/message-images.js";
import { buildAskMessage } from "../lib/prompts.js";
import { askGist } from "../lib/session-recovery.js";

// A question carries any number of images. One is saved where a single image
// always was, so messages from before, and every reader of that field, are
// unchanged; only a question with several carries the list.

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const JPEG = "data:image/jpeg;base64,/9j/4AAQ";

describe("a message's images", () => {
  test("one is saved the old way, several as a list, none as nothing", () => {
    assert.deepEqual(imageFields(undefined), {});
    assert.deepEqual(imageFields([]), {});
    assert.deepEqual(imageFields([PNG]), { imageDataUrl: PNG });
    assert.deepEqual(imageFields([PNG, JPEG]), { imageDataUrls: [PNG, JPEG] });
  });

  test("are read back whichever way they were saved", () => {
    assert.deepEqual(messageImages({ imageDataUrl: PNG }), [PNG]);
    assert.deepEqual(messageImages({ imageDataUrls: [PNG, JPEG] }), [PNG, JPEG]);
    assert.deepEqual(messageImages({}), []);
    assert.deepEqual(messageImages(undefined), []);
  });
});

describe("the images a request carries", () => {
  test("the list, or the single image an older client sends", () => {
    assert.deepEqual(requestImages([PNG, JPEG]), [PNG, JPEG]);
    assert.deepEqual(requestImages(undefined, PNG), [PNG]);
    assert.deepEqual(requestImages(undefined, undefined), []);
  });

  test("anything that is not an image is dropped, and there are never more than the cap", () => {
    assert.deepEqual(requestImages([PNG, "data:text/plain;base64,aGk=", 42, "/etc/passwd", JPEG]), [PNG, JPEG]);
    assert.equal(requestImages(Array(MAX_ATTACHED_IMAGES + 3).fill(PNG)).length, MAX_ATTACHED_IMAGES);
  });

  test("each keeps its own type, for the APIs that check it", () => {
    assert.deepEqual(parseImageDataUrl(JPEG), { mime: "image/jpeg", base64: "/9j/4AAQ" });
    assert.equal(parseImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=")?.mime, "image/svg+xml");
    assert.equal(parseImageDataUrl("not a data url"), null);
    assert.equal(imageExtension("image/jpeg"), "jpg");
    assert.equal(imageExtension("image/webp"), "webp");
    assert.equal(imageExtension("image/svg+xml"), "png");
  });
});

describe("the question about several figures", () => {
  test("says how many there are, and one is asked as before", () => {
    assert.match(buildAskMessage({ kind: "figure", question: "how do they differ?", imageCount: 3 }), /^I captured the 3 attached figures from the paper\. My question: how do they differ\?/);
    assert.match(buildAskMessage({ kind: "figure", imageCount: 2 }), /^I captured the 2 attached figures from the paper\. Explain them\./);
    assert.match(buildAskMessage({ kind: "figure", imageCount: 1 }), /^I captured the attached figure from the paper\. Explain it\./);
    assert.match(buildAskMessage({ kind: "figure" }), /^I captured the attached figure from the paper\. Explain it\./);
  });

  test("and the record's index names it", () => {
    assert.deepEqual(askGist("[turn 4] I captured the 2 attached figures from the paper. My question: which is faster?").gist, "2 captured figures — which is faster?");
    assert.deepEqual(askGist("[turn 5] I captured the attached figure from the paper. Explain it.").gist, "a captured figure");
  });
});
