const { execFile, spawn } = require("node:child_process");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { delimiter, join } = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const repository = "cresset-tools/magequery";

function input(name, fallback = "") {
  return process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`] ?? fallback;
}

function commandArgs(value) {
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

function releaseTag(version) {
  if (version.startsWith("magequery-v")) return version;
  return `magequery-v${version.replace(/^v/, "")}`;
}

async function fetchText(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  return response.text();
}

async function latestTag(token) {
  const body = await fetchText(`https://api.github.com/repos/${repository}/releases/latest`, token);
  const release = JSON.parse(body);
  if (!release.tag_name) throw new Error("latest magequery release did not include a tag name");
  return release.tag_name;
}

async function install(version, token) {
  const tag = version === "latest" ? await latestTag(token) : releaseTag(version);
  const windows = process.platform === "win32";
  const asset = `magequery-installer.${windows ? "ps1" : "sh"}`;
  const url = `https://github.com/${repository}/releases/download/${tag}/${asset}`;
  const directory = await mkdtemp(join(tmpdir(), "magequery-action-"));
  const installer = join(directory, asset);
  const binDir = join(directory, "bin");
  await writeFile(installer, await fetchText(url, token), { mode: 0o700 });

  const env = { ...process.env, XDG_BIN_HOME: binDir };
  if (windows) {
    await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer], { env });
  } else {
    await execFileAsync("sh", [installer], { env });
  }

  return { binary: join(binDir, windows ? "magequery.exe" : "magequery"), tag, binDir };
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`magequery exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

async function main() {
  const requestedVersion = input("version", "latest").trim() || "latest";
  const root = input("root", ".");
  const args = commandArgs(input("args", "doctor"));
  const token = input("github-token");
  const { binary, tag, binDir } = await install(requestedVersion, token);

  const { stdout } = await execFileAsync(binary, ["--version"]);
  const version = stdout.trim();
  console.log(`Installed magequery ${version} from ${tag}`);
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH}`;
  if (process.env.GITHUB_PATH) await writeFile(process.env.GITHUB_PATH, `${binDir}\n`, { flag: "a" });

  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `magequery-version=${version}\n`, { flag: "a" });
  }

  await run(binary, ["--root", root, ...args], process.env);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
