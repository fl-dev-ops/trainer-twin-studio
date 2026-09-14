/**
 * Resume claim engine: selects the specific verbatim resume line a round question
 * should target (Resume Mastery v1 behavior) and the literal anchor the learner's
 * viewer can highlight for it. Claims come from the session document's Postgres
 * chunks (`ContextDocumentChunk`), never from an external index.
 */

/** Short anchors survive markdown-to-PDF text differences (a converter writes "Icon-HSE" where the
 * rendered page has "Icon - HSE"), and the viewer's search only matches what the page really shows. */
export const MAX_ANCHOR_WORDS = 6;

/** Section headings that are never a question target on a resume. */
export const NON_QUESTION_HEADINGS: Record<string, true> = {
  declaration: true,
  references: true,
  reference: true,
  contact: true,
  "personal details": true,
  "personal information": true,
};

/**
 * Resume sections most worth questioning first: the claim-bearing sections carry the evidence the
 * rounds probe, while education and unranked headings are last.
 */
export const SECTION_RANK: Record<string, number> = {
  experience: 0,
  "work experience": 0,
  "professional experience": 0,
  "internship experience": 0,
  internships: 0,
  employment: 0,
  "work history": 0,
  projects: 1,
  "project experience": 1,
  "personal projects": 1,
  "academic projects": 1,
  achievements: 2,
  "key achievements": 2,
  certifications: 2,
  "certifications and awards": 2,
  awards: 2,
  activities: 2,
  skills: 3,
  "technical skills": 3,
  "core competencies": 3,
  technologies: 3,
  "tools and technologies": 3,
  education: 4,
  "academic background": 4,
  qualifications: 4,
};

/** Ranks at or below this carry the achievements and decisions the rounds probe. */
export const CLAIM_BEARING_RANK = 1;

export type ChunkRef = { chunkIndex: number; heading: string | null; text: string };

export type SelectedClaim = {
  section: string | null;
  /** Verbatim bullet line from the resume chunk — the claim itself. */
  line: string;
  /** ≤MAX_ANCHOR_WORDS-word literal anchor the viewer's text search can highlight. */
  anchor: string;
  chunkIndex: number;
};

/** Normalized single-line claim candidates from a chunk's text. */
function claimLines(chunkText: string): string[] {
  return chunkText
    .split("\n")
    .map((line) =>
      line
        .replace(/[*_`#>]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        // Markdown bullets are not in the rendered PDF text layer, so a claim must never
        // start with the marker: the viewer's literal search would find nothing.
        .replace(/^[-•·]\s+/, "")
    )
    .filter((line) => line.length >= 12 && line.length <= 140);
}

const ACTION_VERB =
  /\b(led|built|designed|developed|implemented|reduced|improved|increased|automated|migrated|optimi[sz]ed|created|delivered|architected|integrated|configured|deployed|owned|analyzed|visuali[sz]ed|extracted|building|converting|analyzing)\b/i;

function claimScore(line: string, anchor: string, extractedText: string, preferQuantified: boolean): number {
  const hasNumber = /\d/.test(line);
  const occurrences = extractedText.toLowerCase().split(anchor.toLowerCase()).length - 1;
  return (
    (hasNumber ? (preferQuantified ? 3 : 1) : 0) +
    (ACTION_VERB.test(line) ? 2 : 0) +
    // A unique anchor survives the viewer search: it highlights exactly the claim.
    (occurrences === 1 ? 2 : 0)
  );
}

/**
 * Picks the next resume claim to question: a verbatim claim-bearing line with a literal anchor not
 * used this session. Impact rounds (preferQuantified) rank quantified lines first. Returns null when
 * every usable claim was already questioned — the caller then stays on the current thread.
 */
export function selectResumeClaim(
  chunks: Array<ChunkRef>,
  opts: {
    extractedText: string;
    usedAnchors: string[];
    preferQuantified: boolean;
  }
): SelectedClaim | null {
  const used = new Set(opts.usedAnchors.map((anchor) => anchor.toLowerCase()));
  const ranked = [...chunks]
    .filter((chunk) => (SECTION_RANK[(chunk.heading ?? "").trim().toLowerCase()] ?? 5) <= CLAIM_BEARING_RANK)
    .sort(
      (a, b) =>
        (SECTION_RANK[(a.heading ?? "").trim().toLowerCase()] ?? 5) -
          (SECTION_RANK[(b.heading ?? "").trim().toLowerCase()] ?? 5) || a.chunkIndex - b.chunkIndex
    );

  type Candidate = SelectedClaim & { score: number };
  const candidates: Candidate[] = [];
  for (const chunk of ranked) {
    const lines = claimLines(chunk.text);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // A line that yields no anchor cannot be highlighted, so it never becomes a claim.
      const anchor = documentAnchor(opts.extractedText, chunk.heading ?? "", line);
      if (!anchor || used.has(anchor.toLowerCase())) continue;
      candidates.push({
        section: chunk.heading ?? null,
        line,
        anchor,
        chunkIndex: chunk.chunkIndex,
        // Slight preference for earlier bullets inside an entry.
        score: claimScore(line, anchor, opts.extractedText, opts.preferQuantified) - i * 0.01,
      });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const { score: _score, ...best } = candidates[0];
  return best;
}

/**
 * Anchors must be literal, single-line document text: the learner's viewer highlights with a
 * case-insensitive text search and scrolls to the FIRST match, so a bare heading can land on an
 * earlier mention of the same word ("Projects" inside a sentence about live projects). Prefer the
 * most specific literal that occurs exactly once in the document — a quantified claim during the
 * impact round, otherwise the section's entry line — and fall back to the section heading.
 */
export function documentAnchor(
  documentText: string,
  heading: string,
  chunkText: string,
  preferQuantified = false
): string | null {
  const lines = chunkText
    .split("\n")
    .map((line) =>
      line
        .replace(/[*_`#>]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        // Markdown bullets are not in the rendered PDF text layer, so an anchor must never start
        // with the marker: the viewer's literal search would find nothing to highlight.
        .replace(/^[-•·]\s+/, "")
    )
    .filter((line) => line.length > 3 && line.length <= 110);
  const entryLine = lines[0] ?? "";
  const quantifiedLine = lines.find((line) => /\d/.test(line) && line.split(" ").length <= 14) ?? "";
  const candidates = (preferQuantified ? [quantifiedLine, entryLine, heading] : [entryLine, heading, quantifiedLine])
    .map((candidate) => candidate.split(" ").slice(0, MAX_ANCHOR_WORDS).join(" ").trim())
    .filter((candidate) => candidate.length > 3);
  const haystack = documentText.toLowerCase();
  const occurrences = (candidate: string) => haystack.split(candidate.toLowerCase()).length - 1;
  return (
    candidates.find((candidate) => occurrences(candidate) === 1) ??
    candidates.find((candidate) => occurrences(candidate) > 0) ??
    (heading.trim() || null)
  );
}

/**
 * Section to question next, walked from the document's own headings. The first heading of a resume
 * is its header block, so it is skipped. Claim-bearing sections (experience, projects) carry the
 * evidence a round probes, so they are preferred over skills and education; the least-used section
 * wins, and its visit count selects the entry to anchor inside it.
 */
export function nextDocumentSection(
  headings: string[] | undefined,
  anchored: string[]
): { section: string; variant: number } | null {
  const trimmed = (headings ?? []).map((heading) => heading.trim()).filter((heading) => heading.length > 2);
  const candidates = Array.from(new Set(trimmed.slice(trimmed.length > 1 ? 1 : 0))).filter(
    (heading) => !NON_QUESTION_HEADINGS[heading.toLowerCase()]
  );
  if (!candidates.length) return null;
  const usage = new Map<string, number>();
  for (const section of anchored) {
    const key = section.trim().toLowerCase();
    usage.set(key, (usage.get(key) ?? 0) + 1);
  }
  const rank = (heading: string) => SECTION_RANK[heading.toLowerCase()] ?? 5;
  const claimBearing = candidates.filter((heading) => rank(heading) <= CLAIM_BEARING_RANK);
  const pool = claimBearing.length ? claimBearing : candidates;
  const section = pool.reduce((best, heading) => {
    const used = usage.get(heading.toLowerCase()) ?? 0;
    const bestUsed = usage.get(best.toLowerCase()) ?? 0;
    if (used !== bestUsed) return used < bestUsed ? heading : best;
    return rank(heading) < rank(best) ? heading : best;
  });
  return { section, variant: usage.get(section.toLowerCase()) ?? 0 };
}
