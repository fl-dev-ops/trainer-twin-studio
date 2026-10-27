// The sandbox Io for a tool call, with this session's sources attached.
import { type KnowledgeBaseSource, pullKnowledgeBase } from "./origin";
import { type Io, sandboxIo } from "./paths";

type Principal = { principalId: string; principalType: string } | null;
export type SessionCtx = {
  getSandbox(): Promise<Parameters<typeof sandboxIo>[0]>;
  session: { auth: { current: Principal } };
};

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

export async function sessionIo(ctx: SessionCtx): Promise<Io> {
  const io = sandboxIo(await ctx.getSandbox());
  const kb = knowledgeBaseFor(ctx.session.auth.current);
  if (kb === null) return io;
  return {
    ...io,
    sources: () => {
      if (kb === "unconfigured") throw new Error("STUDIO_URL or SCENARIO_INGEST_SECRET is not configured, so the organization's knowledge base cannot be read.");
      return pullKnowledgeBase(kb);
    },
  };
}
