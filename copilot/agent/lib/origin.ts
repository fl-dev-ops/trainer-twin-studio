// Where sources come from and where results go, outside the sandbox.
// Prod (INGEST_S3_BUCKET set): S3, under <INGEST_S3_PREFIX>/users/<user>/ and <INGEST_S3_PREFIX>/output/<user>/.
// Local: the users/ folder and ./output, so results stay browsable.
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { userId } from "./paths";

const BUCKET = process.env.INGEST_S3_BUCKET;
const PREFIX = (process.env.INGEST_S3_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
const LOCAL_USERS = process.env.INGEST_USERS ?? "/Users/suryaumapathy/Developers/Github/foreverlearning/olga/users";
const LOCAL_OUTPUT = process.env.INGEST_OUTPUT ?? "/Users/suryaumapathy/Developers/Github/foreverlearning/scenario-ingest/output";
const key = (...parts: string[]) => [PREFIX, ...parts].filter(Boolean).join("/");
const s3 = () => new S3Client({});

/** Every markdown source for a user, as relative path + text. */
export async function pullSources(user: string): Promise<{ path: string; text: string }[]> {
  const id = userId(user);
  if (BUCKET) {
    const client = s3();
    const base = key("users", id) + "/";
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: base, ContinuationToken: token }));
      keys.push(...(page.Contents ?? []).map((o) => o.Key!).filter((k) => k.endsWith(".md")));
      token = page.NextContinuationToken;
    } while (token);
    return pool(keys, 16, async (k) => {
      const obj = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: k }));
      return { path: k.slice(base.length), text: await obj.Body!.transformToString("utf-8") };
    });
  }
  const root = path.join(LOCAL_USERS, id);
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)))
    .filter((rel) => !rel.split(path.sep).some((part) => part.startsWith(".")));
  return pool(files, 32, async (rel) => ({ path: rel.split(path.sep).join("/"), text: await readFile(path.join(root, rel), "utf8") }));
}

/** Copies one finished output file out of the sandbox. */
export async function pushOutput(user: string, rel: string, content: string) {
  const id = userId(user);
  if (BUCKET) {
    const k = key("output", id, rel);
    await s3().send(new PutObjectCommand({ Bucket: BUCKET, Key: k, Body: content, ContentType: rel.endsWith(".json") ? "application/json" : "text/markdown" }));
    return `s3://${BUCKET}/${k}`;
  }
  const file = path.join(LOCAL_OUTPUT, id, rel);
  await mkdir(path.dirname(file), { recursive: true });
  // On a case-insensitive disk (macOS), writing SKILL.md over an old skill.md keeps the old name. Drop the variant first.
  const base = path.basename(file);
  for (const e of await readdir(path.dirname(file))) if (e !== base && e.toLowerCase() === base.toLowerCase()) await rm(path.join(path.dirname(file), e));
  await writeFile(file, content);
  return file;
}

/** Local only: files under the user's output folder that this publication did not write, such as a scenario from an older run. */
export async function staleOutputs(user: string, published: string[]) {
  if (BUCKET) return [];
  const root = path.join(LOCAL_OUTPUT, userId(user));
  const keep = new Set(published.map((p) => path.resolve(p)));
  const all = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return all.filter((e) => e.isFile() && !e.name.startsWith("._") && !keep.has(path.resolve(e.parentPath, e.name)))
    .map((e) => path.relative(root, path.join(e.parentPath, e.name))).sort();
}

export async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
