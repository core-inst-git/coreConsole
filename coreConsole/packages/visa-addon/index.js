'use strict';

const fs = require('fs');
const path = require('path');

function resolveAddonPath() {
  const explicit = process.env.VISA_ADDON_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const candidates = [
    path.join(__dirname, 'build', 'Release', 'visa_addon.node'),
    path.join(__dirname, 'build', 'Debug', 'visa_addon.node'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  const searched = candidates.join(', ');
  throw new Error(`visa_addon.node not found. Build visa-addon first. Searched: ${searched}`);
}

module.exports = require(resolveAddonPath());
