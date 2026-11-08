import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { teamService } from "@/features/teams/services/team.service";
import { getFriendlyErrorMessage } from "@/lib/error-message";

export function useTeams(filters = {}) {
  return useQuery({
    queryKey: ["teams", "list", filters],
    queryFn: () => teamService.listTeams(filters),
  });
}

export function useTeam(teamId) {
  return useQuery({
    queryKey: ["teams", "detail", teamId],
    queryFn: () => teamService.getTeam(teamId),
    enabled: !!teamId,
  });
}

export function useMyTeam() {
  return useQuery({
    queryKey: ["teams", "me"],
    queryFn: () => teamService.getMyTeam(),
  });
}

export function useCreateTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data) => teamService.createTeam(data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      toast.success(`Team "${data.team.name}" created`);
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}

export function useUpdateTeam(teamId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (updates) => teamService.updateTeam(teamId, updates),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      toast.success("Team settings updated");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}

export function useDeleteTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (teamId) => teamService.deleteTeam(teamId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["people"] });
      toast.success("Team deleted successfully");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}

export function useAddTeamMember(teamId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId) => teamService.addMember(teamId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["people"] });
      toast.success("Member added to team");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}

export function useRemoveTeamMember(teamId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId) => teamService.removeMember(teamId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["people"] });
      toast.success("Member removed from team");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}

export function useSetTeamManager(teamId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId) => teamService.setManager(teamId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["people"] });
      toast.success("Team manager updated");
    },
    onError: (error) => {
      toast.error(getFriendlyErrorMessage(error));
    },
  });
}

export function useTeamMemberCandidates(teamId, search = "", role = undefined) {
  return useQuery({
    queryKey: ["teams", "candidates", teamId, search, role],
    queryFn: () => teamService.listMemberCandidates(teamId, search, role),
    enabled: !!teamId,
  });
}
