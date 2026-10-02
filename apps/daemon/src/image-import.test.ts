import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  importScopedChatImage,
  isPublicIPv4,
  validateImageDownloadUrl,
} from "./image-import.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/qbkAAAAASUVORK5CYII=",
  "base64",
);

const imageFile = {
  download_url: "https://files.example.com/temporary-image?signature=secret",
  file_id: "file_example",
  mime_type: "image/png",
  file_name: "generated.png",
};

test("imports a selected PNG into the chat's project", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-dev-image-import-"));
  try {
    const result = await importScopedChatImage(
      root,
      "assets/generated.png",
      imageFile,
      async () => ({ bytes: png, contentType: "image/png" }),
    );

    assert.equal(result.path, join(await realpath(root), "assets/generated.png"));
    assert.equal(result.bytes, png.length);
    assert.equal(result.mimeType, "image/png");
    assert.deepEqual(await readFile(result.path), png);
    assert.equal(result.sha256.length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects non-image data even when the file metadata says PNG", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-dev-image-import-"));
  try {
    await assert.rejects(
      importScopedChatImage(
        root,
        "assets/generated.png",
        imageFile,
        async () => ({ bytes: Buffer.from("<script>alert(1)</script>"), contentType: "image/png" }),
      ),
      /supported raster image/i,
    );
    await assert.rejects(readFile(join(root, "assets/generated.png")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects paths outside the project and paths through symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-dev-image-import-"));
  const outside = await mkdtemp(join(tmpdir(), "local-dev-image-outside-"));
  try {
    await mkdir(join(root, "assets"));
    await symlink(outside, join(root, "assets", "escape"));
    const download = async () => ({ bytes: png, contentType: "image/png" });

    await assert.rejects(
      importScopedChatImage(root, "../outside.png", imageFile, download),
      /escapes the Chat2Local project scope/i,
    );
    await assert.rejects(
      importScopedChatImage(root, "assets/escape/outside.png", imageFile, download),
      /escapes the Chat2Local project scope/i,
    );
    await assert.rejects(readFile(join(outside, "outside.png")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects an existing image without overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-dev-image-import-"));
  try {
    await importScopedChatImage(root, "image.png", imageFile, async () => ({ bytes: png }));
    await assert.rejects(
      importScopedChatImage(root, "image.png", imageFile, async () => ({ bytes: png })),
      /already exists/i,
    );
    assert.deepEqual(await readFile(join(root, "image.png")), png);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects oversized data and a misleading destination extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-dev-image-import-"));
  try {
    await assert.rejects(
      importScopedChatImage(root, "large.png", imageFile, async () => ({
        bytes: Buffer.alloc(20 * 1024 * 1024 + 1),
      })),
      /20 MB/i,
    );
    await assert.rejects(
      importScopedChatImage(root, "wrong.svg", imageFile, async () => ({ bytes: png })),
      /\.png extension/i,
    );
    await assert.rejects(readFile(join(root, "large.png")), /ENOENT/);
    await assert.rejects(readFile(join(root, "wrong.svg")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates a temporary file URL before any network request", () => {
  assert.equal(
    validateImageDownloadUrl("https://files.example.com/image.png").hostname,
    "files.example.com",
  );
  for (const url of [
    "http://files.example.com/image.png",
    "https://user:pass@files.example.com/image.png",
    "https://localhost/image.png",
    "https://127.0.0.1/image.png",
    "https://files.example.com:8443/image.png",
  ]) {
    assert.throws(() => validateImageDownloadUrl(url), /download URL/i);
  }
});

test("public IPv4 check excludes local, metadata, and private address ranges", () => {
  assert.equal(isPublicIPv4("8.8.8.8"), true);
  for (const address of [
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1",
    "169.254.169.254", "100.100.100.200", "192.0.2.10",
    "198.18.0.1", "203.0.113.5", "224.0.0.1", "::1",
  ]) {
    assert.equal(isPublicIPv4(address), false, address);
  }
});
