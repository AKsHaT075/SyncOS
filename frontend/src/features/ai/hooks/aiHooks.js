import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { aiService } from "@/features/ai/services/aiService";
import { hasStreamingReply } from "@/features/ai/utils/transcript";
import { aiErrorMessage } from "@/features/ai/utils/apiError";

export const AI_KEY = "ai";
const POLL_MS = 1500;

export const useAiStatus = () =>
  useQuery({ queryKey: [AI_KEY, "status"], queryFn: async () => (await aiService.status()).status, staleTime: 60_000 });

/** Cursor-paginated, newest activity first. `status`: "active" | "archived". */
export const useConversations = ({ status = "active" } = {}) =>
  useInfiniteQuery({
    queryKey: [AI_KEY, "conversations", status],
    queryFn: ({ pageParam }) => aiService.listConversations({ status, limit: 20, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

/** One conversation. A 404 (not yours / deleted) is final: no retries. */
export const useConversation = (id) =>
  useQuery({
    queryKey: [AI_KEY, "conversation", id],
    queryFn: async () => (await aiService.getConversation(id)).conversation,
    enabled: Boolean(id),
    retry: false,
    // While the server says a reply is being generated (this tab just stopped it, or another tab/device started it) keep looking
    // until it is finished: otherwise a read that lands just before the server settles would stay stale.
    refetchInterval: (query) => (query.state.data?.busy ? POLL_MS : false),
  });

/** Messages page BACK in time: the first page is the newest. Each page is already oldest-to-newest. */
export const useMessages = (id) =>
  useInfiniteQuery({
    queryKey: [AI_KEY, "messages", id],
    queryFn: ({ pageParam }) => aiService.listMessages(id, { limit: 30, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(id),
    retry: false,
    staleTime: 0,
    refetchInterval: (query) => (hasStreamingReply(query.state.data) ? POLL_MS : false),
  });

/** Oldest-to-newest list from the infinite pages (page 0 is the newest, so pages are reversed). */
export const flattenMessages = (data) => (data?.pages ? [...data.pages].reverse().flatMap((page) => page.messages) : []);

function useAiMutation(mutationFn, { success, onSuccess } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: [AI_KEY, "conversations"] });
      queryClient.invalidateQueries({ queryKey: [AI_KEY, "conversation"] });
      const message = typeof success === "function" ? success(data, variables) : success;
      if (message) toast.success(message);
      onSuccess?.(data, variables);
    },
    onError: (error) => toast.error(aiErrorMessage(error)),
  });
}

export const useCreateConversation = () => useAiMutation((payload) => aiService.createConversation(payload));
export const useRenameConversation = () => useAiMutation(({ id, title }) => aiService.updateConversation(id, { title }), { success: "Conversation renamed" });
export const useArchiveConversation = () =>
  useAiMutation(({ id, archived }) => aiService.updateConversation(id, { archived }), { success: (_d, v) => (v.archived ? "Conversation archived" : "Conversation restored") });

export function useDeleteConversation({ onDeleted } = {}) {
  const queryClient = useQueryClient();
  return useAiMutation(({ id }) => aiService.deleteConversation(id), {
    success: "Conversation deleted",
    onSuccess: (_d, { id }) => {
      queryClient.removeQueries({ queryKey: [AI_KEY, "messages", id] });
      queryClient.removeQueries({ queryKey: [AI_KEY, "conversation", id] });
      onDeleted?.(id);
    },
  });
}

// ---- Organization AI settings (admins; MANAGE_AI). The server is the authority; these only read and submit.
export const useAiSettings = () =>
  useQuery({ queryKey: [AI_KEY, "settings"], queryFn: () => aiService.getSettings(), staleTime: 15_000 });

export const useUpdateAiSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload) => aiService.updateSettings(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [AI_KEY] });
      toast.success("AI settings saved");
    },
    onError: (error) => toast.error(aiErrorMessage(error)),
  });
};
