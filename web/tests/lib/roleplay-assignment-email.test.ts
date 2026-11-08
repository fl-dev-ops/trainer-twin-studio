import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

type Delivery = { to: string; subject: string; html: string; text: string };

describe("sendRolePlayAssignmentEmail content", () => {
  const originalKey = process.env.RESEND_API_KEY;
  let send: typeof import("@/lib/email").sendRolePlayAssignmentEmail;
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  let deliveries: Delivery[];
  const input = {
    to: "learner@example.com",
    rolePlayName: "Customer support",
    practiceUrl: "https://example.com/s/personal-link",
  };

  beforeAll(async () => {
    // The key must exist before email.ts constructs its Resend client; no request leaves this process.
    process.env.RESEND_API_KEY = "re_test_roleplay_email";
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://api.resend.com/emails");
      deliveries.push(JSON.parse(String(init?.body)) as Delivery);
      return Response.json({ id: "test-delivery" });
    });
    ({ sendRolePlayAssignmentEmail: send } = await import("@/lib/email"));
  });
  beforeEach(() => { deliveries = []; });
  afterAll(() => {
    fetchSpy?.mockRestore();
    if (originalKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalKey;
  });

  test.each([30, 0])("includes %i minutes, the sign-in email and default trainer in HTML and text", async (minutes) => {
    expect(await send({ ...input, minutes })).toMatchObject({ success: true });
    expect(deliveries).toHaveLength(1);
    const { html, text, subject, to } = deliveries[0];
    expect(to).toBe(input.to);
    expect(subject).toBe("New Role Play Assigned: Customer support");
    expect(html).toContain(`You have <strong>${minutes} minutes</strong> of practice, and can do this role play as many times as you like while they last.`);
    expect(text).toContain(`You have ${minutes} minutes of practice, and can do this role play as many times as you like while they last.`);
    expect(html).toContain(`sign in with <strong>${input.to}</strong>`);
    expect(text).toContain(`Sign in with ${input.to}`);
    expect(html).toContain("<strong>Your trainer</strong> has assigned you the <strong>Customer support</strong> role play.");
    expect(text).toContain('Your trainer has assigned you the "Customer support" role play');
    for (const content of [html, text]) {
      expect(content).toContain(input.practiceUrl);
      expect(content).not.toMatch(/interview|Vasanth/i);
    }
  });

  test("omits the minutes sentence when minutes are unknown", async () => {
    expect(await send(input)).toMatchObject({ success: true });
    expect(deliveries).toHaveLength(1);
    for (const content of [deliveries[0].html, deliveries[0].text]) {
      expect(content).not.toContain("minutes");
      expect(content).not.toContain("as many times as you like");
    }
  });

  test("escapes names, objective, what-to-bring and sign-in email in HTML, not plain text", async () => {
    const rolePlayName = '<Sales & "support">';
    const userName = '<Learner & "Lee">';
    const trainerName = '<Trainer & "Tess">';
    const objective = '<Resolve & "retain">';
    const prompt = '<Bring & "review" your client\'s notes>';
    const to = 'learner&"test"@example.com';
    expect(await send({ ...input, to, rolePlayName, userName, trainerName, rolePlayObjective: objective, requiredArtifact: { label: "Notes", prompt } })).toMatchObject({ success: true });
    expect(deliveries).toHaveLength(1);
    const { html, text, subject } = deliveries[0];
    for (const [raw, escaped] of [
      [rolePlayName, "&lt;Sales &amp; &quot;support&quot;&gt;"],
      [userName, "&lt;Learner &amp; &quot;Lee&quot;&gt;"],
      [trainerName, "&lt;Trainer &amp; &quot;Tess&quot;&gt;"],
      [objective, "&lt;Resolve &amp; &quot;retain&quot;&gt;"],
      [prompt, "&lt;Bring &amp; &quot;review&quot; your client&#39;s notes&gt;"],
      [to, "learner&amp;&quot;test&quot;@example.com"],
    ]) {
      expect(html).toContain(escaped);
      expect(html).not.toContain(raw);
    }
    expect(html).toContain(`<title>New Role Play Assigned: &lt;Sales &amp; &quot;support&quot;&gt;</title>`);
    expect(html).toContain('content="You have been assigned to practice &quot;&lt;Sales &amp; &quot;support&quot;&gt;&quot; on TrainerTwin."');
    expect(subject).toBe(`New Role Play Assigned: ${rolePlayName}`);
    for (const raw of [rolePlayName, trainerName, prompt, to]) expect(text).toContain(raw);
    expect(text).not.toMatch(/&lt;|&amp;|&quot;|&#39;/);
  });
});
