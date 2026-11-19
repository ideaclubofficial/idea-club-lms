const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function source(name) {
  const match = new RegExp('^    (?:async )?function ' + name + '\\(', 'm').exec(html);
  if (!match) throw new Error('Missing function: ' + name);
  return html.slice(match.index, html.indexOf('\n    }', match.index) + 6);
}
function installStudentDisplayHelpers(context) {
  if (!context.students) context.students = [];
  for (const name of ['studentDisplayText', 'findStudentForDisplay', 'getStudentDisplayNickname', 'getStudentDisplayName', 'getStudentBundleDisplayNames']) {
    vm.runInContext(source(name), context);
  }
}
module.exports = { source, installStudentDisplayHelpers };
