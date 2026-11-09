// Turns qa/results/results.json (Playwright) into qa/findings/<timestamp>.md plus qa/findings/latest.md.
// Exploratory findings added by the qa-tester agent are appended by the agent itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'results', 'results.json');
if (!fs.existsSync(src)) {
  console.error('qa/report: no results.json (did the suite crash before running?)');
  process.exit(0);
}
const data = JSON.parse(fs.readFileSync(src, 'utf8'));
const rows = [];
const walk = (suite, file) => {
  const f = suite.file ?? file;
  for (const s of suite.specs ?? []) {
    for (const t of s.tests ?? []) {
      const last = t.results?.[t.results.length - 1];
      rows.push({
        file: f,
        title: s.title,
        status: t.status, // expected | unexpected | skipped | flaky
        ms: last?.duration ?? 0,
        errors: (last?.errors ?? []).map((e) => (e.message ?? '').replace(/\x1b\[[0-9;]*m/g, '')),
        line: s.line,
        shots: (last?.attachments ?? []).filter((a) => a.path).map((a) => path.relative(path.join(here, '..'), a.path)),
      });
    }
  }
  for (const c of suite.suites ?? []) walk(c, f);
};
for (const s of data.suites ?? []) walk(s, s.file);

const failed = rows.filter((r) => r.status === 'unexpected' || r.status === 'flaky');
const skipped = rows.filter((r) => r.status === 'skipped');
const passed = rows.filter((r) => r.status === 'expected');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const clean = (s) => s.split('\n').filter((l) => l.trim()).slice(0, 14).join('\n');

let md = `# QA findings (automated suite) - ${new Date().toISOString()}\n\n`;
md += `- Passed: ${passed.length}\n- Failed: ${failed.length}\n- Skipped / did not run: ${skipped.length}\n`;
if (skipped.length) md += `\n> Skipped tests usually mean an earlier test in the same serial flow failed. Fix that first, then re-run.\n`;
md += `\n## Failures\n`;
if (!failed.length) md += `\nNone.\n`;
failed.forEach((r, i) => {
  md += `\n### AUTO-${String(i + 1).padStart(3, '0')}: ${r.title}\n`;
  md += `- File: qa/tests/${path.basename(r.file)}:${r.line}\n- Status: ${r.status}\n`;
  if (r.shots.length) md += `- Evidence: ${r.shots.join(', ')}\n`;
  md += `\n\`\`\`\n${clean(r.errors.join('\n---\n'))}\n\`\`\`\n`;
});
if (skipped.length) md += `\n## Did not run\n${skipped.map((r) => `- ${r.title} (${path.basename(r.file)})`).join('\n')}\n`;
md += `\n## Passed\n${passed.map((r) => `- ${r.title}`).join('\n')}\n`;

fs.mkdirSync(path.join(here, 'findings'), { recursive: true });
fs.writeFileSync(path.join(here, 'findings', `${stamp}.md`), md);
fs.writeFileSync(path.join(here, 'findings', 'latest.md'), md);
console.log(`\nQA summary: ${passed.length} passed, ${failed.length} failed, ${skipped.length} not run. Report: qa/findings/latest.md`);
process.exitCode = failed.length ? 1 : 0;
