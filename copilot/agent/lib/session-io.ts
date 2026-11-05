// The sandbox Io for a tool call, with this session's sources attached.
import { type KnowledgeBaseSource, knowledgeBaseVersion, pullKnowledgeBase } from "./origin";
import { type Io, sandboxIo } from "./paths";
import { sessionPrincipal, type TenantCtx } from "./tenant";

type Principal = { principalId: string; principalType: string; attributes?: Record<string, unknown> } | null | undefined;
export type SessionCtx = TenantCtx & { getSandbox(): Promise<Parameters<typeof sandboxIo>[0]> };

/**
 * A studio session (organization principal, set by the web proxy) works only from that org's knowledge base. Without
 * STUDIO_URL / SCENARIO_INGEST_SECRET it fails loudly instead of falling back to the local users folder, which may hold
 * another trainer's material. Other sessions (eve dev, the TUI) keep the users folder.
 */
export function knowledgeBaseFor(principal: Principal, env = process.env): KnowledgeBaseSource | "unconfigured" | null {
  if (principal?.principalType !== "organization") return null;
  const url = env.STUDIO_URL;
  const secret = env.SCENARIO_INGEST_SECRET;
  return url && secret ? { url, secret, orgId: principal.principalId } : "unconfigured";
}

// The knowledge fingerprint is checked at most this often per org (tools run many times per turn).
const VERSION_TTL_MS = 20_000;
const versions = new Map<string, { at: number; value: Promise<string> }>();

function cachedVersion(kb: KnowledgeBaseSource) {
  const hit = versions.get(kb.orgId);
  if (hit && Date.now() - hit.at < VERSION_TTL_MS) return hit.value;
  const value = knowledgeBaseVersion(kb).catch((error) => {
    versions.delete(kb.orgId);
    throw error;
  });
  versions.set(kb.orgId, { at: Date.now(), value });
  return value;
}

export async function sessionIo(ctx: SessionCtx): Promise<Io> {
  const io = sandboxIo(await ctx.getSandbox());
  const kb = knowledgeBaseFor(sessionPrincipal(ctx));
  if (kb === null) return io;
  const configured = () => {
    if (kb === "unconfigured") throw new Error("STUDIO_URL or SCENARIO_INGEST_SECRET is not configured, so the organization's knowledge base cannot be read.");
    return kb;
  };
  return {
    ...io,
    sources: () => pullKnowledgeBase(configured()),
    sourcesVersion: () => cachedVersion(configured()),
  };
}

/** Where a studio session's published outputs go: under its organization (see pushOutput). */
export function outputScope(ctx: TenantCtx): string | undefined {
  const principal = sessionPrincipal(ctx);
  return principal?.principalType === "organization" ? principal.principalId : undefined;
}
