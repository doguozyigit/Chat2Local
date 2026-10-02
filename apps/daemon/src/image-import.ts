import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { isIP } from "node:net";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { IncomingMessage } from "node:http";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** The file object supplied by ChatGPT through `_meta["openai/fileParams"]`. */
export interface ChatImageFile {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface DownloadedImage {
  bytes: Buffer;
  contentType?: string;
}

export type ImageDownloader = (url: URL) => Promise<DownloadedImage>;

export interface ImportedImage {
  path: string;
  bytes: number;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  sha256: string;
}

/**
 * Import an explicitly supplied ChatGPT file into the caller's project.
 * The MCP handler must establish the caller's ConversationScope before calling.
 */
export async function importScopedChatImage(
  projectRoot: string,
  requestedPath: string,
  file: ChatImageFile,
  downloader: ImageDownloader = downloadChatImage,
): Promise<ImportedImage> {
  if (!file.file_id?.trim()) {
    throw new Error("ChatGPT did not provide a file ID for this image.");
  }
  const url = validateImageDownloadUrl(file.download_url);
  const root = await realpath(projectRoot);
  const path = await resolveImagePath(root, requestedPath);

  const downloaded = await downloader(url);
  if (downloaded.bytes.length === 0 || downloaded.bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("Image must be between 1 byte and 20 MB.");
  }

  const mimeType = detectRasterImage(downloaded.bytes);
  if (!mimeType) {
    throw new Error("The supplied file is not a supported raster image (PNG, JPEG, GIF, or WebP).");
  }
  assertMatchingContentType(downloaded.contentType, mimeType);
  assertMatchingContentType(file.mime_type, mimeType);
  assertMatchingExtension(path, mimeType);

  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  assertWithin(root, await realpath(parent));

  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW,
      0o644,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("The destination image already exists. Choose a new project path.");
    }
    throw error;
  }

  try {
    await handle.writeFile(downloaded.bytes);
  } catch (error) {
    await handle.close();
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();

  return {
    path,
    bytes: downloaded.bytes.length,
    mimeType,
    sha256: createHash("sha256").update(downloaded.bytes).digest("hex"),
  };
}

export function validateImageDownloadUrl(value: string): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
    throw new Error("Invalid ChatGPT image download URL.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid ChatGPT image download URL.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || !host.includes(".")
    || host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || (isIP(host) === 4 && !isPublicIPv4(host))
    || isIP(host) === 6
  ) {
    throw new Error("Invalid ChatGPT image download URL: use a public HTTPS endpoint.");
  }
  return url;
}

/** Conservatively accept publicly routed IPv4 addresses for the HTTPS connection. */
export function isPublicIPv4(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const [a, b, c] = value.split(".").map(Number);
  if (a === undefined || b === undefined || c === undefined) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export async function downloadChatImage(url: URL): Promise<DownloadedImage> {
  return downloadWithRedirects(validateImageDownloadUrl(url.href), 0);
}

async function downloadWithRedirects(url: URL, redirects: number): Promise<DownloadedImage> {
  const response = await new Promise<IncomingMessage>((accept, reject) => {
    const request = httpsGet(url, {
      agent: false,
      signal: AbortSignal.timeout(60_000),
      lookup: (hostname, _options, callback) => {
        void lookup(hostname, { all: true, family: 4 }).then(
          (addresses) => {
            const publicAddress = addresses.find((item) => isPublicIPv4(item.address));
            if (!publicAddress) {
              callback(new Error("Image download host has no public IPv4 address."), "");
              return;
            }
            callback(null, publicAddress.address, 4);
          },
          (error: Error) => callback(error, ""),
        );
      },
      headers: { Accept: "image/png,image/jpeg,image/gif,image/webp" },
    }, accept);
    request.setTimeout(30_000, () => request.destroy(new Error("Image download timed out.")));
    request.on("error", reject);
  });

  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400 && response.headers.location) {
    response.resume();
    if (redirects >= MAX_REDIRECTS) {
      throw new Error("Image download followed too many redirects.");
    }
    const next = validateImageDownloadUrl(new URL(response.headers.location, url).href);
    return downloadWithRedirects(next, redirects + 1);
  }
  if (status !== 200) {
    response.resume();
    throw new Error(`Image download failed with HTTP ${status}.`);
  }

  const contentLength = Number(response.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    response.destroy();
    throw new Error("Image is larger than the 20 MB import limit.");
  }

  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_IMAGE_BYTES) {
      response.destroy();
      throw new Error("Image is larger than the 20 MB import limit.");
    }
    chunks.push(bytes);
  }
  const header = response.headers["content-type"];
  return {
    bytes: Buffer.concat(chunks, total),
    ...(typeof header === "string" ? { contentType: header } : {}),
  };
}

async function resolveImagePath(root: string, requestedPath: string): Promise<string> {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) {
    throw new Error("An image destination path is required.");
  }
  const path = resolve(root, requestedPath);
  assertWithin(root, path);
  if (path === root) throw new Error("An image filename is required.");

  let existing = dirname(path);
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  assertWithin(root, await realpath(existing));
  return path;
}

function assertWithin(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error("Path escapes the Chat2Local project scope.");
  }
}

function detectRasterImage(bytes: Buffer): ImportedImage["mimeType"] | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function assertMatchingContentType(value: string | undefined, actual: ImportedImage["mimeType"]): void {
  if (!value) return;
  const declared = value.split(";", 1)[0]?.trim().toLowerCase();
  if (declared && declared !== actual && declared !== "application/octet-stream") {
    throw new Error(`Image type mismatch: received ${actual}, declared ${declared}.`);
  }
}

function assertMatchingExtension(path: string, mimeType: ImportedImage["mimeType"]): void {
  const allowed: Record<ImportedImage["mimeType"], string[]> = {
    "image/png": [".png"],
    "image/jpeg": [".jpg", ".jpeg"],
    "image/gif": [".gif"],
    "image/webp": [".webp"],
  };
  if (!allowed[mimeType].includes(extname(path).toLowerCase())) {
    throw new Error(`Choose a destination with a ${allowed[mimeType].join(" or ")} extension.`);
  }
}
