import { describe, expect, it, vi } from "vitest";
import {
  INBOUND_WEBHOOK_RESOLVED_EVENT_RECOVERY_WINDOW_MS,
  InboundWebhookProductionIntakeService,
} from "../../src/inbound-webhooks/inbound-webhook-production-intake.service";

vi.mock("../../src/config/deployment-config", () => ({
  parseInboundWebhooksConfig: () => ({
    enabled: true,
    productionEnabled: true,
    conversionRulesEnabled: false,
    conversionProductionEnabled: false,
  }),
}));

const env = {};

function build(stuck: Array<Record<string, string>>) {
  const findMany = vi.fn().mockResolvedValue(stuck);
  const prisma = {
    inboundWebhookProductionItem: { findMany: vi.fn().mockResolvedValue([]) },
    inboundWebhookEvent: { findMany },
    providerConversionRuleExecution: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  const service = new InboundWebhookProductionIntakeService(
    prisma as never,
    { enqueueItem: vi.fn() } as never,
    env as never,
  );
  return { service, findMany };
}

describe("recovery of re-evaluated entries", () => {
  it("re-enqueues a resolved event that never got a production item", async () => {
    const stuck = {
      workspaceId: "w1",
      connectionId: "c1",
      deliveryId: "d1",
    };
    const { service, findMany } = build([stuck]);
    const enqueue = vi.spyOn(service, "enqueueDelivery").mockResolvedValue({
      eligible: 1,
      persisted: 1,
      queued: 1,
      existing: 0,
      queueFailures: 0,
      providerEligible: 0,
      providerQueued: 0,
      providerExisting: 0,
      providerQueueFailures: 0,
    });
    const now = new Date("2026-11-21T12:00:00.000Z");

    const result = await service.recoverPendingItems(now);

    expect(enqueue).toHaveBeenCalledWith(stuck);
    expect(result.queued).toBe(1);
    const where = findMany.mock.calls[0][0].where;
    expect(where.classification).toBe("eligible_route_resolved");
    expect(where.productionItem).toBeNull();
    expect(where.replayItem).toBeNull();
    expect(where.occurredAt.gte).toEqual(
      new Date(
        now.getTime() - INBOUND_WEBHOOK_RESOLVED_EVENT_RECOVERY_WINDOW_MS,
      ),
    );
  });

  it("keeps recovering the next delivery when one fails", async () => {
    const { service } = build([
      { workspaceId: "w1", connectionId: "c1", deliveryId: "d1" },
      { workspaceId: "w1", connectionId: "c1", deliveryId: "d2" },
    ]);
    const enqueue = vi
      .spyOn(service, "enqueueDelivery")
      .mockRejectedValueOnce(new Error("redis"))
      .mockResolvedValueOnce({
        eligible: 1,
        persisted: 1,
        queued: 1,
        existing: 0,
        queueFailures: 0,
        providerEligible: 0,
        providerQueued: 0,
        providerExisting: 0,
        providerQueueFailures: 0,
      });

    const result = await service.recoverPendingItems(new Date());

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(result.queueFailures).toBe(1);
    expect(result.queued).toBe(1);
  });
});
