import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewConversation } from "@/components/calibration/review-conversation";
import { stripAttachments } from "@/lib/markers";

const attached = [{ id: "file-123", name: "objection.png", mediaType: "image/png", href: "/api/uploads/file-123/view" }];

test("attachment-only turns show a preview without a link or empty bubble", () => {
  const { text } = stripAttachments("I've attached a file: objection.png [ATTACHED file-123]");
  expect(text).toBe("");
  const html = renderToStaticMarkup(<ReviewConversation turns={[{ id: "1", speaker: "you", text, attached }]} />);
  expect(html).toContain("objection.png");
  expect(html).toContain('<img');
  expect(html).not.toContain("<a ");
  expect(html).not.toContain("<p");
});

test("attachments with a message keep the message bubble", () => {
  const { text } = stripAttachments("I've attached a file: objection.png [ATTACHED file-123]\nPlease look at this.");
  const html = renderToStaticMarkup(<ReviewConversation turns={[{ id: "1", speaker: "you", text, attached }]} />);
  expect(html).toContain("Please look at this.</p>");
  expect(html).not.toContain("<a ");
});
