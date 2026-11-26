// How the action runs `magequery doctor`. magequery writes GitHub annotations
// itself since `doctor --format github` exists, with what the action's own
// translation of `--json` leaves out (stale baseline entries, the chain under
// a finding, infos as notices). Older pinned versions keep that translation.

/** Whether the user's args already pick doctor's output format. */
export function choosesFormat(args) {
  return args.some((arg) => arg === "--json" || arg === "--format" || arg.startsWith("--format="));
}

/** Whether `magequery doctor --help` lists the GitHub format. */
export function helpOffersGithub(help) {
  return /--format\b/.test(help) && /\bgithub\b/.test(help);
}

/** The argv for one doctor run: `args` with `--format <format>` added. */
export function withFormat(root, args, format) {
  return ["--root", root, ...args, "--format", format];
}
