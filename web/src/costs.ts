import type { Cost } from "./api.js";

/** An amount in its currency, such as "$1.37" for 137 US cents. */
function amountText({ amount, currency }: Cost): string {
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat("en-US", { style: "currency", currency });
  } catch {
    return `${amount} ${currency} (minor units)`;
  }
  // The amount is in the currency's minor units: cents for US dollars, none for yen.
  return format.format(amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}

/**
 * A cost as a person reads it, in its currency, such as "$1.37" for 137 US cents; an estimate, as Claude Code reports
 * for a local Run, says so: "≈ $1.37 estimated".
 */
export const costText = (cost: Cost): string => (cost.estimate ? `≈ ${amountText(cost)} estimated` : amountText(cost));

/**
 * Totals per currency as one line, such as "$3.50" or "$3.50 + €1.00"; estimates stay apart from real costs, after
 * them: "$3.50 · ≈ $1.20 estimated".
 */
export function costsText(costs: Cost[]): string {
  const real = costs.filter((c) => !c.estimate).map(amountText);
  const estimated = costs.filter((c) => c.estimate).map(amountText);
  return [real.length > 0 ? real.join(" + ") : null, estimated.length > 0 ? `≈ ${estimated.join(" + ")} estimated` : null]
    .filter(Boolean)
    .join(" · ");
}
