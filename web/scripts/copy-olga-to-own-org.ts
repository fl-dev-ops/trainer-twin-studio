/**
 * Local replica: copies Olga's material from acme (where it was built) into her own org (slug "olga"):
 *   - her knowledge documents (Loom sessions, Drive imports) through the app's upload, so each gets both S3 copies;
 *   - her own persona with its voice and avatar (headshot, original photo, video), as new rows and files of the olga org.
 * acme is left untouched. Idempotent: documents are matched by externalId, the persona by slug.
 *   bun scripts/copy-olga-to-own-org.ts
 */
import { randomUUID } from "node:crypto";
import { db } from "../lib/db";
import { OrganizationKnowledgeService } from "../lib/org-knowledge";
import { setPersonaAvatar, setPersonaVoice } from "../lib/persona-media";
import { avatarPrefix, getObjectBytes, getObjectText, putObject } from "../lib/s3";

const FROM = "acme";
const TO = "olga";
const SOURCES = ["loom:", "google-drive:"]; // Olga's material; acme's other documents are test files

const [from, to] = await Promise.all(
  [FROM, TO].map((slug) => db.organization.findUniqueOrThrow({ where: { slug }, select: { id: true } })),
);
const MIME: Record<string, string> = {
  md: "text/markdown", txt: "text/plain", pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const fileFrom = async (key: string, name: string, type: string) => new File([new Uint8Array(await getObjectBytes(key))], name, { type });

try {
  // 1. Knowledge documents.
  const docs = await db.knowledgeDocument.findMany({
    where: { kb: { orgId: from.id }, OR: SOURCES.map((prefix) => ({ externalId: { startsWith: prefix } })) },
    orderBy: { createdAt: "asc" },
    select: { title: true, ext: true, externalId: true, s3SourceKey: true },
  });
  let added = 0;
  for (const doc of docs) {
    if (await db.knowledgeDocument.findFirst({ where: { kb: { orgId: to.id }, externalId: doc.externalId }, select: { id: true } })) continue;
    const name = doc.s3SourceKey.split("/").pop()!;
    const created = await OrganizationKnowledgeService.uploadDocument(to.id, await fileFrom(doc.s3SourceKey, name, MIME[doc.ext] ?? "application/octet-stream"));
    await db.knowledgeDocument.update({ where: { id: created.id }, data: { title: doc.title, externalId: doc.externalId } });
    added++;
  }
  console.log(`documents: ${docs.length} in ${FROM}, ${added} copied`);

  // 2. Her own persona, then its voice and avatar (new rows owned by the olga org's persona).
  const persona = await db.persona.findFirstOrThrow({
    where: { orgId: from.id, isOwn: true, slug: "olga" },
    select: {
      slug: true, name: true, data: true, settings: true,
      voice: { select: { name: true, s3AudioKey: true, s3TranscriptKey: true } },
      avatar: { select: { s3ImageKey: true, s3OriginalImageKey: true, s3VideoKey: true } },
    },
  });
  const existing = await db.persona.findFirst({ where: { orgId: to.id, slug: persona.slug }, select: { voiceId: true, avatarId: true } });
  if (!existing) {
    await db.persona.create({
      data: { slug: persona.slug, name: persona.name, version: 1, data: persona.data ?? {}, settings: persona.settings ?? {}, orgId: to.id, isOwn: true },
    });
  }
  if (!existing?.voiceId && persona.voice?.s3AudioKey) {
    const ext = persona.voice.s3AudioKey.split(".").pop()!;
    const transcript = persona.voice.s3TranscriptKey ? await getObjectText(persona.voice.s3TranscriptKey) : undefined;
    const { voiceId } = await setPersonaVoice(to.id, persona.slug, { audio: await fileFrom(persona.voice.s3AudioKey, `reference.${ext}`, `audio/${ext === "wav" ? "wav" : ext}`), transcript });
    await db.voice.update({ where: { id: voiceId }, data: { name: persona.voice.name } });
  }
  if (!existing?.avatarId && persona.avatar?.s3ImageKey) {
    const { s3ImageKey, s3OriginalImageKey, s3VideoKey } = persona.avatar;
    const ext = (key: string) => key.split(".").pop()!;
    const { avatarId } = await setPersonaAvatar(to.id, persona.slug, {
      image: await fileFrom(s3ImageKey, `photo.${ext(s3ImageKey)}`, `image/${ext(s3ImageKey) === "jpg" ? "jpeg" : ext(s3ImageKey)}`),
      ...(s3VideoKey ? { video: await fileFrom(s3VideoKey, `video.${ext(s3VideoKey)}`, `video/${ext(s3VideoKey)}`) } : {}),
    });
    // The photo as taken (kept for regenerating the headshot); setPersonaAvatar does not handle it.
    if (s3OriginalImageKey) {
      const key = `${avatarPrefix(to.id, avatarId)}/image/original-${randomUUID()}.${ext(s3OriginalImageKey)}`;
      await putObject(key, new Uint8Array(await getObjectBytes(s3OriginalImageKey)), `image/${ext(s3OriginalImageKey) === "jpg" ? "jpeg" : ext(s3OriginalImageKey)}`);
      await db.avatar.update({ where: { id: avatarId }, data: { s3OriginalImageKey: key } });
    }
  }
  const copied = await db.persona.findFirstOrThrow({
    where: { orgId: to.id, slug: persona.slug },
    select: { isOwn: true, voice: { select: { name: true, s3AudioKey: true, s3TranscriptKey: true } }, avatar: { select: { s3ImageKey: true, s3OriginalImageKey: true, s3VideoKey: true } } },
  });
  const inOrg = (key: string | null | undefined) => (key ? (key.includes(`/${to.id}/`) ? "yes" : "NO") : "-");
  console.log(`persona ${persona.slug}: own=${copied.isOwn} | voice "${copied.voice?.name}" audio=${inOrg(copied.voice?.s3AudioKey)} transcript=${inOrg(copied.voice?.s3TranscriptKey)} | avatar image=${inOrg(copied.avatar?.s3ImageKey)} original=${inOrg(copied.avatar?.s3OriginalImageKey)} video=${inOrg(copied.avatar?.s3VideoKey)}`);
} finally {
  await db.$disconnect();
}
