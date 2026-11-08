import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { calendarService } from "@/features/calendar/services/calendarService";
import { getFriendlyErrorMessage } from "@/lib/error-message";

const KEY = "calendar";

export const useCalendarItems = (params, { enabled = true } = {}) =>
  useQuery({
    queryKey: [KEY, "items", params],
    queryFn: () => calendarService.list(params),
    placeholderData: keepPreviousData, // keep the previous month on screen while the next one loads
    enabled,
  });

export const useCalendarEvent = (id) =>
  useQuery({ queryKey: [KEY, "event", id], queryFn: () => calendarService.getEvent(id), enabled: Boolean(id) });

export const useCalendarPreferences = () =>
  useQuery({ queryKey: [KEY, "preferences"], queryFn: calendarService.getPreferences, staleTime: 5 * 60 * 1000 });

function useCalendarMutation(mutationFn, success) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: [KEY] });
      const message = typeof success === "function" ? success(data, variables) : success;
      if (message) toast.success(message);
    },
    onError: (error) => toast.error(getFriendlyErrorMessage(error)),
  });
}

export const useCreateEvent = () => useCalendarMutation((body) => calendarService.createEvent(body), "Event created");
export const useUpdateEvent = () => useCalendarMutation(({ id, body }) => calendarService.updateEvent(id, body), "Event updated");
export const useDeleteEvent = () => useCalendarMutation(({ id, params }) => calendarService.deleteEvent(id, params), "Event deleted");
export const useRsvp = () => useCalendarMutation(({ id, status }) => calendarService.rsvp(id, status), "Response saved");

export function useUpdateCalendarPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (updates) => calendarService.updatePreferences(updates),
    onSuccess: (data) => {
      queryClient.setQueryData([KEY, "preferences"], data);
      queryClient.invalidateQueries({ queryKey: [KEY, "items"] }); // timezone / hidden categories change what is shown
    },
    onError: (error) => toast.error(getFriendlyErrorMessage(error)),
  });
}
