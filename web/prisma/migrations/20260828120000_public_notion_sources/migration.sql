ALTER TABLE "KnowledgeSource"
    ALTER COLUMN "notionConnectionId" DROP NOT NULL,
    ADD COLUMN "publicKey" TEXT;

CREATE UNIQUE INDEX "KnowledgeSource_publicKey_key" ON "KnowledgeSource"("publicKey");
