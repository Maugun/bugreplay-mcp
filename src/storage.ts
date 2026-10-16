import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CaptureEvent, CaptureManifest, NewCaptureEvent, StoredCase } from "./types.js";

const CASE_ID_PATTERN = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;

export interface EventLog {
  append(event: CaptureEvent): void;
  close(): Promise<void>;
}

export async function resolveProjectRoot(rootHint = process.env.BUGREPLAY_ROOT ?? process.cwd()): Promise<string> {
  const requested = path.resolve(rootHint);
  const root = await realpath(requested);
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error(`BUGREPLAY_ROOT is not a directory: ${root}`);
  return root;
}

export async function ensureCasesDirectory(root: string): Promise<string> {
  const bugreplayDir = await ensureDirectory(root, ".bugreplay");
  return ensureDirectory(bugreplayDir, "cases");
}

export async function createCaseDirectory(root: string): Promise<{ id: string; directory: string }> {
  const casesDir = await ensureCasesDirectory(root);
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const id = `${timestamp}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(casesDir, id);
  await mkdir(directory, { recursive: false });
  const resolved = await realpath(directory);
  if (!isWithin(casesDir, resolved)) throw new Error("Case directory resolved outside the configured project.");
  return { id, directory: resolved };
}

export function openEventLog(directory: string): EventLog {
  const stream = createWriteStream(path.join(directory, "events.jsonl"), { flags: "wx", encoding: "utf8" });
  let streamError: Error | undefined;
  stream.on("error", (error) => {
    streamError = error;
  });

  return {
    append(event) {
      if (streamError) return;
      stream.write(`${JSON.stringify(event)}\n`);
    },
    async close() {
      if (streamError) throw streamError;
      await new Promise<void>((resolve, reject) => {
        stream.once("error", reject);
        stream.end(() => {
          stream.removeListener("error", reject);
          resolve();
        });
      });
      if (streamError) throw streamError;
    },
  };
}

export async function writeManifest(directory: string, manifest: CaptureManifest): Promise<void> {
  const target = path.join(directory, "case.json");
  const temporary = path.join(directory, `.case-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, target);
}

export async function readStoredCase(root: string, id: string): Promise<StoredCase> {
  assertCaseId(id);
  const casesDir = await ensureCasesDirectory(root);
  const directory = await realpath(path.join(casesDir, id)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`No bug capture found with id ${id}.`);
    throw error;
  });
  if (!isWithin(casesDir, directory)) throw new Error("Case directory resolved outside the configured project.");
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("Case path must be a regular local directory.");

  const manifestPath = await resolveRegularFile(directory, "case.json");
  if (!manifestPath) throw new Error("Capture manifest is missing.");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CaptureManifest;
  if (manifest.id !== id || manifest.schemaVersion !== 1) throw new Error("Capture manifest is invalid or uses an unsupported version.");
  const eventsPath = await resolveRegularFile(directory, "events.jsonl", true);
  const events = eventsPath ? await readEvents(eventsPath) : [];
  return { manifest, events, directory };
}

export async function listStoredCases(root: string): Promise<Array<Pick<CaptureManifest, "id" | "status" | "startedAt" | "stoppedAt" | "startUrl" | "eventCount">>> {
  const casesDir = await ensureCasesDirectory(root);
  const entries = await readdir(casesDir, { withFileTypes: true });
  const manifests: Array<Pick<CaptureManifest, "id" | "status" | "startedAt" | "stoppedAt" | "startUrl" | "eventCount">> = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !CASE_ID_PATTERN.test(entry.name)) continue;
    try {
      const stored = await readStoredCase(root, entry.name);
      manifests.push({
        id: stored.manifest.id,
        status: stored.manifest.status,
        startedAt: stored.manifest.startedAt,
        stoppedAt: stored.manifest.stoppedAt,
        startUrl: stored.manifest.startUrl,
        eventCount: stored.events.length,
      });
    } catch {
      // Ignore incomplete or manually altered directories in the index.
    }
  }

  return manifests.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function validateNewEvent(event: NewCaptureEvent, at: string, elapsedMs: number): CaptureEvent {
  return { ...event, at, elapsedMs } as CaptureEvent;
}

function assertCaseId(id: string): void {
  if (!CASE_ID_PATTERN.test(id)) throw new Error("Invalid case id.");
}

async function readEvents(file: string): Promise<CaptureEvent[]> {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Capture event log must be a regular local file.");

  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const events: CaptureEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      events.push(JSON.parse(lines[index]) as CaptureEvent);
    } catch {
      if (index !== lines.length - 1) throw new Error("Capture event log contains malformed JSON.");
    }
  }
  return events;
}

async function resolveRegularFile(directory: string, name: string, optional = false): Promise<string | undefined> {
  const file = path.join(directory, name);
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} must be a regular local file.`);
  const resolved = await realpath(file);
  if (!isWithin(directory, resolved)) throw new Error(`${name} resolved outside the capture directory.`);
  return resolved;
}

async function ensureDirectory(parent: string, name: string): Promise<string> {
  const directory = path.join(parent, name);
  try {
    await mkdir(directory, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${directory} must be a real directory, not a symlink.`);
  const resolved = await realpath(directory);
  if (!isWithin(parent, resolved)) throw new Error("Capture storage resolved outside the configured project.");
  return resolved;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
