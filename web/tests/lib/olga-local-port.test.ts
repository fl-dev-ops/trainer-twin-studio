import { describe, expect, test } from "bun:test";
import { assertTarget, embeddingInput, vectorsMatch } from "../../scripts/port-olga-local";

describe("Olga local port guards", () => {
  test("only permits the fixed local target", () => {
    expect(() => assertTarget("/tmp", "trainertwin_olga_local", "http://127.0.0.1:9100")).not.toThrow();
    for (const [host, database, endpoint] of [
      ["remote", "trainertwin_olga_local", "http://127.0.0.1:9100"],
      ["/tmp", "trainertwin", "http://127.0.0.1:9100"],
      ["/tmp", "trainertwin_test", "http://127.0.0.1:9100"],
      ["/tmp", "trainertwin_olga_local", "https://s3.amazonaws.com"],
    ]) expect(() => assertTarget(host, database, endpoint)).toThrow();
  });
  test("matches the scenario publisher embedding renderer exactly", () => {
    expect(embeddingInput("situation", "reply")).toBe("situation\nreply");
    expect(embeddingInput("", "reply")).toBe("reply");
    expect(embeddingInput(undefined, "reply")).toBe("reply");
  });
  test("permits only float serialization precision, not changed vectors", () => {
    expect(vectorsMatch([-0.04928589], [-0.049285892])).toBe(true);
    expect(vectorsMatch([0, 0.1], [0, 0.1001])).toBe(false);
    expect(vectorsMatch([0], [1e-12])).toBe(false);
    expect(vectorsMatch([1], [1, 2])).toBe(false);
    expect(vectorsMatch([NaN], [NaN])).toBe(false);
  });
});
