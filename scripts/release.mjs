import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/release.mjs <version> (e.g. 0.1.1)");
  process.exit(1);
}

const root = process.cwd();

// 1. package.json
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// 2. src-tauri/tauri.conf.json
const tauriConfPath = path.join(root, "src-tauri", "tauri.conf.json");
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
tauriConf.version = version;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");

// 3. src-tauri/Cargo.toml
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
const cargoRaw = fs.readFileSync(cargoPath, "utf8");
const cargoUpdated = cargoRaw.replace(
  /^version\s*=\s*"[^"]*"/m,
  `version = "${version}"`
);
fs.writeFileSync(cargoPath, cargoUpdated);

const tag = `v${version}`;
const run = (cmd) => execSync(cmd, { stdio: "inherit" });

run("git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml");
run(`git commit -m "Release ${tag}"`);
run(`git tag ${tag}`);
run("git push");
run(`git push origin ${tag}`);

console.log(`\nPushed ${tag}. GitHub Actions will build and publish the release.`);
