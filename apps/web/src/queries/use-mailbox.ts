import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FALLBACK_REFETCH_MS, subscribeMailbox } from "../mailbox-events.ts";
import { keys } from "./keys.ts";

/** How often a thread is re-read while the mailbox stream is down. */
const STREAM_DOWN_REFETCH_MS = 20_000;

/**
 * Holds the tenant's mailbox stream open and marks every thread read under
 * that tenant stale on each nudge, so a reply shows the moment it lands.
 * Returns the backstop interval a thread query should poll at: short while
 * the stream is down, long while it is open, since an open stream can still
 * drop an event.
 */
export function useMailboxNudge(tenantId: string | null, onNudge?: () => void): () => number {
  const queryClient = useQueryClient();
  const onNudgeRef = useRef(onNudge);
  onNudgeRef.current = onNudge;
  const open = useRef<() => boolean>(() => false);

  useEffect(() => {
    if (!tenantId) return;
    const subscription = subscribeMailbox(tenantId, () => {
      void queryClient.invalidateQueries({ queryKey: keys.thread.in(tenantId) }, { cancelRefetch: false });
      onNudgeRef.current?.();
    });
    open.current = subscription.isOpen;
    return () => {
      open.current = () => false;
      subscription.unsubscribe();
    };
  }, [tenantId, queryClient]);

  return () => (open.current() ? FALLBACK_REFETCH_MS : STREAM_DOWN_REFETCH_MS);
}
