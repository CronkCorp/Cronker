import { Type, type TLiteral, type TSchemaOptions, type TUnion } from "typebox";

/** A union of string literals, typed so that its `Static` is their union rather than `never`. */
export type Literals<T extends readonly string[]> = TUnion<{ -readonly [K in keyof T]: TLiteral<T[K]> }>;

/**
 * The schema of one of `values`: `Type.Union` of a `Type.Literal` for each, as written by hand, but built from a list
 * the code also uses at runtime. `Type.Union` of a mapped array types its `Static` as `never`, which would leave the
 * web client, which takes the server's types, with nothing to check against.
 */
export function literals<const T extends readonly string[]>(values: T, options?: TSchemaOptions): Literals<T> {
  return Type.Union(
    values.map((value) => Type.Literal(value)),
    options,
  ) as unknown as Literals<T>;
}
