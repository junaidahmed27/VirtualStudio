const state = {
  files: [],
  sessionId: "",
  polling: null,
  pollingInFlight: false,
  visibleMode: new Map()
};

const els = {
  health: document.querySelector("#health"),
  choosePhotos: document.querySelector("#choosePhotos"),
  fileInput: document.querySelector("#fileInput"),
  dropzone: document.querySelector("#dropzone"),
  uploadPreview: document.querySelector("#uploadPreview"),
  memoryList: document.querySelector("#memoryList"),
  refreshMemory: document.querySelector("#refreshMemory"),
  sessionSummary: document.querySelector("#sessionSummary"),
  statusPill: document.querySelector("#statusPill"),
  progressList: document.querySelector("#progressList"),
  gallery: document.querySelector("#gallery"),
  messages: document.querySelector("#messages"),
  chatForm: document.querySelector("#chatForm"),
  messageInput: document.querySelector("#messageInput"),
  sendButton: document.querySelector("#sendButton")
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

function setStatus(status) {
  const labels = {
    queued: "Queued",
    planning: "Planning",
    editing: "Editing",
    ready: "Ready",
    error: "Error"
  };
  els.statusPill.textContent = labels[status] || status || "Idle";
  els.sendButton.disabled = ["queued", "planning", "editing"].includes(status);
}

async function compressImage(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return {
    name: file.name,
    mime: "image/jpeg",
    dataUrl: canvas.toDataURL("image/jpeg", 0.84)
  };
}

async function addFiles(fileList) {
  const images = [...fileList].filter((file) => file.type.startsWith("image/"));
  for (const file of images) {
    state.files.push(await compressImage(file));
  }
  renderUploadPreview();
}

function renderUploadPreview() {
  els.uploadPreview.innerHTML = "";
  for (const file of state.files) {
    const img = document.createElement("img");
    img.src = file.dataUrl;
    img.alt = file.name;
    els.uploadPreview.append(img);
  }
}

function renderMessages(turns = []) {
  els.messages.innerHTML = "";
  for (const turn of turns) {
    const node = document.createElement("div");
    node.className = `message ${turn.role}`;
    node.textContent = turn.content;
    els.messages.append(node);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderProgress(progress = [], status = "idle") {
  els.progressList.innerHTML = "";
  const events = [...progress].slice(-14);
  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "progress-empty";
    empty.textContent = status === "idle"
      ? "Progress updates will appear here once a staging session starts."
      : "Preparing the staging job.";
    els.progressList.append(empty);
    return;
  }

  events.forEach((event, index) => {
    const item = document.createElement("div");
    const stage = event.meta?.stage || "";
    item.className = `progress-item ${stage}`;
    if (index === events.length - 1 && !["ready", "error"].includes(status)) item.classList.add("active");

    const dot = document.createElement("span");
    dot.className = "progress-dot";

    const text = document.createElement("div");
    const message = document.createElement("strong");
    message.textContent = event.message || "Working";
    const stamp = document.createElement("span");
    stamp.textContent = event.created_at
      ? new Date(event.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : "";
    text.append(message, stamp);
    item.append(dot, text);
    els.progressList.append(item);
  });
}

function renderGallery(photos = [], sessionStatus = "idle") {
  if (!photos.length) return;
  els.gallery.className = "gallery";
  els.gallery.innerHTML = "";
  const isRunning = ["queued", "planning", "editing"].includes(sessionStatus);
  for (const photo of photos) {
    const card = document.createElement("article");
    card.className = "photo-card";
    const hasStaged = Boolean(photo.latest_data_url);
    const mode = hasStaged ? state.visibleMode.get(photo.id) || "latest" : "original";
    if (!hasStaged && isRunning) card.classList.add("working");

    const media = document.createElement("div");
    media.className = "photo-image-wrap";
    const img = document.createElement("img");
    img.src = mode === "original" ? photo.original_data_url : photo.latest_data_url;
    img.alt = photo.room_label || photo.name;
    media.append(img);
    if (!hasStaged) {
      const chip = document.createElement("div");
      chip.className = "photo-progress-chip";
      chip.textContent = isRunning ? "Working" : "No staged image";
      media.append(chip);
    }

    const body = document.createElement("div");
    body.className = "photo-card-body";

    const titleRow = document.createElement("div");
    titleRow.className = "photo-title-row";
    const title = document.createElement("strong");
    title.textContent = photo.room_label || photo.name;
    const count = document.createElement("span");
    count.textContent = hasStaged
      ? "Staged ready"
      : isRunning
        ? "Waiting for edit"
        : `${(photo.edit_history || []).length} attempts`;
    titleRow.append(title, count);

    const segmented = document.createElement("div");
    segmented.className = "segmented";
    const before = document.createElement("button");
    before.type = "button";
    before.textContent = "Before";
    const staged = document.createElement("button");
    staged.type = "button";
    staged.textContent = hasStaged ? "Staged" : "Working";
    staged.disabled = !hasStaged;
    before.classList.toggle("active", mode === "original");
    staged.classList.toggle("active", hasStaged && mode !== "original");
    before.addEventListener("click", () => {
      state.visibleMode.set(photo.id, "original");
      img.src = photo.original_data_url;
      before.classList.add("active");
      staged.classList.remove("active");
    });
    staged.addEventListener("click", () => {
      if (!hasStaged) return;
      state.visibleMode.set(photo.id, "latest");
      img.src = photo.latest_data_url;
      staged.classList.add("active");
      before.classList.remove("active");
    });
    segmented.append(before, staged);

    body.append(titleRow, segmented);
    card.append(media, body);
    els.gallery.append(card);
  }
}

function renderSession(session) {
  state.sessionId = session.id;
  setStatus(session.status);
  els.sessionSummary.textContent = session.plan?.summary || "The staging agents are working through layout, theme, and edits.";
  renderMessages(session.turns || []);
  renderProgress(session.progress || [], session.status);
  renderGallery(session.photos || [], session.status);
}

async function pollSession() {
  if (!state.sessionId) return;
  if (state.pollingInFlight) return;
  state.pollingInFlight = true;
  try {
    const { session } = await api(`/api/sessions/${state.sessionId}`);
    renderSession(session);
    if (["ready", "error"].includes(session.status)) {
      clearInterval(state.polling);
      state.polling = null;
      await loadMemory();
    }
  } finally {
    state.pollingInFlight = false;
  }
}

function startPolling() {
  clearInterval(state.polling);
  state.polling = setInterval(() => pollSession().catch(console.error), 2400);
}

async function loadMemory() {
  const [{ memories }, { training }, { usage_examples: usageExamples }] = await Promise.all([
    api("/api/memories"),
    api("/api/training"),
    api("/api/usage-examples")
  ]);
  const trainingLessons = training?.durable_lessons || [];
  els.memoryList.innerHTML = "";
  if (!memories.length && !trainingLessons.length && !usageExamples.length) {
    const empty = document.createElement("p");
    empty.textContent = "No corrections stored yet.";
    els.memoryList.append(empty);
    return;
  }
  if (trainingLessons.length) {
    const heading = document.createElement("div");
    heading.className = "memory-heading";
    heading.textContent = `${training.name || "Training exemplar"} (${trainingLessons.length} lessons)`;
    els.memoryList.append(heading);
    const sets = training?.exemplar_sets || [];
    if (sets.length) {
      const setSummary = document.createElement("div");
      setSummary.className = "memory-item training";
      setSummary.textContent = `Examples: ${sets.map((item) => item.unit).join(", ")}`;
      els.memoryList.append(setSummary);
    }
    for (const lesson of trainingLessons.slice(0, 8)) {
      const item = document.createElement("div");
      item.className = "memory-item training";
      item.textContent = lesson;
      els.memoryList.append(item);
    }
  }
  if (usageExamples.length) {
    const heading = document.createElement("div");
    heading.className = "memory-heading";
    heading.textContent = `Learned usage examples (${usageExamples.length})`;
    els.memoryList.append(heading);
    for (const example of usageExamples.slice(0, 5)) {
      const item = document.createElement("div");
      item.className = "memory-item usage";
      item.textContent = example.summary;
      els.memoryList.append(item);
    }
  }
  for (const memory of memories.slice(0, 8)) {
    const item = document.createElement("div");
    item.className = "memory-item";
    item.textContent = memory.durable_instruction;
    els.memoryList.append(item);
  }
}

async function loadHealth() {
  const health = await api("/api/health");
  const training = health.trainingLessons ? `, ${health.trainingLessons} training lessons` : "";
  const usage = Number.isFinite(health.usageExamples) ? `, ${health.usageExamples} learned examples` : "";
  els.health.textContent = health.openaiConfigured
    ? `OpenAI ready, ${health.storage} storage${training}${usage}`
    : `OpenAI key missing, ${health.storage} storage${training}${usage}`;
}

els.choosePhotos.addEventListener("click", () => els.fileInput.click());
els.dropzone.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", (event) => addFiles(event.target.files));
els.refreshMemory.addEventListener("click", () => loadMemory().catch(console.error));

for (const eventName of ["dragenter", "dragover"]) {
  els.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  els.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove("dragging");
  });
}
els.dropzone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));

els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = els.messageInput.value.trim() || els.messageInput.placeholder;
  els.messageInput.value = "";
  els.sendButton.disabled = true;
  try {
    if (!state.sessionId) {
      if (!state.files.length) throw new Error("Upload apartment photos first.");
      const { session } = await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ message, photos: state.files })
      });
      renderSession(session);
      startPolling();
    } else {
      const { session } = await api(`/api/sessions/${state.sessionId}/messages`, {
        method: "POST",
        body: JSON.stringify({ message })
      });
      renderSession(session);
      startPolling();
    }
  } catch (error) {
    const node = document.createElement("div");
    node.className = "message assistant";
    node.textContent = error.message;
    els.messages.append(node);
    els.sendButton.disabled = false;
  }
});

loadHealth().catch((error) => {
  els.health.textContent = error.message;
});
loadMemory().catch(console.error);
