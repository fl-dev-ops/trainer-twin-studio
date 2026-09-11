import { AdminClient, AdminCloudClient, ChromaClient, CloudClient } from "chromadb";
import { db } from "@/lib/db";

export { AdminClient as ChromaAdminClient };

const CHROMA_URL = process.env.CHROMA_URL;
const CHROMA_API_KEY = process.env.CHROMA_API_KEY ?? "";
const CHROMA_TENANT = process.env.CHROMA_TENANT ?? "default_tenant";
const CHROMA_DATABASE = process.env.CHROMA_DATABASE ?? "default_database";

/**
 * Controls whether Chroma operates with dedicated per-org tenant/database isolation
 * (e.g. self-hosted Chroma or Chroma Cloud Enterprise with tenant admin credentials)
 * vs. shared database scope with collection-level namespacing (e.g. standard Chroma Cloud).
 */
export const USE_DEDICATED_TENANT = Boolean(
  process.env.CHROMA_URL || process.env.CHROMA_CLOUD_MODE === "dedicated"
);

/**
 * Checks if the given Chroma client is operating inside a shared database fallback.
 */
export function isSharedScope(clientDatabase?: string): boolean {
  if (USE_DEDICATED_TENANT) return false;
  const configuredDb = process.env.CHROMA_DATABASE ?? "default_database";
  return !clientDatabase || clientDatabase === configuredDb;
}

export function parseChromaUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || (u.protocol === "https:" ? 443 : 8000),
    ssl: u.protocol === "https:",
  };
}

export function getAdminClient(): AdminClient {
  if (CHROMA_URL) {
    return new AdminClient(parseChromaUrl(CHROMA_URL));
  }
  if (CHROMA_API_KEY) {
    return new AdminCloudClient({ apiKey: CHROMA_API_KEY });
  }
  return new AdminClient(parseChromaUrl("http://localhost:8000"));
}

export function orgDatabaseName(orgId: string): string {
  return `org_${orgId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export class ChromaTenantService {
  /** Provisions one database per immutable organization ID in the configured account/tenant. */
  static async createOrgDatabase(orgId: string): Promise<{ tenantId: string; database: string }> {
    const org = await db.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new Error(`Organization ${orgId} not found`);

    const database = orgDatabaseName(orgId);
    if (org.chromaTenantId === CHROMA_TENANT && org.chromaDatabase === database) {
      return { tenantId: CHROMA_TENANT, database };
    }

    const admin = getAdminClient();
    try {
      await admin.getDatabase({ name: database, tenant: CHROMA_TENANT });
    } catch {
      try {
        await admin.createDatabase({ name: database, tenant: CHROMA_TENANT });
      } catch {
        // A concurrent request may have created it after the lookup.
        await admin.getDatabase({ name: database, tenant: CHROMA_TENANT });
      }
    }

    await db.organization.update({
      where: { id: orgId },
      data: { chromaTenantId: CHROMA_TENANT, chromaDatabase: database },
    });

    console.info(`[ChromaTenantService] Provisioned org ${orgId}: tenant=${CHROMA_TENANT}, database=${database}`);
    return { tenantId: CHROMA_TENANT, database };
  }

  /** Deletes only the database deterministically owned by this organization. */
  static async deleteOrgDatabase(orgId: string): Promise<void> {
    const org = await db.organization.findUnique({ where: { id: orgId } });
    if (!org) return;

    const database = orgDatabaseName(orgId);
    try {
      await getAdminClient().deleteDatabase({ name: database, tenant: CHROMA_TENANT });
    } catch (error) {
      console.warn(`Chroma cleanup error for org ${orgId}:`, error);
    }

    await db.organization.update({
      where: { id: orgId },
      data: { chromaTenantId: null, chromaDatabase: CHROMA_DATABASE },
    });
  }

  /**
   * Returns a ChromaClient or CloudClient scoped to the organization's tenant and database.
   */
  static async getClient(orgId: string): Promise<ChromaClient> {
    let org = await db.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new Error(`Organization ${orgId} not found`);

    const expectedDatabase = orgDatabaseName(orgId);
    if (org.chromaTenantId !== CHROMA_TENANT || org.chromaDatabase !== expectedDatabase) {
      const provisioned = await this.createOrgDatabase(orgId);
      org = { ...org, chromaTenantId: provisioned.tenantId, chromaDatabase: provisioned.database };
    }

    const tenant = org.chromaTenantId ?? CHROMA_TENANT;
    const database = org.chromaDatabase ?? CHROMA_DATABASE;

    if (CHROMA_URL) {
      return new ChromaClient({ ...parseChromaUrl(CHROMA_URL), tenant, database });
    }
    if (CHROMA_API_KEY) {
      return new CloudClient({ apiKey: CHROMA_API_KEY, tenant, database });
    }
    return new ChromaClient({ ...parseChromaUrl("http://localhost:8000"), tenant, database });
  }
}
