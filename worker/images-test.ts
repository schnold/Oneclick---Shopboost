// Shares the worker's env preflight: some of these modules reach
// shopify.server, which validates its configuration at module scope.
import "./bootstrap";
import sharp from "sharp";
import {
  compressImage,
  outputFilename,
} from "../app/lib/images/compress.server";
import { DEFAULT_SETTINGS } from "../app/lib/settings.server";
import { formatBytes } from "../app/lib/format";
import { MAX_EDGE_PX } from "../app/lib/graphql/images";

/**
 * Exercises the compression pipeline on generated images — no Shopify store
 * and no network needed.
 *
 * The cases here are the ones that cause real damage if mishandled: an
 * already-optimized file that must be left alone, an oversized image that must
 * be clamped to Shopify's ceiling, an animated GIF that must not be flattened,
 * and a photo that must come out genuinely smaller and still decodable.
 *
 *   npx tsx worker/images-test.ts
 */

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
}

/** A noisy gradient — compresses like a photo rather than like flat colour. */
async function photo(width: number, height: number, format: "png" | "jpeg" = "png") {
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      buf[i] = (x * 255) / width;
      buf[i + 1] = (y * 255) / height;
      buf[i + 2] = ((x ^ y) % 256);
    }
  }
  const img = sharp(buf, { raw: { width, height, channels } });
  return format === "png"
    ? img.png().toBuffer()
    : img.jpeg({ quality: 95 }).toBuffer();
}

const settings = DEFAULT_SETTINGS.images;

console.log("── A large PNG photo ──");
{
  const input = await photo(3000, 2000, "png");
  const result = await compressImage(input, settings);

  check("compressed", result.ok, result.ok ? "" : result.reason);
  if (result.ok) {
    console.log(
      `  ${formatBytes(input.byteLength)} → ${formatBytes(result.bytes)} ` +
        `(−${result.savedPercent.toFixed(0)}%), ${result.width}×${result.height}`,
    );
    check("is smaller", result.bytes < input.byteLength);
    check("converted to WebP", result.mimeType === "image/webp");
    check(
      "resized to the 2048px setting",
      Math.max(result.width, result.height) === settings.maxDimension,
      `${result.width}×${result.height}`,
    );
    check("savedBytes matches the buffers", result.savedBytes === input.byteLength - result.bytes);

    // The output has to be a real image, not just smaller bytes.
    const meta = await sharp(result.buffer).metadata();
    check("output decodes as webp", meta.format === "webp");
    check("output dimensions match the report", meta.width === result.width && meta.height === result.height);
  }
}

console.log("\n── An already-optimized image is left alone ──");
{
  // Compress once, then feed the result back in: the second pass should not
  // clear the savings threshold.
  const original = await photo(1200, 1200, "png");
  const first = await compressImage(original, settings);
  if (!first.ok) throw new Error("fixture setup failed: " + first.reason);

  const second = await compressImage(first.buffer, settings);
  check(
    "second pass declines",
    !second.ok,
    second.ok ? `unexpectedly saved ${second.savedPercent.toFixed(1)}%` : second.reason,
  );
}

console.log("\n── Shopify's 4472px ceiling is enforced even when resizing is off ──");
{
  const input = await photo(5000, 3000, "jpeg");
  const result = await compressImage(input, { ...settings, maxDimension: 0 });

  check("compressed", result.ok, result.ok ? "" : result.reason);
  if (result.ok) {
    check(
      "clamped to Shopify's maximum",
      Math.max(result.width, result.height) <= MAX_EDGE_PX,
      `${result.width}×${result.height}`,
    );
  }
}

console.log("\n── An animated GIF is not flattened ──");
{
  // A real 85-byte two-frame GIF89a with a NETSCAPE loop block. sharp cannot
  // synthesize an animated GIF from raw frames in this build, so the fixture is
  // literal bytes rather than something generated.
  const gif = Buffer.from(
    "R0lGODlhAQABAIAAAP///wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAAC" +
      "AkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==",
    "base64",
  );

  const pages = (await sharp(gif, { animated: true }).metadata()).pages ?? 1;
  check("fixture really is animated", pages === 2, `${pages} frames`);

  const result = await compressImage(gif, settings);
  check(
    "left unchanged",
    !result.ok && result.reason.includes("Animated"),
    result.ok ? "WAS MODIFIED — animation would be lost" : result.reason,
  );
}

console.log("\n── Quality and format settings are honoured ──");
{
  const input = await photo(1600, 1600, "jpeg");

  const low = await compressImage(input, { ...settings, quality: 60 });
  const high = await compressImage(input, { ...settings, quality: 95 });
  if (low.ok && high.ok) {
    check("lower quality yields a smaller file", low.bytes < high.bytes,
      `${formatBytes(low.bytes)} vs ${formatBytes(high.bytes)}`);
  }

  const keep = await compressImage(input, { ...settings, format: "keep" });
  check(
    "keep-format stays JPEG",
    keep.ok && keep.mimeType === "image/jpeg",
    keep.ok ? keep.mimeType : keep.reason,
  );
}

console.log("\n── Filenames ──");
{
  check(
    "extension swapped, stem preserved",
    outputFilename("https://cdn.shopify.com/s/files/1/hero-shot.png?v=123", "webp") ===
      "hero-shot.webp",
    outputFilename("https://cdn.shopify.com/s/files/1/hero-shot.png?v=123", "webp"),
  );
  check(
    "unsafe characters removed",
    /^[a-zA-Z0-9._-]+$/.test(outputFilename("https://x/a b&c.png", "webp")),
    outputFilename("https://x/a b&c.png", "webp"),
  );
}

console.log(
  failures === 0 ? "\n✓ image pipeline verified" : `\n✗ ${failures} check(s) failed`,
);
process.exitCode = failures === 0 ? 0 : 1;
