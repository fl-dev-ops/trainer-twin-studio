import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const connectionString =
    process.env.DATABASE_URL ?? "postgresql://suryaumapathy@localhost:5432/trainertwin?schema=public";
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/**
 * One transaction holding Postgres advisory locks on `keys`, taken in the order given (every caller takes shared keys
 * in the same order: `minutes:<org>` before `people:<org>`), so work on the same thing runs one at a time.
 */
export function withLock<T>(keys: string[], work: (tx: Tx) => Promise<T>, options?: { timeout?: number; maxWait?: number }) {
  return db.$transaction(async (tx) => {
    for (const key of keys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    return work(tx);
  }, options);
}

/** A unique constraint refused the write (Prisma P2002). */
export const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002";
