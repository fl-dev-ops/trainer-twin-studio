import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as minutes from "@/lib/minutes";
import * as delivery from "@/lib/schedule-invite-emails";
import { emailAssignment } from "@/lib/external-api-assignments";

let balance: ReturnType<typeof spyOn<typeof minutes, "learnerBalance">>;
let send: ReturnType<typeof spyOn<typeof delivery, "deliverInviteEmail">>;
const input = { orgId: "org", idempotencyKey: "assignment:1:share-code", to: "learner@example.com", scenario: { name: "Pitch", data: { objective: "Make a pitch" } }, practiceUrl: "https://example.com/s/share-code", trainerName: "Trainer" };
beforeEach(() => {
  balance = spyOn(minutes, "learnerBalance").mockResolvedValue({ balanceSeconds: 359 } as never);
  send = spyOn(delivery, "deliverInviteEmail").mockResolvedValue({ sent: true });
});
afterEach(() => { balance.mockRestore(); send.mockRestore(); });

test("emailAssignment delivers a roleplay email with its stable assignment key and floored balance", async () => {
  expect(await emailAssignment(input)).toBe(true);
  expect(balance).toHaveBeenCalledWith("org", "learner@example.com");
  expect(send).toHaveBeenCalledWith({ kind: "roleplay", idempotencyKey: input.idempotencyKey, args: { to: input.to, userName: undefined, rolePlayName: "Pitch", rolePlayObjective: "Make a pitch", practiceUrl: input.practiceUrl, trainerName: "Trainer", requiredArtifact: null, minutes: 5 } });
});

test("emailAssignment returns the immediate sent result, not confirmation of a queued retry", async () => {
  send.mockResolvedValue({ sent: false });
  balance.mockResolvedValue({ balanceSeconds: -60 } as never);
  expect(await emailAssignment(input)).toBe(false);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: input.idempotencyKey, args: expect.objectContaining({ minutes: 0 }) }));
});
