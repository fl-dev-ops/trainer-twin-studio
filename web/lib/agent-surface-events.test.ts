import { describe, expect, it } from "bun:test";
import { parseAgentSurfaceMessage } from "./agent-surface-events";

describe("session document surfaces", () => {
  it("opens an attached PDF at the requested page", () => {
    expect(parseAgentSurfaceMessage({
      type: "open_pdf",
      eventId: "event-1",
      fileId: "doc-123",
      page: 2,
    })).toEqual({
      surface: {
        key: "agent-pdf-event-1",
        tool: "pdf",
        sourceUrl: "/api/documents/doc-123/raw",
        fileId: "doc-123",
        page: 2,
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
});
