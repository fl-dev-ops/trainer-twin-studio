import { describe, expect, it } from "bun:test";
import { parseAgentSurfaceMessage } from "../../../lib/agent-surface-events";
import { parseWorkspaceCommandSurface } from "../../../lib/livekit-workspaces";

describe("session document surfaces", () => {
  it("opens an attached PDF at the requested page with highlight term", () => {
    expect(parseAgentSurfaceMessage({
      type: "open_pdf",
      eventId: "event-1",
      fileId: "doc-123",
      fileName: "Vasanth Resume.pdf",
      page: 2,
      highlightQuery: "40%",
    })).toEqual({
      surface: {
        key: "agent-pdf-event-1",
        tool: "pdf",
        sourceUrl: "/api/documents/doc-123/raw",
        fileId: "doc-123",
        fileName: "Vasanth Resume.pdf",
        page: 2,
        highlightQuery: "40%",
      },
    });
  });

  it("updates highlight query on an active PDF via highlight_document event", () => {
    expect(parseAgentSurfaceMessage({
      type: "highlight_document",
      eventId: "event-hl-1",
      fileId: "doc-123",
      query: "Redis",
    })).toEqual({
      surface: {
        key: "agent-pdf-event-hl-1",
        tool: "pdf",
        sourceUrl: "/api/documents/doc-123/raw",
        fileId: "doc-123",
        page: undefined,
        highlightQuery: "Redis",
      },
    });
  });

  it("opens an attached image", () => {
    expect(parseAgentSurfaceMessage({
      type: "open_image",
      eventId: "event-2",
      fileId: "img-456",
    })).toEqual({
      surface: {
        key: "agent-image-event-2",
        tool: "image",
        sourceUrl: "/api/documents/img-456/raw",
        fileId: "img-456",
      },
    });
  });

  it("accepts payload.code as starterCode", () => {
    const parsed = parseAgentSurfaceMessage({
      type: "open_code_editor",
      language: "javascript",
      code: "var rate = 10;",
    });
    expect(parsed?.surface).toMatchObject({
      tool: "code",
      language: "javascript",
      starterCode: "var rate = 10;",
    });
  });

  it("opens code editor with targeted highlight lines", () => {
    expect(parseAgentSurfaceMessage({
      type: "open_code_editor",
      eventId: "event-code-1",
      language: "python",
      starterCode: "def solve():\n    pass",
      highlightLines: [10, 25],
    })?.surface).toMatchObject({
      key: "agent-code-event-code-1",
      tool: "code",
      language: "python",
      starterCode: "def solve():\n    pass",
      highlightLines: [10, 25],
    });
  });

  it("opens presentation with targeted slide number", () => {
    expect(parseAgentSurfaceMessage({
      type: "open_presentation",
      eventId: "event-pptx-1",
      fileId: "deck-789",
      slideNumber: 4,
    })).toEqual({
      surface: {
        key: "agent-presentation-event-pptx-1",
        tool: "presentation",
        sourceUrl: "/api/documents/deck-789/raw",
        slideNumber: 4,
      },
    });
  });

  it("opens whiteboard with element highlight targets", () => {
    expect(parseAgentSurfaceMessage({
      type: "open_whiteboard",
      eventId: "event-canvas-1",
      highlightElements: ["node-1", "node-2"],
      scrollToElements: ["node-1"],
    })?.surface).toMatchObject({
      key: "agent-canvas-event-canvas-1",
      tool: "canvas",
      highlightElements: ["node-1", "node-2"],
      scrollToElements: ["node-1"],
    });
  });

  it("derives distinct surface keys between consecutive code-output and coding questions", () => {
    const codeOutput = parseAgentSurfaceMessage({
      type: "open_code_editor",
      questionId: "q_code_output_1",
      question: "What is the output of this code snippet?",
      language: "javascript",
      starterCode: "console.log(typeof NaN);",
      readOnly: true,
    });

    const coding = parseAgentSurfaceMessage({
      type: "open_code_editor",
      questionId: "q_coding_2",
      question: "Write a function to debounce calls.",
      language: "javascript",
      starterCode: "",
      readOnly: false,
    });

    expect(codeOutput?.surface).toMatchObject({
      key: "agent-code-q_code_output_1",
      tool: "code",
      questionId: "q_code_output_1",
      starterCode: "console.log(typeof NaN);",
      readOnly: true,
    });

    expect(coding?.surface).toMatchObject({
      key: "agent-code-q_coding_2",
      tool: "code",
      questionId: "q_coding_2",
      starterCode: "",
      readOnly: false,
    });

    expect(codeOutput?.surface.key).not.toEqual(coding?.surface.key);
  });

  it("falls back to commandId for open_code_editor when questionId/eventId is absent", () => {
    const first = parseAgentSurfaceMessage({
      type: "open_code_editor",
      commandId: "cmd_output_456",
      starterCode: "console.log([1, 2] + [3, 4]);",
      readOnly: true,
    });

    const second = parseAgentSurfaceMessage({
      type: "open_code_editor",
      commandId: "cmd_coding_789",
      starterCode: "",
      readOnly: false,
    });

    expect(first?.surface.key).toBe("agent-code-cmd_output_456");
    expect(second?.surface.key).toBe("agent-code-cmd_coding_789");
    expect(first?.surface.key).not.toEqual(second?.surface.key);
    expect(first?.surface).toMatchObject({ readOnly: true });
    expect(second?.surface).toMatchObject({ starterCode: "", readOnly: false });
  });

  it("does not use commandId on PDF surfaces to preserve viewer mount across highlights", () => {
    const opened = parseAgentSurfaceMessage({
      type: "open_pdf",
      fileId: "resume-123",
      commandId: "cmd_open_1",
    });
    const highlighted = parseAgentSurfaceMessage({
      type: "highlight_document",
      fileId: "resume-123",
      highlightQuery: "Distributed Systems",
      commandId: "cmd_hl_2",
    });

    expect(opened?.surface.key).toBe("agent-pdf-resume-123");
    expect(highlighted?.surface.key).toBe("agent-pdf-resume-123");
    expect(opened?.surface.key).toEqual(highlighted?.surface.key);
  });

  it("parses workspace commands with command.id fallback for open_code_editor", () => {
    const cmd1 = {
      id: "cmd_surface_output_1",
      tool: "surface",
      input: {
        action: "open_code_editor",
        payload: {
          language: "javascript",
          starterCode: "console.log(1);",
          readOnly: true,
        },
      },
    };
    const cmd2 = {
      id: "cmd_surface_coding_2",
      tool: "surface",
      input: {
        action: "open_code_editor",
        payload: {
          language: "javascript",
          starterCode: "",
          readOnly: false,
        },
      },
    };

    const result1 = parseWorkspaceCommandSurface(cmd1);
    const result2 = parseWorkspaceCommandSurface(cmd2);

    expect(result1?.surface?.key).toBe("agent-code-cmd_surface_output_1");
    expect(result2?.surface?.key).toBe("agent-code-cmd_surface_coding_2");
    expect(result1?.surface?.key).not.toEqual(result2?.surface?.key);
    expect(result1?.surface?.questionId).toBe("cmd_surface_output_1");
    expect(result2?.surface?.questionId).toBe("cmd_surface_coding_2");
    expect(result1?.surface).toMatchObject({ readOnly: true, starterCode: "console.log(1);" });
    expect(result2?.surface).toMatchObject({ readOnly: false, starterCode: "" });
  });

  it("preserves stable PDF key across highlight workspace commands", () => {
    const openDocCmd = {
      id: "cmd_open_pdf_1",
      tool: "surface",
      input: {
        action: "open_pdf",
        payload: { fileId: "doc_resume_abc" },
      },
    };
    const highlightCmd = {
      id: "cmd_hl_pdf_2",
      tool: "surface",
      input: {
        action: "highlight_document",
        payload: { fileId: "doc_resume_abc", query: "Leadership" },
      },
    };

    const openSurface = parseWorkspaceCommandSurface(openDocCmd);
    const hlSurface = parseWorkspaceCommandSurface(highlightCmd);

    expect(openSurface?.surface?.key).toBe("agent-pdf-doc_resume_abc");
    expect(hlSurface?.surface?.key).toBe("agent-pdf-doc_resume_abc");
    expect(openSurface?.surface?.key).toEqual(hlSurface?.surface?.key);
  });

  it("parses close_surface workspace command to surface null so UI panel closes", () => {
    const closeCmd = {
      id: "cmd_close_1",
      tool: "surface",
      input: {
        action: "close_surface",
        payload: {},
      },
    };

    const parsed = parseWorkspaceCommandSurface(closeCmd);
    expect(parsed).toEqual({ surface: null });
  });
});
