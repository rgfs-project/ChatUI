import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from "undici";

/**
 * SSRF policy for provider endpoints (contracts INV-19). Applied when the
 * configuration is loaded and on every outbound request: the hostname is
 * resolved, every resolved address is checked, and the connection is pinned
 * to the checked address so DNS rebinding cannot swap it. Redirects are
 * never followed.
 */

/** Cloud metadata endpoints: always denied, even when allowlisted. */
export const METADATA_ADDRESSES: readonly string[] = [
  "169.254.169.254", // AWS, GCP, Azure, OpenStack, DigitalOcean, Oracle (IMDS)
  "169.254.170.2", // AWS ECS task metadata
  "169.254.170.23", // AWS EKS pod identity
  "fd00:ec2::254", // AWS IMDS over IPv6
  "fd00:ec2::23", // AWS EKS pod identity over IPv6
  "100.100.100.200", // Alibaba Cloud
  "192.0.0.192", // Oracle Cloud (legacy)
];
const METADATA = new Set(METADATA_ADDRESSES.map((a) => ipaddr.parse(a).toNormalizedString()));

export interface LinkLocalException {
  hostname: string;
  address: string;
  port: number;
}

export interface SsrfPolicy {
  /** Allow loopback, RFC 1918, unique-local and CGNAT hosts (local llama.cpp). */
  allowPrivate: boolean;
  /** When non-empty, only these exact hostnames may be used. */
  hostAllowlist: readonly string[];
  /** Exact (hostname, address, port) tuples allowed despite being link-local. */
  linkLocalExceptions: readonly LinkLocalException[];
}

export class SsrfError extends Error {
  override name = "SsrfError";
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export const systemResolver: Resolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/** Checks the URL itself: scheme, credentials, fragment, query, allowlist. */
export function checkUrl(raw: string, policy: SsrfPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new SsrfError("only http and https are allowed");
  if (url.username || url.password) throw new SsrfError("URLs must not contain credentials");
  if (url.hash || raw.includes("#")) throw new SsrfError("URLs must not contain a fragment");
  if (url.search) throw new SsrfError("base URLs must not contain a query string");
  const host = hostnameOf(url);
  if (policy.hostAllowlist.length > 0 && !policy.hostAllowlist.includes(host)) {
    throw new SsrfError("host is not in PROVIDER_HOST_ALLOWLIST");
  }
  return url;
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** Classifies one address under the policy; returns a reason when denied. */
export function addressProblem(
  address: string,
  host: string,
  port: number,
  policy: SsrfPolicy,
): string | undefined {
  if (!ipaddr.isValid(address)) return "invalid address";
  // Normalizes IPv4-mapped IPv6 (::ffff:a.b.c.d, ::ffff:7f00:1) to IPv4.
  const parsed = ipaddr.process(address);
  if (METADATA.has(parsed.toNormalizedString()))
    return "cloud metadata endpoints are always denied";
  const range = parsed.range();
  switch (range) {
    case "unicast":
      return undefined;
    case "loopback":
    case "private":
    case "uniqueLocal":
    case "carrierGradeNat":
      return policy.allowPrivate
        ? undefined
        : "private addresses are disabled (ALLOW_PRIVATE_PROVIDER_HOSTS=false)";
    case "linkLocal": {
      const allowed = policy.linkLocalExceptions.some(
        (e) =>
          e.hostname === host &&
          e.port === port &&
          ipaddr.process(e.address).toNormalizedString() === parsed.toNormalizedString(),
      );
      return allowed ? undefined : "link-local addresses are denied";
    }
    default:
      // unspecified, broadcast, multicast, reserved, 6to4/teredo relays, etc.
      return `${range} addresses are denied`;
  }
}

/** Resolves and checks every address; returns the address to pin to. */
export async function resolveChecked(
  url: URL,
  policy: SsrfPolicy,
  resolver: Resolver,
): Promise<{ address: string; family: number }> {
  const host = hostnameOf(url);
  const port = portOf(url);
  const results = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolver(host).catch(() => []);
  if (results.length === 0) throw new SsrfError("host did not resolve");
  for (const result of results) {
    const problem = addressProblem(result.address, host, port, policy);
    if (problem) throw new SsrfError(`${host} resolves to a denied address: ${problem}`);
  }
  const first = results[0] as { address: string; family: number };
  return first;
}

/** A fetch whose every request is SSRF-checked, pinned and never redirected. */
export type SafeFetch = (url: string, init?: UndiciRequestInit) => Promise<UndiciResponse>;

export function createSafeFetch(
  policy: SsrfPolicy,
  resolver: Resolver = systemResolver,
): SafeFetch {
  /** One agent per (hostname, checked address); bounded to avoid unbounded sockets. */
  const agents = new Map<string, Agent>();
  const agentFor = (host: string, pinned: { address: string; family: number }): Agent => {
    const key = `${host}|${pinned.address}`;
    let agent = agents.get(key);
    if (!agent) {
      if (agents.size >= 32) {
        const oldest = agents.entries().next().value;
        if (oldest) {
          agents.delete(oldest[0]);
          void oldest[1].close().catch(() => undefined);
        }
      }
      // Connect to the checked address; TLS still verifies the certificate for
      // the hostname (SNI), so pinning does not weaken HTTPS.
      agent = new Agent({
        connect: {
          // Node may ask for all addresses (autoSelectFamily); answer with the
          // single checked address in whichever form was requested.
          lookup: (_hostname, options, callback) => {
            if ((options as { all?: boolean }).all) {
              (
                callback as unknown as (
                  e: null,
                  list: { address: string; family: number }[],
                ) => void
              )(null, [pinned]);
            } else {
              callback(null, pinned.address, pinned.family);
            }
          },
        },
      });
      agents.set(key, agent);
    }
    return agent;
  };
  return async (raw, init = {}) => {
    const target = new URL(raw);
    const url = checkUrl(`${target.origin}${target.pathname}`, policy);
    const pinned = await resolveChecked(url, policy, resolver);
    const response = await undiciFetch(target, {
      ...init,
      dispatcher: agentFor(hostnameOf(url), pinned),
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new SsrfError("redirects from providers are not followed");
    }
    return response;
  };
}
