// Print the dev-harness URL that opens Email Builder with the permanent
// walk seed loaded (a lived-in drafts library, no dummy-data typing).
//
//   npm run dev:harness   (another terminal, port 5186)
//   npm run seed:url      (then open the printed URL)

import { seededUrl, WALK_SEED } from './seed.mjs';

const base = process.env.EB_WALK_BASE ?? 'http://localhost:5186';
const names = Object.values(WALK_SEED).map((d) => d.name).join(' · ');
console.log(seededUrl(base));
console.log(`\nSeeded drafts: ${names} (plus the screenshot rig's demo draft).`);
