#!/usr/bin/env node
// create-dendra-app — scaffold a Next.js app built on dendra.
// Usage: npm create dendra-app@latest [dir] [--template minimal|mcp] [--pm npm|pnpm|yarn|bun]
//                                     [--no-install] [--no-git] [--yes]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(HERE, "templates");
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

function parseArgs(argv) {
  const out = { _: [], install: true, git: true, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--template" || a === "-t") out.template = argv[++i];
    else if (a === "--pm") out.pm = argv[++i];
    else if (a === "--no-install") out.install = false;
    else if (a === "--no-git") out.git = false;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-")) out._.push(a);
  }
  return out;
}

function detectPm(explicit) {
  if (explicit) return explicit;
  const ua = process.env.npm_config_user_agent || "";
  if (ua.startsWith("pnpm")) return "pnpm";
  if (ua.startsWith("yarn")) return "yarn";
  if (ua.startsWith("bun")) return "bun";
  return "npm";
}

function sanitizeName(dir) {
  return path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9-~]/g, "-").replace(/^[-_.]+/, "") || "dendra-app";
}

function copyTemplate(src, dest, vars) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    // npm strips a .gitignore from published packages, so templates ship it as
    // "gitignore"; restore the dot on copy. Same idea for other dotfiles.
    const name = entry.name === "gitignore" ? ".gitignore" : entry.name;
    const to = path.join(dest, name);
    if (entry.isDirectory()) copyTemplate(from, to, vars);
    else {
      let content = fs.readFileSync(from, "utf8");
      for (const [k, v] of Object.entries(vars)) content = content.split(`{{${k}}}`).join(v);
      fs.writeFileSync(to, content);
    }
  }
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  return r.status === 0;
}

function help(templates) {
  console.log(`
${c.bold("create-dendra-app")} — scaffold a Next.js app built on dendra

${c.bold("Usage")}
  npm create dendra-app@latest ${c.dim("[dir]")} ${c.dim("[options]")}

${c.bold("Options")}
  -t, --template <name>   ${templates.join(" | ")}  (default: ${templates[0]})
      --pm <manager>      npm | pnpm | yarn | bun   (default: auto-detect)
      --no-install        skip dependency install
      --no-git            skip git init
  -y, --yes               accept defaults, no prompts
  -h, --help              show this help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const templates = fs.readdirSync(TEMPLATES_DIR).filter((d) =>
    fs.statSync(path.join(TEMPLATES_DIR, d)).isDirectory(),
  );
  if (args.help) return help(templates);

  const interactive = process.stdin.isTTY && !args.yes;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q, def) => {
    if (!rl) return def;
    const a = (await rl.question(`${q} ${c.dim(`(${def})`)} `)).trim();
    return a || def;
  };

  console.log(`\n  ${c.cyan("◆")} ${c.bold("create-dendra-app")}\n`);

  let dir = args._[0] || (await ask("Project directory:", "my-dendra-app"));
  let template = args.template || templates[0];
  if (!args.template && templates.length > 1 && interactive) {
    template = await ask(`Template (${templates.join(" / ")}):`, templates[0]);
  }
  if (!templates.includes(template)) {
    rl?.close();
    console.error(c.red(`\n  Unknown template "${template}". Choose: ${templates.join(", ")}\n`));
    process.exit(1);
  }
  rl?.close();

  const target = path.resolve(process.cwd(), dir);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    console.error(c.red(`\n  ${target} already exists and is not empty.\n`));
    process.exit(1);
  }

  const name = sanitizeName(dir);
  console.log(`\n  Scaffolding ${c.cyan(name)} ${c.dim(`(${template})`)} …`);
  copyTemplate(path.join(TEMPLATES_DIR, template), target, { projectName: name });

  const pm = detectPm(args.pm);
  if (args.install) {
    console.log(`  Installing dependencies with ${c.cyan(pm)} …\n`);
    if (!run(pm, ["install"], target)) {
      console.log(c.red(`\n  Install failed — you can run it yourself later.`));
      args.install = false;
    }
  }
  if (args.git && !fs.existsSync(path.join(target, ".git"))) {
    run("git", ["init", "-q"], target) &&
      run("git", ["add", "-A"], target) &&
      run("git", ["commit", "-q", "-m", "init dendra app"], target);
  }

  const runCmd = pm === "npm" ? "npm run" : pm;
  console.log(`
  ${c.green("✓")} Done! Next steps:

    ${c.cyan(`cd ${dir}`)}${args.install ? "" : `\n    ${c.cyan(`${pm} install`)}`}${
    template === "mcp" ? `\n    ${c.dim("# optional: add ANTHROPIC_API_KEY to .env.local for the AI/MCP demo")}` : ""
  }
    ${c.cyan(`${runCmd} dev`)}

  Docs: ${c.dim("https://products.techfoundry.io/dendra")}
`);
}

main().catch((e) => {
  console.error(c.red(`\n  ${e?.message || e}\n`));
  process.exit(1);
});
