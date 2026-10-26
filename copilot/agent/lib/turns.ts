export type Turn = { n: number; speaker: string; text: string };

/** Front matter fields plus `speaker_N:` turns. Unlabelled paragraphs continue the previous turn. */
export function parseDoc(raw: string) {
  const meta: Record<string, string> = {};
  let body = raw;
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end > 0) {
      for (const line of raw.slice(3, end).split("\n")) {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (m) meta[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
      }
      body = raw.slice(end + 4);
    }
  }
  const turns: Turn[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^(speaker_\d+):\s?(.*)$/);
    if (m) turns.push({ n: turns.length, speaker: m[1], text: m[2].trim() });
    else if (line.trim() && turns.length) turns[turns.length - 1].text += " " + line.trim();
  }
  return { meta, turns };
}

export function speakerStats(turns: Turn[]) {
  const out: Record<string, { turns: number; words: number }> = {};
  for (const t of turns) {
    out[t.speaker] ??= { turns: 0, words: 0 };
    out[t.speaker].turns += 1;
    out[t.speaker].words += t.text.split(/\s+/).filter(Boolean).length;
  }
  return out;
}

export function render(turns: Turn[], cap = Infinity, perTurn = Infinity) {
  return turns
    .slice(0, cap)
    .map((t) => `[${t.n}] ${t.speaker}: ${t.text.length > perTurn ? t.text.slice(0, perTurn) + " …" : t.text}`)
    .join("\n");
}


/** For each 1-based line of a file, the turn it belongs to (-1 before the first turn), by the same rules as parseDoc. */
export function lineTurns(raw: string) {
  const lines = raw.split("\n");
  let start = 0;
  if (raw.startsWith("---")) { const end = raw.indexOf("\n---", 3); if (end > 0) start = raw.slice(0, end + 4).split("\n").length - 1; }
  const out = [-1];
  let n = -1;
  lines.forEach((line, i) => { if (i >= start && /^(speaker_\d+):/.test(line)) n++; out.push(i >= start ? n : -1); });
  return out;
}
