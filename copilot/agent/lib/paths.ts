// Every file the agent touches lives in the sandbox's /workspace:
//   users/<user>/...    the user's sources, synced once per session (read-only by convention)
//   output/<user>/...   everything the agents write
// Tools get an Io over the sandbox; tests pass an in-memory Io.

export type Io = {
  read(rel: string): Promise<string | null>;
  write(rel: string, content: string): Promise<void>;
  list(dir: string): Promise<string[]>;
  /** Case-insensitive regex search under dir: every matching line as {path, line (1-based), text}. */
  grep(patterns: string[], dir: string): Promise<{ path: string; line: number; text: string }[]>;
  /** Where this session's sources come from (the org's knowledge base); unset: the user folder (pullSources). */
  sources?: () => Promise<{ path: string; text: string }[]>;
};

type Sandbox = {
  readTextFile(o: { path: string }): PromiseLike<string | null>;
  writeTextFile(o: { path: string; content: string }): PromiseLike<void>;
  run(o: { command: string }): PromiseLike<{ stdout: string; stderr?: string; exitCode: number }>;
};

const USER = /^[a-z0-9-]+$/;

export function userId(user: string) {
  const id = user.trim().toLowerCase();
  if (!id) throw new Error("user was empty. Pass the USER value from the task message.");
  if (!USER.test(id)) throw new Error(`bad user: ${JSON.stringify(user)}`);
  return id;
}

/** A relative path inside /workspace. Rejects absolute paths and any ".." segment. */
export function clean(rel: string) {
  const r = rel.trim().replace(/^\/?workspace\//, "").replace(/^\/+/, "");
  if (!r || r.split(/[\\/]/).includes("..")) throw new Error(`bad path: ${rel}`);
  return r;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function sandboxIo(sb: Sandbox): Io {
  return {
    read: async (rel) => (await sb.readTextFile({ path: clean(rel) })) ?? null,
    write: async (rel, content) => { await sb.writeTextFile({ path: clean(rel), content }); },
    list: async (dir) => {
      const r = await sb.run({ command: `find ${shellQuote(clean(dir))} -type f 2>/dev/null || true` });
      return r.stdout.split("\n").map((p) => p.trim().replace(/^\.\//, "")).filter(Boolean).sort();
    },
    grep: async (patterns, dir) => {
      // Only flags both real rg and just-bash's rg accept; just-bash rejects --no-heading and -M. Piped output is path:line:text.
      const args = patterns.map((p) => `-e ${shellQuote(p)}`).join(" ");
      const r = await sb.run({ command: `rg -n -i --glob '*.md' ${args} ${shellQuote(clean(dir))}` });
      // rg exits 1 for "no match"; anything else, or any stderr, is a real failure and must not look like an empty result.
      if (r.exitCode > 1 || r.stderr?.trim()) throw new Error(`search failed: ${(r.stderr ?? "").trim() || `exit ${r.exitCode}`}`);
      return r.stdout.split("\n").flatMap((l) => {
        const m = l.match(/^(.*?\.md):(\d+):(.*)$/);
        return m ? [{ path: m[1].replace(/^\.\//, ""), line: Number(m[2]), text: m[3] }] : [];
      });
    },
  };
}

export const srcPath = (user: string, rel: string) => `users/${userId(user)}/${clean(rel)}`;
export const outPath = (user: string, rel: string) => `output/${userId(user)}/${clean(rel)}`;

export async function readJson<T>(io: Io, user: string, rel: string, fallback: T): Promise<T> {
  const text = await io.read(outPath(user, rel));
  return text == null ? fallback : (JSON.parse(text) as T);
}

export async function writeOut(io: Io, user: string, rel: string, content: string) {
  const path = outPath(user, rel);
  await io.write(path, content.endsWith("\n") ? content : content + "\n");
  return { path, bytes: Buffer.byteLength(content) };
}
