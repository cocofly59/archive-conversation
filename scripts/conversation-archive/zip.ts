import { inflateRawSync } from "node:zlib";
import type { SourceFile } from "./types.ts";
import { SourceError } from "./types.ts";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Reads every file of a zip archive (stored or deflated entries, no ZIP64, no encryption). */
export function readZip(data: Uint8Array): SourceFile[] {
  const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = view.length - 22; i >= Math.max(0, view.length - 22 - 0xffff); i -= 1) {
    if (view.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SourceError("not a zip archive (no end of central directory)");
  const count = view.readUInt16LE(eocd + 10);
  let offset = view.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new SourceError("ZIP64 archives are not supported; unzip it and pass the folder");
  const files: SourceFile[] = [];
  for (let n = 0; n < count; n += 1) {
    if (view.readUInt32LE(offset) !== CENTRAL) throw new SourceError("corrupt zip central directory");
    const flags = view.readUInt16LE(offset + 8);
    const method = view.readUInt16LE(offset + 10);
    const compressed = view.readUInt32LE(offset + 20);
    const nameLength = view.readUInt16LE(offset + 28);
    const extraLength = view.readUInt16LE(offset + 30);
    const commentLength = view.readUInt16LE(offset + 32);
    const local = view.readUInt32LE(offset + 42);
    const name = view.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if ((flags & 1) !== 0) throw new SourceError(`${name}: encrypted zip entries are not supported`);
    if (view.readUInt32LE(local) !== LOCAL) throw new SourceError(`${name}: corrupt zip local header`);
    const start = local + 30 + view.readUInt16LE(local + 26) + view.readUInt16LE(local + 28);
    const body = view.subarray(start, start + compressed);
    if (method === 0) files.push({ name, data: new Uint8Array(body) });
    else if (method === 8) files.push({ name, data: new Uint8Array(inflateRawSync(body)) });
    else throw new SourceError(`${name}: unsupported zip compression method ${method}`);
  }
  return files;
}
