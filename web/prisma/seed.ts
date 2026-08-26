/** Seeds Postgres from the YAML files in ../data (run once during migration from files). */

import "dotenv/config";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import yaml from "js-yaml";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "postgresql://suryaumapathy@localhost:5432/trainertwin?schema=public" }),
});
const DATA = path.join(import.meta.dirname, "../data");

async function seedSpec(dir: "personas" | "agents" | "domains", key: string) {
  const files = (await fs.readdir(path.join(DATA, dir))).filter((f) => f.endsWith(".yaml"));
  type UpsertDelegate = {
    upsert(args: {
      where: { slug: string };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }): Promise<unknown>;
  };
  for (const file of files) {
    const slug = file.replace(/\.yaml$/, "");
    const doc = yaml.load(await fs.readFile(path.join(DATA, dir, file), "utf-8")) as Record<string, any>;
    const entity = doc[key];
    if (!entity) continue;
    const raw = dir === "personas" ? prisma.persona : dir === "agents" ? prisma.agent : prisma.domain;
    const model = raw as unknown as UpsertDelegate;
    const domainSlug = key === "agent" && typeof entity.domain === "string" ? entity.domain : undefined;
    const values = {
      name: entity.name ?? slug,
      version: entity.version ?? 1,
      data: entity,
      ...(domainSlug ? { domainSlug } : {}),
    };
    await model.upsert({
      where: { slug },
      update: values,
      create: { slug, ...values },
    });
    console.log(`seeded ${dir}/${slug}`);
  }
}

async function seedKnowledge() {
  const kbRoot = path.join(DATA, "knowledge");
  const bucket = process.env.S3_BUCKET;
  const basePrefix = (process.env.S3_BASE_PREFIX ?? "trainertwin/kb").replace(/^\/+|\/+$/g, "");
  const region = process.env.AWS_REGION ?? "us-east-1";
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region,
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "" }
      : undefined,
  });

  const bases = (await fs.readdir(kbRoot, { withFileTypes: true })).filter((d) => d.isDirectory());
  for (const base of bases) {
    const kb = await prisma.knowledgeBase.upsert({
      where: { slug: base.name },
      update: {},
      create: { slug: base.name, name: base.name.replace(/[-_]/g, " ") },
    });
    for (const file of (await fs.readdir(path.join(kbRoot, base.name))).filter((f) => f.endsWith(".md"))) {
      const content = await fs.readFile(path.join(kbRoot, base.name, file), "utf-8");
      const existing = await prisma.knowledgeDocument.findUnique({
        where: { kbId_slug: { kbId: kb.id, slug: file } },
      });
      if (existing) continue;
      const docId = crypto.randomUUID();
      const sourceKey = `${basePrefix}/${base.name}/${docId}/source-${file}`;
      const markdownKey = `${basePrefix}/${base.name}/${docId}/content.md`;
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: sourceKey, Body: content, ContentType: "text/markdown" }));
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: markdownKey, Body: content, ContentType: "text/markdown" }));
      await prisma.knowledgeDocument.create({
        data: {
          kbId: kb.id,
          slug: file,
          title: file.replace(/\.md$/, "").replace(/[-_]/g, " "),
          ext: "md",
          size: Buffer.byteLength(content),
          s3SourceKey: sourceKey,
          s3MarkdownKey: markdownKey,
          status: "uploaded",
        },
      });
    }
    console.log(`seeded knowledge/${base.name}`);
  }
}

async function main() {
  await seedSpec("personas", "persona");
  await seedSpec("domains", "domain");
  await seedSpec("agents", "agent");
  await seedKnowledge();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
