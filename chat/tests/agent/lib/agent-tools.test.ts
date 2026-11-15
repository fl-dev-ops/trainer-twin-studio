import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { formatWorkspaceBlock, NO_TOOLS, TOOL_SWITCHED_OFF, toolSettings, workspaceAllowed, type ToolSettings } from "../../../agent/lib/agent-tools";
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
  test("legacy interviews without saved switches retain their original workspace, not new clients or twins", () => {
    const all = on({ canvas: true, codeEditor: true, preview: true, choice: true });
    for (const type of ["technical", "resume"]) {
      const legacy = { config: { interview: { type }, tools: [] } };
      assert.deepEqual(toolSettings(legacy, "ROLEPLAY"), all);
      for (const tools of [{}, NO_TOOLS, null]) assert.deepEqual(toolSettings({ ...legacy, tools }, "ROLEPLAY"), NO_TOOLS);
      assert.deepEqual(toolSettings({ ...legacy, tools: { preview: true } }, "ROLEPLAY"), on({ preview: true }));
      assert.deepEqual(toolSettings(legacy, "TWIN"), NO_TOOLS);
      assert.deepEqual(toolSettings(legacy), NO_TOOLS);
      assert.deepEqual(toolSettings({ ...legacy, skill: "# Client" }, "ROLEPLAY"), NO_TOOLS);
    }
    assert.deepEqual(toolSettings({}, "ROLEPLAY"), NO_TOOLS);
    assert.deepEqual(toolSettings({ config: { interview: { type: "unknown" } } }, "ROLEPLAY"), NO_TOOLS);
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
  test("a real legacy context offers all supported surfaces and inspection tools", async () => {
    studioReturns({ config: { interview: { type: "technical", question_counts: { coding: 1, "system-design": 1, mcq: 1 } } } });
    const resolved = await (workspace as unknown as Record<symbol, (c: unknown) => Promise<unknown>>)[Symbol.for("eve.dynamic")](ctx());
    const names = Object.keys(resolved as object);
    for (const name of ["surface", "workspace_request", "get_code_state", "read_code_range", "read_canvas_scene", "get_choice_state"]) {
      assert.ok(names.includes(name), name);
    }
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
    assert.equal(workspaceAllowed(on({ preview: true }), "start_resume_question", {}), true);
    assert.equal(workspaceAllowed(on({ codeEditor: true }), "start_resume_question", {}), false);
    assert.equal(workspaceAllowed(NO_TOOLS, "start_resume_question", {}), false);
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

describe("legacy workspace calls reach Studio instead of being silently disabled", () => {
  test("surface opens and claim-backed resume questions use the same command transport", async () => {
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      if (payload.action === "getSessionContext") return new Response(JSON.stringify({ agent: { kind: "ROLEPLAY", data: { config: { interview: { type: "resume" } } } } }));
      sent.push(payload);
      return new Response(JSON.stringify({ status: "completed", result: { ok: true } }));
    }) as typeof fetch;
    const context = ctx();
    for (const action of ["open_code_editor", "open_whiteboard", "open_choice", "open_pdf"]) {
      const result = await executeWorkspaceTool({ action, payload: {} }, { ...context, toolName: "surface", callId: `call-${action}` });
      assert.deepEqual(result, { status: "completed", result: { ok: true } });
    }
    await executeWorkspaceTool({ claimId: "claim-1", question: "What did you build?" }, { ...context, toolName: "start_resume_question", callId: "resume-call" });
    assert.equal(sent.length, 5);
    for (const payload of sent) assert.equal(payload.action, "enqueueWorkspaceCommand");
    assert.equal(sent[4].tool, "start_resume_question");
    assert.deepEqual(sent[4].input, { claimId: "claim-1", question: "What did you build?" });
  });
  test("an explicit disabled preview still blocks a resume question", async () => {
    studioReturns({ config: { interview: { type: "resume" } }, tools: NO_TOOLS });
    const result = await executeWorkspaceTool({ claimId: "claim-1", question: "What did you build?" }, { ...ctx(), toolName: "start_resume_question", callId: "blocked" });
    assert.deepEqual(result, TOOL_SWITCHED_OFF);
  });
});

describe("prompt: the workspace for this call", () => {
  const roleplay: RoleplaySkill = { skill: "---\nname: test\n---\n# Test", difficulty: "medium" };
  const specs = { agentName: "Test", agentSlug: "test", personaName: "Adam" };
  const prompt = (tools?: ToolSettings) => formatRoleplaySession(specs, roleplay, { learnerBlock: "" }, tools);

  test("nothing on: the role-play prompt is word for word as before", () => {
    assert.equal(prompt(NO_TOOLS), prompt());
    assert.match(prompt(), /no trainer persona and no workspace\./);
    assert.match(prompt(), /Call no tool except end_call \(to hang up, as above\) and scenario_examples\. Trainer, knowledge, document, résumé, plan and workspace tools are disabled in this mode\./);
    assert.equal(formatWorkspaceBlock(NO_TOOLS, { client: true }), "");
  });

  test("some on: the prompt lists only those, in character, and allows read_document", () => {
    const text = prompt(on({ preview: true }));
    assert.doesNotMatch(text, /and no workspace/);
    assert.match(text, /# Workspace for this call/);
    assert.match(text, /open_pdf/);
    assert.match(text, /read_document/);
    assert.match(text, /Stay in character/);
    assert.doesNotMatch(text, /open_whiteboard|open_code_editor|open_choice/);
  });

  test("the twin wording does not ask to stay in character", () => {
    const block = formatWorkspaceBlock(on({ canvas: true }), { client: false });
    assert.match(block, /open_whiteboard/);
    assert.doesNotMatch(block, /in character/);
  });
});
