import { Type, type Static } from "typebox";

/** What something cost, as its Runner reports it. */
export const Cost = Type.Object(
  {
    amount: Type.Integer({ minimum: 0, description: "In the currency's minor units, such as US cents: 137 is $1.37." }),
    currency: Type.String({ description: "ISO 4217, such as `USD`." }),
  },
  { description: "What it cost, in the currency's minor units." },
);
export type Cost = Static<typeof Cost>;

/**
 * SQL totalling the costs of the Runs `where` picks (in `from runs`), one `Cost` per currency ordered by currency, as a
 * JSON array; empty when none of them reported a cost.
 */
export const costTotalsSql = (where: string) => `coalesce((select json_agg(json_build_object('amount', t.amount, 'currency', t.currency)
    order by t.currency)
  from (select sum(runs.cost_amount)::bigint as amount, runs.cost_currency as currency from runs
    where runs.cost_amount is not null and ${where} group by runs.cost_currency) t), '[]')`;
