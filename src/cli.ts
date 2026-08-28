#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { providerNames, type ProviderName } from "./domain.js";
import { Manager } from "./manager.js";
import {
  checkoutDatabasePath,
  FileCheckoutStore,
  normalizeCheckoutPath,
} from "./checkouts.js";

interface Options {
  objective: string;
  repo: string;
  providers: ProviderName[];
  dryRun: boolean;
  retries: number;
  timeoutMs: number;
  validationCommands?: string[];
  integrate: boolean;
}

function usage(): never {
  process.stderr.write(
    "Usage:\n" +
      "  codepilot run <objective> [--repo <path>] [--agents codex,claude] [--retry <count>] [--timeout <seconds>] [--validate <command>] [--no-integrate] [--dry-run]\n" +
      "  codepilot checkout acquire --owner <task-id> [--repo <path>] [--wait <seconds>] [--lease <seconds>] -- <paths...>\n" +
      "  codepilot checkout release --owner <task-id> [--repo <path>] [-- <paths...>]\n" +
      "  codepilot checkout renew --owner <task-id> [--repo <path>] [--lease <seconds>]\n" +
      "  codepilot checkout list [--repo <path>]\n",
  );
  process.exit(2);
}

export function parseArgs(args: string[]): Options {
  if (args[0] !== "run" || !args[1]) usage();
  const options: Options = {
    objective: args[1],
    repo: process.cwd(),
    providers: ["codex"],
    dryRun: false,
    retries: 0,
    timeoutMs: 30 * 60_000,
    integrate: true,
  };

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-integrate") options.integrate = false;
    else if (arg === "--retry" && args[index + 1]) {
      options.retries = Number.parseInt(args[++index]!, 10);
      if (!Number.isSafeInteger(options.retries) || options.retries < 0) usage();
    } else if (arg === "--timeout" && args[index + 1]) {
      options.timeoutMs = Number.parseInt(args[++index]!, 10) * 1_000;
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) usage();
    } else if (arg === "--validate" && args[index + 1]) {
      (options.validationCommands ??= []).push(args[++index]!);
    }
    else if (arg === "--repo" && args[index + 1]) options.repo = resolve(args[++index]!);
    else if (arg === "--agents" && args[index + 1]) {
      const requested = args[++index]!.split(",");
      if (requested.some((name) => !providerNames.includes(name as ProviderName))) usage();
      options.providers = requested as ProviderName[];
    } else usage();
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] === "checkout") {
    await runCheckoutCommand(args.slice(1));
  } else {
    const options = parseArgs(args);
    const manager = new Manager();
    const summary = await manager.run(options, (event) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    });
    if (!options.dryRun) process.stdout.write(`${JSON.stringify({ type: "run_summary", ...summary }, null, 2)}\n`);
  }
}

async function runCheckoutCommand(args: string[]): Promise<void> {
  const action = args[0];
  if (!["acquire", "release", "renew", "list"].includes(action ?? "")) usage();
  let repo = process.cwd();
  let owner = "";
  let waitSeconds = 0;
  let leaseSeconds = 30 * 60;
  let priority = 50;
  const paths: string[] = [];
  let readingPaths = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") readingPaths = true;
    else if (readingPaths) paths.push(arg);
    else if (arg === "--repo" && args[index + 1]) repo = resolve(args[++index]!);
    else if (arg === "--owner" && args[index + 1]) owner = args[++index]!;
    else if (arg === "--wait" && args[index + 1]) waitSeconds = positiveNumber(args[++index]!);
    else if (arg === "--lease" && args[index + 1]) leaseSeconds = positiveNumber(args[++index]!);
    else if (arg === "--priority" && args[index + 1]) priority = positiveNumber(args[++index]!);
    else usage();
  }
  using store = new FileCheckoutStore(checkoutDatabasePath(repo));
  if (action === "list") {
    process.stdout.write(`${JSON.stringify(store.list(), null, 2)}\n`);
    return;
  }
  if (!owner) usage();
  if (action === "acquire") {
    const normalized = paths.map((path) => normalizeCheckoutPath(repo, path));
    const checkouts = await store.acquire(owner, normalized, {
      waitMs: waitSeconds * 1_000,
      leaseMs: leaseSeconds * 1_000,
      priority,
    });
    process.stdout.write(`${JSON.stringify({ acquired: checkouts }, null, 2)}\n`);
  } else if (action === "release") {
    const normalized = paths.map((path) => normalizeCheckoutPath(repo, path));
    process.stdout.write(`${JSON.stringify({ released: store.release(owner, normalized.length ? normalized : undefined) })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ renewed: store.renew(owner, leaseSeconds * 1_000) })}\n`);
  }
}

function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) usage();
  return parsed;
}
