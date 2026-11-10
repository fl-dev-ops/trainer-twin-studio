import { describe, expect, test } from "bun:test";
import { formatMoney, PurchaseError, toSubunits } from "@/lib/credit-purchases";

describe("toSubunits", () => {
  test.each([[1, 100], [8000, 800000], [99.5, 9950], [1.01, 101], [19.99, 1999]])("%s becomes %s", (major, expected) => {
    expect(toSubunits(major)).toBe(expected);
  });
  test.each([0, -1, 0.99, 1.001, 99.999, NaN, Infinity, -Infinity])("refuses %s", (major) => {
    expect(() => toSubunits(major)).toThrow(PurchaseError);
    expect(() => toSubunits(major)).toThrow("at least 1, with at most 2 decimals");
  });
});

describe("formatMoney", () => {
  test.each([
    [800000, "INR", "₹8,000"],
    [12345678, "INR", "₹1,23,456.78"],
    [9950, "USD", "$99.50"],
    [100000, "USD", "$1,000"],
    [0, "INR", "₹0"],
  ])("formats %s %s", (amount, currency, expected) => {
    expect(formatMoney(amount, currency)).toBe(expected);
  });
});
