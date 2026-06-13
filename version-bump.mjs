/**
 * version-bump.mjs
 * 
 * Atualiza a versão no manifest.json e versions.json a partir do package.json.
 * Uso: node version-bump.mjs
 * 
 * Fluxo de release:
 *   1. Edite a versão em package.json
 *   2. Execute: node version-bump.mjs
 *   3. git add manifest.json versions.json package.json
 *   4. git commit -m "chore: bump to X.Y.Z"
 *   5. git tag X.Y.Z
 *   6. git push && git push --tags
 *      → GitHub Actions cria a release automaticamente
 */

import { readFileSync, writeFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const newVersion = pkg.version;

// Atualiza manifest.json
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = newVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");
console.log(`✅ manifest.json → ${newVersion}`);

// Atualiza versions.json
let versions = {};
try {
  versions = JSON.parse(readFileSync("versions.json", "utf8"));
} catch {
  // arquivo não existe ainda, cria do zero
}
versions[newVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
console.log(`✅ versions.json → ${newVersion}: ${minAppVersion}`);

console.log(`\n🚀 Próximos passos:`);
console.log(`   git add manifest.json versions.json package.json`);
console.log(`   git commit -m "chore: bump to ${newVersion}"`);
console.log(`   git tag ${newVersion}`);
console.log(`   git push && git push --tags`);
