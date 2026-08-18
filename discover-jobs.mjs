#!/usr/bin/env node

/**
 * Minimal, zero-LLM job discovery pipeline.
 *
 * Reads the daily public dataset that already feeds CareerOps's reverse ATS
 * scanner, then keeps only jobs that:
 *   - were first observed in the last 48 hours;
 *   - contain "software" or the standalone token "AI" in the title;
 *   - are classified as entry or mid level; and
 *   - do not contain an explicit senior-title marker.
 *
 * This script only reads public job data and writes output/discovered-jobs.json.
 * It never imports or runs CareerOps application, CV, scoring, or tracker code.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BROWSER_LIKE_USER_AGENT, fetchJson, fetchText } from './providers/_http.mjs';
import { decodeEntities } from './providers/_html-entities.mjs';

export const DATASET_BASE = 'https://feashliaa.github.io/job-board-data/data/chunks';
export const MAX_AGE_HOURS = 48;
export const MAX_DATASET_LAG_HOURS = 24;
export const OUTPUT_PATH = 'output/discovered-jobs.json';

const CHUNK_CONCURRENCY = 4;
const DETAIL_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const ALLOWED_LEVELS = new Set(['entry', 'mid']);
const ENTRY_TITLE_RE = /\b(?:junior|jr\.?|entry(?:[\s-]+level)?|associate|new[\s-]+grad(?:uate)?|graduate|early[\s-]+career|engineer\s+i|level\s*1|engr?\s*1)\b/i;
const INTERN_TITLE_RE = /\b(?:intern(?:ship)?|co[\s-]*op|apprentice)\b/i;
const SENIOR_TITLE_RE = /\b(?:senior|sr\.?|staff|principal|distinguished|fellow|lead|manager|director|head|chief|vp|vice[\s-]+president|architect|engineer\s+(?:iii|iv|v|vi)|level\s*[4-9]|engr?\s*[4-9])\b/i;
const JSON_LD_ATS = new Set(['Ashby', 'iCIMS', 'Lever', 'Paylocity', 'Workday']);
const HTML_ATS = new Set(['BambooHR', 'Greenhouse']);
const EXPERIENCE_CONTEXT_RE = /\b(?:experience|experienced|qualification|qualified|professional|industry|engineering|development|developer|software|technical|technology|programming|coding|building|working|hands-on|minimum|required|background)\b/i;
const NON_EXPERIENCE_CONTEXT_RE = /\b(?:ago|founded|operating|anniversary|vesting|benefit|age)\b/i;

export function titleMatches(title) {
  if (typeof title !== 'string') return false;
  return /software/i.test(title) || /\bAI\b/i.test(title);
}

export function levelMatches(job) {
  if (!job) return false;
  const title = String(job.title || '');
  if (INTERN_TITLE_RE.test(title) || SENIOR_TITLE_RE.test(title)) return false;
  return ALLOWED_LEVELS.has(String(job.skill_level || '').toLowerCase()) || ENTRY_TITLE_RE.test(title);
}

export function observedWithinWindow(firstSeen, cutoffMs, referenceMs) {
  if (typeof firstSeen !== 'string' || !firstSeen.trim()) return false;
  const observedAt = Date.parse(firstSeen);
  return Number.isFinite(observedAt) && observedAt >= cutoffMs && observedAt <= referenceMs;
}

export function jobMatches(job, cutoffMs, referenceMs) {
  return observedWithinWindow(job?.first_seen, cutoffMs, referenceMs)
    && titleMatches(job?.title)
    && levelMatches(job);
}

export function datasetLagHours(datasetUpdatedAtMs, referenceMs) {
  const lagMs = referenceMs - datasetUpdatedAtMs;
  if (!Number.isFinite(lagMs) || lagMs < 0) throw new Error('job-board-data manifest timestamp is in the future');
  const lagHours = lagMs / 3_600_000;
  if (lagHours > MAX_DATASET_LAG_HOURS) {
    throw new Error(`job-board-data is stale by ${lagHours.toFixed(1)} hours`);
  }
  return lagHours;
}

export function compareDiscoveryJobs(a, b) {
  return Date.parse(b.firstSeen) - Date.parse(a.firstSeen)
    || a.company.localeCompare(b.company)
    || a.title.localeCompare(b.title)
    || a.url.localeCompare(b.url);
}

export function compareDetailFailures(a, b) {
  return a.ats.localeCompare(b.ats)
    || a.company.localeCompare(b.company)
    || a.title.localeCompare(b.title)
    || a.url.localeCompare(b.url)
    || a.error.localeCompare(b.error);
}

async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function findJobPosting(value) {
  if (!value || typeof value !== 'object') return null;
  const type = value['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPosting(item);
      if (found) return found;
    }
  }
  for (const child of Object.values(value)) {
    const found = findJobPosting(child);
    if (found) return found;
  }
  return null;
}

function extractJsonLdJobPosting(html, ats) {
  const scripts = [...String(html || '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => /(?:application\/ld\+json|ld\+json)/i.test(match[1]));
  for (const script of scripts) {
    const posting = findJobPosting(JSON.parse(script[2]));
    if (posting) return posting;
  }
  throw new Error(`${ats} page is missing JobPosting JSON-LD`);
}

export function extractDescription(html, ats) {
  if (JSON_LD_ATS.has(ats)) {
    const posting = extractJsonLdJobPosting(html, ats);
    if (typeof posting.description === 'string' && posting.description.trim()) {
      return htmlToText(posting.description);
    }
    throw new Error(`${ats} JobPosting JSON-LD is missing a description`);
  }
  if (HTML_ATS.has(ats)) {
    const text = htmlToText(html);
    if (!text) throw new Error(`${ats} page did not contain visible text`);
    return text;
  }
  throw new Error(`unsupported ATS: ${ats}`);
}

function detailUrl(job) {
  if (job.ats !== 'iCIMS') return job.url;
  const url = new URL(job.url);
  url.searchParams.set('in_iframe', '1');
  return url.toString();
}

const ATS_HOST_RULES = {
  Ashby: host => host === 'jobs.ashbyhq.com',
  BambooHR: host => /^[a-z0-9][a-z0-9-]*\.bamboohr\.com$/i.test(host),
  Greenhouse: host => new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io']).has(host),
  iCIMS: host => /^careers-[a-z0-9-]+\.icims\.com$/i.test(host),
  Lever: host => host === 'jobs.lever.co',
  Paylocity: host => host === 'recruiting.paylocity.com',
  Workday: host => /^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/i.test(host),
};

function assertAtsUrl(job) {
  const url = new URL(job.url);
  const allowed = ATS_HOST_RULES[job.ats];
  if (url.protocol !== 'https:' || typeof allowed !== 'function' || !allowed(url.hostname)) {
    throw new Error(`${job.ats || 'unknown ATS'} URL is outside its allowed host`);
  }
  return url;
}

async function fetchJobDetail(job) {
  const url = assertAtsUrl(job);

  if (job.ats === 'Greenhouse') {
    const match = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    if (!match) throw new Error('Greenhouse URL is missing board and job IDs');
    const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(match[1])}/jobs/${encodeURIComponent(match[2])}`;
    const detail = await fetchJson(apiUrl, { timeoutMs: REQUEST_TIMEOUT_MS, redirect: 'error' });
    if (typeof detail.content !== 'string' || !detail.content.trim()) throw new Error('Greenhouse detail is missing content');
    return { description: htmlToText(detail.content), datePosted: detail.first_published };
  }

  if (job.ats === 'BambooHR') {
    const match = url.pathname.match(/^\/careers\/(\d+)/);
    if (!match) throw new Error('BambooHR URL is missing a job ID');
    const apiUrl = `${url.origin}/careers/${encodeURIComponent(match[1])}/detail`;
    const detail = (await fetchJson(apiUrl, { timeoutMs: REQUEST_TIMEOUT_MS, redirect: 'error' }))?.result?.jobOpening;
    if (!detail || typeof detail.description !== 'string' || !detail.description.trim()) throw new Error('BambooHR detail is missing a description');
    return { description: htmlToText(detail.description), datePosted: detail.datePosted };
  }

  const html = await fetchText(detailUrl(job), {
    timeoutMs: REQUEST_TIMEOUT_MS,
    redirect: 'error',
    headers: { 'user-agent': BROWSER_LIKE_USER_AGENT, 'accept-language': 'en-US,en;q=0.9' },
  });
  const posting = extractJsonLdJobPosting(html, job.ats);
  if (typeof posting.description !== 'string' || !posting.description.trim()) throw new Error(`${job.ats} detail is missing a description`);
  return { description: htmlToText(posting.description), datePosted: posting.datePosted };
}

export function extractRequiredYears(description) {
  if (typeof description !== 'string' || !description.trim()) return [];
  const values = [];
  const yearsRe = /\b(\d{1,2})(?:\s*(?:-|–|—|to)\s*(\d{1,2}))?\s*\+?\s*(?:years?|yrs?)(?:\s*[’']\s*)?/gi;
  for (const match of description.matchAll(yearsRe)) {
    const preceding = description.slice(0, match.index);
    const boundary = Math.max(preceding.lastIndexOf('.'), preceding.lastIndexOf('!'), preceding.lastIndexOf('?'), preceding.lastIndexOf('\n'));
    const start = Math.max(boundary + 1, match.index - 100);
    const following = description.slice(match.index + match[0].length);
    const nextBoundary = following.search(/[.!?\n]/);
    const end = nextBoundary === -1
      ? Math.min(description.length, match.index + match[0].length + 100)
      : match.index + match[0].length + nextBoundary;
    const context = description.slice(start, end);
    if (!EXPERIENCE_CONTEXT_RE.test(context) || NON_EXPERIENCE_CONTEXT_RE.test(context)) continue;
    const lower = Number(match[1]);
    const upper = match[2] === undefined ? lower : Number(match[2]);
    values.push(Math.max(lower, upper));
  }
  return values;
}

export function classifyExperience(job, description = '') {
  if (job.level === 'entry' || ENTRY_TITLE_RE.test(String(job.title || ''))) {
    return { accepted: true, evidence: 'entry-title', requiredYears: null };
  }
  const years = extractRequiredYears(description);
  if (years.length === 0) return { accepted: false, evidence: 'years-not-stated', requiredYears: null };
  const highestRequirement = Math.max(...years);
  if (highestRequirement >= 5) return { accepted: false, evidence: 'requires-5-plus', requiredYears: highestRequirement };
  return { accepted: true, evidence: 'description-under-5', requiredYears: highestRequirement };
}

async function fetchManifest() {
  const bytes = await fetchBytes(`${DATASET_BASE}/jobs_manifest.json`);
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (!manifest || typeof manifest.last_updated !== 'string' || !Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
    throw new Error('job-board-data manifest does not match the expected schema');
  }
  if (!manifest.chunks.every(name => typeof name === 'string' && /^jobs_chunk_\d+\.json\.gz$/.test(name))) {
    throw new Error('job-board-data manifest contains an invalid chunk name');
  }
  return manifest;
}

function normalizeJob(job) {
  return {
    company: job.company || '',
    title: job.title || '',
    url: job.url || '',
    location: job.location || '',
    ats: job.ats || '',
    level: String(job.skill_level || '').toLowerCase(),
    firstSeen: job.first_seen,
    sourceTimestamp: job.updated_at || null,
  };
}

async function scanChunks(chunkNames, cutoffMs, referenceMs) {
  const matches = new Map();
  const stats = { jobsScanned: 0, observedWithin48Hours: 0, keywordMatched: 0, levelMatched: 0 };
  let cursor = 0;

  async function worker() {
    while (cursor < chunkNames.length) {
      const chunkName = chunkNames[cursor++];
      const compressed = await fetchBytes(`${DATASET_BASE}/${chunkName}`);
      const jobs = JSON.parse(gunzipSync(compressed).toString('utf8'));
      if (!Array.isArray(jobs)) throw new Error(`${chunkName} did not contain a JSON array`);

      for (const job of jobs) {
        stats.jobsScanned++;
        if (!observedWithinWindow(job?.first_seen, cutoffMs, referenceMs)) continue;
        stats.observedWithin48Hours++;
        if (!titleMatches(job?.title)) continue;
        stats.keywordMatched++;
        if (!levelMatches(job)) continue;
        stats.levelMatched++;
        if (typeof job.url !== 'string' || !job.url.startsWith('https://')) continue;
        matches.set(job.url, normalizeJob(job));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunkNames.length) }, () => worker()));
  return { jobs: [...matches.values()], stats };
}

async function filterByExperience(jobs, cutoffMs, referenceMs) {
  const accepted = [];
  const failures = [];
  const stats = { entryTitleAccepted: 0, descriptionAccepted: 0, postedOutside48Hours: 0, requires5Plus: 0, yearsNotStated: 0, detailErrors: 0 };
  let cursor = 0;

  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try {
        const detail = await fetchJobDetail(job);
        const postedAt = Date.parse(detail.datePosted);
        if (!Number.isFinite(postedAt)) throw new Error('ATS detail is missing a valid datePosted');
        if (postedAt < cutoffMs || postedAt > referenceMs) {
          stats.postedOutside48Hours++;
          continue;
        }
        const classification = classifyExperience(job, detail.description);
        if (!classification.accepted) {
          if (classification.evidence === 'requires-5-plus') stats.requires5Plus++;
          else stats.yearsNotStated++;
          continue;
        }
        if (classification.evidence === 'entry-title') stats.entryTitleAccepted++;
        else stats.descriptionAccepted++;
        accepted.push({
          ...job,
          postedAt: new Date(postedAt).toISOString(),
          experienceEvidence: classification.evidence,
          requiredYears: classification.requiredYears,
          description: detail.description,
        });
      } catch (error) {
        stats.detailErrors++;
        failures.push({ ats: job.ats, company: job.company, title: job.title, url: job.url, error: error.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, jobs.length) }, () => worker()));
  return { jobs: accepted, stats, failures };
}

export async function run({ now, outputPath = OUTPUT_PATH } = {}) {
  const manifest = await fetchManifest();
  const referenceMs = now === undefined ? Date.now() : Number(now);
  if (!Number.isFinite(referenceMs)) throw new Error('discovery reference time is invalid');
  const datasetUpdatedAtMs = Date.parse(manifest.last_updated);
  if (!Number.isFinite(datasetUpdatedAtMs)) throw new Error('job-board-data manifest has an invalid last_updated timestamp');
  const sourceLagHours = datasetLagHours(datasetUpdatedAtMs, referenceMs);
  const cutoffMs = referenceMs - MAX_AGE_HOURS * 3_600_000;
  const scan = await scanChunks(manifest.chunks, cutoffMs, referenceMs);
  const experience = await filterByExperience(scan.jobs, cutoffMs, referenceMs);
  const jobs = experience.jobs;
  jobs.sort(compareDiscoveryJobs);
  experience.failures.sort(compareDetailFailures);

  const result = {
    schemaVersion: 1,
    generatedAt: new Date(referenceMs).toISOString(),
    datasetUpdatedAt: manifest.last_updated,
    datasetLagHours: Number(sourceLagHours.toFixed(3)),
    filter: {
      observedWithinHours: MAX_AGE_HOURS,
      referenceTime: new Date(referenceMs).toISOString(),
      windowStart: new Date(cutoffMs).toISOString(),
      windowEnd: new Date(referenceMs).toISOString(),
      candidateTimeField: 'first_seen',
      finalTimeField: 'ATS datePosted',
      titleKeywords: ['software', 'AI'],
      acceptedLevels: [...ALLOWED_LEVELS],
      explicitSeniorTitlesExcluded: true,
      experienceRule: 'entry-title OR every stated experience requirement is under 5 years',
    },
    stats: { ...scan.stats, ...experience.stats, uniqueMatches: jobs.length },
    detailFailures: experience.failures,
    jobs,
  };

  mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, outputPath);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run()
    .then(result => {
      process.stdout.write(`${JSON.stringify({
        datasetUpdatedAt: result.datasetUpdatedAt,
        jobsScanned: result.stats.jobsScanned,
        matches: result.stats.uniqueMatches,
        output: OUTPUT_PATH,
      })}\n`);
    })
    .catch(error => {
      console.error(`Discovery failed: ${error.message}`);
      process.exitCode = 1;
    });
}
