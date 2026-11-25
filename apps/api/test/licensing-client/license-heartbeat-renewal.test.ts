import { generateKeyPairSync, type KeyLike } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signCompactToken, type LicenseCachePayload } from "../../src/licensing-client/compact-token";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { LicenseHeartbeatProcessor } from "../../src/licensing-client/license-heartbeat.processor";
import type { LicenseActionResult } from "../../src/licensing-client/license-client.types";
import { createFakePrisma } from "./support";

const env = {
  LICENSE_SERVER_URL: "https://license.test",
  LICENSE_KEY: "student-key-123",
  LICENSE_ACCOUNT_IDENTITY: "student@example.com",
};

function activeResult(privateKey: KeyLike): LicenseActionResult {
  const now = Math.floor(Date.now() / 1000);
  const validUntil = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const payload: LicenseCachePayload = {
    status: "active",
    softLock: false,
    hardLock: false,
    expiresAt,
    validUntil,
    iat: now,
    exp: now + 72 * 60 * 60,
  } as LicenseCachePayload;
  return {
    status: "active",
    softLock: false,
    hardLock: false,
    usable: true,
    bound: true,
    keyPrefix: "RTD-1234",
    expiresAt,
    validUntil,
    interval: "annual",
    cacheToken: signCompactToken(payload, privateKey),
  } as LicenseActionResult;
}

describe("license heartbeat renewal", () => {
  let privateKey: KeyLike;
  let publicKeyPem: string;

  beforeEach(() => {
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  });

  const stalePrisma = () =>
    createFakePrisma({
      status: "active",
      fingerprint: "fp-1",
      accountIdentity: "student@example.com",
      licenseKeyPrefix: "RTD-1234",
      cacheValidUntil: new Date(Date.now() - 60_000),
      lastCheckedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

  function router(activate: () => Response): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/license/public-key") return Response.json({ alg: "Ed25519", publicKey: publicKeyPem });
      if (path === "/license/heartbeat") return new Response("too many", { status: 429 });
      if (path === "/license/activate") return activate();
      throw new Error(`unhandled ${path}`);
    }) as typeof fetch;
  }

  it("renews through activation when the heartbeat answers 429", async () => {
    const { prisma, getRow } = stalePrisma();
    const before = getRow()?.lastCheckedAt?.getTime() ?? 0;
    const service = new LicenseClientService(prisma, env, router(() => Response.json(activeResult(privateKey))));

    const state = await service.heartbeat();

    expect(state.status).toBe("active");
    expect(getRow()?.lastCheckedAt?.getTime()).toBeGreaterThan(before);
  });

  it("keeps grace and records the heartbeat error when activation also fails", async () => {
    const { prisma, getRow } = stalePrisma();
    const service = new LicenseClientService(prisma, env, router(() => new Response("too many", { status: 429 })));

    const state = await service.heartbeat();

    expect(state.status).toBe("grace");
    expect(getRow()?.status).toBe("active");
    expect(getRow()?.lastError).toContain("license_heartbeat_failed:429");
  });

  it("waits a bounded random delay before each heartbeat", async () => {
    vi.useFakeTimers();
    try {
      const heartbeat = vi.fn().mockResolvedValue(undefined);
      const processor = new LicenseHeartbeatProcessor({ heartbeat } as unknown as LicenseClientService);
      const running = processor.process({} as never);
      expect(heartbeat).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      await running;
      expect(heartbeat).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
