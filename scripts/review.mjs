#!/usr/bin/env node
// Modern Web Guidance PR judge.
// Inputs (env): DIFF_FILE, SCAN_FILE, GUIDES_FILE (optional), GROQ_API_KEY, GROQ_MODEL (optional).
// Outputs: review-output.md (summary comment) and review-comments.json (inline review comments).
// Always exits 0 so the judge can never break the workflow.

import { readFile, writeFile } from 'node:fs/promises';

const OUTPUT_FILE = 'review-output.md';
const COMMENTS_FILE = 'review-comments.json';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODELS_URL = 'https://api.groq.com/openai/v1/models';
// Groq retires models over time. Try these in order, skipping any that are not available.
// Set the GROQ_MODEL repo variable to force a specific model.
const PREFERRED_MODELS = [
  process.env.GROQ_MODEL,
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'moonshotai/kimi-k2-instruct',
  'qwen/qwen3-32b',
].filter(Boolean);
// Models that are not general chat models (speech, safety classifiers, agents).
const NON_CHAT = /whisper|tts|orpheus|guard|safeguard|compound|playai|distil/i;
const MAX_DIFF_CHARS = 60_000; // keep the request inside the model's context window
const MAX_SCAN_CHARS = 20_000;
const MAX_INLINE_COMMENTS = 10;
const SNAP_DISTANCE = 5; // move a slightly-off line number to the nearest changed line within this range
const MARKER = '<!-- mwg-review-bot -->';
const SEVERITY_LABEL = { high: '🔴 High', medium: '🟠 Medium', low: '🟡 Low' };

const SYSTEM_PROMPT = `You are a strict but fair code reviewer for a web frontend codebase.

Rules, in order of priority:
1. Judge only the changed lines in the diff (lines marked "+"). Do not comment on unchanged code.
2. Use the legacy-scan findings as ground truth for legacy patterns. Do not invent findings that are in neither the diff nor the scan output.
3. Check for:
   - legacy patterns that Modern Web Guidance replaces (for example custom modal code instead of <dialog>, click handlers instead of the Popover API, fixed pixel layouts instead of container queries);
   - features used without a fallback when they are not Baseline Widely Available;
   - missing feature detection (CSS.supports or @supports);
   - accessibility problems (missing labels, missing alt text, focus handling in modals);
   - heavy JavaScript written for things the browser now does natively.
4. Score the pull request from 0 to 100 on modern web practice.

The diff is annotated: every line starts with its line number in the new file, then "|", then the diff marker.
For each finding, "line" MUST be the number printed at the start of the "+" line the finding is about.

Reply with a single JSON object and nothing else, in this shape:
{
  "score": <integer 0-100>,
  "findings": [
    {
      "file": "<path exactly as shown after 'File:'>",
      "line": <integer>,
      "severity": "high" | "medium" | "low",
      "guide": "<the most relevant Modern Web Guidance guide id from the provided list>",
      "title": "<short imperative title, e.g. use native disclosure>",
      "problem": "<what is wrong and why it matters, 1-2 sentences>",
      "fix": "<what to do instead, 1-3 sentences; always wrap HTML, CSS and JS code in backticks>"
    }
  ],
  "good": ["<at most 3 short points about the changed lines>"]
}
If there are no findings, return "findings": [].`;

// ---------- helpers ----------
async function readOptional(path) {
  if (!path) return '';
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n\n[truncated: ${text.length - max} more characters]` : text;
}

async function loadJson(path, fallback) {
  const raw = (await readOptional(path)).trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback; // e.g. an npx error message instead of JSON
  }
}

/**
 * Annotate a unified diff with new-file line numbers and record which lines
 * GitHub will accept inline comments on (added lines, on the RIGHT side).
 */
export function annotateDiff(diff) {
  const out = [];
  const added = new Map(); // path -> Set<line>
  let file = null;
  let newLine = 0;
  let inHunk = false;

  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) { file = null; inHunk = false; continue; }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (file) { out.push('', `File: ${file}`); added.set(file, new Set()); }
      inHunk = false;
      continue;
    }
    if (!file) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { newLine = Number(hunk[1]); inHunk = true; out.push(line); continue; }
    if (!inHunk) continue;

    if (line.startsWith('+')) {
      out.push(`${String(newLine).padStart(5)} | +${line.slice(1)}`);
      added.get(file).add(newLine++);
    } else if (line.startsWith('-')) {
      out.push(`      | -${line.slice(1)}`);
    } else if (line.startsWith(' ')) {
      out.push(`${String(newLine).padStart(5)} |  ${line.slice(1)}`);
      newLine++;
    }
    // "\ No newline at end of file" and anything else is ignored.
  }
  return { annotated: out.join('\n').trim(), added };
}

/** Return the closest added line to `line` in `file`, or null if none is close enough. */
function snapLine(added, file, line) {
  const lines = added.get(file);
  if (!lines || !Number.isInteger(line)) return null;
  if (lines.has(line)) return line;
  let best = null;
  for (const candidate of lines) {
    const distance = Math.abs(candidate - line);
    if (distance <= SNAP_DISTANCE && (best === null || distance < Math.abs(best - line))) best = candidate;
  }
  return best;
}

/** Pull a JSON object out of a model reply, tolerating code fences and <think> blocks. */
function parseVerdict(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const verdict = JSON.parse(cleaned.slice(start, end + 1));
    if (typeof verdict !== 'object' || verdict === null) return null;
    const score = Math.max(0, Math.min(100, Math.round(Number(verdict.score))));
    if (!Number.isFinite(score)) return null;
    const findings = (Array.isArray(verdict.findings) ? verdict.findings : [])
      .filter((f) => f && typeof f.file === 'string')
      .map((f) => ({
        file: f.file.replace(/^b\//, ''),
        line: Number(f.line),
        severity: ['high', 'medium', 'low'].includes(String(f.severity).toLowerCase()) ? String(f.severity).toLowerCase() : 'medium',
        guide: typeof f.guide === 'string' ? f.guide.trim() : '',
        title: String(f.title ?? '').trim(),
        problem: String(f.problem ?? '').trim(),
        fix: String(f.fix ?? '').trim(),
      }));
    const good = (Array.isArray(verdict.good) ? verdict.good : []).map(String).slice(0, 3);
    return { score, findings, good };
  } catch {
    return null;
  }
}

// ---------- rendering ----------
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
const oneLine = (s) => s.replace(/\s*\n\s*/g, ' ');

function renderSummary({ score, findings, good }, model) {
  const lines = [`SCORE: ${score}`, '', '## Findings'];
  if (findings.length === 0) {
    lines.push('No issues found.');
  } else {
    for (const f of findings) {
      lines.push(`- [severity: ${f.severity}] ${f.file}:${f.line} - ${codeifyTags(oneLine(f.problem || f.title))} - ${codeifyTags(oneLine(f.fix))}`);
    }
  }
  lines.push('', '## What looks good');
  lines.push(...(good.length ? good.map((g) => `- ${oneLine(g)}`) : ['- Nothing specific to call out.']));
  lines.push('', `<sub>Judge model: ${model}</sub>`);
  return lines.join('\n');
}

/** GitHub drops raw HTML tags from comments; wrap any tag that is not already in backticks as code. */
function codeifyTags(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/<\/?[a-zA-Z][^<>]*>/g, (tag) => `\`${tag}\``)))
    .join('');
}

function renderInlineBody(f, knownGuides) {
  const guide = knownGuides.has(f.guide) ? f.guide : '';
  const heading = [guide && `\`${guide}\``, f.title].filter(Boolean).join(' — ');
  const parts = [
    `${MARKER}`,
    `**${heading || 'Modern Web Guidance'}**`,
    '',
    `${SEVERITY_LABEL[f.severity]} severity`,
    '',
    codeifyTags(f.problem),
    '',
    codeifyTags(f.fix),
  ];
  if (guide) parts.push('', `<sub>Modern Web Guidance review bot · read the guide: \`npx modern-web-guidance retrieve ${guide}\`</sub>`);
  return parts.join('\n').replace(/\n{3,}/g, '\n\n');
}

function buildInlineComments(findings, added, knownGuides) {
  const comments = [];
  const used = new Set();
  for (const f of findings) {
    const line = snapLine(added, f.file, f.line);
    if (line === null) continue; // GitHub would reject a comment outside the diff
    const key = `${f.file}:${line}`;
    if (used.has(key)) continue; // one comment per line keeps the review readable
    used.add(key);
    comments.push({ path: f.file, line, side: 'RIGHT', body: renderInlineBody(f, knownGuides) });
    if (comments.length >= MAX_INLINE_COMMENTS) break;
  }
  return comments;
}

// ---------- Groq ----------
async function pickModels(apiKey) {
  try {
    const response = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return PREFERRED_MODELS;
    const { data = [] } = await response.json();
    const available = data
      .filter((m) => m.active !== false && !NON_CHAT.test(m.id))
      .sort((a, b) => (b.context_window ?? 0) - (a.context_window ?? 0))
      .map((m) => m.id);
    const preferred = PREFERRED_MODELS.filter((id) => available.includes(id));
    const rest = available.filter((id) => !preferred.includes(id));
    return preferred.length || rest.length ? [...preferred, ...rest].slice(0, 5) : PREFERRED_MODELS;
  } catch {
    return PREFERRED_MODELS; // listing failed: fall back to trying the preferred list directly
  }
}

async function chat(apiKey, model, userMessage, jsonMode) {
  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      ...(jsonMode && { response_format: { type: 'json_object' } }),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Groq API returned ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
    error.modelMissing = response.status === 404 || /model_not_found|model_decommissioned/.test(body);
    error.jsonProblem = response.status === 400 && /response_format|json_validate_failed|json/i.test(body);
    throw error;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) throw new Error('Groq API returned an empty reply.');
  return content;
}

/** Try each available model; within a model, retry once without JSON mode if JSON mode is the problem. */
async function callJudge(apiKey, userMessage) {
  let lastError;
  for (const model of await pickModels(apiKey)) {
    for (const jsonMode of [true, false]) {
      try {
        const reply = await chat(apiKey, model, userMessage, jsonMode);
        console.log(`Judge model: ${model}${jsonMode ? '' : ' (without JSON mode)'}`);
        return { reply, model };
      } catch (error) {
        lastError = error;
        if (error.jsonProblem && jsonMode) continue;
        if (error.modelMissing) { console.error(`Model ${model} unavailable, trying the next one.`); break; }
        throw error;
      }
    }
  }
  throw lastError ?? new Error('No Groq chat model is available for this key.');
}

// ---------- main ----------
async function main() {
  const diff = (await readOptional(process.env.DIFF_FILE)).trim();
  const scan = await loadJson(process.env.SCAN_FILE, []);
  const guideList = await loadJson(process.env.GUIDES_FILE, []);
  const knownGuides = new Set((Array.isArray(guideList) ? guideList : []).map((g) => g?.id).filter(Boolean));

  let summary;
  let comments = [];

  if (!diff) {
    summary = 'SCORE: 100\n\n## Findings\nNo issues found.\n\n## What looks good\n- The diff is empty, so there was nothing to review.';
  } else {
    try {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new Error('GROQ_API_KEY is not set. Add it under Settings > Secrets and variables > Actions.');

      const { annotated, added } = annotateDiff(diff);
      const userMessage = [
        '### Pull request diff (annotated with new-file line numbers)',
        '```',
        truncate(annotated, MAX_DIFF_CHARS),
        '```',
        '',
        '### Modern Web Guidance legacy-scan output (JSON)',
        '```json',
        truncate(JSON.stringify(scan, null, 2), MAX_SCAN_CHARS),
        '```',
        '',
        '### Modern Web Guidance guide ids (use one for each finding\'s "guide")',
        knownGuides.size ? [...knownGuides].join(', ') : '(list unavailable; use a short topic such as accessibility, dialog, forms, css-layout)',
      ].join('\n');

      const { reply, model } = await callJudge(apiKey, userMessage);
      const verdict = parseVerdict(reply);
      if (verdict) {
        verdict.findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
        summary = renderSummary(verdict, model);
        comments = buildInlineComments(verdict.findings, added, knownGuides);
        console.log(`Findings: ${verdict.findings.length}, inline comments: ${comments.length}`);
      } else {
        // The model ignored the JSON format: still show what it said, just without inline comments.
        summary = `${reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim()}\n\n<sub>Judge model: ${model}</sub>`;
        console.error('Could not parse a JSON verdict; posting the raw reply without inline comments.');
      }
    } catch (error) {
      summary = `The review bot could not get a verdict this time.\n\n**Error:** ${error.message}`;
      console.error(`Judge failed: ${error.message}`);
    }
  }

  await writeFile(OUTPUT_FILE, `${summary}\n`, 'utf8');
  await writeFile(COMMENTS_FILE, `${JSON.stringify(comments, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${OUTPUT_FILE} and ${COMMENTS_FILE}`);
}

main()
  .catch(async (error) => {
    // Last-resort guard: still write the files and still exit 0.
    console.error(error);
    await writeFile(OUTPUT_FILE, `The review bot crashed.\n\n**Error:** ${error.message}\n`, 'utf8').catch(() => {});
    await writeFile(COMMENTS_FILE, '[]\n', 'utf8').catch(() => {});
  })
  // Set the code instead of calling process.exit(), which can abort while fetch sockets are still closing.
  .finally(() => { process.exitCode = 0; });
