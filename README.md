# VirtualStage NYC

A Railway-ready chat app for staging empty NYC apartment photos with multiple OpenAI planning agents, iterative image edits, and durable customer-correction memory.

## What It Does

- Upload multiple empty apartment photos.
- Runs several specialist planning agents over the same apartment set.
- Synthesizes one coherent apartment-wide staging theme.
- Edits each image with consistent furniture, art, lighting, and accessories while preserving fixed architecture.
- Accepts customer feedback turns and re-edits the set.
- Stores reusable feedback as durable memory so future sessions avoid repeated mistakes.

The app follows OpenAI's current guidance for image workflows: the Responses API supports image inputs and multi-turn image generation/editing with the `image_generation` tool. The default configuration uses `gpt-5.5-pro` with `reasoning.effort=xhigh` and background-mode polling for deep, long-running staging work. The Responses image-generation tool uses OpenAI's GPT Image model selection internally, while the Image API exposes `gpt-image-2` for direct single-image generation/editing workflows.

## Local Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Set `OPENAI_API_KEY` in `.env` to enable real planning and image generation. Without a key, the app runs with a fallback plan and no generated image edits.

Local development uses `data/local-db.json`. On Railway, attach Postgres and set `DATABASE_URL` for durable storage.

## Railway Deploy

This repo includes `railway.json` with:

- Railpack builder
- `npm start` start command
- `/api/health` health check

Required Railway variables:

```bash
OPENAI_API_KEY=...
OPENAI_TEXT_MODEL=gpt-5.5-pro
OPENAI_IMAGE_RESPONSE_MODEL=gpt-5.5-pro
OPENAI_REASONING_EFFORT=xhigh
OPENAI_BACKGROUND_MODE=true
OPENAI_POLL_INTERVAL_MS=2500
OPENAI_RESPONSE_TIMEOUT_MS=720000
DATABASE_URL=${{Postgres.DATABASE_URL}}
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
- Customer feedback memory stores generalized staging lessons, not full private conversations.
