import { Type, type Static } from "typebox";

/** What something cost, as its Runner reports it. */
export const Cost = Type.Object(
  {
    amount: Type.Integer({ minimum: 0, description: "In the currency's minor units, such as US cents: 137 is $1.37." }),
    currency: Type.String({ description: "ISO 4217, such as `USD`." }),
    estimate: Type.Optional(
      Type.Boolean({
        description:
          "Whether it is an estimate rather than money spent: what Claude Code reports for a local Run, at list prices, " +
          "while its User pays by subscription. Left out, or false, for a real cost such as a Managed Agents session's.",
      }),
    ),
  },
  { description: "What it cost, in the currency's minor units." },
);
export type Cost = Static<typeof Cost>;

/**
 * SQL totalling the costs of the Runs `where` picks (in `from runs`), one `Cost` per currency and kind, real before
 * estimated, ordered by currency, as a JSON array; empty when none of them reported a cost. Estimates are never added
 * to real costs.
 */
export const costTotalsSql = (where: string) => `coalesce((select json_agg(json_build_object('amount', t.amount, 'currency', t.currency,
    'estimate', t.estimate) order by t.currency, t.estimate)
  from (select sum(runs.cost_amount)::bigint as amount, runs.cost_currency as currency, runs.cost_estimate as estimate from runs
    where runs.cost_amount is not null and ${where} group by runs.cost_currency, runs.cost_estimate) t), '[]')`;
