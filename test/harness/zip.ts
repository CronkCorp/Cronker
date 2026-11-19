import { inflateRawSync } from "node:zlib";

/**
 * The files in a zip archive, by path, read from its central directory as any unzip tool would: stored or deflated
 * entries, each checked against the sizes it records.
 */
export function unzip(archive: Buffer): Map<string, string> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("No end of central directory record: not a zip archive.");
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw new Error(`Central directory entry ${i} is malformed.`);
    const method = archive.readUInt16LE(at + 10);
    const compressedSize = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const localAt = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    if (archive.readUInt32LE(localAt) !== 0x04034b50) throw new Error(`${name}: local header is malformed.`);
    const dataAt = localAt + 30 + archive.readUInt16LE(localAt + 26) + archive.readUInt16LE(localAt + 28);
    const raw = archive.subarray(dataAt, dataAt + compressedSize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`${name}: unknown compression method ${method}.`);
    if (data.length !== size) throw new Error(`${name}: ${data.length} bytes, but records ${size}.`);
    files.set(name, data.toString("utf8"));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
