import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { avatarInitial, avatarLabel, avatarTint, UserAvatar, UserAvatarGroup } from "@/components/user-avatar";

test("label, initial and colour come from name/email and are stable per person", () => {
  expect(avatarLabel({ name: "  ", email: "nora@x.com" })).toBe("nora@x.com");
  expect(avatarInitial({ name: "aisha khan" })).toBe("A");
  expect(avatarInitial({})).toBe("U");
  // Keyed by email, case-insensitively, so the same learner matches across pages.
  expect(avatarTint({ name: "Aisha", email: "AISHA@x.com" })).toBe(avatarTint({ name: "A. Khan", email: "aisha@x.com" }));
});

test("avatar shows the initial and the name on hover", () => {
  const html = renderToStaticMarkup(<UserAvatar user={{ name: "Harini Shekar", email: "h@x.com" }} size="sm" />);
  expect(html).toContain(">H<");
  expect(html).toContain('title="Harini Shekar"');
  expect(html).toContain('aria-hidden="true"');
});

test("group caps visible avatars, adds +N and names everyone for screen readers", () => {
  const users = ["Aisha", "James", "Nora", "Leo", "Priya", "Omar"].map((name) => ({ name, email: `${name}@x.com` }));
  const html = renderToStaticMarkup(<UserAvatarGroup users={users} max={4} />);
  expect(html.match(/title="/g)?.length).toBe(4);
  expect(html).toContain("+2");
  expect(html).toContain('aria-label="6 people: Aisha, James, Nora, Leo, Priya, Omar"');
  expect(renderToStaticMarkup(<UserAvatarGroup users={[]} />)).toBe("");
});
