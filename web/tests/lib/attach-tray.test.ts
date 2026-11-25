import { expect, test } from "bun:test";
import { MAX_ATTACH, stagedMessage } from "@/components/session/attach-tray";
import { stripAttachments } from "@/lib/markers";

test("several staged files go to the twin as one message, each readable by ID", () => {
  const message = stagedMessage([{ id: "doc-1", name: "chat.png" }, { id: "doc-2", name: "brochure.pdf" }]);
  expect(message.match(/\[ATTACHED [A-Za-z0-9_-]+\]/g)).toEqual(["[ATTACHED doc-1]", "[ATTACHED doc-2]"]);
  // The transcript shows both files.
  expect(stripAttachments(message).files).toEqual([{ id: "doc-1", name: "chat.png" }, { id: "doc-2", name: "brochure.pdf" }]);
});

test("the tray holds no more files than the chat service reads in one message", () => {
  expect(MAX_ATTACH).toBe(4); // chat/agent/lib/uploads.ts MAX_FILES_PER_MESSAGE
});
