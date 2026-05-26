#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const indexPath = path.join(rootDir, "index.html");
const html = fs.readFileSync(indexPath, "utf8");

const scriptBlocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1]);
const inlineScript = scriptBlocks.join("\n");

function fail(message, lines) {
  console.error(`FAIL: ${message}`);
  (lines || []).forEach((line) => console.error(`- ${line}`));
  process.exit(1);
}

function pass(message) {
  console.log(`OK: ${message}`);
}

for (const [index, code] of scriptBlocks.entries()) {
  try {
    new Function(code);
  } catch (error) {
    fail(`inline script ${index + 1} syntax error: ${error.message}`);
  }
}
pass(`${scriptBlocks.length} inline script(s) parsed`);

const staticIds = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
const idCounts = staticIds.reduce((counts, id) => {
  counts[id] = (counts[id] || 0) + 1;
  return counts;
}, {});
const duplicateIds = Object.entries(idCounts).filter(([, count]) => count > 1);
if (duplicateIds.length) {
  fail("duplicate static ids found", duplicateIds.map(([id, count]) => `${id}: ${count}`));
}
pass(`${staticIds.length} static ids checked with no duplicates`);

const functionNames = new Set();
[
  /function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/g,
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
].forEach((regex) => {
  let match;
  while ((match = regex.exec(inlineScript))) {
    functionNames.add(match[1]);
  }
});

const browserGlobals = new Set([
  "alert",
  "confirm",
  "event.stopPropagation",
  "Number",
  "String",
  "Date",
  "parseInt",
  "parseFloat",
  "setTimeout",
  "clearTimeout",
]);

const handlerAttrs = [...html.matchAll(/\s(on(?:click|change|input|submit|keyup|keydown))=["']([^"']+)["']/gi)];
const handlerMissing = [];
handlerAttrs.forEach(([, attr, code]) => {
  const calls = [...code.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g)];
  calls.forEach((call) => {
    const name = call[1];
    if (browserGlobals.has(name)) return;
    if (["if", "for", "while", "switch", "return"].includes(name)) return;
    if (!functionNames.has(name)) {
      handlerMissing.push(`${name} <= ${attr}="${code}"`);
    }
  });
});

if (handlerMissing.length) {
  fail("handler references missing functions", [...new Set(handlerMissing)]);
}
pass(`${handlerAttrs.length} inline handlers reference existing functions`);

const staticIdSet = new Set(staticIds);
const dynamicOrLegacyIds = new Set([
  // Monthly question form is injected dynamically.
  "adminQuestionMonthFilter",
  "adminQuestionTableBody",
  "adminQuestionTimeFilter",
  "adminScorePublishSelect",
  "choiceA",
  "choiceB",
  "choiceC",
  "choiceD",
  "correctChoice",
  "editingQuestionId",
  "monthlyTestDate",
  "monthlyTestTime",
  "questionFormBox",
  "questionImage",
  "questionImagePreviewBox",
  "questionNumber",
  "questionSaveResult",
  "questionSubject",
  "questionSubjectFilter",
  "questionText",

  // Member quick-add panel is injected dynamically in admin students.
  "memberGrade",
  "memberPhone",
  "memberResult",
  "memberStudentName",
  "memberTableBody",

  // Profile grade is created only in older/member flows and guarded at runtime.
  "profileGrade",

  // LINE slip UI and old manual slip preview are retained as guarded legacy code.
  "studentLineGroupBox",
  "studentLineGroupButton",
  "studentLineGroupText",
  "studentSlipOcrPausedNotice",
  "studentSlipOcrResult",
  "studentSlipPreview",
  "studentSlipUpload",
]);

const literalGetElementRefs = [...inlineScript.matchAll(/getElement\(\s*["']([^"']+)["']\s*\)/g)]
  .map((match) => match[1]);
const missingGetElementRefs = [...new Set(literalGetElementRefs)]
  .filter((id) => !staticIdSet.has(id) && !dynamicOrLegacyIds.has(id))
  .sort();

if (missingGetElementRefs.length) {
  fail("unexpected missing getElement ids", missingGetElementRefs);
}
pass(`${new Set(literalGetElementRefs).size} literal getElement refs checked`);

const selectHandlerMissing = [];
[...html.matchAll(/<select\b[^>]*>/gi)].forEach((match) => {
  const tag = match[0];
  const id = (tag.match(/\bid=["']([^"']+)["']/) || [])[1] || "(no id)";
  const onchange = (tag.match(/\bonchange=["']([^"']+)["']/) || [])[1];
  if (!onchange) return;
  const calls = [...onchange.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)];
  calls.forEach((call) => {
    const name = call[1];
    if (!functionNames.has(name)) {
      selectHandlerMissing.push(`${id}: ${name} <= ${onchange}`);
    }
  });
});

if (selectHandlerMissing.length) {
  fail("select onchange references missing functions", selectHandlerMissing);
}
pass("select onchange handlers checked");

console.log("OK: UI handler static check passed");
