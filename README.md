# Anecdote

**Turn something ordinary you did into a few natural things to say.**

For introverts, the socially anxious, and anyone who freezes at *"so, what've you been up to?"* — and answers "not much" when there's actually a good story in there.

Anecdote isn't a script and it isn't a story to memorize. It gives you a **mental index card**: a few short beats to jog your memory mid-conversation, so you sound like yourself, just a little more prepared.

**Try it: [anecdote4u.com](https://anecdote4u.com)** — it's friends-only for now, but the welcome page has a "curious what it looks like?" demo you can watch without a password, and a form to request one.

---

## How it works

1. **Say what's on your mind.** Anything: "went to a real estate seminar," "tried a new ramen place," "a firefly tour."
2. **Answer one follow-up.** The app asks a single question tailored to what you said, to pull out the interesting part. You can always skip it.
3. **Get a few short beats.** Each is tagged with its job:

| Beat | What it's for |
|---|---|
| `hook` | A way to open |
| `detail` | Something specific to add |
| `turn` | A twist, when there is one |
| `point` | Your take, in your own words if you already shared it |
| `toss-back` | A question that hands the conversation back to them |

You also get a few **other angles** on the topic, in case the conversation heads somewhere else.

Not quite right? Tap **not quite — try again** for a genuinely different take, not just a rewording.

## Features

- **Story cards:** save the ones you like and keep them on your device.
- **Search your cards:** find any saved card by topic or by anything in the beats.
- **Built for phones:** the value is in capturing it right after it happens.
- **Private by design:** saved cards stay in your browser, and analytics use no cookies and honor Do Not Track.
- **Friends-only access:** a password gate, with per-person passwords and a "request a password" form.

## Under the hood

- Static pages (`site/`) on **Cloudflare Pages**, with no build step.
- A single **Cloudflare Worker** (`site/_worker.js`) handles the AI calls (Anthropic's Claude Haiku), rate limiting, passwords, feedback and a small private stats page.
- **Cloudflare KV** stores feedback, passwords and stats.

## Run your own

1. Create a Cloudflare Pages project from this repo: output directory `site`, no build command.
2. Create a KV namespace, bind it as `FEEDBACK_KV`, and put its id in `wrangler.toml`.
3. Add these secrets: `APP_PASSWORD`, `ANTHROPIC_API_KEY`, and your own prompts as `QUESTION_PROMPT`, `BEATS_PROMPT`, `ANGLES_PROMPT` and `REGENERATE_SUFFIX`.

## About this repo

This is the app's structure and code. The AI prompts that give Anecdote its voice are kept private, so it won't run as-is. All rights reserved.

---

Built because the author freezes at "what've you been up to?" too.
