/* global console */
const fs = require('fs');
const d = fs.readFileSync('./eslint-output.json', 'utf8');
const data = JSON.parse(d);
const files = {};
data.forEach(f => {
  f.messages.forEach(m => {
    if (m.ruleId && m.ruleId.includes('no-unsafe')) {
      const p = f.filePath.replace(/\\/g, '/');
      const short = p.replace(/^.*?src/, 'src');
      if (!files[short]) files[short] = 0;
      files[short]++;
    }
  });
});
Object.entries(files)
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(v, k));
