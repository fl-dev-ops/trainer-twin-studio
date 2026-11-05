import { expect, test } from "bun:test";
import { DURING_IMAGE_MAX_BYTES, UPLOAD_MAX_BYTES, beforeUploadProblem, duringUploadProblem, uploadAllowed } from "@/lib/context-upload";

test("during a conversation: an image up to 5 MB or a PDF up to 10 MB", () => {
  expect(duringUploadProblem({ name: "Screenshot.PNG", size: 2_000_000 })).toBeNull();
  expect(duringUploadProblem({ name: "photo.jpeg", size: DURING_IMAGE_MAX_BYTES })).toBeNull();
  expect(duringUploadProblem({ name: "huge.webp", size: DURING_IMAGE_MAX_BYTES + 1 })).toContain("over 5 MB");
  expect(duringUploadProblem({ name: "brief.pdf", size: UPLOAD_MAX_BYTES })).toBeNull();
  expect(duringUploadProblem({ name: "big.pdf", size: UPLOAD_MAX_BYTES + 1 })).toContain("over 10 MB");
  expect(duringUploadProblem({ name: "notes.docx", size: 1000 })).toContain("Only an image");
  expect(duringUploadProblem({ name: "noextension", size: 1000 })).toContain("Only an image");
});

test("before a call: a PDF or an image, up to 10 MB", () => {
  expect(beforeUploadProblem({ name: "resume.pdf", size: 1000 })).toBeNull();
  expect(beforeUploadProblem({ name: "photo.webp", size: UPLOAD_MAX_BYTES })).toBeNull();
  expect(beforeUploadProblem({ name: "notes.txt", size: 1000 })).toContain("Only a PDF or an image");
  expect(beforeUploadProblem({ name: "big.pdf", size: UPLOAD_MAX_BYTES + 1 })).toContain("over 10 MB");
});

test("the server's check matches", () => {
  const pdf = { kind: "document", mimeType: "application/pdf", size: 1000 };
  expect(uploadAllowed(pdf, "before")).toBe(true);
  expect(uploadAllowed(pdf, "during")).toBe(true);
  expect(uploadAllowed({ kind: "image", mimeType: "image/png", size: DURING_IMAGE_MAX_BYTES }, "during")).toBe(true);
  expect(uploadAllowed({ kind: "image", mimeType: "image/png", size: DURING_IMAGE_MAX_BYTES + 1 }, "during")).toBe(false);
  expect(uploadAllowed({ kind: "image", mimeType: "image/png", size: DURING_IMAGE_MAX_BYTES + 1 }, "before")).toBe(true);
  expect(uploadAllowed({ kind: "document", mimeType: "text/plain", size: 1000 }, "before")).toBe(false);
  expect(uploadAllowed({ kind: "image", mimeType: "image/png", size: UPLOAD_MAX_BYTES + 1 }, "before")).toBe(false);
});
