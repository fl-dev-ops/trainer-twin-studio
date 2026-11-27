import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { callSettings, formatCallBlock, formatWorkspaceBlock, NO_CALL_SETTINGS, NO_TOOLS, toolSettings, workspaceAllowed, type CallSettings, type ToolSettings } from "../../../agent/lib/agent-tools";
import { formatRoleplaySession, type RoleplaySkill } from "../../../agent/lib/roleplay";
import workspace from "../../../agent/tools/workspace";
import { executeWorkspaceTool } from "../../../agent/lib/workspace-tools";

process.env.COPILOT_SERVICE_SECRET ??= "test-secret";
const realFetch = globalThis.fetch;
let call = 0;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The studio answers getSessionContext with this agent data (or fails). */
function studioReturns(data: unknown, ok = true) {
  globalThis.fetch = (async () => new Response(JSON.stringify({ agent: { kind: "ROLEPLAY", data } }), { status: ok ? 200 : 500 })) as typeof fetch;
}
/** A fresh session each time, so the per-session cache never answers for another test. */
const ctx = () => {
  const sessionId = `s${++call}`;
  return { session: { id: sessionId, auth: { current: { principalId: "org1", attributes: { orgId: "org1", sessionId } } } }, memo: (_key: unknown, fn: () => unknown) => fn() };
};
const resolve = async (tools: Partial<ToolSettings> | undefined) => {
  studioReturns(tools === undefined ? {} : { tools });
  // eve 0.91: defineDynamic keeps its function under Symbol.for("eve.dynamic").
  const result = await (workspace as unknown as Record<symbol, (c: unknown) => Promise<unknown>>)[Symbol.for("eve.dynamic")](ctx());
  return result ? Object.keys(result as object).sort() : null;
};
const on = (patch: Partial<ToolSettings>): ToolSettings => ({ ...NO_TOOLS, ...patch });

describe("tool settings", () => {
  test("missing or partial settings are off; only true turns a surface on", () => {
    assert.deepEqual(toolSettings(undefined), NO_TOOLS);
    assert.deepEqual(toolSettings({ tools: { codeEditor: true, canvas: "yes" } }), on({ codeEditor: true }));
  });

});

describe("call settings", () => {
  test("saved Before settings override older twin settings, including explicit off; invalid blocks fall back", () => {
    const twinSettings = { preScreenshare: true, preUpload: true, duringUpload: true };
    assert.deepEqual(callSettings({ twinSettings, before: { preUpload: false } }), NO_CALL_SETTINGS);
    for (const before of [undefined, null, [], "old value"]) {
      assert.deepEqual(callSettings({ twinSettings, before }), { screenShare: true, preUpload: true, duringUpload: true });
    }
    assert.deepEqual(callSettings({ before: { preScreenshare: "true", preUpload: 1, duringUpload: "true" } }), NO_CALL_SETTINGS);
  });

  test("files attached before the call can be read without asking for another mid-call", () => {
    const beforeOnly = { ...NO_CALL_SETTINGS, preUpload: true };
    assert.match(formatCallBlock(beforeOnly, NO_TOOLS), /none attached yet.*[Nn]ever ask.*during the call/);
    assert.match(formatCallBlock(beforeOnly, NO_TOOLS, { attached: 1 }), /ATTACHED ARTIFACTS.*read_document.*[Nn]ever ask.*during the call/);
    assert.match(formatCallBlock({ ...beforeOnly, duringUpload: true }, NO_TOOLS), /may also attach one during the call/);
    assert.match(formatCallBlock(NO_CALL_SETTINGS, NO_TOOLS, { attached: 1 }), /read_document/);
  });
});

describe("workspace tools resolver: a session gets only its switched-on tools", () => {
  const shared = ["surface", "workspace_request"];
  test("canvas", async () => {
    assert.deepEqual(await resolve({ canvas: true }), [...shared, "add_canvas_component", "clear_canvas", "highlight_canvas_element", "highlight_whiteboard", "read_canvas_scene"].sort());
  });
  test("code editor", async () => {
    assert.deepEqual(await resolve({ codeEditor: true }), [...shared, "get_code_state", "highlight_code", "read_code_range", "run_code"].sort());
  });
  test("multiple choice", async () => {
    assert.deepEqual(await resolve({ choice: true }), [...shared, "get_choice_state", "highlight_choice"].sort());
  });
  test("preview enables PDF/image/presentation surfaces and slide navigation", async () => {
    assert.deepEqual(await resolve({ preview: true }), [...shared, "get_presentation_state", "set_presentation_slide", "next_presentation_slide", "previous_presentation_slide"].sort());
    const withoutPreview = await resolve({ canvas: true, codeEditor: true, choice: true });
    assert.equal(withoutPreview?.some((name) => name.includes("presentation")), false);
  });
  test("nothing on, no settings, or a failed lookup: no workspace tools", async () => {
    assert.equal(await resolve({ canvas: false }), null);
    assert.equal(await resolve(undefined), null);
    studioReturns({ tools: { codeEditor: true } }, false);
    const failed = await (workspace as unknown as Record<symbol, (c: unknown) => Promise<unknown>>)[Symbol.for("eve.dynamic")](ctx());
    assert.equal(failed, null);
  });
});

describe("backstop: a call is allowed only when its switch is on", () => {
  test("tools follow their switch", () => {
    assert.equal(workspaceAllowed(on({ canvas: true }), "read_canvas_scene", {}), true);
    assert.equal(workspaceAllowed(on({ canvas: true }), "run_code", {}), false);
    assert.equal(workspaceAllowed(on({ choice: true }), "get_choice_state", {}), true);
  });
  test("surface actions follow their switch; close_surface whenever anything is on; unknown actions refused", () => {
    const pdf = on({ preview: true });
    assert.equal(workspaceAllowed(pdf, "surface", { action: "open_pdf" }), true);
    assert.equal(workspaceAllowed(pdf, "surface", { action: "highlight_document" }), true);
    assert.equal(workspaceAllowed(pdf, "surface", { action: "open_whiteboard" }), false);
    assert.equal(workspaceAllowed(pdf, "surface", { action: "open_image" }), true);
    assert.equal(workspaceAllowed(pdf, "surface", { action: "open_presentation" }), true);
    assert.equal(workspaceAllowed(pdf, "surface", { action: "close_surface" }), true);
    assert.equal(workspaceAllowed(NO_TOOLS, "surface", { action: "close_surface" }), false);
    assert.equal(workspaceAllowed(pdf, "surface", { action: "something_new" }), false);
  });
  test("workspace_request follows its method's switch; unknown methods are refused", () => {
    const code = on({ codeEditor: true });
    assert.equal(workspaceAllowed(code, "workspace_request", { method: "workspace.code" }), true);
    assert.equal(workspaceAllowed(code, "workspace_request", { method: "workspace.canvas" }), false);
    assert.equal(workspaceAllowed(on({ canvas: true }), "workspace_request", { method: "workspace.whiteboard" }), true);
    assert.equal(workspaceAllowed(code, "workspace_request", { method: "workspace.presentation" }), false);
    assert.equal(workspaceAllowed(on({ preview: true }), "workspace_request", { method: "workspace.presentation" }), true);
    assert.equal(workspaceAllowed(code, "workspace_request", { method: "anything" }), false);
  });
  test("unknown tools are refused", () => {
    assert.equal(workspaceAllowed(on({ canvas: true, codeEditor: true, preview: true, choice: true }), "invented_tool", {}), false);
    assert.equal(workspaceAllowed(on({ preview: true }), "next_presentation_slide", {}), true);
    assert.equal(workspaceAllowed(NO_TOOLS, "next_presentation_slide", {}), false);
  });
});

describe("prompt: the workspace for this call", () => {
  const roleplay: RoleplaySkill = { skill: "---\nname: test\n---\n# Test", difficulty: "medium" };
  const specs = { agentName: "Test", agentSlug: "test", personaName: "Adam" };
  const prompt = (tools?: ToolSettings, call?: CallSettings) => formatRoleplaySession(specs, roleplay, { learnerBlock: "" }, tools, call);

  test("nothing on: only end_call and scenario_examples, and no workspace", () => {
    assert.equal(prompt(NO_TOOLS), prompt());
    assert.match(prompt(), /no trainer persona and no workspace\./);
    assert.match(prompt(), /Call no tool except end_call \(to hang up, as above\), scenario_examples\. Every other tool is disabled in this mode\./);
    assert.equal(formatWorkspaceBlock(NO_TOOLS, { client: true }), "");
  });

  test("some on: the prompt lists only those, in character, and allows read_document once uploads are on", () => {
    const text = prompt(on({ preview: true }), { screenShare: false, preUpload: true, duringUpload: false });
    assert.doesNotMatch(text, /and no workspace/);
    assert.match(text, /# Workspace for this call/);
    assert.match(text, /open_pdf/);
    assert.match(text, /read_document/);
    assert.match(text, /Before quoting or referring to a specific line in a PDF, call surface\(\{ action: "highlight_document"/);
    assert.match(text, /Do this on the opening turn too/);
    assert.match(text, /Stay in character/);
    assert.doesNotMatch(text, /open_whiteboard|open_code_editor|open_choice/);
  });

  test("the twin wording does not ask to stay in character", () => {
    const block = formatWorkspaceBlock(on({ canvas: true }), { client: false });
    assert.match(block, /open_whiteboard/);
    assert.doesNotMatch(block, /in character/);
  });
});
