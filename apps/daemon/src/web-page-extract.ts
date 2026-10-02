export const MAX_WEB_PAGE_TEXT_CHARS = 30_000;
export const MAX_WEB_PAGE_LINKS = 100;

const MAX_RAW_LINKS = 300;
const MAX_TITLE_CHARS = 500;
const MAX_LINK_TEXT_CHARS = 160;
const MAX_URL_CHARS = 4_096;

export interface WebPageReading {
  url: string;
  title: string;
  textSource: "main" | "body" | "none";
  text: string;
  links: Array<{ text: string; url: string }>;
  truncated: {
    text: boolean;
    links: boolean;
  };
}

// Evaluate this in the page, then pass its value to normalizeWebPageReading.
// Limit data before CDP transfers it as well as after it reaches the daemon.
export const WEB_PAGE_READ_EXPRESSION = `(() => {
  const textLimit = ${MAX_WEB_PAGE_TEXT_CHARS + 1};
  const linkLimit = ${MAX_RAW_LINKS};
  const main = document.querySelector('main, [role="main"], article');
  const mainText = typeof main?.innerText === 'string' ? main.innerText : '';
  const bodyText = typeof document.body?.innerText === 'string'
    ? document.body.innerText : '';
  const anchors = document.querySelectorAll('a[href]');
  const links = [];
  for (let index = 0; index < Math.min(anchors.length, linkLimit); index++) {
    const anchor = anchors[index];
    const href = anchor.getAttribute('href');
    if (!href || href.length > ${MAX_URL_CHARS}) continue;
    try {
      const url = new URL(href, document.baseURI || location.href).href;
      if (url.length > ${MAX_URL_CHARS}) continue;
      links.push({
        text: String(anchor.innerText || anchor.getAttribute('aria-label') || '').slice(0, ${MAX_LINK_TEXT_CHARS + 1}),
        url,
      });
    } catch {
      // Ignore malformed page links.
    }
  }
  return {
    url: location.href,
    title: String(document.title || '').slice(0, ${MAX_TITLE_CHARS + 1}),
    mainText: mainText.slice(0, textLimit),
    bodyText: bodyText.slice(0, textLimit),
    mainTextTruncated: mainText.length > textLimit - 1,
    bodyTextTruncated: bodyText.length > textLimit - 1,
    links,
    linksTruncated: anchors.length > linkLimit,
  };
})()`;

export function normalizeWebPageReading(
  raw: unknown,
  fallbackUrl: string,
): WebPageReading {
  if (!isRecord(raw)) {
    throw new Error("Page extraction returned invalid data");
  }

  const fallback = httpUrl(fallbackUrl);
  if (!fallback) {
    throw new Error("Page URL must be an http or https URL");
  }
  const url = httpUrl(raw.url, fallback) ?? fallback;
  const title = oneLine(raw.title).slice(0, MAX_TITLE_CHARS);
  const mainText = readableText(raw.mainText);
  const bodyText = readableText(raw.bodyText);
  const textSource = mainText
    ? "main"
    : bodyText
      ? "body"
      : "none";
  const selectedText = textSource === "main"
    ? mainText
    : textSource === "body"
      ? bodyText
      : "";
  const textTruncated = textSource === "main"
    ? raw.mainTextTruncated === true
    : textSource === "body"
      ? raw.bodyTextTruncated === true
      : false;

  const sourceLinks = Array.isArray(raw.links) ? raw.links : [];
  const links: WebPageReading["links"] = [];
  const seen = new Set<string>();
  let linksTruncated =
    raw.linksTruncated === true
    || sourceLinks.length > MAX_RAW_LINKS;

  for (
    let index = 0;
    index < Math.min(sourceLinks.length, MAX_RAW_LINKS);
    index++
  ) {
    const source = sourceLinks[index];
    if (!isRecord(source)) continue;
    const linkUrl = httpUrl(source.url, url);
    if (!linkUrl || linkUrl.length > MAX_URL_CHARS || seen.has(linkUrl)) {
      continue;
    }
    if (links.length === MAX_WEB_PAGE_LINKS) {
      linksTruncated = true;
      break;
    }
    seen.add(linkUrl);
    links.push({
      text: oneLine(source.text).slice(0, MAX_LINK_TEXT_CHARS),
      url: linkUrl,
    });
  }

  return {
    url,
    title,
    textSource,
    text: selectedText.slice(0, MAX_WEB_PAGE_TEXT_CHARS),
    links,
    truncated: {
      text:
        textTruncated
        || selectedText.length > MAX_WEB_PAGE_TEXT_CHARS,
      links: linksTruncated,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value);
}

function httpUrl(value: unknown, base?: string): string | null {
  if (typeof value !== "string" || value.length > MAX_URL_CHARS) {
    return null;
  }
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function oneLine(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : "";
}

function readableText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
