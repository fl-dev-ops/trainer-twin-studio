import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildHostedWidget, buildLoader } from "../build";
import { embedUrl, httpOrigin, isHostMessage, isWidgetMessage } from "../src/protocol";

describe("widget protocol", () => {
  test("derives only the script origin and sends only the parent origin", () => {
    const url = embedUrl("https://acme.example/widgets/v1.js?cache=1", "twin-123", "https://customer.example:8443");
    expect(url.href).toBe("https://acme.example/embed/twin-123?parentOrigin=https%3A%2F%2Fcustomer.example%3A8443");
    expect([...url.searchParams.keys()]).toEqual(["parentOrigin"]);
  });

  test("accepts HTTP for local development and rejects unsafe schemes and credentials", () => {
    expect(httpOrigin("http://localhost:3000/widgets/v1.js")).toBe("http://localhost:3000");
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "file:///widgets/v1.js", "https://user:secret@example.com", "/relative.js"]) {
      expect(() => httpOrigin(url)).toThrow();
    }
  });

  test("rejects malformed IDs and noncanonical parent origins", () => {
    for (const id of ["", "../other", "hello/world", "a?token=x", "a".repeat(129), "<script>"]) {
      expect(() => embedUrl("https://org.example/widgets/v1.js", id, "https://host.example")).toThrow();
    }
    for (const origin of ["null", "file://", "https://host.example/path", "https://host.example/", "https://host.example?secret=x"]) {
      expect(() => embedUrl("https://org.example/widgets/v1.js", "twin", origin)).toThrow();
    }
  });

  test("accepts only versioned messages with known types and bounded status data", () => {
    for (const type of ["ready", "close"]) {
      expect(isWidgetMessage({ source: "trainertwin-widget", version: 1, type })).toBe(true);
    }
    expect(isWidgetMessage({ source: "trainertwin-widget", version: 1, type: "status", active: true })).toBe(true);
    expect(isWidgetMessage({ source: "trainertwin-widget", version: 1, type: "interaction", editing: true })).toBe(true);
    for (const value of [null, {}, "ready", { source: "trainertwin-host", version: 1, type: "ready" },
      { source: "trainertwin-widget", version: 2, type: "ready" },
      { source: "trainertwin-widget", version: 1, type: "resize", height: 100000 },
      { source: "trainertwin-widget", version: 1, type: "interaction", editing: "yes" },
      { source: "trainertwin-widget", version: 1, type: "status", active: "yes" }]) {
      expect(isWidgetMessage(value)).toBe(false);
    }
    expect(isHostMessage({ source: "trainertwin-host", version: 1, type: "init" })).toBe(true);
    expect(isHostMessage({ source: "trainertwin-host", version: 1, type: "destroy" })).toBe(true);
    expect(isHostMessage({ source: "trainertwin-host", version: 1, type: "start", token: "secret" })).toBe(false);
  });
});

test("committed browser artifact exactly matches a fresh build", async () => {
  const artifact = Bun.file(resolve(import.meta.dir, "../../web/public/widgets/v1.js"));
  expect(await artifact.text()).toBe(await buildLoader());
});

test("committed hosted client and stylesheet match their source", async () => {
  expect(await Bun.file(resolve(import.meta.dir, "../../web/public/widgets/voice-v1.js")).text()).toBe(await buildHostedWidget());
  expect(await Bun.file(resolve(import.meta.dir, "../../web/public/widgets/voice-v1.css")).text()).toBe(
    await Bun.file(resolve(import.meta.dir, "../src/widget.css")).text(),
  );
});
