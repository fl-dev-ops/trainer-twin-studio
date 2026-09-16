import { describe, expect, it } from "bun:test";
import { claimSpanInPage } from "./pdf-claim-anchors";

/**
 * The layer and the markdown converter render the same resume text differently, so a claim is only
 * highlightable when the locator bridges those differences. Every page string below is taken from a
 * real resume PDF as pdfium returns it.
 */
describe("claimSpanInPage", () => {
  it("finds a claim across the hyphenated line break the converter keeps", () => {
    const page = "Relevant Coursework: Data structures and algo\uFFFErithms, Database management systems.";
    const claim = "Data structures and algo- rithms, Database management systems";

    const span = claimSpanInPage(page, claim);

    expect(span && page.slice(span.start, span.end)).toBe(
      "Data structures and algo\uFFFErithms, Database management systems"
    );
  });

  it("finds a claim where the layer spaces a hyphenated entry title and the converter does not", () => {
    const page = "Machine Learning Engineer - Intern One Data Software Solutions [May 2026 - Present]";
    const claim = "Machine Learning Engineer-Intern One Data Software Solutions [May 2026 - Present]";

    const span = claimSpanInPage(page, claim);

    expect(span && page.slice(span.start, span.end)).toBe(page);
  });

  it("finds a claim where the layer pads before punctuation", () => {
    const page = "Sobha Icon Higher Secondary School, Palakkad , Kerala";
    const claim = "Higher Secondary School, Palakkad, Kerala";

    const span = claimSpanInPage(page, claim);

    expect(span && page.slice(span.start, span.end)).toBe("Higher Secondary School, Palakkad , Kerala");
  });

  it("keeps a genuine hyphenated compound distinct from the same words without it", () => {
    const page = "Higher Secondary-Science Jun 2020 - Apr 2021";

    const found = claimSpanInPage(page, "Higher Secondary-Science Jun 2020 - Apr 2021");
    expect(found && page.slice(found.start, found.end)).toBe(page);
    expect(claimSpanInPage(page, "Higher Secondary Science Jun 2020 - Apr 2021")).toBeNull();
  });

  it("returns null when the claim is not on the page", () => {
    expect(claimSpanInPage("Jane Doe, Software Engineer", "Architected a distributed WAL engine")).toBeNull();
  });
});
