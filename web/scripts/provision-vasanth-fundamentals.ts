import "dotenv/config";

import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { db } from "../lib/db";
import {
  createKnowledgeBase,
  digestKnowledge,
  listKnowledgeFiles,
  saveSpec,
  uploadKnowledgeFile,
} from "../lib/specs";

const orgSlug = "careerwithvasanth";
const kbSlug = "vasanth-frontend-mastery";
const root = path.resolve(import.meta.dirname, "../..");

// One knowledge base attaches to every Vasanth interview agent.
const agents = [
  "fundamentals-depth",
  "resume-mastery",
  "real-world-system-design",
] as const;
const specs = [
  {
    type: "personas",
    slug: "vasanth",
    file: "personas/vasanth.yaml",
    key: "persona",
  },
  {
    type: "domains",
    slug: "software-engineering-fundamentals",
    file: "domains/software-engineering-fundamentals.yaml",
    key: "domain",
  },
  {
    type: "domains",
    slug: "software-engineering-resume",
    file: "domains/software-engineering-resume.yaml",
    key: "domain",
  },
  {
    type: "domains",
    slug: "software-engineering-system-design",
    file: "domains/software-engineering-system-design.yaml",
    key: "domain",
  },
] as const;

async function markdownFiles(
  directory: string,
  prefix = "",
): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const relativePath = path.join(prefix, entry.name);
      return entry.isDirectory()
        ? markdownFiles(path.join(directory, entry.name), relativePath)
        : entry.name.endsWith(".md")
          ? [relativePath]
          : [];
    }),
  );
  return files.flat();
}

async function main() {
  const org = await db.organization.findUnique({ where: { slug: orgSlug } });
  if (!org) throw new Error(`Organization ${orgSlug} was not found`);
  const voice = await db.voice.findFirst({
    where: {
      orgId: org.id,
      name: { equals: "Vasanth", mode: "insensitive" },
      status: "ready",
    },
    orderBy: { createdAt: "desc" },
  });
  if (!voice) throw new Error("A ready Vasanth voice was not found");

  await createKnowledgeBase(org.id, kbSlug);
  const knowledgeRoot = path.join(
    root,
    "careerwithvasanth/knowledge/vasanth-frontend-mastery",
  );
  const files = (await markdownFiles(knowledgeRoot)).sort();
  const existing = new Set(
    (await listKnowledgeFiles(org.id, kbSlug)).map((document) => document.slug),
  );
  for (const relativePath of files) {
    const name = relativePath.replaceAll("/", "--");
    if (existing.has(name)) continue;
    const content = await fs.readFile(path.join(knowledgeRoot, relativePath));
    await uploadKnowledgeFile(
      org.id,
      kbSlug,
      new File([content], name, { type: "text/markdown" }),
    );
    console.log(`uploaded ${relativePath}`);
  }

  const documents = await listKnowledgeFiles(org.id, kbSlug);
  if (documents.some((document) => document.status !== "indexed")) {
    const result = await digestKnowledge(org.id, kbSlug);
    console.log(`indexed ${result.indexed} documents`);
  }

  for (const { type, slug, file, key } of specs) {
    const text = await fs.readFile(path.join(root, "web/data", file), "utf8");
    const document = yaml.load(text) as Record<string, Record<string, unknown>>;
    if (key === "domain") document.domain.knowledge_bases = [kbSlug];
    await saveSpec(type, slug, yaml.dump(document, { lineWidth: -1 }), org.id);
  }

  for (const agentSlug of agents) {
    const agentPath = path.join(root, "web/data/agents", `${agentSlug}.yaml`);
    const agentDocument = yaml.load(await fs.readFile(agentPath, "utf8")) as {
      agent: Record<string, unknown>;
    };
    agentDocument.agent.voiceId = voice.id;
    agentDocument.agent.knowledgeBase = kbSlug;
    await saveSpec(
      "agents",
      agentSlug,
      yaml.dump(agentDocument, { lineWidth: -1 }),
      org.id,
    );
    console.log(`provisioned agent ${agentSlug}`);
  }

  console.log(
    JSON.stringify(
      {
        org: org.slug,
        agents: agents.map((slug) => ({
          slug,
          voice: voice.name,
          knowledgeBase: kbSlug,
        })),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
