import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const LOCAL_DB_PATH = path.join(DATA_DIR, "local-db.json");
const TRAINING_MEMORY_PATH = process.env.TRAINING_MEMORY_PATH
  ? path.resolve(process.env.TRAINING_MEMORY_PATH)
  : path.join(__dirname, "training", "unit-1-style-memory.json");

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-5.5-pro";
const IMAGE_RESPONSE_MODEL = process.env.OPENAI_IMAGE_RESPONSE_MODEL || "gpt-5.5-pro";
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || "xhigh";
const OPENAI_BACKGROUND_MODE = (process.env.OPENAI_BACKGROUND_MODE || "true").toLowerCase() !== "false";
const OPENAI_POLL_INTERVAL_MS = Number(process.env.OPENAI_POLL_INTERVAL_MS || 2500);
const OPENAI_RESPONSE_TIMEOUT_MS = Number(process.env.OPENAI_RESPONSE_TIMEOUT_MS || 12 * 60 * 1000);
const OPENAI_HTTP_TIMEOUT_MS = Number(process.env.OPENAI_HTTP_TIMEOUT_MS || 60 * 1000);
const OPENAI_AGENT_TIMEOUT_MS = Number(process.env.OPENAI_AGENT_TIMEOUT_MS || 90 * 1000);
const OPENAI_SYNTHESIS_TIMEOUT_MS = Number(process.env.OPENAI_SYNTHESIS_TIMEOUT_MS || 90 * 1000);
const OPENAI_EDIT_TIMEOUT_MS = Number(process.env.OPENAI_EDIT_TIMEOUT_MS || 5 * 60 * 1000);
const OPENAI_DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_DEFAULT_MAX_OUTPUT_TOKENS || 8000);
const OPENAI_RETRY_MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_RETRY_MAX_OUTPUT_TOKENS || 16000);
const OPENAI_AGENT_IMAGE_INPUTS = (process.env.OPENAI_AGENT_IMAGE_INPUTS || "false").toLowerCase() === "true";
const MAX_IMAGE_COUNT = Number(process.env.MAX_IMAGE_COUNT || 8);
const MAX_JSON_BODY_BYTES = Number(process.env.MAX_JSON_BODY_BYTES || 32 * 1024 * 1024);
const AUTO_LEARN_FROM_USAGE = (process.env.AUTO_LEARN_FROM_USAGE || "true").toLowerCase() !== "false";
const MAX_USAGE_EXAMPLES_IN_PROMPT = Number(process.env.MAX_USAGE_EXAMPLES_IN_PROMPT || 8);
const MAX_USAGE_LESSONS_IN_PROMPT = Number(process.env.MAX_USAGE_LESSONS_IN_PROMPT || 24);
const MAX_USAGE_LESSONS_PER_EXAMPLE = Number(process.env.MAX_USAGE_LESSONS_PER_EXAMPLE || 6);
const OPENAI_EDIT_CONCURRENCY = Math.max(1, Number(process.env.OPENAI_EDIT_CONCURRENCY || 2));
const RESUME_ACTIVE_SESSIONS_LIMIT = Math.max(0, Number(process.env.RESUME_ACTIVE_SESSIONS_LIMIT || 10));

const jobs = new Set();
let trainingMemory = {
  name: "No static staging exemplar loaded",
  durable_lessons: []
};

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function logSession(sessionId, message, meta = {}) {
  console.log(JSON.stringify({
    at: nowIso(),
    session_id: sessionId,
    message,
    ...meta
  }));
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(payload);
}

function textResponse(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_JSON_BODY_BYTES) {
      throw Object.assign(new Error("Request body is too large"), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sanitizePhoto(photo, index) {
  const name = String(photo.name || `photo-${index + 1}.jpg`).slice(0, 160);
  const mime = String(photo.mime || "image/jpeg").slice(0, 80);
  const dataUrl = String(photo.dataUrl || "");
  if (!dataUrl.startsWith("data:image/")) {
    throw Object.assign(new Error(`${name} is not an image data URL`), { status: 400 });
  }
  return { name, mime, dataUrl };
}

function extractText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const parts = [];
  for (const output of response.output || []) {
    if (output.type === "message") {
      for (const item of output.content || []) {
        if (item.type === "output_text" && item.text) parts.push(item.text);
        if (item.type === "text" && item.text) parts.push(item.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function extractGeneratedImage(response) {
  for (const output of response.output || []) {
    if (output.type === "image_generation_call" && output.result) {
      return output.result;
    }
  }
  for (const item of response.data || []) {
    if (item.b64_json) return item.b64_json;
  }
  return "";
}

function parseJsonish(text, fallback) {
  if (!text) return fallback;
  const cleaned = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

class JsonStore {
  async init() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      this.db = JSON.parse(await fs.readFile(LOCAL_DB_PATH, "utf8"));
    } catch {
      this.db = { sessions: [], turns: [], photos: [], memories: [], usage_examples: [], progress_events: [] };
      await this.save();
    }
    if (!Array.isArray(this.db.sessions)) this.db.sessions = [];
    if (!Array.isArray(this.db.turns)) this.db.turns = [];
    if (!Array.isArray(this.db.photos)) this.db.photos = [];
    if (!Array.isArray(this.db.memories)) this.db.memories = [];
    if (!Array.isArray(this.db.usage_examples)) this.db.usage_examples = [];
    if (!Array.isArray(this.db.progress_events)) this.db.progress_events = [];
  }

  async save() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(LOCAL_DB_PATH, JSON.stringify(this.db, null, 2));
  }

  async createSession({ title, message, photos }) {
    const session = {
      id: id("ses"),
      title,
      status: "queued",
      plan: {},
      created_at: nowIso(),
      updated_at: nowIso()
    };
    this.db.sessions.push(session);
    for (const photo of photos) {
      this.db.photos.push({
        id: id("pho"),
        session_id: session.id,
        name: photo.name,
        mime: photo.mime,
        original_data_url: photo.dataUrl,
        latest_data_url: "",
        room_label: "",
        edit_history: [],
        created_at: nowIso(),
        updated_at: nowIso()
      });
    }
    await this.addTurn(session.id, "user", message, { kind: "initial" });
    await this.save();
    return this.getSession(session.id);
  }

  async getSession(sessionId) {
    const session = this.db.sessions.find((row) => row.id === sessionId);
    if (!session) return null;
    return {
      ...session,
      photos: this.db.photos.filter((row) => row.session_id === sessionId),
      turns: this.db.turns.filter((row) => row.session_id === sessionId),
      progress: this.db.progress_events.filter((row) => row.session_id === sessionId)
    };
  }

  async updateSession(sessionId, patch) {
    const session = this.db.sessions.find((row) => row.id === sessionId);
    if (!session) return;
    Object.assign(session, patch, { updated_at: nowIso() });
    await this.save();
  }

  async addTurn(sessionId, role, content, meta = {}) {
    this.db.turns.push({
      id: id("turn"),
      session_id: sessionId,
      role,
      content,
      meta,
      created_at: nowIso()
    });
    await this.save();
  }

  async addProgress(sessionId, message, meta = {}) {
    const event = {
      id: id("evt"),
      session_id: sessionId,
      message,
      meta,
      created_at: nowIso()
    };
    this.db.progress_events.push(event);
    await this.save();
    return event;
  }

  async updatePhoto(photoId, patch) {
    const photo = this.db.photos.find((row) => row.id === photoId);
    if (!photo) return;
    Object.assign(photo, patch, { updated_at: nowIso() });
    await this.save();
  }

  async listRunnableSessions(limit = RESUME_ACTIVE_SESSIONS_LIMIT) {
    return this.db.sessions
      .filter((row) => ["queued", "planning", "editing"].includes(row.status))
      .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))
      .slice(0, limit);
  }

  async listMemories() {
    return [...this.db.memories].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async listUsageExamples(limit = 20) {
    return [...this.db.usage_examples]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
  }

  async countUsageExamples() {
    return this.db.usage_examples.length;
  }

  async upsertUsageExample(example) {
    if (!example?.source_session_id || !Array.isArray(example.reusable_lessons) || !example.reusable_lessons.length) {
      return null;
    }
    const turnCount = Number(example.source_turn_count || 0);
    const existing = this.db.usage_examples.find((row) => (
      row.source_session_id === example.source_session_id && Number(row.source_turn_count || 0) === turnCount
    ));
    const patch = {
      source_session_id: example.source_session_id,
      source_turn_count: turnCount,
      summary: example.summary || "Reusable staging example",
      customer_brief: example.customer_brief || "",
      feedback: example.feedback || "",
      room_labels: example.room_labels || [],
      theme: example.theme || {},
      reusable_lessons: example.reusable_lessons,
      quality_signals: example.quality_signals || [],
      updated_at: nowIso()
    };
    if (existing) {
      Object.assign(existing, patch);
      await this.save();
      return existing;
    }
    const row = {
      id: id("uxe"),
      ...patch,
      created_at: nowIso()
    };
    this.db.usage_examples.push(row);
    await this.save();
    return row;
  }

  async upsertMemory(memory) {
    if (!memory?.durable_instruction) return null;
    const key = memory.durable_instruction.trim().toLowerCase();
    const existing = this.db.memories.find((row) => row.durable_instruction.trim().toLowerCase() === key);
    if (existing) {
      existing.times_seen += 1;
      existing.updated_at = nowIso();
      await this.save();
      return existing;
    }
    const row = {
      id: id("mem"),
      issue: memory.issue || "Customer correction",
      durable_instruction: memory.durable_instruction,
      source_session_id: memory.source_session_id || "",
      source_feedback: memory.source_feedback || "",
      times_seen: 1,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    this.db.memories.push(row);
    await this.save();
    return row;
  }
}

class PgStore {
  async init() {
    const { Pool } = await import("pg");
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
    });
    await this.pool.query(`
      create table if not exists sessions (
        id text primary key,
        title text not null,
        status text not null,
        plan jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists turns (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        role text not null,
        content text not null,
        meta jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create table if not exists photos (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        name text not null,
        mime text not null,
        original_data_url text not null,
        latest_data_url text not null default '',
        room_label text not null default '',
        edit_history jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists memories (
        id text primary key,
        issue text not null,
        durable_instruction text not null unique,
        source_session_id text not null default '',
        source_feedback text not null default '',
        times_seen integer not null default 1,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists usage_examples (
        id text primary key,
        source_session_id text not null,
        source_turn_count integer not null,
        summary text not null,
        customer_brief text not null default '',
        feedback text not null default '',
        room_labels jsonb not null default '[]'::jsonb,
        theme jsonb not null default '{}'::jsonb,
        reusable_lessons jsonb not null default '[]'::jsonb,
        quality_signals jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (source_session_id, source_turn_count)
      );
      create table if not exists progress_events (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        message text not null,
        meta jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
    `);
  }

  async createSession({ title, message, photos }) {
    const sessionId = id("ses");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "insert into sessions (id, title, status) values ($1, $2, 'queued')",
        [sessionId, title]
      );
      for (const photo of photos) {
        await client.query(
          `insert into photos (id, session_id, name, mime, original_data_url)
           values ($1, $2, $3, $4, $5)`,
          [id("pho"), sessionId, photo.name, photo.mime, photo.dataUrl]
        );
      }
      await client.query(
        "insert into turns (id, session_id, role, content, meta) values ($1, $2, $3, $4, $5)",
        [id("turn"), sessionId, "user", message, { kind: "initial" }]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return this.getSession(sessionId);
  }

  async getSession(sessionId) {
    const session = await this.pool.query("select * from sessions where id = $1", [sessionId]);
    if (!session.rows[0]) return null;
    const photos = await this.pool.query("select * from photos where session_id = $1 order by created_at asc", [sessionId]);
    const turns = await this.pool.query("select * from turns where session_id = $1 order by created_at asc", [sessionId]);
    const progress = await this.pool.query("select * from progress_events where session_id = $1 order by created_at asc", [sessionId]);
    return { ...session.rows[0], photos: photos.rows, turns: turns.rows, progress: progress.rows };
  }

  async updateSession(sessionId, patch) {
    const fields = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      values.push(value);
      fields.push(`${key} = $${values.length}`);
    }
    if (!fields.length) return;
    values.push(sessionId);
    await this.pool.query(
      `update sessions set ${fields.join(", ")}, updated_at = now() where id = $${values.length}`,
      values
    );
  }

  async addTurn(sessionId, role, content, meta = {}) {
    await this.pool.query(
      "insert into turns (id, session_id, role, content, meta) values ($1, $2, $3, $4, $5)",
      [id("turn"), sessionId, role, content, meta]
    );
  }

  async addProgress(sessionId, message, meta = {}) {
    const result = await this.pool.query(
      `insert into progress_events (id, session_id, message, meta)
       values ($1, $2, $3, $4)
       returning *`,
      [id("evt"), sessionId, message, meta]
    );
    return result.rows[0];
  }

  async updatePhoto(photoId, patch) {
    const fields = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      values.push(value);
      fields.push(`${key} = $${values.length}`);
    }
    if (!fields.length) return;
    values.push(photoId);
    await this.pool.query(
      `update photos set ${fields.join(", ")}, updated_at = now() where id = $${values.length}`,
      values
    );
  }

  async listRunnableSessions(limit = RESUME_ACTIVE_SESSIONS_LIMIT) {
    const result = await this.pool.query(
      `select id, status, updated_at
       from sessions
       where status in ('queued', 'planning', 'editing')
       order by updated_at asc
       limit $1`,
      [limit]
    );
    return result.rows;
  }

  async listMemories() {
    const result = await this.pool.query("select * from memories order by updated_at desc");
    return result.rows;
  }

  async listUsageExamples(limit = 20) {
    const result = await this.pool.query(
      "select * from usage_examples order by updated_at desc limit $1",
      [limit]
    );
    return result.rows;
  }

  async countUsageExamples() {
    const result = await this.pool.query("select count(*)::int as count from usage_examples");
    return result.rows[0]?.count || 0;
  }

  async upsertUsageExample(example) {
    if (!example?.source_session_id || !Array.isArray(example.reusable_lessons) || !example.reusable_lessons.length) {
      return null;
    }
    const result = await this.pool.query(
      `insert into usage_examples
       (id, source_session_id, source_turn_count, summary, customer_brief, feedback, room_labels, theme, reusable_lessons, quality_signals)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (source_session_id, source_turn_count)
       do update set
         summary = excluded.summary,
         customer_brief = excluded.customer_brief,
         feedback = excluded.feedback,
         room_labels = excluded.room_labels,
         theme = excluded.theme,
         reusable_lessons = excluded.reusable_lessons,
         quality_signals = excluded.quality_signals,
         updated_at = now()
       returning *`,
      [
        id("uxe"),
        example.source_session_id,
        Number(example.source_turn_count || 0),
        example.summary || "Reusable staging example",
        example.customer_brief || "",
        example.feedback || "",
        example.room_labels || [],
        example.theme || {},
        example.reusable_lessons,
        example.quality_signals || []
      ]
    );
    return result.rows[0];
  }

  async upsertMemory(memory) {
    if (!memory?.durable_instruction) return null;
    const result = await this.pool.query(
      `insert into memories (id, issue, durable_instruction, source_session_id, source_feedback)
       values ($1, $2, $3, $4, $5)
       on conflict (durable_instruction)
       do update set times_seen = memories.times_seen + 1, updated_at = now()
       returning *`,
      [
        id("mem"),
        memory.issue || "Customer correction",
        memory.durable_instruction,
        memory.source_session_id || "",
        memory.source_feedback || ""
      ]
    );
    return result.rows[0];
  }
}

const store = process.env.DATABASE_URL ? new PgStore() : new JsonStore();

async function recordProgress(sessionId, message, meta = {}) {
  logSession(sessionId, "progress", { progress_message: message, ...meta });
  try {
    return await store.addProgress(sessionId, message, meta);
  } catch (error) {
    console.error(`Could not store progress for ${sessionId}: ${error.message}`);
    return null;
  }
}

async function loadTrainingMemory() {
  try {
    const raw = await fs.readFile(TRAINING_MEMORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    trainingMemory = {
      ...parsed,
      durable_lessons: Array.isArray(parsed.durable_lessons) ? parsed.durable_lessons : []
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not load training memory from ${TRAINING_MEMORY_PATH}: ${error.message}`);
    }
    trainingMemory = {
      name: "No static staging exemplar loaded",
      durable_lessons: []
    };
  }
}

async function openaiResponses(payload, options = {}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const response = await openaiFetch("/v1/responses", {
    method: "POST",
    body: JSON.stringify(payload)
  }, options.requestTimeoutMs || OPENAI_HTTP_TIMEOUT_MS);
  if (payload.background && response.id) {
    return pollOpenAIResponse(response, options.responseTimeoutMs || OPENAI_RESPONSE_TIMEOUT_MS);
  }
  return response;
}

async function openaiFetch(pathname, init = {}, timeoutMs = OPENAI_HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`https://api.openai.com${pathname}`, {
      ...init,
      signal: init.signal || controller.signal,
      headers: {
        authorization: `Bearer ${OPENAI_API_KEY}`,
        "content-type": "application/json",
        ...(init.headers || {})
      }
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`OpenAI request to ${pathname} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${text}`);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollOpenAIResponse(initialResponse, timeoutMs = OPENAI_RESPONSE_TIMEOUT_MS) {
  let response = initialResponse;
  const startedAt = Date.now();
  while (["queued", "in_progress"].includes(response.status)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`OpenAI background response ${response.id} timed out after ${timeoutMs}ms`);
    }
    await sleep(OPENAI_POLL_INTERVAL_MS);
    response = await openaiFetch(`/v1/responses/${response.id}`);
  }
  if (response.status && response.status !== "completed") {
    const detail = response.error?.message || response.incomplete_details?.reason || response.status;
    throw new Error(`OpenAI background response ${response.id} ended with ${detail}`);
  }
  return response;
}

function responsePayload({ model, input, tools, maxOutputTokens = OPENAI_DEFAULT_MAX_OUTPUT_TOKENS }) {
  const payload = {
    model,
    input,
    max_output_tokens: maxOutputTokens
  };
  if (tools) payload.tools = tools;
  if (REASONING_EFFORT) payload.reasoning = { effort: REASONING_EFFORT };
  if (OPENAI_BACKGROUND_MODE) {
    payload.background = true;
    payload.store = true;
  }
  return payload;
}

async function safeResponses(payload, options = {}) {
  let current = { ...payload };
  let removedReasoning = false;
  while (true) {
    try {
      return await openaiResponses(current, options);
    } catch (error) {
      if (!removedReasoning && current.reasoning && /reasoning|effort|unsupported/i.test(error.message)) {
        current = { ...current };
        delete current.reasoning;
        removedReasoning = true;
        continue;
      }
      if (/max_output_tokens/i.test(error.message) && current.max_output_tokens < OPENAI_RETRY_MAX_OUTPUT_TOKENS) {
        current = {
          ...current,
          max_output_tokens: Math.min(
            OPENAI_RETRY_MAX_OUTPUT_TOKENS,
            Math.max(current.max_output_tokens * 2, OPENAI_DEFAULT_MAX_OUTPUT_TOKENS)
          )
        };
        continue;
      }
      throw error;
    }
  }
}

function imageInputs(photos) {
  const content = [];
  photos.forEach((photo, index) => {
    content.push({
      type: "input_text",
      text: `Photo ${index + 1}: ${photo.name}. Photo id: ${photo.id}.`
    });
    content.push({
      type: "input_image",
      image_url: photo.original_data_url,
      detail: "high"
    });
  });
  return content;
}

function cleanString(value, maxLength = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanStringList(value, maxItems = 8, maxLength = 500) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function usageExamplesText(usageExamples) {
  if (!usageExamples.length) return "No completed usage examples have been distilled yet.";
  const lines = [];
  for (const example of usageExamples.slice(0, MAX_USAGE_EXAMPLES_IN_PROMPT)) {
    const lessons = cleanStringList(example.reusable_lessons, MAX_USAGE_LESSONS_PER_EXAMPLE, 450);
    if (!lessons.length) continue;
    lines.push(`Example: ${cleanString(example.summary, 260) || "Reusable staging example"}`);
    lessons.forEach((lesson, index) => lines.push(`- Lesson ${index + 1}: ${lesson}`));
    if (lines.filter((line) => line.startsWith("- Lesson")).length >= MAX_USAGE_LESSONS_IN_PROMPT) break;
  }
  return lines.length ? lines.join("\n") : "No completed usage examples have reusable lessons yet.";
}

function memoryText(memories, usageExamples = []) {
  const staticLessons = trainingMemory.durable_lessons || [];
  const staticText = staticLessons.length
    ? staticLessons.slice(0, 40).map((lesson, index) => `${index + 1}. ${lesson}`).join("\n")
    : "No static staging exemplar is configured.";
  const learnedText = memories.length
    ? memories
      .slice(0, 30)
      .map((memory, index) => `${index + 1}. ${memory.durable_instruction}`)
      .join("\n")
    : "No durable customer corrections have been learned yet.";
  return [
    `Static before-after exemplar lessons:\n${staticText}`,
    `Distilled lessons from completed app usage:\n${usageExamplesText(usageExamples)}`,
    `Durable customer correction memory:\n${learnedText}`
  ].join("\n\n");
}

function agentPrompt(role, brief, memories, usageExamples, feedback) {
  return [
    `You are the ${role} for a premium NYC apartment virtual staging workflow.`,
    "You are reviewing empty apartment photos that must be staged for rental or sale.",
    "Hard constraints: preserve all physical layout, walls, floors, windows, doors, closets, radiators, outlets, plumbing, ceiling, trim, and room proportions. Never create, remove, resize, or move architectural features.",
    "Furniture and accessories may be added, removed, or changed. Furniture must not block doors, windows, radiators, through-paths, or natural light.",
    "The whole apartment must have one coherent theme, palette, material system, and level of luxury across every photo.",
    "Minimize customer prompting by making tasteful defaults and calling out only truly necessary questions.",
    `Customer brief: ${brief || "Stage this apartment to look stunning, spacious, and high-end."}`,
    feedback ? `Customer feedback to incorporate: ${feedback}` : "",
    `Durable lessons from prior customers and usage:\n${memoryText(memories, usageExamples)}`,
    "Return concise JSON with keys: observations, constraints, theme_recommendation, per_photo_recommendations, risks, edit_prompt_addendum."
  ].filter(Boolean).join("\n\n");
}

async function runAgent(role, session, memories, usageExamples, feedback) {
  const content = [
    { type: "input_text", text: agentPrompt(role, session.turns.at(-1)?.content || "", memories, usageExamples, feedback) }
  ];
  if (OPENAI_AGENT_IMAGE_INPUTS) content.push(...imageInputs(session.photos));

  try {
    await recordProgress(session.id, `Planning agent started: ${role}.`, {
      stage: "planning",
      role,
      image_inputs: OPENAI_AGENT_IMAGE_INPUTS
    });
    const response = await safeResponses(responsePayload({
      model: TEXT_MODEL,
      input: [{ role: "user", content }],
      maxOutputTokens: 6000
    }), { responseTimeoutMs: OPENAI_AGENT_TIMEOUT_MS });
    await recordProgress(session.id, `Planning agent finished: ${role}.`, { stage: "planning", role });
    return { role, text: extractText(response) };
  } catch (error) {
    await recordProgress(session.id, `Planning agent timed out; using conservative defaults for ${role}.`, {
      stage: "planning",
      role,
      error: error.message
    });
    return {
      role,
      text: [
        "This specialist did not complete before the planning timeout.",
        "Use conservative premium virtual-staging defaults: preserve all architecture, keep circulation clear, use cohesive warm-modern luxury furniture, keep windows and doors unobstructed, and prioritize spacious listing appeal.",
        `Failure detail: ${error.message}`
      ].join("\n")
    };
  }
}

function fallbackPlan(session, feedback = "") {
  return {
    summary: OPENAI_API_KEY
      ? "A fallback plan was generated because the model response was not structured."
      : "OpenAI is not configured yet. Add OPENAI_API_KEY to generate staged images.",
    theme: {
      name: "Warm modern gallery apartment",
      palette: ["soft white", "charcoal", "walnut", "brass", "deep green"],
      materials: ["tailored linen", "walnut wood", "brushed brass", "low-pile wool"]
    },
    global_guardrails: [
      "Preserve every architectural feature and fixed layout element.",
      "Keep doors, windows, radiators, and walking paths clear.",
      "Use one coherent furniture style across all rooms.",
      "Favor low-profile furniture where it improves perceived space."
    ],
    per_photo: session.photos.map((photo, index) => ({
      photo_id: photo.id,
      room_label: photo.room_label || `Room ${index + 1}`,
      staging_goal: "Make the room look spacious, premium, bright, and immediately livable.",
      furniture: ["low-profile sofa or bed as appropriate", "slim side tables", "large neutral rug", "one statement art piece", "warm task lighting"],
      placement_rules: ["do not block doors or windows", "maintain clear circulation", "keep furniture scale proportional"],
      edit_prompt: "Add premium modern furniture, cohesive warm neutral styling, tasteful art, layered lighting, and minimal accessories while preserving the original architecture."
    })),
    customer_reply: feedback
      ? "I incorporated the feedback and kept the apartment-wide theme consistent."
      : "I created a cohesive staging direction and queued the image edits.",
    quality_bar: ["photorealistic", "spacious", "cohesive", "practical", "high-end"]
  };
}

async function synthesizePlan(session, agentOutputs, memories, usageExamples, feedback) {
  const prompt = [
    "You are the final design director. Synthesize these specialist agent notes into one apartment-wide virtual staging plan.",
    "Return JSON only. Match this shape:",
    `{
  "summary": "short customer-facing summary",
  "theme": {"name": "", "palette": [], "materials": []},
  "global_guardrails": [],
  "per_photo": [
    {"photo_id": "", "room_label": "", "staging_goal": "", "furniture": [], "placement_rules": [], "edit_prompt": ""}
  ],
  "customer_reply": "",
  "quality_bar": []
}`,
    "Rules: no architectural changes; one coherent theme; do not block doors/windows/radiators; minimize customer questions; optimize for stunning, lavish, spacious real estate photos.",
    `Photos: ${session.photos.map((photo, index) => `${index + 1}. ${photo.name} (${photo.id})`).join("; ")}`,
    `Durable lessons:\n${memoryText(memories, usageExamples)}`,
    feedback ? `Customer feedback:\n${feedback}` : "",
    `Agent notes:\n${agentOutputs.map((item) => `## ${item.role}\n${item.text}`).join("\n\n")}`
  ].filter(Boolean).join("\n\n");

  try {
    const response = await safeResponses(responsePayload({
      model: TEXT_MODEL,
      input: prompt,
      maxOutputTokens: 8000
    }), { responseTimeoutMs: OPENAI_SYNTHESIS_TIMEOUT_MS });
    return parseJsonish(extractText(response), fallbackPlan(session, feedback));
  } catch (error) {
    await recordProgress(session.id, "Plan synthesis timed out; using the safe staging fallback plan.", {
      stage: "planning",
      error: error.message
    });
    return fallbackPlan(session, feedback);
  }
}

async function generatePlan(session, feedback) {
  if (!OPENAI_API_KEY) return fallbackPlan(session, feedback);
  const [memories, usageExamples] = await Promise.all([
    store.listMemories(),
    store.listUsageExamples(MAX_USAGE_EXAMPLES_IN_PROMPT)
  ]);
  const roles = [
    "spatial planner focused on clear circulation and fixed constraints",
    "luxury interior designer focused on theme, materials, and apartment-wide cohesion",
    "NYC leasing photographer focused on buyer impact, light, spaciousness, and listing appeal",
    "practical staging critic focused on realism, furniture scale, blocked windows, blocked doors, and avoidable customer complaints"
  ];
  await recordProgress(session.id, "Design agents are building a cohesive apartment-wide staging plan.", {
    stage: "planning",
    photos: session.photos.length,
    roles: roles.length
  });
  const agentOutputs = await Promise.all(roles.map((role) => runAgent(role, session, memories, usageExamples, feedback)));
  const plan = await synthesizePlan(session, agentOutputs, memories, usageExamples, feedback);
  await recordProgress(session.id, "Design plan is ready. Moving to image generation.", {
    stage: "planning",
    per_photo: plan.per_photo?.length || 0
  });
  return plan;
}

function photoPlan(plan, photo, index) {
  const byId = plan.per_photo?.find((item) => item.photo_id === photo.id);
  return byId || plan.per_photo?.[index] || fallbackPlan({ photos: [photo] }).per_photo[0];
}

function editPrompt(plan, item, feedback) {
  return [
    "Virtually stage this NYC apartment photo for a premium rental or sale listing.",
    "Make it photorealistic, stunning, spacious, polished, and expensive without looking fake.",
    `Apartment-wide theme: ${plan.theme?.name || "premium cohesive modern staging"}.`,
    `Palette: ${(plan.theme?.palette || []).join(", ") || "warm neutrals, charcoal, walnut, brass, restrained accent color"}.`,
    `Materials: ${(plan.theme?.materials || []).join(", ") || "tailored textiles, warm wood, refined metal, layered lighting"}.`,
    `Room goal: ${item.staging_goal || ""}`,
    `Furniture and accessories: ${(item.furniture || []).join(", ")}`,
    `Placement rules: ${(item.placement_rules || []).join("; ")}`,
    `Specific staging prompt: ${item.edit_prompt || ""}`,
    feedback ? `Customer feedback to apply now: ${feedback}` : "",
    "Non-negotiable constraints: preserve all walls, floors, windows, doors, closets, radiators, outlets, ceiling, trim, and room proportions exactly. Do not add, remove, resize, move, or cover fixed architecture. Do not block any door, window, radiator, or natural walkway. No labels, captions, watermarks, or impossible furniture placement."
  ].filter(Boolean).join("\n\n");
}

async function generatePhotoEdit(photo, plan, item, feedback) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const content = [
    { type: "input_text", text: editPrompt(plan, item, feedback) },
    { type: "input_image", image_url: photo.latest_data_url || photo.original_data_url, detail: "high" }
  ];

  const response = await safeResponses(responsePayload({
    model: IMAGE_RESPONSE_MODEL,
    input: [{ role: "user", content }],
    tools: [{
      type: "image_generation",
      quality: "high",
      size: "auto",
      output_format: "jpeg"
    }],
    maxOutputTokens: 4000
  }), { responseTimeoutMs: OPENAI_EDIT_TIMEOUT_MS });
  const b64 = extractGeneratedImage(response);
  if (!b64) {
    throw new Error("OpenAI image generation completed without returning an edited image");
  }
  return `data:image/jpeg;base64,${b64}`;
}

async function generateEdits(session, plan, feedback) {
  const results = [];
  let nextIndex = 0;

  async function editOne(index) {
    const photo = session.photos[index];
    const item = photoPlan(plan, photo, index);
    const editHistory = Array.isArray(photo.edit_history) ? photo.edit_history : [];
    try {
      await recordProgress(session.id, `Creating staged image ${index + 1} of ${session.photos.length}.`, {
        stage: "editing",
        photo_id: photo.id,
        photo_index: index + 1,
        total_photos: session.photos.length
      });
      const latest = await generatePhotoEdit(photo, plan, item, feedback);
      await store.updatePhoto(photo.id, {
        latest_data_url: latest,
        room_label: item.room_label || photo.room_label || `Room ${index + 1}`,
        edit_history: [
          ...editHistory,
          {
            at: nowIso(),
            feedback: feedback || "",
            plan: item,
            generated: true
          }
        ]
      });
      await recordProgress(session.id, `Staged image ${index + 1} of ${session.photos.length} is ready.`, {
        stage: "editing",
        photo_id: photo.id,
        photo_index: index + 1,
        total_photos: session.photos.length
      });
      results.push({ photo_id: photo.id, generated: true });
    } catch (error) {
      await store.updatePhoto(photo.id, {
        room_label: item.room_label || photo.room_label || `Room ${index + 1}`,
        edit_history: [
          ...editHistory,
          {
            at: nowIso(),
            feedback: feedback || "",
            plan: item,
            generated: false,
            error: error.message
          }
        ]
      });
      await recordProgress(session.id, `Staged image ${index + 1} failed: ${error.message}`, {
        stage: "editing",
        photo_id: photo.id,
        photo_index: index + 1,
        total_photos: session.photos.length,
        error: error.message
      });
      results.push({ photo_id: photo.id, generated: false, error: error.message });
    }
  }

  async function worker() {
    while (nextIndex < session.photos.length) {
      const index = nextIndex;
      nextIndex += 1;
      await editOne(index);
    }
  }

  const workerCount = Math.min(OPENAI_EDIT_CONCURRENCY, session.photos.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (!results.some((result) => result.generated)) {
    const detail = results.find((result) => result.error)?.error || "no edited image output";
    throw new Error(`No staged images were generated: ${detail}`);
  }
  return results;
}

async function deriveDurableMemory(sessionId, feedback) {
  const trimmed = String(feedback || "").trim();
  if (!trimmed || trimmed.length < 12) return null;
  if (!OPENAI_API_KEY) {
    return store.upsertMemory({
      issue: "Customer feedback",
      durable_instruction: `When staging future apartments, watch for this customer correction: ${trimmed}`,
      source_session_id: sessionId,
      source_feedback: trimmed
    });
  }
  const prompt = [
    "Decide whether this virtual-staging customer feedback contains a reusable lesson for future apartment staging jobs.",
    "Store only generalizable lessons. Do not store personal data or one-off taste preferences unless they reveal an avoidable recurring staging mistake.",
    "Return JSON only with keys: should_store boolean, issue string, durable_instruction string.",
    `Feedback: ${trimmed}`
  ].join("\n\n");
  const response = await safeResponses(responsePayload({
    model: TEXT_MODEL,
    input: prompt,
    maxOutputTokens: 2500
  }));
  const parsed = parseJsonish(extractText(response), { should_store: false });
  if (!parsed.should_store || !parsed.durable_instruction) return null;
  return store.upsertMemory({
    issue: parsed.issue || "Customer correction",
    durable_instruction: parsed.durable_instruction,
    source_session_id: sessionId,
    source_feedback: trimmed
  });
}

function sessionTrainingDigest(session, feedback) {
  const plan = session.plan || {};
  const initialBrief = session.turns.find((turn) => turn.role === "user")?.content || "";
  return {
    customer_brief: cleanString(initialBrief, 1200),
    feedback: cleanString(feedback, 1200),
    plan: {
      summary: cleanString(plan.summary, 1000),
      theme: plan.theme || {},
      global_guardrails: cleanStringList(plan.global_guardrails, 12, 400),
      per_photo: (plan.per_photo || []).map((item) => ({
        room_label: cleanString(item.room_label, 120),
        staging_goal: cleanString(item.staging_goal, 300),
        furniture: cleanStringList(item.furniture, 12, 160),
        placement_rules: cleanStringList(item.placement_rules, 12, 240)
      })).slice(0, MAX_IMAGE_COUNT)
    },
    photos: session.photos.map((photo, index) => ({
      photo_number: index + 1,
      room_label: cleanString(photo.room_label || `Room ${index + 1}`, 120),
      edit_count: Array.isArray(photo.edit_history) ? photo.edit_history.length : 0,
      generated: Boolean(photo.latest_data_url)
    }))
  };
}

async function deriveUsageTrainingExample(sessionId, feedback = "", { force = false } = {}) {
  if (!force && !AUTO_LEARN_FROM_USAGE) return null;
  if (!OPENAI_API_KEY) return null;
  const session = await store.getSession(sessionId);
  if (!session?.plan || !Array.isArray(session.photos) || !session.photos.length) return null;
  const hasGeneratedEdit = session.photos.some((photo) => Boolean(photo.latest_data_url));
  if (!hasGeneratedEdit) return null;

  const digest = sessionTrainingDigest(session, feedback);
  const prompt = [
    "Distill this completed virtual-staging app usage into reusable training memory for future apartment staging jobs.",
    "Store only generalizable lessons about room recognition, layout constraints, furniture placement, theme selection, customer feedback, and avoidable mistakes.",
    "Do not store private listing photos, image filenames, addresses, personal names, exact customer wording, or one-off taste preferences.",
    `Return JSON only with keys:
{
  "should_store": true,
  "summary": "short sanitized example summary",
  "customer_brief_summary": "sanitized brief summary",
  "feedback_summary": "sanitized feedback summary or empty string",
  "reusable_lessons": ["up to ${MAX_USAGE_LESSONS_PER_EXAMPLE} durable instructions"],
  "quality_signals": ["short reasons this example is useful"]
}`,
    `Completed usage digest:\n${JSON.stringify(digest)}`
  ].join("\n\n");

  const response = await safeResponses(responsePayload({
    model: TEXT_MODEL,
    input: prompt,
    maxOutputTokens: 4000
  }));
  const parsed = parseJsonish(extractText(response), { should_store: false });
  const reusableLessons = cleanStringList(parsed.reusable_lessons, MAX_USAGE_LESSONS_PER_EXAMPLE, 700);
  if (!parsed.should_store || !reusableLessons.length) return null;

  const usageExample = await store.upsertUsageExample({
    source_session_id: sessionId,
    source_turn_count: session.turns.length,
    summary: cleanString(parsed.summary, 500) || "Completed staging session",
    customer_brief: cleanString(parsed.customer_brief_summary, 700),
    feedback: cleanString(parsed.feedback_summary, 700),
    room_labels: cleanStringList(session.photos.map((photo) => photo.room_label), MAX_IMAGE_COUNT, 120),
    theme: session.plan.theme || {},
    reusable_lessons: reusableLessons,
    quality_signals: cleanStringList(parsed.quality_signals, 8, 300)
  });

  for (const lesson of reusableLessons) {
    await store.upsertMemory({
      issue: `Usage example: ${cleanString(parsed.summary, 220) || "Completed staging session"}`,
      durable_instruction: lesson,
      source_session_id: sessionId,
      source_feedback: cleanString(parsed.feedback_summary, 500) || "usage example"
    });
  }

  return usageExample;
}

async function processSession(sessionId, feedback = "") {
  if (jobs.has(sessionId)) return;
  jobs.add(sessionId);
  try {
    let session = await store.getSession(sessionId);
    const existingPlan = session?.plan && Object.keys(session.plan).length ? session.plan : null;
    const resumeEditing = !feedback && session?.status === "editing" && existingPlan;
    await recordProgress(sessionId, feedback
      ? "Received your feedback. Restarting the staging workflow."
      : resumeEditing
        ? "Resuming image generation from the existing design plan."
        : "Received the photos and brief. Starting the staging workflow.", {
        stage: "queued",
        feedback: Boolean(feedback),
        resume_editing: Boolean(resumeEditing)
      });

    let plan = existingPlan;
    if (!resumeEditing) {
      await store.updateSession(sessionId, { status: "planning" });
      session = await store.getSession(sessionId);
      plan = await generatePlan(session, feedback);
      await store.updateSession(sessionId, { status: "editing", plan });
      await store.addTurn(sessionId, "assistant", plan.customer_reply || plan.summary || "I created the staging plan.", {
        kind: feedback ? "feedback_plan" : "initial_plan",
        plan
      });
    } else {
      await store.updateSession(sessionId, { status: "editing" });
    }

    await recordProgress(sessionId, "The app is now producing staged pictures.", {
      stage: "editing",
      photos: session.photos.length
    });
    session = await store.getSession(sessionId);
    const editResults = await generateEdits(session, plan, feedback);
    if (feedback) await deriveDurableMemory(sessionId, feedback);
    await store.updateSession(sessionId, { status: "ready" });
    await recordProgress(sessionId, "Staging run complete. Review the generated images below.", {
      stage: "ready",
      generated: editResults.filter((result) => result.generated).length,
      failed: editResults.filter((result) => !result.generated).length
    });
    deriveUsageTrainingExample(sessionId, feedback).catch((error) => {
      console.error(`Usage learning failed for ${sessionId}: ${error.message}`);
    });
  } catch (error) {
    await recordProgress(sessionId, `Generation failed: ${error.message}`, {
      stage: "error",
      error: error.message
    });
    await store.addTurn(sessionId, "assistant", `Generation failed: ${error.message}`, {
      kind: "error"
    });
    await store.updateSession(sessionId, { status: "error" });
  } finally {
    jobs.delete(sessionId);
  }
}

async function resumeRunnableSessions() {
  if (!RESUME_ACTIVE_SESSIONS_LIMIT) return;
  const sessions = await store.listRunnableSessions(RESUME_ACTIVE_SESSIONS_LIMIT);
  for (const session of sessions) {
    await recordProgress(session.id, "Resuming this staging job after a deployment restart.", {
      stage: "queued",
      previous_status: session.status
    });
    processSession(session.id).catch((error) => {
      logSession(session.id, "resume_failed", { error: error.message });
    });
  }
}

async function serveStatic(req, res) {
  const requestPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const filePath = path.normalize(path.join(PUBLIC_DIR, relativePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    textResponse(res, 403, "Forbidden");
    return;
  }
  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    textResponse(res, 200, body, types[ext] || "application/octet-stream");
  } catch {
    textResponse(res, 404, "Not found");
  }
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    jsonResponse(res, 200, {
      ok: true,
      storage: process.env.DATABASE_URL ? "postgres" : "json",
      openaiConfigured: Boolean(OPENAI_API_KEY),
      trainingExemplar: trainingMemory.name || "",
      trainingLessons: (trainingMemory.durable_lessons || []).length,
      usageLearningEnabled: AUTO_LEARN_FROM_USAGE,
      usageExamples: await store.countUsageExamples()
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/training") {
    jsonResponse(res, 200, { training: trainingMemory });
    return;
  }

  if (req.method === "GET" && pathname === "/api/memories") {
    jsonResponse(res, 200, { memories: await store.listMemories() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/usage-examples") {
    jsonResponse(res, 200, { usage_examples: await store.listUsageExamples(50) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/memories") {
    const body = await readJsonBody(req);
    const memory = await store.upsertMemory({
      issue: String(body.issue || "Manual staging lesson").slice(0, 500),
      durable_instruction: String(body.durable_instruction || "").slice(0, 2000),
      source_feedback: "manual"
    });
    jsonResponse(res, memory ? 201 : 400, { memory });
    return;
  }

  if (req.method === "POST" && pathname === "/api/sessions") {
    const body = await readJsonBody(req);
    const message = String(body.message || "Stage this apartment to look stunning, spacious, lavish, and practical.").slice(0, 4000);
    const photos = (body.photos || []).slice(0, MAX_IMAGE_COUNT).map(sanitizePhoto);
    if (!photos.length) {
      jsonResponse(res, 400, { error: "Upload at least one apartment photo." });
      return;
    }
    const session = await store.createSession({
      title: String(body.title || "NYC virtual staging").slice(0, 160),
      message,
      photos
    });
    processSession(session.id).catch(console.error);
    jsonResponse(res, 201, { session });
    return;
  }

  const learnMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/learn$/);
  if (learnMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const usageExample = await deriveUsageTrainingExample(learnMatch[1], String(body.feedback || ""), { force: true });
    if (!usageExample) {
      jsonResponse(res, 400, { error: "No reusable usage example could be distilled from this session yet." });
      return;
    }
    jsonResponse(res, 201, { usage_example: usageExample });
    return;
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === "GET") {
    const session = await store.getSession(sessionMatch[1]);
    jsonResponse(res, session ? 200 : 404, session ? { session } : { error: "Session not found" });
    return;
  }

  const messageMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (messageMatch && req.method === "POST") {
    const sessionId = messageMatch[1];
    const body = await readJsonBody(req);
    const content = String(body.message || "").trim().slice(0, 4000);
    const session = await store.getSession(sessionId);
    if (!session) {
      jsonResponse(res, 404, { error: "Session not found" });
      return;
    }
    if (!content) {
      jsonResponse(res, 400, { error: "Message is required." });
      return;
    }
    await store.addTurn(sessionId, "user", content, { kind: "feedback" });
    await store.updateSession(sessionId, { status: "queued" });
    processSession(sessionId, content).catch(console.error);
    jsonResponse(res, 202, { session: await store.getSession(sessionId) });
    return;
  }

  jsonResponse(res, 404, { error: "Not found" });
}

async function main() {
  await loadTrainingMemory();
  await store.init();
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, `http://${req.headers.host}`);
      if (pathname.startsWith("/api/")) {
        await handleApi(req, res, pathname);
      } else {
        await serveStatic(req, res);
      }
    } catch (error) {
      const status = error.status || 500;
      jsonResponse(res, status, { error: error.message || "Server error" });
    }
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Virtual staging app listening on http://0.0.0.0:${PORT}`);
    resumeRunnableSessions().catch((error) => console.error(`Could not resume active sessions: ${error.message}`));
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
