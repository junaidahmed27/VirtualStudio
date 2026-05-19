# Agent Orchestration Flow

This document explains how VirtualStage NYC coordinates its planning agents, plan synthesis, image-edit workers, layout QA, feedback reruns, and learning loop.

The implementation is concentrated in `server.js`. There is no external agent framework and there are no separate agent processes. In this app, an agent is an independent OpenAI Responses API call with a specialist role. The server runs several of those calls concurrently, waits for a useful quorum, and then asks a final synthesis call to merge the notes into one apartment-wide plan.

## High-Level Runtime Flow

```text
Browser upload
  -> POST /api/sessions
  -> store session, photos, and first user turn
  -> processSession(session.id) starts in the background
  -> planning agents run concurrently
  -> synthesis produces one JSON staging plan
  -> image-edit workers generate staged images
  -> layout QA accepts, retries, or rejects outputs
  -> session is marked ready
  -> usage learning runs asynchronously
```

The browser does not keep the original upload request open while the OpenAI work runs. It polls `GET /api/sessions/:id` and renders persisted progress events, messages, photo status, and staged image data.

## Main Orchestration Entry Point

`processSession(sessionId, feedback = "")` is the top-level job runner.

Responsibilities:

- Prevent duplicate work for the same session with the in-memory `jobs` set.
- Load the current session, photos, turns, and existing plan.
- Clear previous staged outputs when the user is submitting feedback.
- Run planning unless the server is resuming an already-planned editing job.
- Save the synthesized plan and assistant response.
- Run image generation for each photo.
- Store durable feedback memory and usage examples.
- Mark the session `ready` or `error`.
- Start a queued feedback rerun if feedback arrived during an active run.

Session statuses move through this path:

```text
queued -> planning -> editing -> ready
                      -> error
```

`jobs` is process-local, so it prevents duplicate work inside one Node process. It is not a distributed lock. If this app is scaled to multiple Node instances, this coordination should move into Postgres or a queue.

## Agent Definitions

`generatePlan(session, feedback)` defines four specialist roles:

- Spatial planner focused on circulation and fixed constraints.
- Luxury interior designer focused on theme, materials, and cohesion.
- NYC leasing photographer focused on light, spaciousness, and listing appeal.
- Practical staging critic focused on realism, scale, blocked windows, blocked doors, and customer complaints.

Each specialist receives:

- The current customer brief.
- Any feedback for this run.
- Static exemplar lessons from `training/unit-1-style-memory.json`.
- Durable learned customer corrections.
- Distilled usage examples from previous completed sessions.
- The original uploaded images, when `OPENAI_AGENT_IMAGE_INPUTS=true`.

The prompt is built by `agentPrompt(...)`. It tells every agent to preserve the exact room layout, avoid changing fixed architecture, add only tenant-removable staging items, and return concise JSON-like notes.

## Per-Agent Execution

`runAgent(role, session, memories, usageExamples, feedback)` executes one specialist.

Flow:

```text
build role-specific prompt
  -> attach image inputs if enabled
  -> record "Planning agent started"
  -> call safeResponses(...)
  -> record heartbeat progress while waiting
  -> extract text
  -> return { role, text, timed_out: false }
```

If the OpenAI call fails or times out, `runAgent` does not throw to the planning coordinator. It records a progress event and returns a conservative fallback note:

```text
This specialist did not complete before the planning timeout.
Use conservative premium virtual-staging defaults...
```

That design keeps one failed specialist from stopping the whole staging run.

## Planning Agent Pool

`runPlanningAgents(roles, session, memories, usageExamples, feedback)` is the main agent coordinator.

It uses three environment-controlled values:

- `OPENAI_PLANNING_AGENT_CONCURRENCY`: maximum planning agents running at once.
- `OPENAI_PLANNING_SOFT_TIMEOUT_MS`: time after which quorum can unblock synthesis.
- `OPENAI_PLANNING_MIN_AGENTS`: minimum completed outputs required before synthesis can proceed after the soft timeout.

The coordinator tracks:

- `outputs`: completed agent outputs.
- `completedRoles`: roles that finished.
- `startedRoles`: roles that were launched.
- `pending`: running agent promises mapped to their roles.
- `nextRoleIndex`: the next role to start.
- `usedSoftTimeout`: whether synthesis started before all agents finished.

The pool starts agents with `startNextAgent()` and keeps the pool full with `fillAgentPool()`.

Simplified logic:

```js
fillAgentPool();

while (pending.size || nextRoleIndex < roles.length) {
  const elapsed = Date.now() - startedAt;

  if (elapsed >= softTimeout && outputs.length >= minAgents) {
    usedSoftTimeout = true;
    break;
  }

  const waitForAgent = Promise.race([...pending.keys()]);
  const result = await Promise.race([
    waitForAgent,
    sleep(remainingMs).then(() => softTimeoutMarker)
  ]);

  if (result === softTimeoutMarker && outputs.length >= minAgents) {
    usedSoftTimeout = true;
    break;
  }

  fillAgentPool();
}
```

The important behavior is quorum. The app does not need every specialist to finish before moving forward. Once enough specialists have responded and the soft timeout has elapsed, synthesis starts. This reduces the chance that one slow model call delays the whole user-visible job.

## Deferred Agent Handling

If synthesis starts before all roles complete, incomplete roles are represented by fallback outputs. The fallback is different depending on whether the role had started:

- Started but unfinished: the specialist was still running after the soft timeout.
- Not started: the specialist was not launched before quorum was reached.

Both fallbacks instruct synthesis to use conservative staging defaults.

Already-started deferred agents are not cancelled. The server waits for them in a detached `Promise.allSettled(...)` and records a progress event when they finish. Their late notes are not used in the current synthesized plan.

## Synthesis

`synthesizePlan(session, agentOutputs, memories, usageExamples, feedback)` acts as the final design director.

Input:

- Photo IDs and names.
- Durable memory text.
- Current feedback, if any.
- Completed agent notes.
- Deferred or fallback agent notes.

Output shape:

```json
{
  "summary": "short customer-facing summary",
  "theme": {
    "name": "",
    "palette": [],
    "materials": []
  },
  "global_guardrails": [],
  "per_photo": [
    {
      "photo_id": "",
      "room_label": "",
      "staging_goal": "",
      "furniture": [],
      "placement_rules": [],
      "edit_prompt": ""
    }
  ],
  "customer_reply": "",
  "quality_bar": []
}
```

If every planning agent timed out, synthesis is skipped and `fallbackPlan(...)` is used. If the synthesis model response is malformed or times out, the app also falls back to `fallbackPlan(...)`.

## Image Editing Worker Pool

Planning produces the instructions. `generateEdits(session, plan, feedback)` performs image generation.

This stage has its own bounded worker pool controlled by `OPENAI_EDIT_CONCURRENCY`.

Flow:

```text
workerCount = min(OPENAI_EDIT_CONCURRENCY, photo count)
  -> start workerCount async workers
  -> each worker claims the next photo index
  -> editOne(index)
  -> save success or failure metadata
```

Each worker uses a shared `nextIndex` counter:

```js
while (nextIndex < session.photos.length) {
  const index = nextIndex;
  nextIndex += 1;
  await editOne(index);
}
```

This is safe in the current single-threaded Node event loop because the index is claimed synchronously before awaiting the edit call.

## Per-Photo Editing

`editOne(index)` performs one photo edit.

Steps:

- Pick the relevant per-photo plan using `photoPlan(...)`.
- Skip already-generated images when this is not a feedback rerun.
- Record progress.
- Call `generatePhotoEditWithLayoutGuard(...)`.
- Save `latest_data_url`, `room_label`, and `edit_history` on success.
- Save error metadata in `edit_history` on failure.

`editPrompt(...)` builds the image-edit prompt. It repeats the strict layout lock: preserve camera position, crop, wall geometry, floor, ceiling, windows, doors, closets, radiators, appliances, counters, outlets, fixtures, and all permanent features. Only movable staging items are allowed.

`generatePhotoEdit(...)` calls the OpenAI image edit endpoint with:

- The original uploaded photo.
- The generated staging prompt.
- `quality=high`.
- `size=auto`.
- JPEG output.
- Optional `input_fidelity`.

## Layout QA Loop

`generatePhotoEditWithLayoutGuard(...)` wraps image generation with QA and retry behavior.

For each attempt:

```text
generate staged image from original photo
  -> validate original vs generated
  -> pass: save image
  -> fail with retries left: regenerate from original photo with extra guardrails
  -> fail with no retries left: reject image
  -> QA timeout with soft fail enabled: keep generated image as timeout_unverified
```

`validateLayoutPreserved(...)` sends both original and generated images to the Responses API and asks for JSON:

```json
{
  "pass": true,
  "severity": "none",
  "issues": []
}
```

The QA prompt fails outputs that change fixed apartment features, camera perspective, crop, layout, walls, floors, windows, doors, appliances, plumbing, radiators, counters, cabinets, closets, or room proportions.

## Feedback Reruns

Feedback enters through `POST /api/sessions/:id/messages`.

If the session is idle:

```text
store feedback turn
  -> status queued
  -> processSession(sessionId, feedback)
```

If the session is already running:

```text
store feedback turn
  -> append text to pendingFeedback
  -> current run continues
  -> finally block starts the queued feedback run
```

On a feedback run, previous generated images are cleared. The system regenerates from the original uploaded photos, not from prior staged outputs. This avoids compounding image artifacts across revisions.

## Memory And Learning Loop

The app improves through prompt memory, not fine-tuning.

Memory sources:

- Static lessons from `training/unit-1-style-memory.json`.
- Durable customer correction memory in the store.
- Sanitized usage examples distilled from completed sessions.

`memoryText(...)` merges those sources into future planning prompts.

After a feedback run, `deriveDurableMemory(...)` decides whether the feedback contains a reusable instruction. After any successful run, `deriveUsageTrainingExample(...)` can distill the completed session into sanitized reusable lessons and promote those lessons into durable memory.

## Reliability Characteristics

The orchestration favors progress over waiting for perfect completion:

- Planning uses independent specialist calls.
- A soft timeout plus quorum prevents one slow planner from blocking synthesis.
- Failed planners become conservative fallback notes.
- Image generation uses a bounded worker pool instead of unbounded parallel requests.
- Layout QA retries genuine failures from the original photo.
- Feedback reruns start from originals.
- Progress is persisted so polling survives browser refreshes.
- Startup resumes sessions left in `queued`, `planning`, or `editing`.

## Current Limitations

- `jobs` and `pendingFeedback` are in-memory, so multi-instance deployment needs database-backed locking and durable feedback queues.
- Deferred planning agents are allowed to finish, but their late outputs are not incorporated into the already-started synthesis.
- `runAgent(...)` labels every agent failure as a timeout-style fallback, even when the failure is a non-timeout OpenAI error.
- Photo data is stored as compressed data URLs, which is acceptable for an MVP but should move to object storage for heavier production usage.
