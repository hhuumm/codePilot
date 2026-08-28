export function removeProjectRegistration<T extends { id: string }>(
  projects: T[],
  activeProjectId: string,
  projectId: string,
): { projects: T[]; activeProjectId: string } {
  if (!projects.some((project) => project.id === projectId))
    throw new Error("Project not found. Refresh the workspace and try again.");
  if (projects.length === 1)
    throw new Error("CodePilot needs at least one registered project.");
  const remaining = projects.filter((project) => project.id !== projectId);
  return {
    projects: remaining,
    activeProjectId:
      activeProjectId === projectId ? remaining[0]!.id : activeProjectId,
  };
}
