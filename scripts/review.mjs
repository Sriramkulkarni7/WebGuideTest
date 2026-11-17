#!/usr/bin/env node
// Modern Web Guidance PR judge.
// Inputs (env): DIFF_FILE, SCAN_FILE, GROQ_API_KEY. Output: review-output.md.
// Always exits 0 so the judge can never break the workflow.

import { readFile, writeFile } from 'node:fs/promises';

const OUTPUT_FILE = 'review-output.md';
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

const SYSTEM_PROMPT = `You are a strict but fair code reviewer for a web frontend codebase.

Rules, in order of priority:
1. Judge only the changed lines in the diff (lines starting with "+" or "-"). Do not comment on unchanged code.
2. Use the legacy-scan findings as ground truth for legacy patterns. Do not invent findings that are in neither the diff nor the scan output.
3. Check for:
   - legacy patterns that Modern Web Guidance replaces (for example custom modal code instead of <dialog>, click handlers instead of the Popover API, fixed pixel layouts instead of container queries);
   - features used without a fallback when they are not Baseline Widely Available;
   - missing feature detection (CSS.supports or @supports);
   - accessibility problems (missing labels, missing alt text, focus handling in modals);
   - heavy JavaScript written for things the browser now does natively.
4. Score the pull request from 0 to 100 on modern web practice.
5. Reply in this exact format and nothing else:

SCORE: <number>

## Findings
- [severity: high/medium/low] file:line - what is wrong - what to do instead

## What looks good
- at most 3 bullets

If there are no findings, the Findings section must say exactly "No issues found."`;

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

async function loadScan(path) {
  const raw = (await readOptional(path)).trim();
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    // A non-JSON scan (for example an npx error message) counts as "no scan results".
    return [];
  }
}

async function callJudge(diff, scan) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set. Add it under Settings > Secrets and variables > Actions.');

  const userMessage = [
    '### Pull request diff',
    '```diff',
    truncate(diff, MAX_DIFF_CHARS),
    '```',
    '',
    '### Modern Web Guidance legacy-scan output (JSON)',
    '```json',
    truncate(JSON.stringify(scan, null, 2), MAX_SCAN_CHARS),
    '```',
  ].join('\n');

  const candidates = await pickModels(apiKey);
  let lastError;
  for (const model of candidates) {
    try {
      const reply = await chat(apiKey, model, userMessage);
      console.log(`Judge model: ${model}`);
      return `${reply}

<sub>Judge model: ${model}</sub>`;
    } catch (error) {
      lastError = error;
      // Only move on to the next model when this one is missing; other errors are real failures.
      if (!error.modelMissing) throw error;
      console.error(`Model ${model} unavailable, trying the next one.`);
    }
  }
  throw lastError ?? new Error('No Groq chat model is available for this key.');
}

/** Preferred models that this key can use, followed by any other available chat model. */
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

async function chat(apiKey, model, userMessage) {
  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.1,
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
    throw error;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  // Some reasoning models wrap their thinking in <think> tags; keep only the verdict.
  const reply = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!reply) throw new Error('Groq API returned an empty reply.');
  return reply;
}

async function main() {
  const diff = (await readOptional(process.env.DIFF_FILE)).trim();
  const scan = await loadScan(process.env.SCAN_FILE);

  let output;
  if (!diff) {
    output = 'SCORE: 100\n\n## Findings\nNo issues found.\n\n## What looks good\n- The diff is empty, so there was nothing to review.';
  } else {
    try {
      output = await callJudge(diff, scan);
    } catch (error) {
      output = `The review bot could not get a verdict this time.\n\n**Error:** ${error.message}`;
      console.error(`Judge failed: ${error.message}`);
    }
  }

  await writeFile(OUTPUT_FILE, `${output}\n`, 'utf8');
  console.log(`Wrote ${OUTPUT_FILE}`);
}

main()
  .catch(async (error) => {
    // Last-resort guard: still write the file and still exit 0.
    console.error(error);
    await writeFile(OUTPUT_FILE, `The review bot crashed.\n\n**Error:** ${error.message}\n`, 'utf8').catch(() => {});
  })
  // Set the code instead of calling process.exit(), which can abort while fetch sockets are still closing.
  .finally(() => { process.exitCode = 0; });
