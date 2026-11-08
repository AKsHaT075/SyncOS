"use client";

import { useState } from "react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";

export default function QueryProvider({ children }) {
  const [queryClient] = useState(() => {
    // Tasks, meetings and projects all appear on the calendar. Rather than editing every one of their
    // hooks, any successful mutation marks calendar data stale; only a calendar view that is currently
    // on screen actually refetches, otherwise it refreshes the next time it is opened.
    let client;
    client = new QueryClient({
      mutationCache: new MutationCache({ onSuccess: () => client.invalidateQueries({ queryKey: ["calendar"] }) }),
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 30 * 1000,
          },
          mutations: {
            retry: 0,
          },
        },
    });
    return client;
  });

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
