const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const projectRoot = path.resolve(__dirname, "..");
const indexPath = path.join(projectRoot, "index.html");

const assets = [
  {
    name: "highlight.css",
    file: path.join(projectRoot, "public", "highlight.css"),
    updateRegex:
      /(<link[^>]*href="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/highlight\.js\/[^"]+\/styles\/github-dark\.min\.css"[^>]*integrity=")([^"]*)(")/g
  },
  {
    name: "highlight.min.js",
    file: path.join(projectRoot, "public", "highlight.min.js"),
    updateRegex:
      /(<script[^>]*src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/highlight\.js\/[^"]+\/highlight\.min\.js"[^>]*integrity=")([^"]*)(")/g
  }
];

function extractIntegrity(html, regex, name) {
  regex.lastIndex = 0;
  const match = regex.exec(html);
  if (!match) {
    console.error(`Missing integrity tag for ${name} in index.html`);
    return null;
  }

  return match[2];
}

function sha512Base64(filePath) {
  const buffer = fs.readFileSync(filePath);
  return `sha512-${crypto.createHash("sha512").update(buffer).digest("base64")}`;
}

function main() {
  const shouldWrite = process.argv.includes("--write");
  const shouldCheck = process.argv.includes("--check");
  const results = [];
  let hasError = false;

  for (const asset of assets) {
    if (!fs.existsSync(asset.file)) {
      console.error(`Missing file: ${asset.file}`);
      hasError = true;
      continue;
    }

    const integrity = sha512Base64(asset.file);
    results.push({ ...asset, integrity });
    console.log(`${asset.name}: integrity="${integrity}"`);
  }

  if (hasError) {
    process.exitCode = 1;
    return;
  }

  if (!shouldWrite) {
    if (!shouldCheck) {
      return;
    }
  }

  if (!fs.existsSync(indexPath)) {
    console.error(`Missing index.html at: ${indexPath}`);
    process.exitCode = 1;
    return;
  }

  const originalHtml = fs.readFileSync(indexPath, "utf8");
  let updatedHtml = originalHtml;

  if (shouldWrite) {
    for (const result of results) {
      if (!result.updateRegex.test(updatedHtml)) {
        console.warn(`No matching tag found in index.html for ${result.name}`);
        continue;
      }

      updatedHtml = updatedHtml.replace(result.updateRegex, `$1${result.integrity}$3`);
    }

    if (updatedHtml !== originalHtml) {
      fs.writeFileSync(indexPath, updatedHtml, "utf8");
      console.log("index.html updated with new integrity hashes.");
    } else {
      console.log("index.html already up to date.");
    }
  }

  if (shouldCheck) {
    const htmlToCheck = shouldWrite ? updatedHtml : originalHtml;
    let mismatch = false;

    for (const result of results) {
      const existing = extractIntegrity(htmlToCheck, result.updateRegex, result.name);
      if (!existing) {
        mismatch = true;
        continue;
      }

      if (existing !== result.integrity) {
        console.error(
          `SRI mismatch for ${result.name}.\nExpected: ${result.integrity}\nFound:    ${existing}`
        );
        mismatch = true;
      }
    }

    if (mismatch) {
      console.error("SRI mismatch detected. Run: npm run generate:sri -- --write");
      process.exit(1);
    } else {
      console.log("SRI hashes are up-to-date");
    }
  }
}

main();
