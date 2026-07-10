/* global console */
const fs = require('fs');
const d = fs.readFileSync('./eslint-output.json', 'utf8');
const r = JSON.parse(d);
r.forEach(f => {
  const msgs = f.messages.filter(m => m.ruleId && m.ruleId.includes('no-unsafe'));
  if (msgs.length > 0) {
    const p = f.filePath.replace(/\\/g, '/').replace(/^.*?src/, 'src');
    console.log('--- ' + p + ' (' + msgs.length + ')');
    msgs.forEach(m => console.log('  L' + m.line + ': ' + m.ruleId + ' - ' + m.message));
  }
});
