import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  MAX_WEB_PAGE_LINKS,
  MAX_WEB_PAGE_TEXT_CHARS,
  normalizeWebPageReading,
  WEB_PAGE_READ_EXPRESSION,
} from "./web-page-extract.js";

test("browser expression reads visible main text and absolute links", () => {
  const reading = runInNewContext(
    WEB_PAGE_READ_EXPRESSION,
    {
      URL,
      location: { href: "https://example.com/docs/start" },
      document: {
        title: "Guide",
        body: { innerText: "Navigation\nFull page" },
        querySelector: () => ({ innerText: "Visible guide text" }),
        querySelectorAll: () => [
          {
            getAttribute: () => "../next",
            innerText: "Next page",
          },
        ],
      },
    },
    { timeout: 1_000 },
  );

  assert.equal(reading.title, "Guide");
  assert.equal(reading.mainText, "Visible guide text");
  assert.equal(reading.bodyText, "Navigation\nFull page");
  assert.equal(reading.links[0].url, "https://example.com/next");
});

test("browser expression bounds the page title before returning it", () => {
  const reading = runInNewContext(
    WEB_PAGE_READ_EXPRESSION,
    {
      URL,
      location: { href: "https://example.com/" },
      document: {
        title: "x".repeat(10_000),
        body: { innerText: "" },
        querySelector: () => null,
        querySelectorAll: () => [],
      },
    },
    { timeout: 1_000 },
  );

  assert.ok(reading.title.length <= 501);
});

test("browser expression skips oversized links before transferring them", () => {
  const reading = runInNewContext(
    WEB_PAGE_READ_EXPRESSION,
    {
      URL,
      location: { href: "https://example.com/" },
      document: {
        title: "Links",
        body: { innerText: "" },
        querySelector: () => null,
        querySelectorAll: () => [{
          getAttribute: () => `/page/${"x".repeat(10_000)}`,
          innerText: "Oversized",
        }],
      },
    },
    { timeout: 1_000 },
  );

  assert.equal(reading.links.length, 0);
});

test("page normalization prefers main text and sanitizes links", () => {
  const reading = normalizeWebPageReading(
    {
      url: "https://example.com/articles/one",
      title: "  Example article  ",
      mainText: "  Main   text\r\n\r\n\r\nsecond line  ",
      bodyText: "Menu and whole page",
      links: [
        { text: " More ", url: "../two" },
        { text: "duplicate", url: "https://example.com/two" },
        { text: "Script", url: "javascript:alert(1)" },
        { text: "Mail", url: "mailto:test@example.com" },
        { text: "Other", url: "https://other.example/page" },
      ],
    },
    "https://example.com/fallback",
  );

  assert.equal(reading.url, "https://example.com/articles/one");
  assert.equal(reading.title, "Example article");
  assert.equal(reading.textSource, "main");
  assert.equal(reading.text, "Main text\n\nsecond line");
  assert.deepEqual(reading.links, [
    { text: "More", url: "https://example.com/two" },
    { text: "Other", url: "https://other.example/page" },
  ]);
  assert.deepEqual(reading.truncated, { text: false, links: false });
});

test("page normalization falls back to body and caps text and links", () => {
  const reading = normalizeWebPageReading(
    {
      mainText: "  ",
      bodyText: "x".repeat(MAX_WEB_PAGE_TEXT_CHARS + 1),
      links: Array.from(
        { length: MAX_WEB_PAGE_LINKS + 1 },
        (_, index) => ({ text: `Link ${index}`, url: `/page/${index}` }),
      ),
    },
    "https://example.com/start",
  );

  assert.equal(reading.textSource, "body");
  assert.equal(reading.text.length, MAX_WEB_PAGE_TEXT_CHARS);
  assert.equal(reading.links.length, MAX_WEB_PAGE_LINKS);
  assert.deepEqual(reading.truncated, { text: true, links: true });
});

test("page normalization rejects invalid output and tolerates malformed fields", () => {
  assert.throws(
    () => normalizeWebPageReading(undefined, "https://example.com"),
    /invalid data/i,
  );

  const reading = normalizeWebPageReading(
    {
      url: "javascript:alert(1)",
      title: 10,
      mainText: {},
      bodyText: null,
      links: [null, 4, {}, { text: 5, url: "/ok" }],
    },
    "https://example.com/fallback",
  );

  assert.equal(reading.url, "https://example.com/fallback");
  assert.equal(reading.title, "");
  assert.equal(reading.text, "");
  assert.equal(reading.textSource, "none");
  assert.deepEqual(reading.links, [
    { text: "", url: "https://example.com/ok" },
  ]);
});
