import "../use-test-db";
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { db } from "../../lib/db";
import { browserToken } from "../../lib/interview-sessions";
import { seed } from "../seed-data";

let execute: typeof import("../../../chat/agent/lib/workspace-tools")["executeWorkspaceTool"];
let orgId: string;
let sessionId: string;
let token: string;
let pdfBytes: Buffer;
let contextId: string;
let data: ReturnType<typeof seed>;
const secret = process.env.COPILOT_SERVICE_SECRET!;
const context = (tool: string, callId: string = randomUUID()) => ({ toolName: tool, callId,
  session: { auth: { initiator: { principalId: orgId }, current: { principalId: orgId, attributes: { orgId, sessionId } } } },
});
const command = (tool: string, input: unknown = {}, callId?: string) => execute(input, context(tool, callId)) as Promise<{ status: string; result: Record<string, unknown> }>;
const open = (action: string, payload: object = {}) => command("surface", { action, payload });

test.beforeAll(async () => {
  process.env.STUDIO_URL = "http://localhost:3999";
  execute = (await import("../../../chat/agent/lib/workspace-tools")).executeWorkspaceTool;
  execFileSync("bun", ["e2e/seed.ts"], { stdio: "pipe", timeout: 60_000 });
  data = seed();
  orgId = (await db.organization.findUniqueOrThrow({ where: { slug: data.org.slug } })).id;
  pdfBytes = Buffer.from(await (await fetch("http://127.0.0.1:4174/fixture.pdf")).arrayBuffer());
});
test.beforeEach(async ({ context: browser }) => {
  const agent = await db.agent.findFirstOrThrow({ where: { orgId, slug: data.roleplay.slug }, include: { persona: true } });
  const doc = await db.contextDocument.create({ data: { orgId, ownerUserId: data.learner.id, name: "Resume.pdf", mimeType: "application/pdf", size: pdfBytes.length, content: new Uint8Array(pdfBytes),
    extractedText: "Built reliable distributed systems and reduced latency by forty percent." } });
  contextId = doc.id;
  const row = await db.interviewSession.create({ data: { orgId, userId: data.learner.id, agentId: agent.id, agentSlug: agent.slug, agentVersion: agent.version,
    personaSlug: agent.persona.slug, personaVersion: agent.persona.version, shareCode: randomUUID(), status: "active", mode: "voice", startedAt: new Date(), contextId,
    compiledSnapshot: { agent: {
      slug: agent.slug, version: agent.version,
      data: { tools: { canvas: true, codeEditor: true, preview: true, choice: true } },
    } },
  } });
  sessionId = row.id;
  token = browserToken(sessionId);
  await browser.route("https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@*/dist/pdfium.wasm", route => route.fulfill({ body: readFileSync("node_modules/@embedpdf/pdfium/dist/pdfium.wasm"), contentType: "application/wasm" }));
  await browser.route("**/api/documents/*/raw**", route => route.fulfill({ body: pdfBytes, contentType: "application/pdf" }));
});
test.afterEach(async () => {
  await db.interviewSession.deleteMany({ where: { id: sessionId } });
  await db.contextDocument.deleteMany({ where: { id: contextId } });
});
const visit = async (page: import("@playwright/test").Page) => page.goto(`/?session=${sessionId}&token=${token}`);

test("real code editor opens, reads current code, highlights it and displays run output", async ({ page }) => {
  await visit(page);
  expect(await open("open_code_editor", { questionId: "q1", question: "Write an addition", language: "javascript", starterCode: "console.log(1 + 1);" })).toMatchObject({ status: "completed" });
  await expect(page.getByText("Write an addition", { exact: true })).toBeVisible();
  expect(await command("get_code_state")).toMatchObject({ status: "completed", result: { result: { code: "console.log(1 + 1);" } } });
  expect(await command("read_code_range", { from_line: 1, to_line: 200 })).toMatchObject({ status: "completed" });
  expect(await command("highlight_code", { from_line: 1, to_line: 1 })).toMatchObject({ status: "completed" });
  await expect(page.locator(".agent-code-highlight").first()).toBeVisible();
  expect(await command("run_code")).toMatchObject({ status: "completed", result: { result: { stdout: "2\n" } } });
  await expect(page.getByRole("tab", { name: "Output" })).toHaveAttribute("aria-selected", "true");
  expect(await open("close_surface")).toMatchObject({ status: "completed" });
  await expect(page.getByTestId("surface")).toHaveText("none");
});

test("a new editor question is ready before acknowledgement and the previous code cannot leak into it", async ({ page }) => {
  await visit(page);
  expect(await open("open_code_editor", { questionId: "first", question: "First task", language: "javascript", starterCode: "old code" })).toMatchObject({ status: "completed" });
  expect(await open("open_code_editor", { questionId: "second", question: "Second task", language: "javascript", starterCode: "new code" })).toMatchObject({ status: "completed" });
  expect(await command("get_code_state")).toMatchObject({ result: { result: { code: "new code" } } });
  await expect(page.getByText("Second task", { exact: true })).toBeVisible();
});

test("real whiteboard adds, reads, highlights and clears elements", async ({ page }) => {
  await visit(page);
  expect(await open("open_whiteboard", { question: "Design a queue", questionId: "board1" })).toMatchObject({ status: "completed" });
  const added = await command("add_canvas_component", { label: "Message Queue", x: 100, y: 120 });
  expect(added.status).toBe("completed");
  expect(await command("read_canvas_scene")).toMatchObject({ result: { labels: ["Message Queue"] } });
  expect(await command("highlight_whiteboard", { component_label: "Message Queue" })).toMatchObject({ status: "completed" });
  expect(await command("highlight_canvas_element", { element_id: (added.result.result as { element_id: string }).element_id })).toMatchObject({ status: "completed" });
  expect(await command("clear_canvas")).toMatchObject({ status: "completed" });
  expect(await command("read_canvas_scene")).toMatchObject({ result: { elementsCount: 0 } });
});

test("a submitted whiteboard is replaced by a fresh editable question, without requiring model IDs", async ({ page }) => {
  await visit(page);
  expect(await open("open_whiteboard", { question: "First design" })).toMatchObject({ status: "completed" });
  expect(await command("add_canvas_component", { label: "Queue", x: 100, y: 100 })).toMatchObject({ status: "completed" });
  await page.getByRole("button", { name: "Submit diagram" }).click();
  await expect(page.getByRole("button", { name: "Submitted" })).toBeDisabled();
  expect(await open("open_whiteboard", { question: "Second design" })).toMatchObject({ status: "completed" });
  expect(await command("read_canvas_scene")).toMatchObject({ result: { elementsCount: 0 } });
  await expect(page.getByRole("button", { name: "Submit diagram" })).toBeEnabled();
});

test("real multiple choice reflects the learner's pick and agent highlighting", async ({ page }) => {
  await visit(page);
  expect(await open("open_choice", { questionId: "choice1", question: "Which is a queue?", options: [{ id: "A", text: "FIFO" }, { id: "B", text: "LIFO" }] })).toMatchObject({ status: "completed" });
  await page.getByRole("radio", { name: "A. FIFO" }).check();
  expect(await command("get_choice_state")).toMatchObject({ status: "completed", result: { result: { selectedId: "A" } } });
  expect(await command("highlight_choice", { option_id: "B" })).toMatchObject({ status: "completed" });
  expect(await command("workspace_request", { method: "workspace.choice", action: "get_state" })).toMatchObject({ result: { result: { highlightedId: "B" } } });
});

test("PDF loads, an image loads, and real presentation navigation uses zero-based tool indices", async ({ page }) => {
  await visit(page);
  expect(await open("open_pdf", { fileId: contextId })).toMatchObject({ status: "completed" });
  await expect(page.getByTestId("surface")).toHaveText("pdf");
  expect(await open("highlight_document", { fileId: contextId, highlightQuery: "Built reliable distributed systems" })).toMatchObject({ status: "completed" });
  expect(await open("highlight_document", { fileId: contextId, highlightQuery: "This phrase does not occur in the document" })).toMatchObject({ status: "failed", result: { ok: false } });
  expect(await open("open_image", { sourceUrl: "http://127.0.0.1:4174/fixture.png" })).toMatchObject({ status: "completed" });
  await expect(page.locator("img")).toBeVisible();
  expect(await open("open_presentation", { sourceUrl: "http://127.0.0.1:4174/fixture.pptx" })).toMatchObject({ status: "completed" });
  expect(await command("get_presentation_state")).toMatchObject({ result: { result: { slideCount: 2, slideIndex: 0 } } });
  expect(await command("set_presentation_slide", { slide_index: 1 })).toMatchObject({ status: "completed", result: { result: { slideIndex: 1 } } });
  await expect(page.getByRole("textbox", { name: "Current slide" })).toHaveValue("2");
  expect(await command("previous_presentation_slide")).toMatchObject({ result: { result: { slideIndex: 0 } } });
  await expect(page.getByRole("textbox", { name: "Current slide" })).toHaveValue("1");
  expect(await command("next_presentation_slide")).toMatchObject({ result: { result: { slideIndex: 1 } } });
  expect(await command("workspace_request", { method: "workspace.presentation", action: "set_zoom", payload: { percent: 150 } })).toMatchObject({ result: { result: { zoom: 150 } } });
});

test("replaying a confirmed PDF highlight returns the saved result without reopening the viewer", async ({ page }) => {
  await visit(page);
  expect(await open("open_pdf", { fileId: contextId })).toMatchObject({ status: "completed" });
  await expect(page.getByRole("button", { name: "Current page 1. Edit page number" })).toBeVisible();
  const id = randomUUID();
  const input = {
    action: "highlight_document",
    payload: { fileId: contextId, highlightQuery: "Built reliable distributed systems" },
  };
  const first = await command("surface", input, id);
  expect(first).toMatchObject({ status: "completed" });
  expect(await command("surface", input, id)).toEqual(first);
  await expect(page.getByTestId("opens")).toHaveText("2");
});

test("failed acknowledgements retry without reopening or resetting the workspace", async ({ page }) => {
  let failures = 0;
  await page.route("**/api/sessions/*/commands/*", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "complete" && failures++ < 2) return route.fulfill({ status: 503, body: "temporary" });
    return route.continue();
  });
  await visit(page);
  expect(await open("open_choice", { question: "Pick one", options: [{ id: "A", text: "Yes" }, { id: "B", text: "No" }] })).toMatchObject({ status: "completed" });
  await expect(page.getByTestId("opens")).toHaveText("1");
  expect(failures).toBe(3);
});

test("a lost ACK response after commit does not execute the command twice", async ({ page }) => {
  await page.route("**/api/sessions/*/commands/*", async route => {
    if (route.request().postDataJSON().action === "complete") {
      await route.fetch();
      return route.abort("connectionreset");
    }
    return route.continue();
  });
  await visit(page);
  expect(await open("open_choice", { question: "Pick one", options: [{ id: "A", text: "Yes" }, { id: "B", text: "No" }] })).toMatchObject({ status: "completed" });
  await expect(page.getByTestId("opens")).toHaveText("1");
});

test("expired commands are not replayed when the browser reconnects", async ({ page }) => {
  await visit(page);
  await page.getByRole("button", { name: "Toggle connection" }).click();
  const row = await db.workspaceCommand.create({ data: { id: randomUUID(), sessionId, tool: "surface", input: { action: "open_whiteboard" }, createdAt: new Date(Date.now() - 31_000) } });
  await page.getByRole("button", { name: "Toggle connection" }).click();
  await expect.poll(async () => (await db.workspaceCommand.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("failed");
  await expect(page.getByTestId("opens")).toHaveText("0");
});

test("two tabs execute one pending command only once", async ({ page, context: browser }) => {
  const other = await browser.newPage();
  await Promise.all([visit(page), visit(other)]);
  expect(await open("open_choice", { question: "Pick one", options: [{ id: "A", text: "Yes" }, { id: "B", text: "No" }] })).toMatchObject({ status: "completed" });
  const counts = await Promise.all([page.getByTestId("opens").textContent(), other.getByTestId("opens").textContent()]);
  expect(counts.map(Number).reduce((a, b) => a + b, 0)).toBe(1);
  await other.close();
});

test("unknown actions and missing files are failed, never acknowledged as visible work", async ({ page }) => {
  await visit(page);
  expect(await open("invented_action")).toMatchObject({ disabled: true });
  const invalid = await fetch("http://localhost:3999/api/copilot/studio", { method: "POST",
    headers: { authorization: `Bearer ${secret}`, "x-trainertwin-org-id": orgId, "content-type": "application/json" },
    body: JSON.stringify({ action: "enqueueWorkspaceCommand", sessionId, callId: randomUUID(), tool: "surface", input: { action: "invented_action" } }),
  });
  expect(await invalid.json()).toMatchObject({ status: "failed", result: { ok: false } });
  expect(await open("open_pdf")).toMatchObject({ status: "failed", result: { ok: false } });
  await expect(page.getByTestId("surface")).toHaveText("none");
  expect(await command("highlight_choice", { option_id: "missing" })).toMatchObject({ status: "failed" });
});
