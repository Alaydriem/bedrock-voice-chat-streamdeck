import { readFileSync, writeFileSync } from "fs";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node patch-versions.js <version>");
  process.exit(1);
}

console.log(`Patching versions to ${version}`);

// Patch package.json
const packageJsonPath = "package.json";
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
packageJson.version = version;
writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 4) + "\n");
console.log(`  Updated ${packageJsonPath}`);

// Patch manifest.json - Stream Deck uses 4-component versions (major.minor.patch.build)
const manifestPath =
  "com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/manifest.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

// Parse semver and convert to 4-component version
const semverMatch = version.match(/^(\d+)\.(\d+)\.(\d+)/);
if (semverMatch) {
  const [, major, minor, patch] = semverMatch;
  manifest.Version = `${major}.${minor}.${patch}.0`;
} else {
  manifest.Version = `${version}.0`;
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");
console.log(`  Updated ${manifestPath} to ${manifest.Version}`);
