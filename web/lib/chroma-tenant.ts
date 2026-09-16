import { AdminClient, AdminCloudClient, ChromaClient, CloudClient } from "chromadb";
import { db } from "@/lib/db";
import { invalidateCollectionCache } from "@/lib/main-collection";
import { interviewQuestionOrgDatabaseName } from "@shared/interview-question";

export { AdminClient as ChromaAdminClient };

const clientCache = new Map<string, ChromaClient>();

const CHROMA_URL = process.env.CHROMA_URL;
const CHROMA_API_KEY = process.env.CHROMA_API_KEY ?? "";
const CHROMA_TENANT = process.env.CHROMA_TENANT ?? "default_tenant";

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
  return interviewQuestionOrgDatabaseName(orgId);
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
    clientCache.delete(orgId);
    invalidateCollectionCache(orgId); // keep the MainCollectionService handle cache coherent
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
      data: { chromaTenantId: null, chromaDatabase: database },
    });
  }

  /**
   * Returns a ChromaClient or CloudClient scoped to the organization's tenant and database.
   * Clients are cached per org in-process; constructing a client is cheap but the
   * org lookup + auth handshake repeated per search are not (Chroma docs: reuse one client).
   */
  static async getClient(orgId: string): Promise<ChromaClient> {
    // ponytail: unbounded Map — one entry per active org; per-org DB validation skipped after first resolve.
    const cached = clientCache.get(orgId);
    if (cached) return cached;
    let org = await db.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new Error(`Organization ${orgId} not found`);

    const expectedDatabase = orgDatabaseName(orgId);
    if (org.chromaTenantId !== CHROMA_TENANT || org.chromaDatabase !== expectedDatabase) {
      const provisioned = await this.createOrgDatabase(orgId);
      org = { ...org, chromaTenantId: provisioned.tenantId, chromaDatabase: provisioned.database };
    }

    const tenant = org.chromaTenantId ?? CHROMA_TENANT;
    const database = org.chromaDatabase ?? expectedDatabase;

    let client: ChromaClient;
    if (CHROMA_URL) {
      client = new ChromaClient({ ...parseChromaUrl(CHROMA_URL), tenant, database });
    } else if (CHROMA_API_KEY) {
      client = new CloudClient({ apiKey: CHROMA_API_KEY, tenant, database });
    } else {
      client = new ChromaClient({ ...parseChromaUrl("http://localhost:8000"), tenant, database });
    }
    clientCache.set(orgId, client);
    return client;
  }
}
