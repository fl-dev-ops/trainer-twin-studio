ALTER TABLE "SkillOwnership" ADD CONSTRAINT "SkillOwnership_approval_check"
CHECK (
    "mode" = 'compatibility' OR (
        "inventoryHash" IS NOT NULL AND length(trim("inventoryHash")) > 0
        AND "canaryReference" IS NOT NULL AND length(trim("canaryReference")) > 0
        AND "verifiedAt" IS NOT NULL AND "approvedAt" IS NOT NULL
    )
);
