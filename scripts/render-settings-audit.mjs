import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const audit = JSON.parse(await fs.readFile(path.join(root, 'docs/settings-audit.json'), 'utf8'));
const counts = {};
for (const item of audit.settings) counts[item.status] = (counts[item.status] || 0) + 1;
const pendingCount = counts.pending || 0;
const auditStatus =
  pendingCount === 0
    ? `Audit complete: functional evidence recorded for all ${audit.settings.length} inventory entries.`
    : `Goal remains active: ${pendingCount} inventory entries still need functional evidence.`;
const escapeCell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const lines = [
  '# Xyst individual settings audit',
  '',
  `Updated: ${audit.updated}. ${auditStatus}`,
  '',
  audit.scope,
  '',
  `Inventory: ${audit.settings.length} entries. ${Object.entries(counts)
    .map(([status, count]) => `${status}: ${count}`)
    .join('; ')}.`,
  '',
  'Fixture verification proves local application behavior with controlled providers. It does not assert that every external provider honors an option or that every setting combination has been tested.',
  '',
  '| Setting or control | Status | Control | Functional evidence |',
  '| --- | --- | --- | --- |',
];
for (const item of audit.settings)
  lines.push(
    `| ${escapeCell(item.setting)} | ${escapeCell(item.status)} | ${escapeCell(item.control || 'Not yet mapped')} | ${escapeCell(item.functional.join('; ') || 'Pending workflow evidence')} |`,
  );
if (audit.verification_runs?.length) {
  lines.push('', '## Verification runs', '');
  for (const run of audit.verification_runs) {
    const sentence = (value) => String(value).replace(/[.\s]+$/, '');
    lines.push(
      `- **${run.platform} — ${run.name}:** ${sentence(run.result)}. Evidence: ${sentence(run.evidence)}. Coverage limit: ${sentence(run.limit)}.`,
      '',
    );
  }
}
lines.push('', '## Repairs discovered during this audit', '');
for (const repair of audit.repairs || [])
  lines.push(`- **${repair.setting}**: ${repair.problem}. ${repair.fix}. Evidence: ${repair.evidence}.`, '');
lines.push('', '## Detailed evidence', '');
for (const item of audit.settings.filter((item) => item.status !== 'pending')) {
  lines.push(`### ${item.setting}`, '');
  for (const key of ['persistence', 'functional', 'reset', 'interactions', 'limitations']) {
    lines.push(`**${key}**`, '');
    for (const evidence of item[key]) lines.push(`- ${evidence}`);
    if (!item[key].length) lines.push('- Not yet recorded.');
    lines.push('');
  }
}
await fs.writeFile(path.join(root, 'docs/SETTINGS_AUDIT.md'), `${lines.join('\n').trimEnd()}\n`);
console.log(`Rendered ${audit.settings.length} inventory entries.`);
