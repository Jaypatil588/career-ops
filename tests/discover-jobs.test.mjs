import {
  classifyExperience,
  compareDetailFailures,
  compareDiscoveryJobs,
  datasetLagHours,
  extractDescription,
  extractRequiredYears,
  jobMatches,
  levelMatches,
  observedWithinWindow,
  titleMatches,
} from '../discover-jobs.mjs';

let failures = 0;
function check(name, condition) {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${name}`);
  }
}

check('software matches case-insensitively', titleMatches('SOFTWARE Engineer'));
check('AI matches as a standalone token', titleMatches('Applied AI Engineer'));
check('AI does not match inside another word', !titleMatches('Maintenance Engineer'));
check('unrelated title is rejected', !titleMatches('Account Executive'));

check('entry is accepted', levelMatches({ title: 'Junior Software Engineer', skill_level: 'entry' }));
check('non-senior mid is accepted', levelMatches({ title: 'Software Engineer II', skill_level: 'mid' }));
check('senior marker overrides a bad mid label', !levelMatches({ title: 'Senior Software Engineer', skill_level: 'mid' }));
check('intern is rejected', !levelMatches({ title: 'Software Intern', skill_level: 'intern' }));
check('senior tier is rejected', !levelMatches({ title: 'AI Engineer', skill_level: 'senior' }));

const cutoff = Date.parse('2026-08-16T12:00:00.000Z');
const reference = Date.parse('2026-08-18T12:00:00.000Z');
check('cutoff is inclusive', observedWithinWindow('2026-08-16T12:00:00.000Z', cutoff, reference));
check('reference time is inclusive', observedWithinWindow('2026-08-18T12:00:00.000Z', cutoff, reference));
check('older observation is rejected', !observedWithinWindow('2026-08-16T11:59:59.999Z', cutoff, reference));
check('future observation is rejected', !observedWithinWindow('2026-08-18T12:00:00.001Z', cutoff, reference));
check('missing observation is rejected', !observedWithinWindow(null, cutoff, reference));
check('invalid observation is rejected', !observedWithinWindow('not-a-date', cutoff, reference));
check('fresh dataset lag is returned', datasetLagHours(reference - 12 * 3_600_000, reference) === 12);
check('stale dataset is rejected', (() => {
  try {
    datasetLagHours(reference - 25 * 3_600_000, reference);
    return false;
  } catch (error) {
    return /stale by 25\.0 hours/.test(error.message);
  }
})());
check('future dataset timestamp is rejected', (() => {
  try {
    datasetLagHours(reference + 1, reference);
    return false;
  } catch (error) {
    return /timestamp is in the future/.test(error.message);
  }
})());

check('complete matching job passes', jobMatches({
  title: 'Associate AI Engineer',
  skill_level: 'entry',
  first_seen: '2026-08-17T00:00:00.000Z',
}, cutoff, reference));
check('updated_at is not used as a hidden date fallback', !jobMatches({
  title: 'Associate AI Engineer',
  skill_level: 'entry',
  updated_at: '2026-08-17T00:00:00.000Z',
}, cutoff, reference));

check('junior title is accepted when dataset level is unknown', levelMatches({
  title: 'Junior Software Engineer',
  skill_level: 'unknown',
}));
check('intern title is rejected even when dataset level is entry', !levelMatches({
  title: 'Software Engineering Intern',
  skill_level: 'entry',
}));

check('JSON-LD description is extracted for Ashby', extractDescription(
  '<script type="application/ld+json">{"@type":"JobPosting","description":"<p>Three years</p>"}</script>',
  'Ashby',
) === 'Three years');
check('JSON-LD description is extracted for iCIMS', extractDescription(
  '<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","description":"<p>Two years</p>","datePosted":"2026-08-17"}</script>',
  'iCIMS',
) === 'Two years');
check('visible HTML is extracted for Greenhouse', extractDescription(
  '<html><script>ignore me</script><body><h1>Role</h1><p>2+ years of software experience</p></body></html>',
  'Greenhouse',
) === 'Role 2+ years of software experience');
check('experience years parser keeps the upper end of a requirement range', JSON.stringify(extractRequiredYears(
  'Founded 10 years ago. Required: 2-4 years of software development experience and 3+ years programming.',
)) === '[4,3]');
check('experience classifier accepts an entry title without description', classifyExperience(
  { level: 'entry' },
).evidence === 'entry-title');
check('experience classifier accepts explicit requirements under five', classifyExperience(
  { level: 'mid' },
  'Required qualifications: 3+ years of software development experience.',
).accepted);
check('experience classifier rejects a five-year requirement', !classifyExperience(
  { level: 'mid' },
  'Required qualifications: 5+ years of software development experience.',
).accepted);
check('experience classifier rejects a range ending at five years', !classifyExperience(
  { level: 'mid' },
  'Required qualifications: 2-5 years of software development experience.',
).accepted);
check('experience classifier rejects unknown years', classifyExperience(
  { level: 'mid' },
  'Professional software development experience required.',
).evidence === 'years-not-stated');
check('job ordering has deterministic title and URL tie-breakers', [
  { firstSeen: '2026-08-18T00:00:00Z', company: 'Acme', title: 'Software B', url: 'https://b.example' },
  { firstSeen: '2026-08-18T00:00:00Z', company: 'Acme', title: 'Software A', url: 'https://a.example' },
].sort(compareDiscoveryJobs)[0].title === 'Software A');
check('failure ordering is deterministic', [
  { ats: 'Workday', company: 'B', title: 'T', url: 'https://b.example', error: 'E' },
  { ats: 'Ashby', company: 'A', title: 'T', url: 'https://a.example', error: 'E' },
].sort(compareDetailFailures)[0].ats === 'Ashby');

if (failures > 0) process.exitCode = 1;
else console.log('discover-jobs: 33 checks passed');
