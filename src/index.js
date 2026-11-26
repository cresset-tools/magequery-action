import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as toolCache from "@actions/tool-cache";

import { choosesFormat, helpOffersGithub, withFormat } from "./doctor.js";

const repository = "cresset-tools/magequery";
const mirrorBase = "https://releases.bougie.tools/github/magequery/releases/download";
const githubBase = `https://github.com/${repository}/releases/download`;
const toolName = "magequery";

function splitArgs(value) {
  const args = [];
  let current = "";
  let quote;

  for (const character of value.trim()) {
    if (character === "'" || character === '"') {
      if (quote === character) quote = undefined;
      else if (!quote) quote = character;
      else current += character;
    } else if (/\s/.test(character) && !quote) {
      if (current) args.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  if (quote) throw new Error("args contains an unmatched quote");
  if (current) args.push(current);
  if (!args.length) throw new Error("args must contain a magequery command");
  return args;
}

function normalizeTag(version) {
  const tag = version.startsWith("magequery-v")
    ? version
    : `magequery-v${version.replace(/^v/, "")}`;
  if (!/^magequery-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`invalid magequery version: ${version}`);
  }
  return tag;
}

async function latestTag(token, asset) {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=20`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "cresset-tools/magequery-action",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`failed to resolve magequery releases (${response.status})`);
  const releases = await response.json();
  const release = releases.find((candidate) => {
    if (candidate.draft || candidate.prerelease) return false;
    const names = new Set((candidate.assets ?? []).map(({ name }) => name));
    return names.has(asset) && names.has(`${asset}.sha256`);
  });
  if (!release) throw new Error(`no complete magequery release contains ${asset}`);
  return normalizeTag(release.tag_name ?? "");
}

function platformVariant() {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") {
    return { target: "aarch64-apple-darwin", extension: ".tar.gz" };
  }
  if (platform === "win32" && arch === "x64") {
    return { target: "x86_64-pc-windows-msvc", extension: ".zip" };
  }
  if (platform === "linux" && arch === "arm64") {
    return { target: "aarch64-unknown-linux-gnu", extension: ".tar.gz" };
  }
  if (platform === "linux" && arch === "x64") {
    const glibc = process.report?.getReport?.().header?.glibcVersionRuntime;
    return {
      target: glibc ? "x86_64-unknown-linux-gnu" : "x86_64-unknown-linux-musl",
      extension: ".tar.gz",
    };
  }
  throw new Error(`unsupported runner: ${platform}/${arch}`);
}

async function downloadAsset(tag, name, token) {
  const sources = [
    { url: `${mirrorBase}/${tag}/${name}` },
    { url: `${githubBase}/${tag}/${name}`, auth: token || undefined },
  ];

  let lastError;
  for (const source of sources) {
    try {
      core.info(`Downloading ${name} from ${new URL(source.url).host}`);
      return await toolCache.downloadTool(source.url, undefined, source.auth);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      core.warning(`Download failed from ${new URL(source.url).host}: ${message}; trying the next source`);
    }
  }
  throw lastError ?? new Error(`failed to download ${name}`);
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function expectedChecksum(tag, asset, token, override) {
  if (override) {
    if (!/^[0-9a-fA-F]{64}$/.test(override)) throw new Error("checksum must be a SHA-256 hex digest");
    return override.toLowerCase();
  }
  const sidecar = await downloadAsset(tag, `${asset}.sha256`, token);
  const contents = (await readFile(sidecar, "utf8")).trim();
  const match = contents.match(/^([0-9a-fA-F]{64})\s+[* ]?(.+)$/);
  if (!match || path.basename(match[2]) !== asset) {
    throw new Error(`invalid checksum sidecar for ${asset}`);
  }
  return match[1].toLowerCase();
}

async function findBinary(directory, binaryName) {
  const direct = path.join(directory, binaryName);
  try {
    await chmod(direct, 0o755);
    return direct;
  } catch {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        return await findBinary(path.join(directory, entry.name), binaryName);
      } catch {
        // Keep looking in other archive directories.
      }
    }
    throw new Error(`archive did not contain ${binaryName}`);
  }
}

async function install(tag, token, checksumOverride) {
  const version = tag.slice("magequery-v".length);
  const variant = platformVariant();
  const cacheArch = variant.target;
  const cached = checksumOverride ? "" : toolCache.find(toolName, version, cacheArch);
  const binaryName = process.platform === "win32" ? "magequery.exe" : "magequery";
  if (cached) {
    core.info(`Using magequery ${version} from the tool cache`);
    return { binary: path.join(cached, binaryName), directory: cached, version };
  }

  const asset = `magequery-${variant.target}${variant.extension}`;
  const [archive, expected] = await Promise.all([
    downloadAsset(tag, asset, token),
    expectedChecksum(tag, asset, token, checksumOverride),
  ]);
  const actual = await sha256(archive);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  }
  core.info(`Verified SHA-256 for ${asset}`);

  const extracted = variant.extension === ".zip"
    ? await toolCache.extractZip(archive)
    : await toolCache.extractTar(archive);
  const extractedBinary = await findBinary(extracted, binaryName);
  const staging = await mkdtemp(path.join(tmpdir(), "magequery-cache-"));
  await mkdir(staging, { recursive: true });
  await copyFile(extractedBinary, path.join(staging, binaryName));
  if (process.platform !== "win32") await chmod(path.join(staging, binaryName), 0o755);

  const directory = process.env.RUNNER_TOOL_CACHE
    ? await toolCache.cacheDir(staging, toolName, version, cacheArch)
    : staging;
  return { binary: path.join(directory, binaryName), directory, version };
}

function annotationProperties(finding) {
  const source = finding.source;
  return {
    title: `magequery: ${finding.lint}`,
    ...(source?.file ? { file: annotationFile(source.file) } : {}),
    ...(source?.line ? { startLine: source.line } : {}),
  };
}

function annotationFile(file) {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace || !path.isAbsolute(file)) return file;
  const relative = path.relative(workspace, file);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." ? relative : file;
}

async function capturedRun(binary, args) {
  let stdout = "";
  let stderr = "";
  const exitCode = await exec.exec(binary, args, {
    ignoreReturnCode: true,
    silent: true,
    listeners: {
      stdout: (data) => { stdout += data.toString(); },
      stderr: (data) => { stderr += data.toString(); },
    },
  });
  return { exitCode, stdout, stderr };
}

async function supportsFormats(binary) {
  const result = await capturedRun(binary, ["doctor", "--help"]);
  return result.exitCode === 0 && helpOffersGithub(result.stdout);
}

async function writeSarif(binary, root, args, file) {
  const result = await capturedRun(binary, withFormat(root, args.filter((arg) => arg !== "--json"), "sarif"));
  try {
    JSON.parse(result.stdout);
  } catch {
    throw new Error(`magequery doctor --format sarif did not return valid JSON: ${result.stderr.trim()}`);
  }
  await writeFile(file, result.stdout);
  core.setOutput("sarif-file", file);
  core.info(`Wrote the SARIF log to ${file}`);
}

async function runDoctor(binary, root, args, sarifFile) {
  const formats = await supportsFormats(binary);
  if (sarifFile && !formats) {
    core.warning("sarif-file needs magequery with `doctor --format sarif`; no SARIF log was written");
  }
  if (formats) {
    // Written before the gate below, so a failing run still uploads its log.
    if (sarifFile) await writeSarif(binary, root, args, sarifFile);
    if (!choosesFormat(args)) {
      // magequery prints the annotations itself, with paths relative to the
      // workspace this runs in.
      const exitCode = await exec.exec(binary, withFormat(root, args, "github"), { ignoreReturnCode: true });
      if (exitCode !== 0) throw new Error(`magequery exited with code ${exitCode}`);
      return;
    }
  }
  return runDoctorJson(binary, root, args);
}

// Annotations from `--json`, for a magequery without `doctor --format github`.
async function runDoctorJson(binary, root, args) {
  const requestedJson = args.includes("--json");
  const commandArgs = ["--root", root, ...args, ...(requestedJson ? [] : ["--json"])];
  const result = await capturedRun(binary, commandArgs);
  if (result.stderr.trim()) core.info(result.stderr.trim());

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    if (result.stdout.trim()) core.info(result.stdout.trim());
    if (result.exitCode !== 0) throw new Error(`magequery exited with code ${result.exitCode}`);
    throw new Error("magequery doctor did not return valid JSON");
  }
  if (requestedJson) process.stdout.write(result.stdout);

  let errors = 0;
  let warnings = 0;
  for (const finding of report.findings ?? []) {
    if (finding.severity === "error") {
      errors += 1;
      core.error(finding.message, annotationProperties(finding));
    } else {
      warnings += 1;
      core.warning(finding.message, annotationProperties(finding));
    }
  }
  core.info(`magequery doctor: ${errors} error(s), ${warnings} warning(s)`);
  if (result.exitCode !== 0) throw new Error(`magequery exited with code ${result.exitCode}`);
}

async function runModuleCheck(binary, root, args) {
  const requestedJson = args.includes("--json");
  const commandArgs = ["--root", root, ...args, ...(requestedJson ? [] : ["--json"])];
  const result = await capturedRun(binary, commandArgs);
  if (result.stderr.trim()) core.info(result.stderr.trim());

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    if (result.stdout.trim()) core.info(result.stdout.trim());
    if (result.exitCode !== 0) throw new Error(`magequery exited with code ${result.exitCode}`);
    throw new Error("magequery modules --check did not return valid JSON");
  }
  if (requestedJson) process.stdout.write(result.stdout);

  for (const module of report.on_disk_not_in_config ?? []) {
    core.error(`module ${module.name} exists on disk but is not registered in app/etc/config.php`, {
      title: "magequery: module-not-registered",
    });
  }
  for (const name of report.in_config_not_on_disk ?? []) {
    core.error(`module ${name} is registered in app/etc/config.php but is missing on disk`, {
      title: "magequery: module-missing-on-disk",
    });
  }
  if (result.exitCode !== 0) throw new Error(`magequery exited with code ${result.exitCode}`);
  core.info("magequery modules --check: module registration is consistent");
}

async function runMagequery(binary, root, args, sarifFile) {
  const help = args.includes("--help") || args.includes("-h");
  if (!help && args[0] === "doctor") return runDoctor(binary, root, args, sarifFile);
  if (sarifFile) core.warning("sarif-file applies to `doctor` only; no SARIF log was written");
  if (!help && args[0] === "modules" && args.includes("--check")) {
    return runModuleCheck(binary, root, args);
  }
  const exitCode = await exec.exec(binary, ["--root", root, ...args], { ignoreReturnCode: true });
  if (exitCode !== 0) throw new Error(`magequery exited with code ${exitCode}`);
}

async function main() {
  const token = core.getInput("github-token");
  const requestedVersion = core.getInput("version").trim() || "latest";
  const variant = platformVariant();
  const asset = `magequery-${variant.target}${variant.extension}`;
  const tag = requestedVersion === "latest" ? await latestTag(token, asset) : normalizeTag(requestedVersion);
  const args = splitArgs(core.getInput("args") || "doctor");
  const root = core.getInput("root") || ".";
  const checksum = core.getInput("checksum").trim();
  const sarifFile = core.getInput("sarif-file").trim();

  const installed = await install(tag, token, checksum);
  core.addPath(installed.directory);
  core.setOutput("magequery-version", installed.version);
  core.info(`Installed magequery ${installed.version} from ${tag}`);
  await runMagequery(installed.binary, root, args, sarifFile);
}

main().catch((error) => core.setFailed(error instanceof Error ? error.message : String(error)));
