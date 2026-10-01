import { QueryClient } from "@tanstack/react-query";

/**
 * The one query client, module-level so code outside the component tree (the
 * mailbox and inbox streams, the installer's workspace cache) can invalidate
 * what it knows has changed. A clock is a backstop, never the mechanism:
 * nothing refetches in a hidden tab, and a stream event is what marks a
 * query stale.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: false,
      retry: 1,
    },
  },
});
