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

export class ChromaTenantService {
  /**
   * Automatically creates or provisions a Chroma tenant/database for an organization
   * and records it in PostgreSQL.
   */
  static async createTenant(orgId: string): Promise<{ tenantId: string; database: string }> {
    const org = await db.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new Error(`Organization ${orgId} not found`);

    if (org.chromaTenantId && org.chromaDatabase) {
      return { tenantId: org.chromaTenantId, database: org.chromaDatabase };
    }

    const admin = getAdminClient();
    const candidateTenant = `org_${orgId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const candidateDatabase = "default";
    const orgDbName = `org_${orgId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

    let assignedTenant = candidateTenant;
    let assignedDatabase = candidateDatabase;

    try {
      // 1. Try creating a dedicated Chroma tenant
      await admin.createTenant({ name: candidateTenant });
      try {
        await admin.createDatabase({ name: candidateDatabase, tenant: candidateTenant });
      } catch (dbError) {
        // Database may already exist or default database might be auto-created
        const msg = String(dbError).toLowerCase();
        if (!msg.includes("already exists") && !msg.includes("unique")) {
          console.warn(`Database creation notice for ${candidateTenant}:`, dbError);
        }
      }
    } catch (tenantError) {
      // If tenant creation is restricted (e.g. Chroma Cloud fixed tenant),
      // try creating a database inside the authorized cloud tenant.
      const errorMsg = String(tenantError);
      console.warn(`Dedicated tenant creation unavailable (${candidateTenant}): ${errorMsg}`);

      const cloudTenant = CHROMA_TENANT;
      try {
        await admin.createDatabase({ name: orgDbName, tenant: cloudTenant });
        assignedTenant = cloudTenant;
        assignedDatabase = orgDbName;
      } catch (dbError) {
        // If creating arbitrary databases is also restricted by Cloud plan,
        // use the configured tenant and database as the parent scope.
        console.warn(`Dedicated database creation unavailable (${orgDbName}): ${dbError}`);
        assignedTenant = cloudTenant;
        assignedDatabase = CHROMA_DATABASE;
      }
    }

    await db.organization.update({
      where: { id: orgId },
      data: {
        chromaTenantId: assignedTenant,
        chromaDatabase: assignedDatabase,
      },
    });

    const isolationMode = assignedTenant === candidateTenant
      ? "dedicated-tenant"
      : assignedDatabase === orgDbName
        ? "dedicated-database"
        : "shared-fallback";

    console.info(`[ChromaTenantService] Finalized org ${orgId} ("${org.name}"): isolation=${isolationMode}, tenant=${assignedTenant}, database=${assignedDatabase}`);

    return { tenantId: assignedTenant, database: assignedDatabase };
  }

  /**
   * Deletes an organization's Chroma tenant / database when the org is removed.
   */
  static async deleteTenant(orgId: string): Promise<void> {
    const org = await db.organization.findUnique({ where: { id: orgId } });
    if (!org || !org.chromaTenantId) return;

    const admin = getAdminClient();
    try {
      if (org.chromaTenantId !== CHROMA_TENANT) {
        // In self-hosted or full-admin mode, delete the database if applicable
        if (org.chromaDatabase && org.chromaDatabase !== CHROMA_DATABASE) {
          try {
            await admin.deleteDatabase({ name: org.chromaDatabase, tenant: org.chromaTenantId });
          } catch {
            // best-effort cleanup
          }
        }
      }
    } catch (error) {
      console.warn(`Chroma cleanup error for org ${orgId}:`, error);
    }

    await db.organization.update({
      where: { id: orgId },
      data: { chromaTenantId: null, chromaDatabase: "default" },
    });
  }

  /**
   * Returns a ChromaClient or CloudClient scoped to the organization's tenant and database.
   */
  static async getClient(orgId: string): Promise<ChromaClient> {
    let org = await db.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new Error(`Organization ${orgId} not found`);

    if (!org.chromaTenantId) {
      const provisioned = await this.createTenant(orgId);
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
