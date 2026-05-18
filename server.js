import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const LOCAL_DB_PATH = path.join(DATA_DIR, "local-db.json");

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-5.5-pro";
const IMAGE_RESPONSE_MODEL = process.env.OPENAI_IMAGE_RESPONSE_MODEL || "gpt-5.5-pro";
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || "xhigh";
const OPENAI_BACKGROUND_MODE = (process.env.OPENAI_BACKGROUND_MODE || "true").toLowerCase() !== "false";
const OPENAI_POLL_INTERVAL_MS = Number(process.env.OPENAI_POLL_INTERVAL_MS || 2500);
const OPENAI_RESPONSE_TIMEOUT_MS = Number(process.env.OPENAI_RESPONSE_TIMEOUT_MS || 12 * 60 * 1000);
const MAX_IMAGE_COUNT = Number(process.env.MAX_IMAGE_COUNT || 8);
const MAX_JSON_BODY_BYTES = Number(process.env.MAX_JSON_BODY_BYTES || 32 * 1024 * 1024);

const jobs = new Set();

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
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
      this.db = { sessions: [], turns: [], photos: [], memories: [] };
      await this.save();
    }
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
      turns: this.db.turns.filter((row) => row.session_id === sessionId)
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

  async updatePhoto(photoId, patch) {
    const photo = this.db.photos.find((row) => row.id === photoId);
    if (!photo) return;
    Object.assign(photo, patch, { updated_at: nowIso() });
    await this.save();
  }

  async listMemories() {
    return [...this.db.memories].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
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
    return { ...session.rows[0], photos: photos.rows, turns: turns.rows };
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

  async listMemories() {
    const result = await this.pool.query("select * from memories order by updated_at desc");
    return result.rows;
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

async function openaiResponses(payload) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const response = await openaiFetch("/v1/responses", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (payload.background && response.id) {
    return pollOpenAIResponse(response);
  }
  return response;
}

async function openaiFetch(pathname, init = {}) {
  const response = await fetch(`https://api.openai.com${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${text}`);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollOpenAIResponse(initialResponse) {
  let response = initialResponse;
  const startedAt = Date.now();
  while (["queued", "in_progress"].includes(response.status)) {
    if (Date.now() - startedAt > OPENAI_RESPONSE_TIMEOUT_MS) {
      throw new Error(`OpenAI background response ${response.id} timed out after ${OPENAI_RESPONSE_TIMEOUT_MS}ms`);
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

function responsePayload({ model, input, tools, maxOutputTokens = 2500 }) {
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

async function safeResponses(payload) {
  try {
    return await openaiResponses(payload);
  } catch (error) {
    if (payload.reasoning && /reasoning|effort|unsupported/i.test(error.message)) {
      const retry = { ...payload };
      delete retry.reasoning;
      return openaiResponses(retry);
    }
    throw error;
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

function memoryText(memories) {
  if (!memories.length) return "No durable customer corrections have been learned yet.";
  return memories
    .slice(0, 30)
    .map((memory, index) => `${index + 1}. ${memory.durable_instruction}`)
    .join("\n");
}

function agentPrompt(role, brief, memories, feedback) {
  return [
    `You are the ${role} for a premium NYC apartment virtual staging workflow.`,
    "You are reviewing empty apartment photos that must be staged for rental or sale.",
    "Hard constraints: preserve all physical layout, walls, floors, windows, doors, closets, radiators, outlets, plumbing, ceiling, trim, and room proportions. Never create, remove, resize, or move architectural features.",
    "Furniture and accessories may be added, removed, or changed. Furniture must not block doors, windows, radiators, through-paths, or natural light.",
    "The whole apartment must have one coherent theme, palette, material system, and level of luxury across every photo.",
    "Minimize customer prompting by making tasteful defaults and calling out only truly necessary questions.",
    `Customer brief: ${brief || "Stage this apartment to look stunning, spacious, and high-end."}`,
    feedback ? `Customer feedback to incorporate: ${feedback}` : "",
    `Durable lessons from prior customers:\n${memoryText(memories)}`,
    "Return concise JSON with keys: observations, constraints, theme_recommendation, per_photo_recommendations, risks, edit_prompt_addendum."
  ].filter(Boolean).join("\n\n");
}

async function runAgent(role, session, memories, feedback) {
  const response = await safeResponses(responsePayload({
    model: TEXT_MODEL,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: agentPrompt(role, session.turns.at(-1)?.content || "", memories, feedback) },
        ...imageInputs(session.photos)
      ]
    }]
  }));
  return { role, text: extractText(response) };
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

async function synthesizePlan(session, agentOutputs, memories, feedback) {
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
    `Durable lessons:\n${memoryText(memories)}`,
    feedback ? `Customer feedback:\n${feedback}` : "",
    `Agent notes:\n${agentOutputs.map((item) => `## ${item.role}\n${item.text}`).join("\n\n")}`
  ].filter(Boolean).join("\n\n");

  const response = await safeResponses(responsePayload({
    model: TEXT_MODEL,
    input: prompt,
    maxOutputTokens: 4000
  }));
  return parseJsonish(extractText(response), fallbackPlan(session, feedback));
}

async function generatePlan(session, feedback) {
  if (!OPENAI_API_KEY) return fallbackPlan(session, feedback);
  const memories = await store.listMemories();
  const roles = [
    "spatial planner focused on clear circulation and fixed constraints",
    "luxury interior designer focused on theme, materials, and apartment-wide cohesion",
    "NYC leasing photographer focused on buyer impact, light, spaciousness, and listing appeal",
    "practical staging critic focused on realism, furniture scale, blocked windows, blocked doors, and avoidable customer complaints"
  ];
  const agentOutputs = await Promise.all(roles.map((role) => runAgent(role, session, memories, feedback)));
  return synthesizePlan(session, agentOutputs, memories, feedback);
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
  if (!OPENAI_API_KEY) return "";
  const content = [
    { type: "input_text", text: editPrompt(plan, item, feedback) },
    { type: "input_image", image_url: photo.latest_data_url || photo.original_data_url, detail: "high" }
  ];

  const response = await safeResponses(responsePayload({
    model: IMAGE_RESPONSE_MODEL,
    input: [{ role: "user", content }],
    tools: [{
      type: "image_generation",
      action: "edit",
      quality: "high",
      size: "auto",
      output_format: "jpeg"
    }],
    maxOutputTokens: 1000
  }));
  const b64 = extractGeneratedImage(response);
  return b64 ? `data:image/jpeg;base64,${b64}` : "";
}

async function generateEdits(session, plan, feedback) {
  const updated = [];
  for (let index = 0; index < session.photos.length; index += 1) {
    const photo = session.photos[index];
    const item = photoPlan(plan, photo, index);
    const latest = await generatePhotoEdit(photo, plan, item, feedback);
    const editHistory = Array.isArray(photo.edit_history) ? photo.edit_history : [];
    const nextHistory = [
      ...editHistory,
      {
        at: nowIso(),
        feedback: feedback || "",
        plan: item,
        generated: Boolean(latest)
      }
    ];
    await store.updatePhoto(photo.id, {
      latest_data_url: latest || photo.latest_data_url || "",
      room_label: item.room_label || photo.room_label || `Room ${index + 1}`,
      edit_history: nextHistory
    });
    updated.push(photo.id);
  }
  return updated;
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
    maxOutputTokens: 700
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

async function processSession(sessionId, feedback = "") {
  if (jobs.has(sessionId)) return;
  jobs.add(sessionId);
  try {
    await store.updateSession(sessionId, { status: "planning" });
    let session = await store.getSession(sessionId);
    const plan = await generatePlan(session, feedback);
    await store.updateSession(sessionId, { status: "editing", plan });
    await store.addTurn(sessionId, "assistant", plan.customer_reply || plan.summary || "I created the staging plan.", {
      kind: feedback ? "feedback_plan" : "initial_plan",
      plan
    });
    session = await store.getSession(sessionId);
    await generateEdits(session, plan, feedback);
    if (feedback) await deriveDurableMemory(sessionId, feedback);
    await store.updateSession(sessionId, { status: "ready" });
  } catch (error) {
    await store.addTurn(sessionId, "assistant", `Generation failed: ${error.message}`, {
      kind: "error"
    });
    await store.updateSession(sessionId, { status: "error" });
  } finally {
    jobs.delete(sessionId);
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
      openaiConfigured: Boolean(OPENAI_API_KEY)
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/memories") {
    jsonResponse(res, 200, { memories: await store.listMemories() });
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
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
