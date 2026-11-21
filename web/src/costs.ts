import type { Cost } from "./api.js";

/** A cost as a person reads it, in its currency, such as "$1.37" for 137 US cents. */
export function costText({ amount, currency }: Cost): string {
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat("en-US", { style: "currency", currency });
  } catch {
    return `${amount} ${currency} (minor units)`;
  }
  // The amount is in the currency's minor units: cents for US dollars, none for yen.
  return format.format(amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}

/** Totals per currency as one line, such as "$3.50" or "$3.50 + €1.00". */
export const costsText = (costs: Cost[]): string => costs.map(costText).join(" + ");
