#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const upstreamUrl = "https://github.com/addyosmani/agent-skills.git";
const upstreamWebUrl = "https://github.com/addyosmani/agent-skills";
const upstreamSkillPath = "skills/interview-me";
const subtreePrefix = "implementation/third_party/agent-skills/interview-me";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const metadataPath = path.join(scriptDirectory, "UPSTREAM.md");
const licensePath = path.join(scriptDirectory, "LICENSE");
const commitPattern = /^[0-9a-f]{40}$/;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function readPins() {
  const metadata = readFileSync(metadataPath, "utf8");
  const source = metadata.match(/Pinned upstream commit: `([0-9a-f]{40})`/);
  const split = metadata.match(/Synthetic split commit: `([0-9a-f]{40})`/);

  if (!source || !split) {
    throw new Error("UPSTREAM.md does not contain valid source and split pins.");
  }

  return {
    metadata,
    sourceCommit: source[1],
    splitCommit: split[1],
  };
}

function verifyLocal() {
  const pins = readPins();
  const license = readFileSync(licensePath, "utf8");
  const skill = readFileSync(
    path.join(repositoryRoot, subtreePrefix, "SKILL.md"),
    "utf8",
  );

  if (!license.startsWith("MIT License\n")) {
    throw new Error("Vendored agent-skills license is not the expected MIT text.");
  }
  if (!license.includes("Copyright (c) 2025 Addy Osmani")) {
    throw new Error("Vendored agent-skills copyright notice is missing.");
  }
  if (!/^---\nname: interview-me\n/m.test(skill)) {
    throw new Error("Vendored interview-me skill is missing or has changed identity.");
  }

  return pins;
}

function inspectUpstream() {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "codex-small-loop-agent-skills-"),
  );
  const cloneDirectory = path.join(temporaryRoot, "repository");

  try {
    run(
      "git",
      ["clone", "--quiet", "--no-tags", upstreamUrl, cloneDirectory],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    const sourceCommit = run(
      "git",
      ["rev-parse", "origin/main"],
      { cwd: cloneDirectory },
    ).trim();
    const upstreamLicense = run(
      "git",
      ["show", `${sourceCommit}:LICENSE`],
      { cwd: cloneDirectory },
    );
    const splitCommit = run(
      "git",
      ["subtree", "split", `--prefix=${upstreamSkillPath}`, sourceCommit],
      { cwd: cloneDirectory },
    ).trim();

    if (!commitPattern.test(sourceCommit) || !commitPattern.test(splitCommit)) {
      throw new Error("Upstream inspection did not produce valid commit pins.");
    }

    return {
      cloneDirectory,
      sourceCommit,
      splitCommit,
      upstreamLicense,
      cleanup() {
        rmSync(temporaryRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertCleanWorktree() {
  const status = run("git", ["status", "--porcelain"]).trim();

  if (status) {
    throw new Error(
      "Apply requires a clean worktree so the subtree commit stays isolated.",
    );
  }
}

function updatePins(metadata, sourceCommit, splitCommit) {
  return metadata
    .replace(
      /Pinned upstream commit: `[0-9a-f]{40}`/,
      `Pinned upstream commit: \`${sourceCommit}\``,
    )
    .replace(
      /Synthetic split commit: `[0-9a-f]{40}`/,
      `Synthetic split commit: \`${splitCommit}\``,
    );
}

function printHelp() {
  process.stdout.write(`Usage:
  node implementation/third_party/agent-skills/update-interview-me.mjs --verify-local
  node implementation/third_party/agent-skills/update-interview-me.mjs --check
  node implementation/third_party/agent-skills/update-interview-me.mjs --apply <reviewed-commit>
`);
}

function main() {
  const [command, expectedCommit] = process.argv.slice(2);

  if (command === "--verify-local") {
    const pins = verifyLocal();
    process.stdout.write(
      JSON.stringify(
        {
          status: "valid",
          sourceCommit: pins.sourceCommit,
          splitCommit: pins.splitCommit,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  if (command !== "--check" && command !== "--apply") {
    printHelp();
    process.exitCode = command ? 1 : 0;
    return;
  }

  const local = verifyLocal();
  if (command === "--apply") {
    if (!expectedCommit || !commitPattern.test(expectedCommit)) {
      throw new Error("--apply requires the exact 40-character reviewed commit.");
    }
    assertCleanWorktree();
  }

  const upstream = inspectUpstream();

  try {
    const compareUrl =
      `${upstreamWebUrl}/compare/${local.sourceCommit}...${upstream.sourceCommit}`;

    if (command === "--check") {
      process.stdout.write(
        JSON.stringify(
          {
            currentCommit: local.sourceCommit,
            latestCommit: upstream.sourceCommit,
            updateAvailable: local.sourceCommit !== upstream.sourceCommit,
            compareUrl,
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }

    if (expectedCommit !== upstream.sourceCommit) {
      throw new Error(
        `Reviewed commit ${expectedCommit} is not current upstream main ${upstream.sourceCommit}.`,
      );
    }
    if (local.sourceCommit === upstream.sourceCommit) {
      throw new Error("The vendored interview-me skill is already current.");
    }

    const localLicense = readFileSync(licensePath, "utf8").trimEnd();
    if (upstream.upstreamLicense.trimEnd() !== localLicense) {
      throw new Error(
        "Upstream LICENSE changed. Review and update the vendored license before applying.",
      );
    }

    run(
      "git",
      [
        "subtree",
        "pull",
        `--prefix=${subtreePrefix}`,
        upstream.cloneDirectory,
        upstream.splitCommit,
        "--squash",
      ],
      { stdio: "inherit" },
    );

    writeFileSync(
      metadataPath,
      updatePins(local.metadata, upstream.sourceCommit, upstream.splitCommit),
    );
    run("git", ["add", path.relative(repositoryRoot, metadataPath)]);
    run("git", ["commit", "--amend", "--no-edit"], { stdio: "inherit" });

    process.stdout.write(
      `Updated interview-me to ${upstream.sourceCommit}. Review the commit and run the contract tests.\n`,
    );
  } finally {
    upstream.cleanup();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `update-interview-me: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
