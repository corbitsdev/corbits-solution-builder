/**
 * External input is validated once, at the route that owns it: an arktype
 * result either is the value or names what was wrong, as a 400.
 */
import { type } from "arktype";
import { HostError } from "@corbits/embedded-host";

export function parsed<T>(result: T | type.errors): T {
  if (result instanceof type.errors) {
    throw new HostError("validation_failed", result.summary);
  }
  return result;
}
