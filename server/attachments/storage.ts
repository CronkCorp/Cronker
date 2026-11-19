import { createReadStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

/**
 * Where Attachments' bytes are kept, by Attachment id. What describes them (name, media type, size, what they're
 * attached to) is in Postgres; this holds only the bytes, so object storage could take the directory's place.
 */
export interface AttachmentStorage {
  /** Keeps the bytes under the id, replacing any already there. */
  put(id: string, bytes: Buffer): Promise<void>;
  /** The bytes kept under the id. */
  get(id: string): Readable;
  /** Forgets the bytes kept under the id, if any. */
  delete(id: string): Promise<void>;
}

/** Keeps each Attachment as a file named by its id in the directory, created when first needed. */
export function directoryStorage(directory: string): AttachmentStorage {
  // Ids are UUIDs Cronk made, never a path a caller chose.
  const path = (id: string) => join(directory, id);
  return {
    async put(id, bytes) {
      await mkdir(directory, { recursive: true });
      // Written aside, then renamed into place, so a half-written file is never served.
      const partial = `${path(id)}.partial`;
      await writeFile(partial, bytes);
      await rename(partial, path(id));
    },
    get: (id) => createReadStream(path(id)),
    async delete(id) {
      await rm(path(id), { force: true });
    },
  };
}
