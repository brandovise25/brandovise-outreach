// Developer check: reads company sites and prints the signals. Read-only, nothing is stored.
//   npx tsx server/src/cli/profile-site.ts shop1.de shop2.de
import { profileCompany } from '../web/profile-company.ts';

for (const d of process.argv.slice(2)) {
  const p = await profileCompany(d);
  process.stdout.write(
    `\n== ${p.domain}${p.blocked ? ' [blocked]' : ''}${p.error ? ` [${p.error}]` : ''} (${p.pages.length} pages)\n`,
  );
  for (const o of p.observations)
    process.stdout.write(`  ${o.code}: ${o.value_text ?? o.value_num} (${o.confidence})` + '\n');
  if (p.impressum)
    process.stdout.write(
      `  impressum: ${p.impressum.register ?? '-'} ${p.impressum.court ?? ''}` + '\n',
    );
}
