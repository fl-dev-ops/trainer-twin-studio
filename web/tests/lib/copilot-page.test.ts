import { describe, expect, test } from "bun:test";
import { decodeCopilotMessage, encodeCopilotMessage } from "@/lib/copilot-message";
import { copilotPageOf, dashPath, isCopilotHome, sectionOf, startersFor } from "@/lib/copilot-page";

describe("copilot page context", () => {
  test("the dash URL is the same with or without the /dash folder prefix", () => {
    expect(dashPath("/dash/twin/sessions")).toBe("/twin/sessions");
    expect(dashPath("/twin/sessions/")).toBe("/twin/sessions");
    expect(dashPath("/dash")).toBe("/");
    expect(dashPath("/dashboard")).toBe("/dashboard");
    expect(isCopilotHome("/")).toBe(true);
    expect(isCopilotHome("/dash")).toBe(true);
    expect(isCopilotHome("/twin")).toBe(false);
  });

  test("sections are named the way the sidebar names them; the most specific route wins", () => {
    expect(sectionOf("/twin")).toBe("Twin agents");
    expect(sectionOf("/twin/sessions")).toBe("Twin sessions");
    expect(sectionOf("/twin/sessions/abc")).toBe("Twin session");
    expect(sectionOf("/twin/knowledge")).toBe("Twin’s brain");
    expect(sectionOf("/twin/olga")).toBe("Twin");
    expect(sectionOf("/roleplay/sessions")).toBe("Role play sessions");
    expect(sectionOf("/roleplay/new")).toBe("New role play");
    expect(sectionOf("/roleplay/renewal-call/edit")).toBe("Role play: edit");
    expect(sectionOf("/personas/priya/edit")).toBe("Persona");
    expect(sectionOf("/somewhere/else")).toBeNull();
  });

  test("a page heading names the item; a heading that repeats the section adds nothing", () => {
    expect(copilotPageOf("/roleplay/renewal-call", "Renewal  call")).toEqual({ path: "/roleplay/renewal-call", title: "Role play: Renewal call" });
    expect(copilotPageOf("/roleplay/renewal-call/edit", "Renewal call")).toEqual({
      path: "/roleplay/renewal-call/edit",
      title: "Role play: Renewal call · edit",
    });
    expect(copilotPageOf("/dash/twin/sessions", "Twin sessions")).toEqual({ path: "/twin/sessions", title: "Twin sessions" });
    expect(copilotPageOf("/twin/sessions", "Twin")).toEqual({ path: "/twin/sessions", title: "Twin sessions" });
    expect(copilotPageOf("/users", null)).toEqual({ path: "/users", title: "Users" });
    expect(copilotPageOf("/twin/olga", "Olga Sinenko’s twin")).toEqual({ path: "/twin/olga", title: "Olga Sinenko’s twin" });
    expect(copilotPageOf("/twin/olga/edit", "Olga Sinenko’s twin")).toEqual({ path: "/twin/olga/edit", title: "Olga Sinenko’s twin · configure" });
    expect(copilotPageOf("/", "Copilot")).toBeNull();
    expect(copilotPageOf("/unknown")).toBeNull();
  });

  test("starters follow the page and only offer what the copilot can do", () => {
    expect(startersFor({ path: "/roleplay/x", title: "Role play: X" })[0]).toBe("Change this role play");
    expect(startersFor({ path: "/twin/brain", title: "Twin’s brain" })[0]).toBe("Build a twin skill from my knowledge");
    expect(startersFor(null)).toHaveLength(2);
    for (const starter of ["/twin", "/roleplay", "/personas", "/users", "/usage"].flatMap((path) => startersFor({ path, title: "" }))) {
      expect(starter.toLowerCase()).not.toContain("invite");
    }
  });

  test("the page tag round-trips ahead of the skill and files, and plain messages are unchanged", () => {
    const page = { path: "/roleplay/renewal-call", title: 'Role play: "Renewal" <call> & co' };
    const sent = encodeCopilotMessage({ page, skill: "roleplay-creator", files: [{ id: "d1", title: "Deck" }], text: "Make it harder" });
    expect(sent.startsWith('<page path="/roleplay/renewal-call" title="Role play: &quot;Renewal&quot; &lt;call&gt; &amp; co" />\n<use-skill')).toBe(true);
    expect(decodeCopilotMessage(sent)).toEqual({ page, skill: "roleplay-creator", files: [{ id: "d1", title: "Deck" }], text: "Make it harder" });
    expect(decodeCopilotMessage(encodeCopilotMessage({ page, files: [], text: "hi" }))).toEqual({ page, skill: undefined, files: [], text: "hi" });
    expect("page" in decodeCopilotMessage("hello")).toBe(false);
  });
});
