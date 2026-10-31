import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAuthMode, claudeEnvironment, parseClaudeAuthStatus, resolveClaudeAuthentication } from "./claude-auth.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

/** Fake Claude CLI that reports an API key when one is visible and otherwise the given login. */
async function fakeClaude(withoutKey: object): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "multicode-claude-auth-"));
  directories.push(directory);
  const executable = path.join(directory, "claude");
  const withKey = JSON.stringify({ loggedIn: true, authMethod: "api_key" });
  await writeFile(executable, `#!/usr/bin/env node\nprocess.stdout.write(process.env.ANTHROPIC_API_KEY ? ${JSON.stringify(withKey)} : ${JSON.stringify(JSON.stringify(withoutKey))});\n`);
  await chmod(executable, 0o755);
  return executable;
}

describe("Claude authentication", () => {
  it("validates authentication modes", () => {
    expect(claudeAuthMode(undefined)).toBe("auto");
    expect(claudeAuthMode("subscription")).toBe("subscription");
    expect(claudeAuthMode("api-key")).toBe("api-key");
    expect(() => claudeAuthMode("other")).toThrow(/Unsupported Claude authentication mode/);
  });

  it("isolates subscription authentication from ambient credentials", () => {
    expect(claudeEnvironment("subscription", {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "api-secret",
      ANTHROPIC_AUTH_TOKEN: "auth-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
    })).toEqual({ PATH: "/bin" });
  });

  it("requires and isolates an API key in API-key mode", () => {
    expect(claudeEnvironment("api-key", {
      PATH: "/bin",
      ANTHROPIC_API_KEY: " api-secret ",
      ANTHROPIC_AUTH_TOKEN: "auth-secret",
    })).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "api-secret" });
    expect(() => claudeEnvironment("api-key", { PATH: "/bin" })).toThrow(/requires ANTHROPIC_API_KEY/);
  });

  it("classifies status responses without depending on account identity fields", () => {
    expect(parseClaudeAuthStatus({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "private@example.com" })).toEqual({
      loggedIn: true, source: "subscription", authMethod: "claude.ai", subscriptionType: "max",
    });
    expect(parseClaudeAuthStatus({ loggedIn: true, authMethod: "api_key" })).toEqual({ loggedIn: true, source: "api-key", authMethod: "api_key" });
    expect(parseClaudeAuthStatus({ loggedIn: true, authMethod: "oauth_token" })).toEqual({ loggedIn: true, source: "oauth", authMethod: "oauth_token" });
    expect(parseClaudeAuthStatus({ loggedIn: false, authMethod: "none" })).toEqual({ loggedIn: false, source: "signed-out", authMethod: "none" });
    expect(parseClaudeAuthStatus({ loggedIn: true, authMethod: "future_method" })).toEqual({ loggedIn: true, source: "unknown", authMethod: "future_method" });
    expect(parseClaudeAuthStatus("invalid")).toEqual({ loggedIn: false, source: "unknown" });
  });

  it("prefers a subscription login over an ambient API key in auto mode", async () => {
    const executable = await fakeClaude({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
    await expect(resolveClaudeAuthentication(executable, "auto", { PATH: process.env.PATH, ANTHROPIC_API_KEY: "api-secret" })).resolves.toEqual({
      mode: "subscription", status: { loggedIn: true, source: "subscription", authMethod: "claude.ai", subscriptionType: "max" },
    });
  });

  it("keeps the ambient API key in auto mode when no subscription login exists", async () => {
    const executable = await fakeClaude({ loggedIn: false, authMethod: "none" });
    await expect(resolveClaudeAuthentication(executable, "auto", { PATH: process.env.PATH, ANTHROPIC_API_KEY: "api-secret" })).resolves.toEqual({ mode: "auto" });
  });

  it("leaves auto mode untouched without ambient credentials", async () => {
    await expect(resolveClaudeAuthentication("/nonexistent/claude", "auto", { PATH: "/bin" })).resolves.toEqual({ mode: "auto" });
  });
});
