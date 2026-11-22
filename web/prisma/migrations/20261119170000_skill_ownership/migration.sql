CREATE TABLE "SkillOwnership" (
    "orgId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'compatibility',
    "inventoryHash" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "canaryReference" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkillOwnership_pkey" PRIMARY KEY ("orgId"),
    CONSTRAINT "SkillOwnership_mode_check" CHECK ("mode" IN ('compatibility', 'managed')),
    CONSTRAINT "SkillOwnership_orgId_fkey" FOREIGN KEY ("orgId")
        REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
