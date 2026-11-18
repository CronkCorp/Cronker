import type { FastifyInstance } from "fastify";
import { ApiError } from "./errors.js";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuses state-changing requests a browser sent from another Origin, on top of the
 * `SameSite=Strict` cookie. Browsers send `Origin` on every such request (`null` from
 * sandboxed pages, which is refused too). Clients that aren't browsers send neither
 * `Origin` nor `Sec-Fetch-Site`, and carry no cookie a page could abuse.
 */
export function refuseOtherOrigins(app: FastifyInstance, publicUrl: URL): void {
  app.addHook("onRequest", async (request) => {
    if (safeMethods.has(request.method)) return;
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    const allowed =
      origin !== undefined
        ? origin === publicUrl.origin
        : fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none";
    if (!allowed) {
      throw new ApiError(403, "cross_origin", `Requests that change things must come from ${publicUrl.origin}.`);
    }
  });
}
