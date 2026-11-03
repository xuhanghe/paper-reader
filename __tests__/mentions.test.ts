import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deleteMention, insertMention, liveMentions, MENTION_HREF, mentionQuery, mentionRanges, mentionToken, typedMentionStart, withMentionLinks } from "../lib/mentions.js";

// A paper named inline: "compare @Title with …". The text keeps the name as
// typed; a mention lives as long as its "@Title" is whole in the text.

const A = { id: "AAA", name: "Understanding BlueField DPUs.pdf", zoteroKey: "AAA" };
const B = { id: "BBB", name: "BlueField", zoteroKey: "BBB" };
const C = { id: "CCC", name: "iPipe" };

describe("typing a mention", () => {
  test("an @ that starts a word begins one; an @ inside a word is just text", () => {
    assert.ok(typedMentionStart("compare ", "compare @", 9));
    assert.ok(typedMentionStart("", "@", 1));
    assert.ok(typedMentionStart("见", "见＠", 2) === false, "after a CJK character without a space it is text");
    assert.ok(typedMentionStart("（", "（@", 2), "after an opening bracket it starts a word");
    assert.ok(!typedMentionStart("mail", "mail@", 5));
    assert.ok(!typedMentionStart("compare", "compare @", 9), "a paste of two characters is not a typed @");
  });

  test("the name typed after the @ is the query, until the @ goes, the caret leaves, or a line breaks", () => {
    assert.equal(mentionQuery("compare @Blue", 8, 13), "Blue");
    assert.equal(mentionQuery("compare @Blue Field", 8, 19), "Blue Field", "names have spaces");
    assert.equal(mentionQuery("compare @", 8, 9), "");
    assert.equal(mentionQuery("compare Blue", 8, 12), null, "the @ is gone");
    assert.equal(mentionQuery("compare @Blue", 8, 6), null, "the caret moved before it");
    assert.equal(mentionQuery("compare @Blue\nmore", 8, 18), null);
  });

  test("picking replaces the @ and the name typed with the mention and a space", () => {
    const { text, caret } = insertMention("compare @blue with x", 8, 13, A);
    assert.equal(text, "compare @Understanding BlueField DPUs with x");
    assert.equal(caret, "compare @Understanding BlueField DPUs ".length);
    assert.equal(insertMention("@ip", 0, 3, C).text, "@iPipe ");
  });
});

describe("mentions in the text", () => {
  test("are found where they stand, each whole, the longer name first", () => {
    const text = "@BlueField vs @Understanding BlueField DPUs, and @iPipe";
    const ranges = mentionRanges(text, [B, A, C]);
    assert.deepEqual(ranges.map((r) => [r.ref.id, text.slice(r.start, r.end)]), [
      ["BBB", "@BlueField"], ["AAA", "@Understanding BlueField DPUs"], ["CCC", "@iPipe"],
    ]);
    assert.deepEqual(mentionRanges("mail@iPipe", [C]), [], "not inside a word");
  });

  test("one whose name is no longer whole is dropped; each paper is kept once", () => {
    assert.deepEqual(liveMentions("@iPipe and @iPipe", [C, A]).map((r) => r.id), ["CCC"]);
    assert.deepEqual(liveMentions("@iPip", [C]), []);
  });

  test("Backspace after or inside a mention takes it out whole; elsewhere it is an ordinary key", () => {
    const text = "see @iPipe now";
    assert.deepEqual(deleteMention(text, 10, [C], "Backspace"), { text: "see  now", caret: 4 });
    assert.deepEqual(deleteMention(text, 7, [C], "Backspace"), { text: "see  now", caret: 4 });
    assert.equal(deleteMention(text, 4, [C], "Backspace"), null, "just before it");
    assert.equal(deleteMention(text, 11, [C], "Backspace"), null);
    assert.deepEqual(deleteMention(text, 4, [C], "Delete"), { text: "see  now", caret: 4 });
    assert.equal(deleteMention(text, 10, [C], "Delete"), null);
  });
});

describe("a sent question", () => {
  test("draws its mentions as links the message view turns into marks, its other text untouched", () => {
    const text = "compare @iPipe with *this*";
    assert.equal(withMentionLinks(text, [C]), `compare [@iPipe](${MENTION_HREF}CCC) with *this*`);
    assert.equal(withMentionLinks(text, undefined), text);
    const odd = { id: "x/y", name: "A [bracketed] *title*" };
    assert.equal(withMentionLinks(`${mentionToken(odd)} ok`, [odd]), `[@A \\[bracketed\\] \\*title\\*](${MENTION_HREF}x%2Fy) ok`);
  });
});
