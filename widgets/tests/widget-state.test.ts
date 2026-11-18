import { describe, expect, test } from "bun:test";
import { callStartError, parseConfig, parseSession, remainingCallMs, visitorName } from "../src/widget";

const config = {
  agentId: "agent_123", parentOrigin: "https://customer.example", name: "Asha's twin",
  trainerName: "Asha", photoUrl: null, welcome: "Talk to my AI twin",
  accentColor: "#315327", maxSeconds: 120, livekitUrl: "wss://voice.example",
};

describe("hosted widget input boundaries", () => {
  test("keeps start failures friendly without exposing transport details", () => {
    for (const failure of [new TypeError("Failed to fetch"), new Error("private provider credential"), null]) {
      expect(callStartError(failure)).toBe("Please try again in a little while.");
    }
    expect(callStartError(new DOMException("denied", "NotAllowedError"))).toContain("Microphone access is blocked");
    expect(callStartError(new DOMException("missing", "NotFoundError"))).toContain("No microphone was found");
  });
  test("accepts the hosted JSON contract without requiring a portrait", () => {
    expect(parseConfig(config).photoUrl).toBeNull();
    expect(parseConfig(config).parentOrigin).toBe(config.parentOrigin);
    expect(() => parseConfig({ ...config, mode: "inline" })).toThrow();
    expect(parseConfig(config).mode).toBe("floating");
  });

  test("never accepts script, data, credentialed or relative portrait URLs", () => {
    for (const photoUrl of ["javascript:alert(1)", "data:image/png;base64,a", "//images.example/portrait", "https://user:pass@images.example/a"]) {
      expect(parseConfig({ ...config, photoUrl }).photoUrl).toBeNull();
    }
    expect(parseConfig({ ...config, photoUrl: "https://images.example/portrait.jpg" }).photoUrl).toBe("https://images.example/portrait.jpg");
  });

  test("rejects invalid origins, connection URLs, identifiers, colours and limits", () => {
    for (const change of [
      { parentOrigin: "https://customer.example/path" },
      { parentOrigin: "https://customer.example/" },
      { parentOrigin: "null" },
      { livekitUrl: "javascript:alert(1)" },
      { agentId: "../../private" },
      { accentColor: "red; background:url(https://attacker.example)" },
      { maxSeconds: 0 },
      { maxSeconds: 120.5 },
      { maxSeconds: Infinity },
      { mode: "popup" },
      { welcome: " " },
      { welcome: "x".repeat(121) },
    ]) expect(() => parseConfig({ ...config, ...change })).toThrow();
  });

  test("trims bounded names and treats markup as data", () => {
    expect(visitorName("  Noor  ")).toBe("Noor");
    expect(visitorName("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
    expect(visitorName("n".repeat(80))).toHaveLength(80);
    for (const name of ["", "   ", "n".repeat(81), "a\nb", "\tNoor", "a\u0000b", "a\u0085b"]) {
      expect(() => visitorName(name)).toThrow();
    }
  });

  test("only extracts session-scoped capabilities and LiveKit token", () => {
    const result = parseSession({
      session: { id: "session_1", embedToken: "signed-end-capability", runtimeToken: "must-not-be-used", secondsLeft: 117 },
      participantToken: "livekit-token", room: "session_1",
    });
    expect(result).toEqual({
      session: { id: "session_1", embedToken: "signed-end-capability", secondsLeft: 117 },
      participantToken: "livekit-token",
    });
    expect("runtimeToken" in result.session).toBe(false);
    expect(parseSession({ session: { id: "s", embedToken: "end", secondsLeft: 60, endsAt: 1794998400000 }, participantToken: "lk" }).session.endsAt).toBe(1794998400000);
  });

  test("rejects expired, malformed and unbounded session responses", () => {
    for (const value of [
      null, {}, { session: {} },
      { session: { id: "s", runtimeToken: "not-an-end-capability", secondsLeft: 120 }, participantToken: "lk" },
      { session: { id: "s", embedToken: "end", secondsLeft: 0 }, participantToken: "lk" },
      { session: { id: "s", embedToken: "end", secondsLeft: Infinity }, participantToken: "lk" },
      { session: { id: "s", embedToken: "end", secondsLeft: 60, endsAt: Infinity }, participantToken: "lk" },
      { session: { id: "s", embedToken: "end", secondsLeft: 120 }, participantToken: "" },
    ]) expect(() => parseSession(value)).toThrow();
  });
  test("uses a bounded server allowance independent of the device wall clock", () => {
    expect(remainingCallMs({ secondsLeft: 2, endsAt: 1794998401500, serverTime: 1794998400000 }, 120)).toBe(1500);
    expect(remainingCallMs({ secondsLeft: 5, endsAt: 1794998390000, serverTime: 1794998400000 }, 120)).toBe(0);
    expect(remainingCallMs({ secondsLeft: 600 }, 120)).toBe(120000);
    expect(remainingCallMs({ secondsLeft: 90 }, 120)).toBe(90000);
  });
});
