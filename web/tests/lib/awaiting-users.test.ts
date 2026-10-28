import { expect, test } from "bun:test";
import { awaitingUsers } from "@/lib/awaiting-users";

test("people assigned by email who aren't members or invited yet, grouped with what they got", () => {
  expect(awaitingUsers({
    memberEmails: ["olga@x.com", "Joined@x.com"],
    invitedEmails: ["invited@x.com"],
    assignments: [
      { email: "Cathy@foreeverlearning.in", title: "Objections & silent clients" },
      { email: "cathy@foreeverlearning.in", title: "Wait-and-see investor" },
      { email: "cathy@foreeverlearning.in", title: "Objections & silent clients" },
      { email: "joined@x.com", title: "Objections & silent clients" },
      { email: "invited@x.com", title: "Wait-and-see investor" },
    ],
  })).toEqual([{ email: "cathy@foreeverlearning.in", assigned: ["Objections & silent clients", "Wait-and-see investor"] }]);
});
