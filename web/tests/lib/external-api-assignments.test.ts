import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as minutes from "@/lib/minutes";
import * as delivery from "@/lib/queue-emails";
import * as personEmail from "@/lib/invite/person-email";
import { signInUrl } from "@/lib/invite/links";
import { emailAssignment } from "@/lib/external-api-assignments";
import type { AddedPerson } from "@/lib/org-people";

const person = (fields: Partial<AddedPerson> = {}): AddedPerson => ({
  memberId: "m1", userId: "u1", name: "Learner", email: "learner@example.com", image: null, role: "user",
  disabled: false, disabledAt: null, addedAt: new Date(), added: false, startingCredits: 0, ...fields,
});
const input = (p = person()) => ({
  org: { id: "org", slug: "acme" }, idempotencyKey: "assignment:1:share-code", person: p,
  scenario: { name: "Pitch", data: { objective: "Make a pitch" } }, practiceUrl: "https://acme.example.com/s/share-code", trainerName: "Trainer",
});
let spies: { mockRestore(): void }[] = [];
let balance: ReturnType<typeof spyOn<typeof minutes, "learnerBalance">>;
let send: ReturnType<typeof spyOn<typeof delivery, "deliverEmail">>;
beforeEach(() => {
  balance = spyOn(minutes, "learnerBalance").mockResolvedValue({ balanceSeconds: 359 } as never);
  send = spyOn(delivery, "deliverEmail").mockResolvedValue({ sent: true });
  spies = [balance, send, spyOn(personEmail, "orgName").mockResolvedValue("Acme")];
});
afterEach(() => { for (const spy of spies) spy.mockRestore(); });

test("an existing learner gets one role-play email keyed by the assignment, with the floored balance", async () => {
  expect(await emailAssignment(input())).toBe(true);
  expect(balance).toHaveBeenCalledWith("org", "learner@example.com");
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({
    kind: "person", idempotencyKey: "assignment:1:share-code",
    args: {
      to: "learner@example.com", orgName: "Acme", byName: "Trainer",
      roleplay: { name: "Pitch", url: "https://acme.example.com/s/share-code", objective: "Make a pitch", requiredArtifact: null },
      credits: { added: undefined, balance: 5 },
    },
  });
});

test("someone added just now gets the same single email with 'added' and their starting credits", async () => {
  await emailAssignment(input(person({ added: true, startingCredits: 30 })));
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].args).toMatchObject({ added: { role: "user", signInUrl: signInUrl("user", "acme") }, credits: { added: 30, balance: 5 } });
});

test("returns whether it went now (a queued retry is not 'sent'); a negative balance shows 0", async () => {
  send.mockResolvedValue({ sent: false });
  balance.mockResolvedValue({ balanceSeconds: -60 } as never);
  expect(await emailAssignment(input())).toBe(false);
  expect(send.mock.calls[0][0].args).toMatchObject({ credits: { balance: 0 } });
});
