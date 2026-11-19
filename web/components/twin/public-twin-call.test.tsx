import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicTwinCall } from "./public-twin-call";

test("public prejoin discloses AI and transcript use without visitor text or upload controls", () => {
  const html = renderToStaticMarkup(<PublicTwinCall
    twin={{ id: "twin-id", slug: "coach", name: "Coach’s twin", description: null, publicAccess: { enabled: true, maxSeconds: 180 } }}
    trainer={{ name: "Coach", title: null, bio: null, photoUrl: null }}
    onBack={() => undefined}
  />);
  expect(html).toContain("Your name");
  expect(html).toContain("AI twin");
  expect(html).toContain("transcribed");
  expect(html).toContain("self-reported");
  expect(html).toContain("3 minutes");
  expect(html).toContain("Start voice call");
  expect(html).not.toContain("Type a message");
  expect(html).not.toContain("Attach a file");
  expect(html).not.toContain("Share screen");
});
