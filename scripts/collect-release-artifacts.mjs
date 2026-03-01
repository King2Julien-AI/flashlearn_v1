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

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function newestMatch(files, predicate) {
  return files
    .filter(predicate)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
}

function readVersion() {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  return packageJson.version;
}

function productBaseName() {
  const config = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
  return config.productName ?? "app";
}

function updaterExtension(filePath) {
  const basename = path.basename(filePath);
  const patterns = [
    ".app.tar.gz",
    ".AppImage.tar.gz",
    ".AppImage",
    ".msi.zip",
    ".exe.zip",
    ".msi"
  ];
  const match = patterns.find((suffix) => basename.endsWith(suffix));
  if (!match) {
    throw new Error(`Unsupported updater artifact: ${basename}`);
  }
  return match;
}

function pickArtifacts(platformKey, files) {
  if (platformKey.startsWith("darwin-")) {
    return {
      manual: newestMatch(files, (file) => file.endsWith(".dmg")),
      updater: newestMatch(files, (file) => file.endsWith(".app.tar.gz"))
    };
  }

  if (platformKey.startsWith("linux-")) {
    return {
      manual: newestMatch(
        files,
        (file) => file.endsWith(".AppImage") && !file.endsWith(".AppImage.sig")
      ),
      updater:
        newestMatch(files, (file) => file.endsWith(".AppImage.tar.gz")) ??
        newestMatch(
          files,
          (file) => file.endsWith(".AppImage") && !file.endsWith(".AppImage.sig")
        )
    };
  }

  if (platformKey.startsWith("windows-")) {
    return {
      manual: newestMatch(files, (file) => file.endsWith(".msi")),
      updater:
        newestMatch(files, (file) => file.endsWith(".msi.zip")) ??
        newestMatch(files, (file) => file.endsWith(".exe.zip")) ??
        newestMatch(files, (file) => file.endsWith(".msi"))
    };
  }

  throw new Error(`Unsupported platform key: ${platformKey}`);
}

function relativeSigPath(filePath) {
  const candidate = `${filePath}.sig`;
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`Missing signature for updater artifact: ${path.basename(filePath)}`);
}

const args = parseArgs(process.argv);
const outDir = args["out-dir"];
const platformKey = args["platform-key"];
const manualName = args["manual-name"];

if (!outDir || !platformKey || !manualName) {
  throw new Error("Expected --out-dir, --platform-key and --manual-name");
}

const version = readVersion();
const productName = productBaseName();
const targetRoot = path.resolve("src-tauri/target");
const allFiles = walk(targetRoot);
const { manual, updater } = pickArtifacts(platformKey, allFiles);

if (!updater) throw new Error(`Could not find updater bundle for ${platformKey}`);

const updaterSig = relativeSigPath(updater);
const manualSource = manual ?? updater;
const updaterOutName = `${productName}-${version}-${platformKey}-updater${updaterExtension(updater)}`;
const updaterSigOutName = `${updaterOutName}.sig`;
const manualOutName = `${productName}-${version}-${manualName}`;

ensureDir(outDir);
copyFile(updater, path.join(outDir, updaterOutName));
copyFile(updaterSig, path.join(outDir, updaterSigOutName));

if (path.resolve(manualSource) !== path.resolve(updater) || manualOutName !== updaterOutName) {
  copyFile(manualSource, path.join(outDir, manualOutName));
}

const manifest = {
  version,
  platformKey,
  updaterFile: updaterOutName,
  signatureFile: updaterSigOutName
};

fs.writeFileSync(
  path.join(outDir, `${platformKey}.updater-manifest.json`),
  JSON.stringify(manifest, null, 2)
);
