import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  AdminClient,
  ChromaConnectionError,
  ChromaForbiddenError,
  ChromaNotFoundError,
  ChromaQuotaExceededError,
  ChromaServerError,
  ChromaUnauthorizedError,
  ChromaUniqueError,
} from "chromadb";
import type { Organization } from "@/lib/generated/prisma/client";

const findOrganization = mock(async (): Promise<Organization | null> => null);
const updateOrganization = mock(async (): Promise<Organization | null> => null);
mock.module("@/lib/db", () => ({
  db: { organization: { findUnique: findOrganization, update: updateOrganization } },
}));
const { ChromaTenantService, orgDatabaseName } = await import("@/lib/chroma-tenant");

const tenant = process.env.CHROMA_TENANT ?? "default_tenant";
const orgId = "sharedskills-live-chroma-provisioning-unit";
const database = orgDatabaseName(orgId);
const target = { name: database, tenant };
const databaseRecord = { id: "provisioned-database-id", ...target };
const failures = [
  ["quota", new ChromaQuotaExceededError("Database quota exceeded")],
  ["unauthorized", new ChromaUnauthorizedError("Invalid credentials")],
  ["forbidden", new ChromaForbiddenError("Insufficient permissions")],
  ["connection", new ChromaConnectionError("Connection failed")],
  ["server", new ChromaServerError("Provider unavailable")],
] as const;

function fixture() {
  const org: Organization = {
    id: orgId, slug: orgId, name: "Provisioning unit fixture", createdAt: new Date("2026-11-19T00:00:00Z"),
    logo: null, websiteUrl: null, metadata: null, chromaTenantId: null, chromaDatabase: "default",
  };
  const find = findOrganization.mockReset().mockResolvedValue(org);
  const update = updateOrganization.mockReset().mockResolvedValue({
    ...org, chromaTenantId: tenant, chromaDatabase: database,
  });
  const get = spyOn(AdminClient.prototype, "getDatabase").mockResolvedValue(databaseRecord);
  const create = spyOn(AdminClient.prototype, "createDatabase").mockResolvedValue(undefined);
  return { org, find, update, get, create };
}

describe("Chroma organization database provisioning", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => { f = fixture(); });
  afterEach(() => {
    for (const spy of [f.create, f.get, f.update, f.find]) spy.mockRestore();
  });

  function expectPersisted() {
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.update).toHaveBeenCalledWith({
      where: { id: orgId }, data: { chromaTenantId: tenant, chromaDatabase: database },
    });
  }

  function expectNotPersisted() {
    expect(f.update).not.toHaveBeenCalled();
    expect(f.org.chromaTenantId).toBeNull();
    expect(f.org.chromaDatabase).toBe("default");
  }

  test("already recorded deterministic database requires no provider calls or writes", async () => {
    f.find.mockResolvedValue({ ...f.org, chromaTenantId: tenant, chromaDatabase: database });
    expect(await ChromaTenantService.createOrgDatabase(orgId)).toEqual({ tenantId: tenant, database });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });

  test("existing provider database is recorded without creating it", async () => {
    expect(await ChromaTenantService.createOrgDatabase(orgId)).toEqual({ tenantId: tenant, database });
    expect(f.get.mock.calls).toEqual([[target]]);
    expect(f.create).not.toHaveBeenCalled();
    expectPersisted();
  });

  test("native not-found creates only the deterministic organization database", async () => {
    f.get.mockRejectedValueOnce(new ChromaNotFoundError("Database absent"));
    expect(await ChromaTenantService.createOrgDatabase(orgId)).toEqual({ tenantId: tenant, database });
    expect(f.get.mock.calls).toEqual([[target]]);
    expect(f.create.mock.calls).toEqual([[target]]);
    expectPersisted();
  });

  test("native unique conflict recovers a concurrent create by re-reading the exact database", async () => {
    f.get.mockRejectedValueOnce(new ChromaNotFoundError("Database absent"));
    f.create.mockRejectedValueOnce(new ChromaUniqueError("Concurrent create won"));
    expect(await ChromaTenantService.createOrgDatabase(orgId)).toEqual({ tenantId: tenant, database });
    expect(f.get.mock.calls).toEqual([[target], [target]]);
    expect(f.create.mock.calls).toEqual([[target]]);
    expectPersisted();
  });

  test.each(failures)("lookup %s failure is preserved without create or pointer persistence", async (_name, error) => {
    f.get.mockRejectedValueOnce(error);
    await expect(ChromaTenantService.createOrgDatabase(orgId)).rejects.toBe(error);
    expect(f.get.mock.calls).toEqual([[target]]);
    expect(f.create).not.toHaveBeenCalled();
    expectNotPersisted();
  });

  test.each(failures)("create %s failure is preserved without a misleading read or pointer persistence", async (_name, error) => {
    f.get.mockRejectedValueOnce(new ChromaNotFoundError("Database absent"));
    f.create.mockRejectedValueOnce(error);
    await expect(ChromaTenantService.createOrgDatabase(orgId)).rejects.toBe(error);
    expect(f.get.mock.calls).toEqual([[target]]);
    expect(f.create.mock.calls).toEqual([[target]]);
    expectNotPersisted();
  });

  test("failed concurrent-create verification preserves its original error and does not persist a pointer", async () => {
    const error = new ChromaNotFoundError("Concurrent database is not visible");
    f.get.mockRejectedValueOnce(new ChromaNotFoundError("Database absent")).mockRejectedValueOnce(error);
    f.create.mockRejectedValueOnce(new ChromaUniqueError("Concurrent create won"));
    await expect(ChromaTenantService.createOrgDatabase(orgId)).rejects.toBe(error);
    expect(f.get.mock.calls).toEqual([[target], [target]]);
    expect(f.create.mock.calls).toEqual([[target]]);
    expectNotPersisted();
  });

  test("an error named not-found is not treated as the native SDK error", async () => {
    const error = new Error("Unrelated lookup failure");
    error.name = "ChromaNotFoundError";
    f.get.mockRejectedValueOnce(error);
    await expect(ChromaTenantService.createOrgDatabase(orgId)).rejects.toBe(error);
    expect(f.create).not.toHaveBeenCalled();
    expectNotPersisted();
  });

  test("an error named unique is not treated as a native concurrent-create conflict", async () => {
    const error = new Error("Unrelated create failure");
    error.name = "ChromaUniqueError";
    f.get.mockRejectedValueOnce(new ChromaNotFoundError("Database absent"));
    f.create.mockRejectedValueOnce(error);
    await expect(ChromaTenantService.createOrgDatabase(orgId)).rejects.toBe(error);
    expect(f.get.mock.calls).toEqual([[target]]);
    expectNotPersisted();
  });

  test("missing organization never contacts the provider or persists a pointer", async () => {
    f.find.mockResolvedValueOnce(null);
    await expect(ChromaTenantService.createOrgDatabase(orgId)).rejects.toThrow("not found");
    expect(f.get).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expectNotPersisted();
  });
});
