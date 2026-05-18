# VirtualStage NYC

A Railway-ready chat app for staging empty NYC apartment photos with multiple OpenAI planning agents, iterative image edits, and durable customer-correction memory.

## What It Does

- Upload multiple empty apartment photos.
- Runs several specialist planning agents over the same apartment set.
- Synthesizes one coherent apartment-wide staging theme.
- Edits each image with consistent movable furniture, pictures, rugs, lamps, plants, and cosmetic accessories while preserving the original layout exactly.
- Accepts customer feedback turns and re-edits the set.
- Shows a live progress timeline for planning, image generation, retries, completion, and failures.
- Stores reusable feedback as durable memory so future sessions avoid repeated mistakes.
- Loads checked-in Units #1-#5 before/after exemplar memory so every new job starts with a broader baseline taste profile and fixed-layout constraints.
- Distills completed usage into reusable server-side training examples, then feeds those lessons back into future planning prompts.

The app uses the Responses API for planning and the Images edit endpoint for direct virtual-staging photo edits. The default configuration uses `gpt-5.5-pro` with `reasoning.effort=xhigh` for planning and `gpt-image-1.5` for edited image generation.

## Local Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Set `OPENAI_API_KEY` in `.env` to enable real planning and image generation. Without a key, the app runs with a fallback plan and no generated image edits.

Local development uses `data/local-db.json`. On Railway, attach Postgres and set `DATABASE_URL` for durable storage.

## Training Memory

The app is not fine-tuning a model. It uses a durable exemplar file at `training/unit-1-style-memory.json`, distilled from the local Unit #1 through Unit #5 before/after folders in Downloads. The file stores reusable staging lessons, room rules, and architectural constraints while keeping the private listing photos out of GitHub.

Set `TRAINING_MEMORY_PATH` only if you want to load a different JSON exemplar file. The active exemplar is exposed at `/api/training`, and `/api/health` returns the loaded lesson count.

## Continual Usage Learning

By default, completed sessions are distilled into compact `usage_examples` records. These records store sanitized summaries, reusable lessons, room labels, theme metadata, and quality signals. They do not store raw photos, generated images, filenames, addresses, or exact customer wording.

The server promotes each reusable lesson into durable memory and includes recent usage examples in future agent prompts. Set `AUTO_LEARN_FROM_USAGE=false` to disable automatic learning. A completed session can also be manually distilled with:

```bash
curl -X POST /api/sessions/<session-id>/learn
```

Recent learned examples are exposed at `/api/usage-examples`.

## Railway Deploy

This repo includes `railway.json` with:

- Railpack builder
- `npm start` start command
- `/api/health` health check

Required Railway variables:

```bash
OPENAI_API_KEY=...
OPENAI_TEXT_MODEL=gpt-5.5-pro
OPENAI_IMAGE_EDIT_MODEL=gpt-image-1.5
OPENAI_REASONING_EFFORT=xhigh
OPENAI_BACKGROUND_MODE=true
OPENAI_POLL_INTERVAL_MS=2500
OPENAI_RESPONSE_TIMEOUT_MS=1200000
OPENAI_HTTP_TIMEOUT_MS=180000
OPENAI_AGENT_TIMEOUT_MS=600000
OPENAI_SYNTHESIS_TIMEOUT_MS=600000
OPENAI_EDIT_TIMEOUT_MS=600000
OPENAI_AGENT_IMAGE_INPUTS=true
OPENAI_IMAGE_INPUT_FIDELITY=high
STRICT_LAYOUT_LOCK=true
OPENAI_LAYOUT_QA_ENABLED=true
OPENAI_LAYOUT_QA_MODEL=
OPENAI_LAYOUT_QA_TIMEOUT_MS=300000
OPENAI_LAYOUT_QA_RETRIES=1
OPENAI_DEFAULT_MAX_OUTPUT_TOKENS=8000
OPENAI_RETRY_MAX_OUTPUT_TOKENS=16000
OPENAI_EDIT_CONCURRENCY=2
RESUME_ACTIVE_SESSIONS_LIMIT=10
DATABASE_URL=${{Postgres.DATABASE_URL}}
TRAINING_MEMORY_PATH=
AUTO_LEARN_FROM_USAGE=true
MAX_USAGE_EXAMPLES_IN_PROMPT=8
MAX_USAGE_LESSONS_IN_PROMPT=24
MAX_USAGE_LESSONS_PER_EXAMPLE=6
```

Deploy with the Railway dashboard or CLI:

```bash
railway login
railway init
railway add --database postgres
railway variables set OPENAI_API_KEY=...
railway up
```

The Railway CLI is not bundled with this project.

## Production Notes

- Photo data is stored as compressed data URLs for a compact MVP. For heavy production use, move images to object storage and keep only URLs in Postgres.
- Long image generation jobs run asynchronously and the browser polls session status.
- Generated photos are checked against the original before being saved; images that change fixed layout, windows, doors, counters, appliances, closets, or other permanent features are rejected and retried.
- Customer feedback memory stores generalized staging lessons, not full private conversations.
