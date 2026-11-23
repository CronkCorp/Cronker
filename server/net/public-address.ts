import { lookup as systemLookup, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";

/**
 * Telling public addresses from private ones, for what Cronk's server fetches from addresses others give it (Client
 * ID Metadata Documents, webhook deliveries), so those can't be used to reach the network Cronk runs in.
 */

/** The system's resolver, as a `lookup` for `node:http` and `node:net`. */
export const systemResolver = systemLookup as unknown as LookupFunction;

/** Whether an address is on a loopback, private, shared, link-local or otherwise non-public network. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (dotted) return isPrivateAddress(dotted[1]!);
    // An IPv4 address embedded in hex, as the URL parser writes `[::ffff:10.0.0.5]`: `::ffff:a00:5`.
    const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hex) {
      const [high, low] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower) ||
      lower.startsWith("64:ff9b:");
  }
  const [a, b] = address.split(".").map(Number) as [number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
  );
}

/** A URL's host as an IP address, without an IPv6 address's brackets; undefined for a host name. */
export function addressLiteral(url: URL): string | undefined {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return isIP(host) ? host : undefined;
}

/** Every address a host resolves to; none when it doesn't resolve. */
export function resolveAll(resolver: LookupFunction, hostname: string): Promise<string[]> {
  return new Promise((resolve) => {
    resolver(hostname, { all: true }, (error, addresses) => {
      if (error) return resolve([]);
      resolve(typeof addresses === "string" ? [addresses] : addresses.map((a) => a.address));
    });
  });
}

/**
 * Resolves a host with `resolver`, but refuses one on a private network with an `EPRIVATE` error. Checking the very
 * addresses the connection then uses leaves no gap for the host to answer differently in between. The connection
 * doesn't call it for an IP address, which `addressLiteral` and `isPrivateAddress` check.
 */
export function publicOnly(resolver: LookupFunction = systemResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname, { ...options, all: true }, (error, found) => {
      if (error) return callback(error, "", 0);
      const addresses = (typeof found === "string" ? [] : found) as LookupAddress[];
      if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
        return callback(Object.assign(new Error(`${hostname} is on a private network`), { code: "EPRIVATE" }), "", 0);
      }
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

/** `publicOnly` over the system's resolver. */
export const publicOnlyLookup = publicOnly();
