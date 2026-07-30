import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

/**
 * A byte-level checkpoint of a transcript file at a point in time. Captures the
 * whole file's size and a hash of its raw bytes so a later re-read can cheaply
 * decide whether the already-seen prefix is byte-identical (safe to tail-append)
 * or was rewritten in place (must be fully re-parsed).
 */
export interface TranscriptCheckpoint {
  /** Byte length of the file when the checkpoint was captured. */
  sizeBytes: number;
  /** SHA-1 (hex) of the first `sizeBytes` raw bytes of the file. */
  prefixHash: string;
}

/**
 * Capture a checkpoint over the whole current file: its byte length and the
 * SHA-1 of its exact raw bytes. Throws if the file cannot be read (e.g. missing).
 */
export function captureCheckpoint(filePath: string): TranscriptCheckpoint {
  const bytes = readFileSync(filePath);
  return {
    sizeBytes: bytes.length,
    prefixHash: createHash('sha1').update(bytes).digest('hex'),
  };
}

/**
 * Return `true` iff `filePath` is at least `sizeBytes` long and its first
 * `sizeBytes` raw bytes hash to `prefixHash`. Appended files (prefix unchanged)
 * validate true; an in-place rewrite of the prefix, or a shrunk/truncated file,
 * validates false. Missing/unreadable files also return false.
 */
export function validatePrefix(filePath: string, sizeBytes: number, prefixHash: string): boolean {
  let fd: number | undefined;
  try {
    const currentSize = statSync(filePath).size;
    if (currentSize < sizeBytes) {
      return false;
    }
    const buffer = Buffer.allocUnsafe(sizeBytes);
    fd = openSync(filePath, 'r');
    let offset = 0;
    while (offset < sizeBytes) {
      const read = readSync(fd, buffer, offset, sizeBytes - offset, offset);
      if (read === 0) {
        // File is shorter than statSync reported (raced shrink); cannot validate.
        return false;
      }
      offset += read;
    }
    return createHash('sha1').update(buffer).digest('hex') === prefixHash;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}
