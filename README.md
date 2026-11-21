# Anecdote

Turn something ordinary you did into a few natural talking points — for introverts, the socially anxious, and anyone who dreads *"so what've you been up to?"*

Not a script, not a story to memorize. A mental index card: a few short beats to jog your memory mid-conversation.

## How it works

1. **Say what's on your mind.** For example, "went to a real estate seminar."
2. **Answer one follow-up.** One tailored question draws out the interesting part. Skippable.
3. **Get a few short beats**, each tagged with its job: `hook`, `detail`, `turn`, `point`, `toss-back`.

Save the ones you like as story cards (stored in your browser) and search them later.

## Run it

- **Deploy your own:** Cloudflare Pages, output directory `site`, no build command. Set secrets `APP_PASSWORD`, `ANTHROPIC_API_KEY`, and your own prompts as `QUESTION_PROMPT`, `BEATS_PROMPT`, `ANGLES_PROMPT` and `REGENERATE_SUFFIX`, and create a KV namespace bound as `FEEDBACK_KV` (put its id in `wrangler.toml`). The backend is `site/_worker.js`.

## About this repo

All rights reserved. The AI prompts are kept private (supplied as Cloudflare secrets), so this repo shows the app structure but can't be run as-is.
