// Which organization a copilot conversation belongs to. eve has no per-session access control (the web proxy enforces
// ownership, web/app/api/eve/v1), so the copilot also refuses, as a second line, a turn from another org than the one
// that started the conversation: its tools would otherwise act for one org with another org's conversation.

type Principal = { principalId: string; principalType: string; attributes?: Record<string, unknown> } | null | undefined;
export type TenantCtx = { session: { auth: { current: Principal; initiator?: Principal } } };

export class WrongOrganization extends Error {}

/**
 * The org that started this conversation, with the current turn's caller attributes (the signed-in trainer). Throws
 * when the current turn comes from a different org. Non-studio sessions (eve dev, TUI) pass through unchanged.
 */
export function sessionPrincipal(ctx: TenantCtx): Principal {
  const { current, initiator } = ctx.session.auth;
  const owner = initiator ?? current;
  if (current?.principalType !== "organization" || owner?.principalType !== "organization") return current;
  if (current.principalId !== owner.principalId) {
    throw new WrongOrganization("This conversation belongs to another organization. Start a new conversation in this one.");
  }
  return { ...owner, attributes: current.attributes };
}
