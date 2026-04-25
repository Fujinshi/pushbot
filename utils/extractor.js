const AdmZip = require('adm-zip');
const { promises: fs } = require('fs');
const path = require('path');
const os = require('os');

async function extractZip(zipPath) {
  const outputDir = path.join(os.tmpdir(), `extract-${Date.now()}`);
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(outputDir, true);
  return outputDir;
}

module.exports = { extractZip };