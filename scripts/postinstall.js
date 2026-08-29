// postinstall.js — remove legacy skill (spec §8): two skills with the same triggers fight each other.
try {
  const fs = require('fs'), path = require('path'), os = require('os');
  const old = path.join(os.homedir(), '.pi/agent/skills/blocked-fetch');
  if (fs.existsSync(old)) { fs.rmSync(old, { recursive: true, force: true }); console.log('[opencrab] removed legacy skill ' + old); }
} catch (e) { console.error('[opencrab] postinstall: ' + e.message); }
