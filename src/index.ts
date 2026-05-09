/**
 * vibe-plugin-bridle
 *
 * Cross-harness configuration management via Bridle CLI.
 * Exposes REST routes for profile management, skill installation,
 * and config editing across Claude Code, OpenCode, Goose, Amp, Copilot, and Crush.
 */

import { Elysia, t } from "elysia";
import type {
  HostServices,
  ProfileContext,
  VibePlugin,
  VibePluginFactory,
} from "@vibecontrols/plugin-sdk";
import {
  BoundLogger,
  TelemetryEmitter,
  createLifecycleHooks,
} from "@vibecontrols/plugin-sdk";

// ── Helper: run bridle CLI ───────────────────────────────────────────────

async function runBridle(
  args: string[],
  jsonOutput = true,
): Promise<{ ok: boolean; output: string; parsed?: unknown }> {
  const fullArgs = [...args];
  if (jsonOutput) fullArgs.push("-o", "json");

  try {
    const proc = Bun.spawn(["bridle", ...fullArgs], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return { ok: false, output: stderr.trim() || stdout.trim() || `Exit code ${exitCode}` };
    }

    const output = stdout.trim();
    if (jsonOutput) {
      try {
        return { ok: true, output, parsed: JSON.parse(output) };
      } catch {
        return { ok: true, output };
      }
    }
    return { ok: true, output };
  } catch (err) {
    return {
      ok: false,
      output: err instanceof Error ? err.message : "Failed to run bridle",
    };
  }
}

// ── Routes ───────────────────────────────────────────────────────────────

function createBridleRoutes() {
  return new Elysia()
    // Status
    .get("/status", async () => {
      const result = await runBridle(["status"]);
      return result.ok
        ? { status: "ok", data: result.parsed ?? result.output }
        : { status: "error", error: result.output };
    })

    // Init
    .post("/init", async () => {
      const result = await runBridle(["init"], false);
      return result.ok
        ? { status: "ok", message: result.output }
        : { status: "error", error: result.output };
    })

    // List profiles
    .get(
      "/profiles/:harness",
      async ({ params }) => {
        const result = await runBridle(["profile", "list", params.harness]);
        return result.ok
          ? { profiles: result.parsed ?? result.output }
          : { error: result.output };
      },
      { params: t.Object({ harness: t.String() }) },
    )

    // Show profile
    .get(
      "/profiles/:harness/:name",
      async ({ params }) => {
        const result = await runBridle([
          "profile",
          "show",
          params.harness,
          params.name,
        ]);
        return result.ok
          ? { profile: result.parsed ?? result.output }
          : { error: result.output };
      },
      { params: t.Object({ harness: t.String(), name: t.String() }) },
    )

    // Create profile
    .post(
      "/profiles/:harness",
      async ({ params, body }) => {
        const args = ["profile", "create", params.harness, body.name];
        if (body.fromCurrent) args.push("--from-current");
        const result = await runBridle(args, false);
        return result.ok
          ? { status: "ok", message: result.output }
          : { error: result.output };
      },
      {
        params: t.Object({ harness: t.String() }),
        body: t.Object({
          name: t.String({ minLength: 1 }),
          fromCurrent: t.Optional(t.Boolean()),
        }),
      },
    )

    // Switch profile
    .put(
      "/profiles/:harness/:name/switch",
      async ({ params }) => {
        const result = await runBridle(
          ["profile", "switch", params.harness, params.name],
          false,
        );
        return result.ok
          ? { status: "ok", message: result.output }
          : { error: result.output };
      },
      { params: t.Object({ harness: t.String(), name: t.String() }) },
    )

    // Delete profile
    .delete(
      "/profiles/:harness/:name",
      async ({ params }) => {
        const result = await runBridle(
          ["profile", "delete", params.harness, params.name],
          false,
        );
        return result.ok
          ? { status: "ok" }
          : { error: result.output };
      },
      { params: t.Object({ harness: t.String(), name: t.String() }) },
    )

    // Diff profiles
    .get(
      "/profiles/:harness/:name/diff",
      async ({ params, query }) => {
        const args = ["profile", "diff", params.harness, params.name];
        if (query.other) args.push(query.other);
        const result = await runBridle(args, false);
        return result.ok
          ? { diff: result.output }
          : { error: result.output };
      },
      {
        params: t.Object({ harness: t.String(), name: t.String() }),
        query: t.Object({ other: t.Optional(t.String()) }),
      },
    )

    // Install from GitHub
    .post(
      "/install",
      async ({ body }) => {
        const args = ["install", body.source];
        if (body.force) args.push("--force");
        const result = await runBridle(args, false);
        return result.ok
          ? { status: "ok", message: result.output }
          : { error: result.output };
      },
      {
        body: t.Object({
          source: t.String({ minLength: 1 }),
          force: t.Optional(t.Boolean()),
        }),
      },
    )

    // Config get
    .get(
      "/config/:key",
      async ({ params }) => {
        const result = await runBridle(["config", "get", params.key], false);
        return result.ok
          ? { key: params.key, value: result.output }
          : { error: result.output };
      },
      { params: t.Object({ key: t.String() }) },
    )

    // Config set
    .put(
      "/config/:key",
      async ({ params, body }) => {
        const result = await runBridle(
          ["config", "set", params.key, body.value],
          false,
        );
        return result.ok
          ? { status: "ok" }
          : { error: result.output };
      },
      {
        params: t.Object({ key: t.String() }),
        body: t.Object({ value: t.String() }),
      },
    )

    // Health check
    .get("/health", async () => {
      try {
        const proc = Bun.spawnSync(["bridle", "--version"], {
          timeout: 5000,
          stdout: "pipe",
          stderr: "ignore",
        });
        if (proc.exitCode === 0) {
          return {
            ok: true,
            version: proc.stdout.toString().trim(),
          };
        }
        return { ok: false, message: "Bridle not available" };
      } catch {
        return { ok: false, message: "Bridle not installed" };
      }
    });
}

// ── Plugin Export ────────────────────────────────────────────────────────

const PLUGIN_NAME = "bridle";
const PLUGIN_VERSION = "2026.509.3";

/**
 * Plugin contract V2 factory. Builds a fresh VibePlugin (with its own
 * lifecycle/telemetry) per call. Bridle CLI invocations are stateless
 * subprocess spawns, so no module-level state is required.
 */
export const createPlugin: VibePluginFactory = (
  _ctx: ProfileContext,
): VibePlugin => {
  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    telemetryEventName: `${PLUGIN_NAME}.ready`,
    onInit: (hostServices: HostServices) => {
      const log = new BoundLogger(hostServices.logger, PLUGIN_NAME);
      log.info("Bridle plugin ready");
      new TelemetryEmitter(
        PLUGIN_NAME,
        PLUGIN_VERSION,
        hostServices,
      ).emitReady();
    },
  });

  const plugin: VibePlugin = {
    capabilities: {
      storage: "rw",
      secrets: "read",
      broadcast: true,
    },
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description:
      "Cross-harness configuration management via Bridle — profiles, skills, agents, commands, and MCPs",
    tags: ["backend", "cli", "integration"],
    cliCommand: PLUGIN_NAME,
    apiPrefix: "/api/bridle",

    createRoutes() {
      return createBridleRoutes();
    },

    onServerStart: lifecycle.onServerStart,
    onServerStop: lifecycle.onServerStop,
  };

  return plugin;
};
