import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { notificationService } from "@/features/notifications/services/notificationService";
import {
  KEYS,
  findInCache,
  markAllReadInCache,
  markReadInCache,
  removeFromCache,
  setUnreadCount,
} from "@/features/notifications/utils/cache";
import { getFriendlyErrorMessage } from "@/lib/error-message";

/** Cursor-paginated feed. `status`: "all" | "unread"; `category`: optional. */
export function useNotifications({ status = "all", category, limit = 20, enabled = true } = {}) {
  const filters = { status, limit, ...(category ? { category } : {}) };
  return useInfiniteQuery({
    queryKey: [...KEYS.lists, filters],
    queryFn: ({ pageParam }) => notificationService.list({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
  });
}

/**
 * Kept in sync by the live stream, so no polling. Refetching on focus is a
 * single cheap request that heals any drift (e.g. a tab that slept).
 */
export function useUnreadCount({ enabled = true } = {}) {
  return useQuery({
    queryKey: KEYS.unread,
    queryFn: notificationService.unreadCount,
    staleTime: Infinity,
    refetchOnWindowFocus: true,
    enabled,
  });
}

function useOptimistic({ mutationFn, optimistic, errorMessage }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: KEYS.all });
      const snapshot = {
        lists: queryClient.getQueriesData({ queryKey: KEYS.lists }),
        unread: queryClient.getQueryData(KEYS.unread),
      };
      optimistic(queryClient, variables);
      return snapshot;
    },
    onError: (error, variables, snapshot) => {
      snapshot?.lists.forEach(([key, data]) => queryClient.setQueryData(key, data));
      if (snapshot?.unread) queryClient.setQueryData(KEYS.unread, snapshot.unread);
      toast.error(errorMessage || getFriendlyErrorMessage(error));
    },
    onSuccess: (data) => setUnreadCount(queryClient, data?.unreadCount),
  });
}

const decrement = (queryClient, by = 1) => {
  const current = queryClient.getQueryData(KEYS.unread);
  if (current) setUnreadCount(queryClient, Math.max(0, current.count - by));
};

export function useMarkRead() {
  return useOptimistic({
    mutationFn: (id) => notificationService.markRead(id),
    optimistic: (queryClient, id) => {
      const existing = findInCache(queryClient, id);
      markReadInCache(queryClient, id);
      if (existing && !existing.read) decrement(queryClient);
    },
  });
}

export function useMarkAllRead() {
  return useOptimistic({
    mutationFn: (category) => notificationService.markAllRead(category),
    optimistic: (queryClient, category) => {
      markAllReadInCache(queryClient, category);
      if (!category) setUnreadCount(queryClient, 0);
    },
  });
}

export function useDismissNotification() {
  return useOptimistic({
    mutationFn: (id) => notificationService.dismiss(id),
    optimistic: (queryClient, id) => {
      const existing = findInCache(queryClient, id);
      removeFromCache(queryClient, id);
      if (existing && !existing.read) decrement(queryClient);
    },
  });
}

export function useNotificationPreferences() {
  return useQuery({ queryKey: KEYS.preferences, queryFn: notificationService.getPreferences, staleTime: 5 * 60 * 1000 });
}

export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (updates) => notificationService.updatePreferences(updates),
    onMutate: async (updates) => {
      await queryClient.cancelQueries({ queryKey: KEYS.preferences });
      const previous = queryClient.getQueryData(KEYS.preferences);
      if (previous) {
        const next = structuredClone(previous);
        Object.assign(next.preferences.channels, updates.channels || {});
        Object.entries(updates.categories || {}).forEach(([category, channels]) => {
          Object.assign(next.preferences.categories[category], channels);
        });
        queryClient.setQueryData(KEYS.preferences, next);
      }
      return { previous };
    },
    onError: (error, variables, context) => {
      if (context?.previous) queryClient.setQueryData(KEYS.preferences, context.previous);
      toast.error(getFriendlyErrorMessage(error));
    },
    onSuccess: (data) => queryClient.setQueryData(KEYS.preferences, data),
  });
}
