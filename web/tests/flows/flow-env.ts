// Import first in a flow file: lib/email reads RESEND_API_KEY when it loads, and flows check the emails that go out
// (answered by tests/flows/harness.ts, never sent).
process.env.RESEND_API_KEY = "re_test_flows";
