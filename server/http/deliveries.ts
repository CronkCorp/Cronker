import type { FastifyInstance, FastifySchema } from "fastify";

/** A webhook delivery as it arrived: its exact bytes, which its signature covers, and its headers and path parameters. */
export interface RawDelivery {
  body: Buffer;
  header(name: string): string | undefined;
  params: Record<string, string>;
}

/**
 * Registers a POST route for a webhook's deliveries that reads each body as the bytes sent, whatever its content type,
 * since a signature covers exactly those; a parsed and re-serialized body would no longer match it.
 */
export async function deliveryRoute(
  app: FastifyInstance,
  path: string,
  options: { bodyLimit: number; schema: FastifySchema },
  handle: (delivery: RawDelivery) => Promise<unknown>,
): Promise<void> {
  await app.register(async (deliveries) => {
    deliveries.removeAllContentTypeParsers();
    deliveries.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: options.bodyLimit }, (_request, body, done) => done(null, body));
    deliveries.post(path, options, async (request) =>
      handle({
        body: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        header: (name) => {
          const value = request.headers[name];
          return Array.isArray(value) ? value[0] : value;
        },
        params: request.params as Record<string, string>,
      }),
    );
  });
}
