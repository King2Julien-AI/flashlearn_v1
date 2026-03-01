import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--") || value == null) {
      throw new Error(`Invalid arguments near ${key ?? "<end>"}`);
    }
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

const args = parseArgs(process.argv);
const assetsDir = args["assets-dir"];
const repo = args.repo;
const tag = args.tag;
const version = args.version;

if (!assetsDir || !repo || !tag || !version) {
  throw new Error("Expected --assets-dir, --repo, --tag and --version");
}

const manifests = fs
  .readdirSync(assetsDir)
  .filter((file) => file.endsWith(".updater-manifest.json"))
  .map((file) => JSON.parse(fs.readFileSync(path.join(assetsDir, file), "utf8")));

if (manifests.length === 0) {
  throw new Error("No updater manifests were found");
}

const platforms = {};
for (const manifest of manifests) {
  const signature = fs
    .readFileSync(path.join(assetsDir, manifest.signatureFile), "utf8")
    .trim();

  platforms[manifest.platformKey] = {
    signature,
    url: `https://github.com/${repo}/releases/download/${tag}/${manifest.updaterFile}`
  };
}

const latest = {
  version,
  notes: `FlashLearn ${version}`,
  pub_date: new Date().toISOString(),
  platforms
};

fs.writeFileSync(
  path.join(assetsDir, "latest.json"),
  JSON.stringify(latest, null, 2)
);
