-- Members are never deleted: a studio member disables them instead (soft delete, reversible).
-- A disabled member cannot sign in; their history stays. Additive and nullable: existing rows stay enabled.
ALTER TABLE "member" ADD COLUMN "disabledAt" TIMESTAMP(3);
