import { describe, expect, test } from "vitest";
import { costsText, costText } from "../../web/src/costs.js";

describe("costs as the web client shows them", () => {
  test("a real cost is its amount; an estimate says so", () => {
    expect(costText({ amount: 137, currency: "USD" })).toBe("$1.37");
    expect(costText({ amount: 137, currency: "USD", estimate: false })).toBe("$1.37");
    expect(costText({ amount: 137, currency: "USD", estimate: true })).toBe("≈ $1.37 estimated");
  });

  test("totals keep estimates apart from real costs, after them", () => {
    expect(costsText([{ amount: 350, currency: "USD", estimate: false }])).toBe("$3.50");
    expect(
      costsText([
        { amount: 100, currency: "EUR", estimate: false },
        { amount: 120, currency: "USD", estimate: true },
        { amount: 350, currency: "USD", estimate: false },
      ]),
    ).toBe("€1.00 + $3.50 · ≈ $1.20 estimated");
    expect(costsText([{ amount: 120, currency: "USD", estimate: true }])).toBe("≈ $1.20 estimated");
  });
});
