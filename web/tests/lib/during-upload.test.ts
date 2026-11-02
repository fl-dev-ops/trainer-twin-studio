import { expect, test } from "bun:test";
import { UPLOAD_MAX_BYTES, beforeUploadProblem, duringUploadProblem, uploadAllowed } from "@/lib/context-upload";

test("during a conversation: images up to 10 MB attach, anything else is refused with a reason", () => {
  expect(duringUploadProblem({ name: "Screenshot.PNG", size: 2_000_000 })).toBeNull();
  expect(duringUploadProblem({ name: "photo.jpeg", size: UPLOAD_MAX_BYTES })).toBeNull();
  expect(duringUploadProblem({ name: "brief.pdf", size: 1000 })).toContain("Only images");
  expect(duringUploadProblem({ name: "noextension", size: 1000 })).toContain("Only images");
  expect(duringUploadProblem({ name: "huge.webp", size: UPLOAD_MAX_BYTES + 1 })).toContain("over 10 MB");
});

test("before the conversation: a PDF or an image up to 10 MB; Word, slides and text are refused", () => {
  expect(beforeUploadProblem({ name: "resume.pdf", size: 900_000 })).toBeNull();
  expect(beforeUploadProblem({ name: "brochure.webp", size: 900_000 })).toBeNull();
  expect(beforeUploadProblem({ name: "resume.docx", size: 1000 })).toContain("PDF or an image");
  expect(beforeUploadProblem({ name: "notes.txt", size: 1000 })).toContain("PDF or an image");
  expect(beforeUploadProblem({ name: "big.pdf", size: UPLOAD_MAX_BYTES + 1 })).toContain("over 10 MB");
});

test("the server's check reads the stored kind and type, not the name", () => {
  const pdf = { kind: "document", mimeType: "application/pdf", size: 1000 };
  expect(uploadAllowed(pdf, "before")).toBe(true);
  expect(uploadAllowed(pdf, "during")).toBe(false);
  expect(uploadAllowed({ kind: "image", mimeType: "image/png", size: 1000 }, "during")).toBe(true);
  expect(uploadAllowed({ kind: "document", mimeType: "text/plain", size: 1000 }, "before")).toBe(false);
  expect(uploadAllowed({ kind: "image", mimeType: "image/png", size: UPLOAD_MAX_BYTES + 1 }, "before")).toBe(false);
});
