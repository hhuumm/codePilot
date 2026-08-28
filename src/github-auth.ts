export type GitHubStatus = {
  installed: boolean;
  authenticated: boolean;
  host: "github.com";
  account?: string;
  gitProtocol?: "https" | "ssh";
  scopes: string[];
  error?: string;
};

export function parseGitHubAuthStatus(output: string): Omit<GitHubStatus, "installed"> {
  const account = output.match(/Logged in to github\.com account\s+([^\s(]+)/i)?.[1];
  const protocol = output.match(/Git operations protocol:\s*(https|ssh)/i)?.[1]?.toLowerCase() as "https" | "ssh" | undefined;
  const scopeLine = output.match(/Token scopes:\s*(.+)$/im)?.[1] ?? "";
  const quotedScopes = [...scopeLine.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]!);
  const scopes = (quotedScopes.length ? quotedScopes : scopeLine.split(","))
    .map(scope => scope.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
    .sort();
  return {
    authenticated: Boolean(account),
    host: "github.com",
    ...(account ? { account } : {}),
    ...(protocol ? { gitProtocol: protocol } : {}),
    scopes,
    ...(!account ? { error: "GitHub CLI is not authenticated" } : {}),
  };
}

export function assertGitHubPublicationAllowed(allowWrites: boolean, status: GitHubStatus): void {
  if (!allowWrites)
    throw new Error("GitHub publishing is disabled. Enable write operations in Settings before creating a pull request.");
  if (!status.authenticated)
    throw new Error("Connect GitHub in Settings before creating a pull request.");
}
