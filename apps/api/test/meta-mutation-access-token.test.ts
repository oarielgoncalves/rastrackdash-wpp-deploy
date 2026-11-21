import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { MetaReportingService } from "../src/reporting/meta-reporting.service";

function build(input: {
  account: { id: string; businessConnectionId: string | null } | null;
  legacy?: Record<string, string> | null;
}) {
  const service = Object.create(MetaReportingService.prototype) as any;
  const resolveReportingRoute = vi.fn(async () => ({
    accessToken: "normalized-token",
  }));
  const decrypt = vi.fn(() => "legacy-token");
  service.prisma = {
    metaReportingAccount: { findFirst: vi.fn(async () => input.account) },
    metaIntegration: { findUnique: vi.fn(async () => input.legacy ?? null) },
  };
  service.connectionResolver = { resolveReportingRoute };
  service.encryption = { decrypt };
  return { service, resolveReportingRoute, decrypt };
}

describe("metaMutationAccessToken", () => {
  it("uses the account's normalized connection without a legacy row", async () => {
    const { service, resolveReportingRoute } = build({
      account: { id: "acc", businessConnectionId: "bc" },
    });

    await expect(
      service.metaMutationAccessToken("ws", "act_1"),
    ).resolves.toBe("normalized-token");
    expect(resolveReportingRoute).toHaveBeenCalledWith({
      workspaceId: "ws",
      reportingAccountId: "acc",
      adAccountId: "act_1",
      businessConnectionId: "bc",
    });
  });

  it("keeps the legacy token for accounts without a connection", async () => {
    const { service, resolveReportingRoute } = build({
      account: { id: "acc", businessConnectionId: null },
      legacy: { encryptedAccessToken: "e", tokenIv: "i", tokenTag: "t" },
    });

    await expect(
      service.metaMutationAccessToken("ws", "act_1"),
    ).resolves.toBe("legacy-token");
    expect(resolveReportingRoute).not.toHaveBeenCalled();
  });

  it("still reports a missing connection when neither exists", async () => {
    const { service } = build({
      account: { id: "acc", businessConnectionId: null },
    });

    await expect(
      service.metaMutationAccessToken("ws", "act_1"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
