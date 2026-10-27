const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const tag = process.env.GITHUB_REF_NAME;
if (!tag) throw new Error("GITHUB_REF_NAME is required for a tagged release build");
if (tag !== `v${version}`) throw new Error(`Release tag ${tag} must match package version v${version}`);
process.stdout.write(`Release tag ${tag} matches package version ${version}\n`);
