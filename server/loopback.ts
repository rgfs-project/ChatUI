// Loaded natively by Node (type stripping); see server/config.ts.
import { isIP } from "node:net";

/**
 * True for IPv4 127.0.0.0/8, IPv6 ::1 and IPv4-mapped IPv6 loopback
 * (::ffff:127.x.y.z). Only the socket peer address is ever passed here, never
 * a forwarded header (contracts §9.2b).
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  const candidate = mapped?.[1] ?? normalized;
  if (isIP(candidate) === 4) return candidate.startsWith("127.");
  return candidate === "::1" || candidate === "0:0:0:0:0:0:0:1";
}
