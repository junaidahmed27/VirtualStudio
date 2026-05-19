# Code Walkthrough

This document explains how the VirtualStage NYC codebase is organized and how a staging request moves through the system.

## Repository Layout

- `server.js`: the backend, storage adapters, OpenAI integration, planning pipeline, image editing pipeline, layout QA, learning pipeline, routes, and static file server.
- `public/index.html`: the browser shell.
- `public/app.js`: upload handling, polling, chat feedback, progress rendering, and before/after display behavior.
- `public/styles.css`: app layout and responsive UI styling.
- `training/unit-1-style-memory.json`: checked-in static lessons distilled from Units #1-#5 examples.
- `railway.json`: Railway build, start, and health-check configuration.
- `.env.example`: deployable runtime knobs.

The app intentionally keeps the MVP simple: one Node.js process serves the frontend and API. Local development uses a JSON file database; Railway uses Postgres when `DATABASE_URL` is present.

## Configuration

Runtime configuration is declared near the top of `server.js`. The most important groups are:

- Model settings: `OPENAI_TEXT_MODEL`, `OPENAI_IMAGE_EDIT_MODEL`, `OPENAI_REASONING_EFFORT`, and `OPENAI_BACKGROUND_MODE`.
- Request timing: `OPENAI_RESPONSE_TIMEOUT_MS`, `OPENAI_HTTP_TIMEOUT_MS`, `OPENAI_AGENT_TIMEOUT_MS`, `OPENAI_SYNTHESIS_TIMEOUT_MS`, `OPENAI_EDIT_TIMEOUT_MS`, and `OPENAI_LAYOUT_QA_TIMEOUT_MS`.
- Parallelism: `OPENAI_PLANNING_AGENT_CONCURRENCY`, `OPENAI_PLANNING_SOFT_TIMEOUT_MS`, `OPENAI_PLANNING_MIN_AGENTS`, and `OPENAI_EDIT_CONCURRENCY`.
- Guardrails: `STRICT_LAYOUT_LOCK`, `OPENAI_LAYOUT_QA_ENABLED`, `OPENAI_LAYOUT_QA_RETRIES`, and `OPENAI_LAYOUT_QA_SOFT_FAIL_ON_TIMEOUT`.
- Learning: `TRAINING_MEMORY_PATH`, `AUTO_LEARN_FROM_USAGE`, `MAX_USAGE_EXAMPLES_IN_PROMPT`, `MAX_USAGE_LESSONS_IN_PROMPT`, and `MAX_USAGE_LESSONS_PER_EXAMPLE`.

These settings are environment variables so Railway behavior can be changed without a code edit.

## Storage Layer

`server.js` defines two storage adapters with matching method names:

- `JsonStore` stores sessions in `data/local-db.json` for local development.
- `PgStore` creates and uses Postgres tables for Railway production.

Both adapters support the same operations: create sessions, read sessions, update sessions, update photos, add turns, add progress events, list memories, list usage examples, and upsert learned records. The rest of the app talks to `store`, so the runtime can switch storage backends based only on `DATABASE_URL`.

Main persisted entities:

- `sessions`: current status and synthesized plan.
- `photos`: original upload data URLs, latest staged result, room labels, and edit history.
- `turns`: user and assistant conversation turns.
- `progress_events`: customer-visible status updates.
- `memories`: durable correction lessons.
- `usage_examples`: sanitized lessons distilled from completed app usage.

## API Routes

The API is implemented in `handleApi`.

- `GET /api/health`: health check and configuration summary.
- `GET /api/training`: current checked-in training exemplar.
- `GET /api/memories`: durable learned correction memory.
- `GET /api/usage-examples`: recent sanitized usage lessons.
- `POST /api/memories`: manual memory insertion.
- `POST /api/sessions`: creates a session, stores uploaded photos, and starts background staging.
- `GET /api/sessions/:id`: returns current session, photos, turns, plan, and progress.
- `POST /api/sessions/:id/messages`: stores feedback and triggers regeneration.
- `POST /api/sessions/:id/learn`: manually distills a completed session into reusable training memory.

The long-running staging job is not completed inside the initial request. `POST /api/sessions` returns quickly, and the browser keeps polling the session endpoint.

## OpenAI Client

The OpenAI helpers are:

- `openaiFetch`: wraps `fetch`, adds authorization, applies request timeouts, and converts non-2xx responses into errors.
- `openaiResponses`: creates a Responses API call and polls background responses when enabled.
- `pollOpenAIResponse`: waits for queued or in-progress background Responses API jobs.
- `responsePayload`: normalizes model, input, tools, token budget, reasoning effort, and background mode.
- `safeResponses`: retries known recoverable model/API issues, including unsupported reasoning settings and `max_output_tokens` exhaustion.
- `extractText` and `extractGeneratedImage`: read text and image payloads from OpenAI responses.

Planning and QA use the Responses API. Staged image generation uses the image edit endpoint.

## Planning Pipeline

`generatePlan` orchestrates the planning stage.

1. It loads durable memories and recent usage examples concurrently.
2. It defines four specialist roles: spatial planner, luxury interior designer, NYC leasing photographer, and practical staging critic.
3. It records progress with the number of photos, planner count, concurrency, and quorum settings.
4. It calls `runPlanningAgents`.
5. It sends completed and deferred planner notes to `synthesizePlan`.
6. It stores the resulting apartment-wide plan before image generation starts.

`runAgent` sends each specialist a prompt containing the customer brief, hard layout rules, exemplar lessons, learned memories, and optionally the uploaded images. Each agent is independent.

`runPlanningAgents` is the concurrency coordinator. It starts planners up to `OPENAI_PLANNING_AGENT_CONCURRENCY`, collects outputs as they complete, and uses a soft timeout plus quorum to prevent one slow specialist from delaying the whole staging job. When the quorum is reached, incomplete planners are represented by conservative fallback notes so synthesis can proceed.

`synthesizePlan` is the final design director. It converts specialist notes into a single JSON plan with a cohesive theme, global guardrails, per-photo room labels, furniture lists, placement rules, and edit prompts.

## Image Editing Pipeline

`generateEdits` performs the image work with a bounded worker pool.

1. It calculates `workerCount` from `OPENAI_EDIT_CONCURRENCY` and the number of photos.
2. Each worker takes the next unprocessed photo.
3. `editOne` records progress and calls `generatePhotoEditWithLayoutGuard`.
4. Successful edits are saved to `latest_data_url` with edit history.
5. Failed edits are saved with error metadata so the user can see what happened.

The worker pool is intentionally bounded. It avoids linear image generation while still protecting the OpenAI account and Railway service from unbounded concurrent image calls.

## Layout Preservation

The layout guard exists because the product requirement is strict: staged images may add movable furniture and cosmetic decor only. They must not remodel or redraw the apartment.

`editPrompt` builds the image-edit prompt with a strict layout lock. It repeatedly instructs the model to preserve camera perspective, crop, wall geometry, floors, ceilings, windows, doors, closets, radiators, counters, cabinets, appliances, outlets, fixtures, and room proportions.

`generatePhotoEditWithLayoutGuard` attempts each edit and then calls `validateLayoutPreserved`.

`validateLayoutPreserved` compares the original and generated image with a lightweight QA prompt. It returns:

- `pass`: save the staged image.
- `fail`: reject and retry when retries remain.
- timeout with soft fail enabled: save the staged image as `timeout_unverified` so the user can inspect it instead of seeing no output.

Real QA failures still fail closed. The soft-fail behavior only applies when the checker itself times out.

## Feedback and Regeneration

When the user sends a chat message to `POST /api/sessions/:id/messages`, the server stores the message as a feedback turn.

If the session is already running, the feedback is queued in memory and applied after the current run completes. If no job is active, the session returns to `queued` and `processSession` starts immediately.

On feedback runs, the app clears prior staged outputs and regenerates from the original uploaded photos. This prevents repeated edits from compounding artifacts or drifting away from the real apartment.

## Durable Learning

The app does not fine-tune a model. It improves through retrieval-style prompt memory.

There are three memory sources:

- Static exemplar lessons from `training/unit-1-style-memory.json`.
- Durable customer correction memory in the `memories` table.
- Sanitized usage examples in the `usage_examples` table.

`deriveDurableMemory` decides whether customer feedback contains a reusable lesson. `deriveUsageTrainingExample` distills completed sessions into compact lessons that avoid raw photos, generated images, addresses, exact customer wording, and private listing details.

Future planning prompts include those lessons through `memoryText`, so later users benefit from prior corrections.

## Frontend Behavior

The frontend in `public/app.js` keeps the user informed while work continues server-side.

- It uploads photos as data URLs.
- It creates a session with the current brief.
- It polls `GET /api/sessions/:id`.
- It renders photo numbers, original images, staged images, status labels, and before/after controls.
- It renders progress events from `progress_events`.
- It sends chat feedback as regeneration requests.

The progress timeline is entirely driven by server events, so it survives page refreshes and Railway deployment restarts as long as the session is persisted.

## Deployment Behavior

Railway runs `npm start`, which starts `server.js`. On boot, the server loads training memory, initializes storage, serves static files, and resumes sessions whose status is `queued`, `planning`, or `editing`.

The health check is `/api/health`. It reports whether OpenAI is configured, which storage backend is active, whether usage learning is enabled, and how many usage examples exist.

## Key Reliability Choices

- Background work is decoupled from upload requests.
- Progress is persisted, not only held in browser memory.
- Planning uses concurrent specialist calls and a quorum soft timeout.
- Image generation uses a bounded worker pool.
- Layout QA can retry genuine layout failures.
- QA timeout no longer discards otherwise generated images.
- Feedback regenerates from originals.
- Sessions can resume after deployment restarts.
