import * as path from "path";

export const CHARACTER_LIMIT = 100000;
export const DEFAULT_TIMEOUT = 10000;
export const SEARCH_MAX_COLUMNS = 200;
export const SEARCH_MAX_MATCHES = 200;
export const SEARCH_EXEC_MAX_BUFFER = 50 * 1024 * 1024; // 50MB

// --- Image reading support ---

/** Maximum image file size (10MB). Base64 encoding adds ~33% overhead. */
export const IMAGE_SIZE_LIMIT = 10 * 1024 * 1024;

/** Number of leading bytes to read for magic-byte sniffing and binary detection. */
export const FILE_SNIFF_SIZE = 4096;

/** MIME types that are returned as image content blocks (not including SVG). */
export const SUPPORTED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Fallback: extension → MIME type mapping (used when sniffing fails, e.g. for SVG). */
export const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".ico": "image/x-icon",
};

/**
 * Sniff the MIME type of a file from its leading bytes (magic bytes).
 * Returns null if the bytes don't match any known image signature.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  // WebP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

// --- Binary file detection ---

/**
 * Determine whether a file is binary (should not be read as text).
 * Uses content-based detection only (no extension reliance):
 * 1. Contains a null byte (0x00) → true
 * 2. Ratio of non-printable bytes > 30% → true
 *
 * @param filepath - File path (reserved for future use, not currently used)
 * @param bytes    - Leading bytes of the file (recommend 4096 bytes)
 */
export function isBinaryFile(filepath: string, bytes: Uint8Array): boolean {
  if (bytes.length === 0) {
    return false;
  }

  // 1. Null byte detection - text files almost never contain 0x00
  let nonPrintableCount = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x00) {
      return true;
    }
    // Count non-printable bytes (excluding common whitespace: \t=9, \n=10, \r=13)
    if (b < 9 || (b > 13 && b < 32)) {
      nonPrintableCount++;
    }
  }

  // 2. Non-printable ratio threshold
  return nonPrintableCount / bytes.length > 0.3;
}
