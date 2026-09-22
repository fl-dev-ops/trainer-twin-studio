import { describe, expect, it } from "bun:test";
import { documentAnchor, MAX_ANCHOR_WORDS } from "../../../lib/runtime/claims";

describe("documentAnchor", () => {
  it("anchors an over-long single claim line on the claim, never on the section heading", () => {
    // A single line longer than the chunk-line cap: extraction passes claim lines this long, so the
    // anchor must still be cut from the claim or the viewer highlights the heading instead.
    const claim =
      "Machine Learning Engineer-Intern One Data Software Solutions [May 2026 - Present] Worked on building LLM-based chat agents and enhancing model responses using prompt engineering.";
    const document = [
      "# Jane Doe",
      "",
      "## Experience",
      "",
      `**${claim}**`,
      "",
      "## Skills",
      "",
      "Python, SQL",
    ].join("\n");

    const anchor = documentAnchor(document, "Experience", claim);

    expect(claim.length).toBeGreaterThan(110);
    expect(anchor).toBe("Machine Learning Engineer-Intern One Data Software");
  });

  it("anchors a claim that spans markdown emphasis to the claim text, not the heading", () => {
    const document = [
      "# Aswathy B",
      "",
      "## Education",
      "",
      "**B. Tech in Data Science** Aug 2021 – May 2025 *Sai University, Chennai* Relevant Coursework: Linear algebra, Numerical methods, Data structures and algorithms, NLP, Operating Systems, Computer Networks. CGPA: 7.55",
    ].join("\n");
    const claim =
      "B. Tech in Data Science Aug 2021 – May 2025 Sai University, Chennai Relevant Coursework: Linear algebra, Numerical methods, Data structures and algorithms, NLP, Operating Systems, Computer Networks. CGPA: 7.55";

    // The emphasis marker sits inside the first six words, so a raw-markdown search finds nothing.
    const anchor = documentAnchor(document, "Education", claim);

    expect(anchor).toBe("B. Tech in Data Science Aug");
  });

  it("keeps every anchor bounded and literally searchable in the rendered document", () => {
    const document = [
      "# Jane Doe",
      "",
      "## Experience",
      "",
      "- Building LLM-based chat agents and enhancing model responses using prompt engineering.",
      "- Creating business dashboards and automating AWS cloud infrastructure using Terraform.",
    ].join("\n");
    const haystack = document.replace(/[*_`#>]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

    for (const line of [
      "Building LLM-based chat agents and enhancing model responses using prompt engineering.",
      "Creating business dashboards and automating AWS cloud infrastructure using Terraform.",
    ]) {
      const anchor = documentAnchor(document, "Experience", line) ?? "";
      expect(anchor.trim().split(/\s+/).length).toBeLessThanOrEqual(MAX_ANCHOR_WORDS);
      expect(haystack).toContain(anchor.replace(/[*_`#>]/g, " ").replace(/\s+/g, " ").trim().toLowerCase());
    }
  });
});
