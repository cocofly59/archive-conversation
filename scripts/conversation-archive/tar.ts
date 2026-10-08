import { gzipSync } from "node:zlib";

export interface TarEntry {
  readonly path: string;
  readonly content: string | Uint8Array;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** Splits a path into the ustar `prefix` and `name` fields (155 and 100 bytes). */
function splitName(path: string): { prefix: string; name: string } {
  if (Buffer.byteLength(path) <= 100) return { prefix: "", name: path };
  for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { prefix, name };
  }
  throw new Error(`path too long for a tar archive: ${path}`);
}

function header(path: string, size: number, mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  const { prefix, name } = splitName(path);
  block.write(name, 0, 100, "utf8");
  block.write(octal(0o644, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(mtime, 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write("0", 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  block.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

/** Builds a gzip-compressed ustar archive of regular files. */
export function tarGzip(entries: readonly TarEntry[], mtime: Date): Buffer {
  const seconds = Math.floor(mtime.getTime() / 1000);
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : Buffer.from(entry.content);
    chunks.push(header(entry.path, body.length, seconds), body);
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks));
}
