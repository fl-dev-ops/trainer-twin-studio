import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachedTurn } from "@/components/calibration/parts";
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

test("a learner's summary transcript shows the attached file as a card, not the raw marker", () => {
  const raw = "Okay, Olga, give me a minute. I've attached a file: Objection_chat_screenshot.png [ATTACHED 692cf6e0-f89b-4314-bba9-e5fa8e8de5b8]";
  const files = new Map([["692cf6e0-f89b-4314-bba9-e5fa8e8de5b8", { name: "Objection_chat_screenshot.png", mediaType: "image/png" }]]);
  const html = renderToStaticMarkup(<AttachedTurn text={raw} files={files} />);
  expect(html).toContain("Objection_chat_screenshot.png");
  expect(html).toContain("<img");
  expect(html).toContain("Okay, Olga, give me a minute.</p>");
  expect(html).not.toContain("[ATTACHED");
});
