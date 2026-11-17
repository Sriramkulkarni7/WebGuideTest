# shoplite-mwg-review

A small two-part project:

1. **ShopLite** (`app/`): a single-page shopping app in plain HTML, CSS and JavaScript, written with modern web platform features.
2. **Modern Web Guidance review bot**: a GitHub Actions workflow that reviews every pull request for modern web practice, modelled on how MetaMask used Modern Web Guidance as a PR review bot.

## Running the app

There is no framework and no build step.

1. Open `app/index.html` in a modern browser (double-click it, or drag it into a browser window).
2. Optional: serve the folder if you prefer a local URL, for example `npx serve app` or `python -m http.server -d app`.

Features:

- A product grid of 6 products with prices in rupees
- A cart: add, remove, total item count and total price
- Live search filter
- A product quick-view modal
- A checkout form with name, address and payment fields

How it is built:

- Semantic HTML (`<header>`, `<main>`, `<search>`, `<article>`, `<template>`)
- Native `<dialog>` opened with `showModal()` for the quick view, cart and checkout. Light dismiss uses `closedby="any"`, with a small fallback for Safari.
- CSS grid with intrinsic columns, plus container queries so each card adapts to its own width
- `aspect-ratio` and `object-fit` on images, and `loading="lazy"` on images below the first row
- A `<label>` on every form field, and `autocomplete` tokens so the browser can autofill addresses and cards

## How the review bot works

```
pull request ──► git diff vs base ──► diff.txt ─┐
                                                ├─► scripts/review.mjs ──► Groq (llama-3.3-70b-versatile) ──► review-output.md ──► PR comment
repo ──► modern-web-guidance legacy-scan ──► scan.json ─┘
```

1. On every pull request (opened, synchronize, reopened), or when started by hand, `.github/workflows/mwg-review.yml` checks out the PR with full history.
2. It writes the PR diff to `diff.txt` with `git diff origin/<base>...HEAD`.
3. It runs `npx -y modern-web-guidance@latest legacy-scan . --json > scan.json`. If the scan fails, the bot carries on with an empty scan.
4. `scripts/review.mjs` sends the diff and the scan to the Groq API. The model is told to:
   - judge only the changed lines,
   - treat the legacy-scan findings as ground truth,
   - check for legacy patterns, non-Baseline features with no fallback, missing feature detection, accessibility problems and heavy JavaScript the browser can now replace,
   - reply with `SCORE: <0-100>`, a `## Findings` list and a `## What looks good` list.
5. The reply goes into `review-output.md`. `actions/github-script` posts it as a PR comment headed "Modern Web Guidance review bot". On later pushes it edits that same comment instead of adding new ones.

The bot is **warn-only**. If the Groq call fails, the script writes the error into `review-output.md` and exits 0. Every step uses `continue-on-error`, so a low score or a broken step never fails the pull request check.

### Running the judge locally

```sh
DIFF_FILE=diff.txt SCAN_FILE=scan.json GROQ_API_KEY=your_key node scripts/review.mjs
cat review-output.md
```

Requires Node 18 or newer (for built-in `fetch`).

## Adding the GROQ_API_KEY secret

1. Create a key at <https://console.groq.com/keys>.
2. In your GitHub repository, open **Settings** → **Secrets and variables** → **Actions**.
3. Click **New repository secret**.
4. Set **Name** to `GROQ_API_KEY` and paste the key as the **Secret**.
5. Click **Add secret**.

Never commit the key or a `.env` file. Both are ignored by `.gitignore`.

Note: GitHub does not pass secrets to workflows triggered from forks, and their token is read-only. On fork PRs the bot can't review or comment. The workflow still passes, and the job summary shows the reason.
