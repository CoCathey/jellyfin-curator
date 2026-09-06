// Entry point launchd runs on a Mac. Lives in the install directory next to
// dist/, node_modules/, .env and state.json (see scripts/install-mac.sh), all
// on the internal disk: macOS lets a launchd-spawned process see but not read
// files on an external volume, so nothing here touches the SSD checkout.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, ".env"), "utf8").split("\n")) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (!m || line.trimStart().startsWith("#")) continue;
  if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
}
console.log(`=== ${new Date().toISOString()} scheduled run ===`);
const { main } = await import("./dist/cli.js");
process.exitCode = await main(process.argv.slice(2).length ? process.argv.slice(2) : ["run"]);
