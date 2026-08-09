import { getDomain } from "tldts";
import { HttpError } from "./errors.ts";

export function registrableDomain(hostname: string): string {
  const apex = getDomain(hostname, { allowPrivateDomains: true });
  if (!apex) {
    throw new HttpError(
      400,
      `Unable to determine the registrable apex for ${hostname}`,
      "domain_apex_unknown",
    );
  }
  return apex;
}
