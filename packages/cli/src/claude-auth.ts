import { execFile } from "node:child_process";

export type ClaudeAuthMode = "subscription" | "api-key" | "auto";

export type ClaudeAuthSource = "subscription" | "api-key" | "oauth" | "signed-out" | "unknown";

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  source: ClaudeAuthSource;
  authMethod?: string;
  subscriptionType?: string;
}

export function claudeAuthMode(value: string | undefined): ClaudeAuthMode {
  if (value === undefined || value === "auto") return "auto";
  if (value === "subscription" || value === "api-key") return value;
  throw new Error(`Unsupported Claude authentication mode: ${value}. Use subscription, api-key, or auto.`);
}

export function claudeEnvironment(mode: ClaudeAuthMode, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...source };
  if (mode === "auto") return environment;

  const apiKey = environment.ANTHROPIC_API_KEY?.trim();
  delete environment.ANTHROPIC_API_KEY;
  delete environment.ANTHROPIC_AUTH_TOKEN;
  delete environment.CLAUDE_CODE_OAUTH_TOKEN;

  if (mode === "api-key") {
    if (!apiKey) throw new Error("Claude API-key authentication requires ANTHROPIC_API_KEY");
    environment.ANTHROPIC_API_KEY = apiKey;
  }
  return environment;
}

export function parseClaudeAuthStatus(value: unknown): ClaudeAuthStatus {
  if (!value || typeof value !== "object") return { loggedIn: false, source: "unknown" };
  const record = value as Record<string, unknown>;
  const loggedIn = record.loggedIn === true;
  const authMethod = typeof record.authMethod === "string" ? record.authMethod : undefined;
  const subscriptionType = typeof record.subscriptionType === "string" ? record.subscriptionType : undefined;
  if (!loggedIn) return { loggedIn: false, source: authMethod === "none" ? "signed-out" : "unknown", ...(authMethod ? { authMethod } : {}) };
  if (authMethod === "claude.ai" || subscriptionType) return { loggedIn: true, source: "subscription", ...(authMethod ? { authMethod } : {}), ...(subscriptionType ? { subscriptionType } : {}) };
  if (authMethod === "api_key") return { loggedIn: true, source: "api-key", authMethod };
  if (authMethod === "oauth_token") return { loggedIn: true, source: "oauth", authMethod };
  return { loggedIn: true, source: "unknown", ...(authMethod ? { authMethod } : {}) };
}

export async function readClaudeAuthStatus(executable: string, environment: NodeJS.ProcessEnv, timeoutMs = 5_000): Promise<ClaudeAuthStatus> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(executable, ["auth", "status", "--json"], { encoding: "utf8", env: environment, timeout: timeoutMs }, (error, output) => {
      if (output.trim()) {
        try { JSON.parse(output); resolve(output); return; }
        catch { /* Use the process error below when the output is not valid status JSON. */ }
      }
      if (error) { reject(error); return; }
      resolve(output);
    });
  });
  try {
    return parseClaudeAuthStatus(JSON.parse(stdout));
  } catch {
    return { loggedIn: false, source: "unknown" };
  }
}

export interface ResolvedClaudeAuthentication {
  mode: ClaudeAuthMode;
  status?: ClaudeAuthStatus;
}

/**
 * Auto mode prefers the local subscription login, matching
 * `env -u ANTHROPIC_API_KEY claude`, so an ambient API key is only used when no
 * subscription login is available.
 */
export async function resolveClaudeAuthentication(executable: string, mode: ClaudeAuthMode, source: NodeJS.ProcessEnv = process.env): Promise<ResolvedClaudeAuthentication> {
  if (mode !== "auto") {
    const status = await preflightClaudeAuthentication(executable, mode, source);
    return { mode, ...(status ? { status } : {}) };
  }
  const hasAmbientCredential = Boolean(source.ANTHROPIC_API_KEY?.trim() || source.ANTHROPIC_AUTH_TOKEN?.trim() || source.CLAUDE_CODE_OAUTH_TOKEN?.trim());
  if (!hasAmbientCredential) return { mode };
  try {
    const status = await readClaudeAuthStatus(executable, claudeEnvironment("subscription", source));
    if (status.loggedIn && status.source === "subscription") return { mode: "subscription", status };
  } catch { /* Fall back to the ambient credential below. */ }
  return { mode };
}

export async function preflightClaudeAuthentication(executable: string, mode: ClaudeAuthMode, source: NodeJS.ProcessEnv = process.env): Promise<ClaudeAuthStatus | undefined> {
  const environment = claudeEnvironment(mode, source);
  if (mode === "api-key") return { loggedIn: true, source: "api-key", authMethod: "api_key" };
  if (mode === "auto") return undefined;

  let status: ClaudeAuthStatus;
  try {
    status = await readClaudeAuthStatus(executable, environment);
  } catch (error) {
    throw new Error(`Could not check Claude authentication with ${executable}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!status.loggedIn) throw new Error("Claude is not signed in. Run `claude auth login`, then try again.");
  if (status.source === "api-key") throw new Error("Claude resolved an API key instead of a subscription login. Run `claude auth login` or select API-key authentication explicitly.");
  return status;
}
