import { describe, expect, it } from "bun:test";
import { parseAgentSurfaceMessage } from "./agent-surface-events";

describe("session document surfaces", () => {
  it("opens an attached PDF at the requested page with highlight term", () => {
    expect(parseAgentSurfaceMessage({
      type: "open_pdf",
      eventId: "event-1",
      fileId: "doc-123",
      page: 2,
      highlightQuery: "40%",
    })).toEqual({
      surface: {
        key: "agent-pdf-event-1",
        tool: "pdf",
        sourceUrl: "/api/documents/doc-123/raw",
        fileId: "doc-123",
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

  it("opens code editor with targeted highlight lines", () => {
    expect(parseAgentSurfaceMessage({
      type: "open_code_editor",
      eventId: "event-code-1",
      language: "python",
      starterCode: "def solve():\n    pass",
      highlightLines: [10, 25],
    })).toEqual({
      surface: {
        key: "agent-code-event-code-1",
        tool: "code",
        language: "python",
        starterCode: "def solve():\n    pass",
        highlightLines: [10, 25],
      },
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
    })).toEqual({
      surface: {
        key: "agent-canvas-event-canvas-1",
        tool: "canvas",
        highlightElements: ["node-1", "node-2"],
        scrollToElements: ["node-1"],
      },
    });
  });
});
