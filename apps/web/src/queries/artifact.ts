/**
 * One artifact's content as a query. An artifact is revised in place under
 * its id, so a read goes stale the moment a revision lands (the stream
 * invalidates it); the client's default `staleTime` is the backstop, never
 * `Infinity`.
 */
import { queryOptions } from "@tanstack/react-query";
import { api } from "../client.js";
import { keys } from "./keys.ts";

export function artifactContentQuery(tenantId: string, id: string) {
  return queryOptions({
    queryKey: keys.artifact.of(tenantId, id),
    queryFn: () => api.artifactContent(tenantId, id),
  });
}
