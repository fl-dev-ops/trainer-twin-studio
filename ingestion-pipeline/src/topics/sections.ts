import type { PreparedChunk, PreparedDocument } from "../chunking/markdown";
import { createTopicResolver } from "./normalization";

export type ClassificationUnit = { index: number; sectionId: string; text: string };
const MAX_UNIT_CHARS = 6000;

/** Cover complete direct section content, including the middle of large sections. */
export function buildClassificationUnits(document: PreparedDocument): ClassificationUnit[] {
  const units: ClassificationUnit[] = [];
  for (const section of document.sections) {
    if (!section.text.trim()) continue;
    const context = [
      document.pageTitle ? `Page: ${document.pageTitle}` : "",
      section.headingPath.length ? `Topic: ${section.headingPath.join(" > ")}` : "",
    ].filter(Boolean).join("\n");
    const prefix = context ? `${context}\n\n` : "";
    const budget = MAX_UNIT_CHARS - prefix.length;
    if (budget < 1) throw new Error("Heading context exceeds the classification size budget");
    for (let start = 0; start < section.text.length; start += budget) {
      units.push({ index: units.length, sectionId: section.id, text: prefix + section.text.slice(start, start + budget) });
    }
  }
  return units;
}

/** Missing, duplicate, or malformed results fail closed; explicit [] is valid. */
export function parseUnitTopicResults(
  raw: unknown,
  batch: ClassificationUnit[],
  approvedSlugs: Set<string>,
): Map<number, string[] | null> {
  const results = new Map<number, string[] | null>(batch.map((unit) => [unit.index, null]));
  if (!raw || typeof raw !== "object" || !("results" in raw) || !Array.isArray(raw.results)) return results;
  const resolveTopic = createTopicResolver(approvedSlugs);
  const seen = new Set<number>();
  for (const entry of raw.results) {
    if (!entry || typeof entry !== "object" || typeof entry.unit !== "number"
      || !Number.isInteger(entry.unit) || !results.has(entry.unit)) continue;
    if (seen.has(entry.unit)) {
      results.set(entry.unit, null);
      continue;
    }
    seen.add(entry.unit);
    if (!Array.isArray(entry.topics) || !entry.topics.every((value: unknown) => typeof value === "string")) continue;
    const topics = entry.topics.map(resolveTopic).filter((slug: string | undefined): slug is string => slug !== undefined);
    results.set(entry.unit, [...new Set<string>(topics)]);
  }
  return results;
}

/** Finalize each section once, then inherit its complete tag set into all fragments. */
export function applySectionTopics(
  document: PreparedDocument,
  units: ClassificationUnit[],
  results: Map<number, string[] | null>,
): PreparedChunk[] {
  const bySection = new Map<string, Set<string>>(document.sections.map((section) => [section.id, new Set<string>()]));
  const failed = new Set<string>();
  for (const unit of units) {
    const topics = results.get(unit.index);
    if (!topics) failed.add(unit.sectionId);
    else for (const topic of topics) bySection.get(unit.sectionId)?.add(topic);
  }
  return document.chunks.map((chunk) => ({
    ...chunk,
    topics: chunk.sectionIds.some((id) => failed.has(id))
      ? []
      : [...new Set<string>(chunk.sectionIds.flatMap((id) => [...(bySection.get(id) ?? [])]))],
  }));
}
