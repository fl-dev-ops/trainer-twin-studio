import { expect, test } from "bun:test";
import { cn } from "@/lib/utils";

test("cn keeps design-token sizes alongside colours", () => {
  expect(cn("text-body-s font-medium", "text-white")).toBe("text-body-s font-medium text-white");
  expect(cn("shadow-elevation-1 ring-foreground/10", "rounded-tt-md")).toBe("shadow-elevation-1 ring-foreground/10 rounded-tt-md");
});

test("cn still lets a later token size replace an earlier one", () => {
  expect(cn("text-body-s", "text-overline")).toBe("text-overline");
  expect(cn("shadow-elevation-1", "shadow-elevation-2")).toBe("shadow-elevation-2");
  expect(cn("rounded-tt-md", "rounded-tt-lg")).toBe("rounded-tt-lg");
});
