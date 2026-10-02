/** Defense in depth for short recovery prose. Raw tool payloads must never be supplied. */
export function redactWorkText(text: string): string {
  return text
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, "[redacted]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi, (matched) => {
      const punctuation = matched.match(/[).,;!\]}]+$/)?.[0] ?? "";
      const address = punctuation ? matched.slice(0, -punctuation.length) : matched;
      try {
        const url = new URL(address);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString() + punctuation;
      } catch { return "[redacted URL]" + punctuation; }
    })
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(["'])([a-z0-9_]*(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|authorization)[a-z0-9_]*)\1(\s*:\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,}\]]+)/gi,
      (_matched, quote: string, key: string, separator: string) => `${quote}${key}${quote}${separator}"[redacted]"`)
    .replace(/\b([a-z0-9_]*(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|authorization)[a-z0-9_]*)\b(\s*[=:]\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;]+)/gi, "$1$2[redacted]");
}
