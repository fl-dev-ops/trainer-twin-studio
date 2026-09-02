import type { ConnectionScope } from "./types";

export type SqlQuery = <T>(text: string, values: unknown[]) => Promise<T[]>;
export type StoredConnection = {
  id: string; orgId: string; userId: string; channelId: string; status: string;
  accessTokenCiphertext: string | null; refreshTokenCiphertext: string | null;
  tokenExpiresAt: Date | null;
};

/** Shared Postgres implementation; Prisma and pg supply the query adapter. */
export function createConnectionStore(query: SqlQuery) {
  const ids = (scope: ConnectionScope) => [scope.connectionId, scope.orgId, scope.userId];
  return {
    async get(scope: ConnectionScope) {
      return (await query<StoredConnection>(`SELECT id, "orgId", "userId", "channelId", status,
        "accessTokenCiphertext", "refreshTokenCiphertext", "tokenExpiresAt"
        FROM "YouTubeConnection" WHERE id = $1 AND "orgId" = $2 AND "userId" = $3`, ids(scope)))[0] ?? null;
    },
    async acquire(scope: ConnectionScope, leaseId: string) {
      const rows = await query<{ id: string }>(`UPDATE "YouTubeConnection"
        SET "refreshLeaseId" = $4, "refreshLeaseExpiresAt" = NOW() + INTERVAL '40 seconds'
        WHERE id = $1 AND "orgId" = $2 AND "userId" = $3 AND status = 'active'
        AND ("refreshLeaseExpiresAt" IS NULL OR "refreshLeaseExpiresAt" < NOW()) RETURNING id`, [...ids(scope), leaseId]);
      return rows.length === 1;
    },
    async save(scope: ConnectionScope, leaseId: string, access: string, refresh: string | null, expiresAt: Date) {
      return (await query<{ id: string }>(`UPDATE "YouTubeConnection" SET "accessTokenCiphertext" = $5,
        "refreshTokenCiphertext" = COALESCE($6, "refreshTokenCiphertext"), "tokenExpiresAt" = $7,
        "refreshLeaseId" = NULL, "refreshLeaseExpiresAt" = NULL, "updatedAt" = NOW()
        WHERE id = $1 AND "orgId" = $2 AND "userId" = $3 AND "refreshLeaseId" = $4
        AND status = 'active' AND "refreshLeaseExpiresAt" > NOW() RETURNING id`, [...ids(scope), leaseId, access, refresh, expiresAt])).length === 1;
    },
    async release(scope: ConnectionScope, leaseId: string) {
      await query(`UPDATE "YouTubeConnection" SET "refreshLeaseId" = NULL, "refreshLeaseExpiresAt" = NULL
        WHERE id = $1 AND "orgId" = $2 AND "userId" = $3 AND "refreshLeaseId" = $4 RETURNING id`, [...ids(scope), leaseId]);
    },
    async requireReconnect(scope: ConnectionScope, leaseId: string) {
      await query(`UPDATE "YouTubeConnection" SET status = 'reconnect_required', "updatedAt" = NOW()
        WHERE id = $1 AND "orgId" = $2 AND "userId" = $3 AND "refreshLeaseId" = $4
        AND status = 'active' RETURNING id`, [...ids(scope), leaseId]);
    },
    async expire(scope: ConnectionScope, ciphertext: string) {
      await query(`UPDATE "YouTubeConnection" SET "tokenExpiresAt" = NOW()
        WHERE id = $1 AND "orgId" = $2 AND "userId" = $3 AND "accessTokenCiphertext" = $4
        AND status = 'active' RETURNING id`, [...ids(scope), ciphertext]);
    },
  };
}
export type ConnectionStore = ReturnType<typeof createConnectionStore>;
