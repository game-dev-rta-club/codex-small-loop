import { conversationFocusMatches, conversationNavigationTarget, conversationReadingKey, createActivityListLoader,
  createActivitySelection, readingFocusCandidates, readingFocusDescriptor, restoreDeferredReadingFocus } from "/activity-selection.js";
import { layoutWorkGraph, roundedWorkLink } from "/sonner-view.js";

const state = { activities: [], detail: null, activityId: null, agentId: null, signalId: null,
  boardView: "activity", sonner: null, sonnerRequest: 0, sonnerTab: "work-graph",
  workId: null, workGraphScrollLeft: 0, workGraphScrollTop: 0, workGraphZoom: 1,
  sonnerLoadedAt: null, fileKeyPointsSequence: 0, openingPaths: new Set(),
  liveRevision: null, liveTimer: null, liveInFlight: false, liveGeneration: 0 };
const projectKey = new URL(location.href).searchParams.get("project");
const projectQuery = projectKey ? `project=${encodeURIComponent(projectKey)}` : "";
const boardUrl = (pathname) => projectQuery ? `${pathname}${pathname.includes("?") ? "&" : "?"}${projectQuery}` : pathname;
if (projectKey) new EventSource(boardUrl("/api/lease"));
const el = (id) => document.getElementById(id);
const workDetail = el("work-detail");
const formatNumber = (value) => value == null ? "—" : new Intl.NumberFormat().format(value);
const hours = (ms) => ms ? `${(ms / 3_600_000).toFixed(ms < 3_600_000 ? 2 : 1)}h` : "0h";
const clock = (value) => value ? new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : "—";
const duration = (ms) => ms == null ? "unknown duration" : ms < 60_000 ? `${Math.round(ms / 1_000)} seconds` : `${Math.round(ms / 60_000)} minutes`;

async function api(url, label = "Activity") {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch {}
    const error = new Error(response.status === 429
      ? `${label} is busy. Retry with Refresh.`
      : `${label} request failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return response.json();
}

async function postApi(url, value, label) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) { const error = new Error(`${label} request failed (${response.status})`); error.status = response.status; throw error; }
  return response.json();
}

function button(label, className, onClick) {
  const result = document.createElement("button");
  result.type = "button";
  result.className = className;
  result.textContent = label;
  result.addEventListener("click", onClick);
  return result;
}

function activateSonnerTab(name, { focus = false } = {}) {
  const tabs = ["work-graph", "files", "runtime"];
  if (!tabs.includes(name)) return;
  state.sonnerTab = name;
  for (const tab of tabs) {
    const selected = tab === name;
    el(`${tab}-tab`).setAttribute("aria-selected", String(selected));
    el(`${tab}-tab`).tabIndex = selected ? 0 : -1;
    el(`${tab}-panel`).hidden = !selected;
  }
  if (focus) el(`${name}-tab`).focus();
}

function runtimeHealthLabel(value) {
  return { ok: "OK", attention: "Attention", unknown: "Unknown" }[value] ?? "Unknown";
}

function runtimeTaskStateLabel(value) {
  return { not_started: "Not started", running: "Running", aborted: "Aborted", unknown: "Unknown" }[value] ?? "Unknown";
}

function runtimeReasonLabel(value) {
  return {
    history_unavailable: "Task history unavailable",
    observation_failed: "Runtime observation failed",
    task_aborted: "Task aborted",
    runtime_diagnostic: "Runtime diagnostic present",
  }[value] ?? "Runtime state uncertain";
}

function shortTaskId(value) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 8) : "—";
}

function runtimeReasons(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  const result = document.createElement("p");
  result.className = "runtime-reasons";
  result.textContent = reasons.map(runtimeReasonLabel).join(" · ");
  return result;
}

function runtimeHealth(health) {
  const dimensions = document.createElement("dl");
  dimensions.className = "runtime-mechanical-state";
  const term = document.createElement("dt"); term.textContent = "Health:";
  const detail = document.createElement("dd");
  detail.className = `runtime-health runtime-health-${health}`;
  detail.textContent = runtimeHealthLabel(health);
  dimensions.append(term, detail);
  return dimensions;
}

function renderSonnerLoadedAt() {
  const loadedAt = el("sonner-loaded-at");
  if (!state.sonnerLoadedAt) {
    loadedAt.textContent = "";
    loadedAt.removeAttribute("datetime");
    return;
  }
  loadedAt.dateTime = state.sonnerLoadedAt.toISOString();
  loadedAt.textContent = `Loaded ${clock(state.sonnerLoadedAt)}`;
}

function clearRuntimeState({ focusFallback = true } = {}) {
  const listRegion = el("runtime-task-list");
  const listHadFocus = listRegion === document.activeElement || listRegion.contains(document.activeElement);
  el("runtime-overall").replaceChildren();
  listRegion.replaceChildren(); listRegion.tabIndex = -1;
  if (focusFallback && listHadFocus) el("runtime-tab").focus({ preventScroll: true });
}

function runtimeTaskList(tasks) {
  const list = document.createElement("ul");
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", "Active Tasks");
  for (const task of tasks) {
    const item = document.createElement("li");
    item.setAttribute("role", "listitem");
    const row = document.createElement("div");
    row.className = "runtime-task-row";
    row.title = task.id;
    const identity = document.createElement("span");
    identity.className = "runtime-task-identity";
    const id = document.createElement("code");
    id.className = "runtime-task-id";
    id.textContent = shortTaskId(task.id);
    const name = document.createElement("strong");
    name.textContent = task.name ?? "Controller";
    const role = document.createElement("span");
    role.className = "runtime-task-role";
    role.textContent = task.role;
    identity.append(id, name, role);
    const taskState = document.createElement("span");
    taskState.className = `runtime-state runtime-state-${task.turnState}`;
    taskState.textContent = runtimeTaskStateLabel(task.turnState);
    row.append(identity, taskState);
    item.append(row);
    list.append(item);
  }
  return list;
}

function renderRuntime(runtime) {
  if (runtime.status !== "available") {
    clearRuntimeState();
    const unavailable = document.createElement("p");
    unavailable.className = "empty";
    unavailable.textContent = runtime.status === "missing"
      ? "Codex Small Loop Runtime is not configured for this project."
      : "Codex Small Loop Runtime could not be inspected safely.";
    el("runtime-overall").replaceChildren(unavailable);
    return;
  }
  const overall = document.createElement("div");
  overall.className = "runtime-overall-status";
  overall.append(runtimeHealth(runtime.health));
  const reasons = runtimeReasons(runtime.reasons);
  if (reasons) overall.append(reasons);
  if (runtime.tasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "runtime-empty";
    empty.textContent = "No active Tasks.";
    overall.append(empty);
  }
  el("runtime-overall").replaceChildren(overall);
  const listRegion = el("runtime-task-list");
  const listHadFocus = listRegion === document.activeElement || listRegion.contains(document.activeElement);
  listRegion.replaceChildren(...(runtime.tasks.length > 0 ? [runtimeTaskList(runtime.tasks)] : []));
  listRegion.tabIndex = runtime.tasks.length > 0 ? 0 : -1;
  if (listHadFocus && runtime.tasks.length === 0) el("runtime-tab").focus({ preventScroll: true });
}

function clearWorkDetail({ clearSelection = false } = {}) {
  if (clearSelection) state.workId = null;
  workDetail.hidden = true;
  workDetail.replaceChildren();
}

function renderWorkDetail(works) {
  const work = works.find((candidate) => candidate.id === state.workId);
  if (!work) {
    clearWorkDetail();
    return;
  }
  const heading = document.createElement("div");
  heading.className = "work-detail-heading";
  const title = document.createElement("h3");
  title.textContent = work.id;
  heading.append(title);
  const keyPoints = document.createElement("p");
  keyPoints.className = "work-detail-key-points";
  keyPoints.textContent = work.keyPoints;
  const details = document.createElement("dl");
  const directoryPath = work.nodePath.slice(0, work.nodePath.lastIndexOf("/"));
  for (const [label, value] of [
    ["Directory", directoryPath],
    ["Inputs", work.inputs],
    ["Outputs", work.outputs],
  ]) {
    const term = document.createElement("dt"); term.textContent = label;
    const description = document.createElement("dd");
    if (!Array.isArray(value)) {
      description.textContent = value;
    } else if (value.length === 0) {
      description.textContent = "—";
    } else {
      value.forEach((workId, index) => {
        if (index > 0) description.append(document.createTextNode(", "));
        const relation = button(workId, "work-relation-link", () => {
          const card = [...el("work-graph-layout").querySelectorAll(".work-card")]
            .find((candidate) => candidate.dataset.workId === workId);
          if (card) selectWork(workId, works, card, { reveal: true });
        });
        relation.setAttribute("aria-label", `Select ${label.slice(0, -1).toLowerCase()} ${workId}`);
        description.append(relation);
      });
    }
    details.append(term, description);
  }
  const open = button("Open Folder", "quiet work-open", () => openFile({
    name: work.id,
    path: directoryPath,
  }, open));
  open.setAttribute("aria-label", `Open ${work.id} folder`);
  workDetail.replaceChildren(heading, keyPoints, details, open);
  workDetail.hidden = false;
}

function selectWork(workId, works, card, { reveal = false } = {}) {
  state.workId = workId;
  el("work-graph-layout").querySelectorAll(".work-item").forEach((item) => {
    const selected = item.dataset.workId === workId;
    item.classList.toggle("is-selected", selected);
    item.querySelector(".work-card")?.setAttribute("aria-pressed", String(selected));
  });
  renderWorkDetail(works);
  card.focus({ preventScroll: true });
  if (reveal) card.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function updateWorkGraphZoomControls(available = true) {
  const percentage = Math.round(state.workGraphZoom * 100);
  const reset = el("work-graph-zoom-reset");
  reset.textContent = `${percentage}%`;
  reset.setAttribute("aria-label", `Reset Work Graph zoom from ${percentage}% to 100%`);
  reset.disabled = !available;
  el("work-graph-zoom-out").disabled = !available || state.workGraphZoom <= 0.5;
  el("work-graph-zoom-in").disabled = !available || state.workGraphZoom >= 2;
}

function applyWorkGraphZoom() {
  const stage = el("work-graph-layout").querySelector(".work-graph-stage");
  const graph = stage?.querySelector(".work-graph");
  if (!stage || !graph) {
    updateWorkGraphZoomControls(false);
    return;
  }
  const width = Number(stage.dataset.graphWidth);
  const height = Number(stage.dataset.graphHeight);
  stage.style.width = `${width * state.workGraphZoom}px`;
  stage.style.height = `${height * state.workGraphZoom}px`;
  graph.style.transform = `scale(${state.workGraphZoom})`;
  updateWorkGraphZoomControls();
}

function setWorkGraphZoom(value) {
  const layout = el("work-graph-layout");
  const previousZoom = state.workGraphZoom;
  const nextZoom = Math.max(0.5, Math.min(2, Math.round(value * 10) / 10));
  if (nextZoom === previousZoom) return;
  const centerX = (layout.scrollLeft + layout.clientWidth / 2) / previousZoom;
  const centerY = (layout.scrollTop + layout.clientHeight / 2) / previousZoom;
  state.workGraphZoom = nextZoom;
  applyWorkGraphZoom();
  layout.scrollLeft = Math.max(0, centerX * nextZoom - layout.clientWidth / 2);
  layout.scrollTop = Math.max(0, centerY * nextZoom - layout.clientHeight / 2);
  state.workGraphScrollLeft = layout.scrollLeft;
  state.workGraphScrollTop = layout.scrollTop;
}

function renderWorkLinks(svg, edges) {
  const definitions = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.setAttribute("id", "work-link-arrow");
  marker.setAttribute("viewBox", "0 0 8 8");
  marker.setAttribute("refX", "7");
  marker.setAttribute("refY", "4");
  marker.setAttribute("markerWidth", "6");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("orient", "auto");
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrow.setAttribute("d", "M 0 0 L 8 4 L 0 8 z");
  marker.append(arrow);
  definitions.append(marker);
  svg.append(definitions);

  for (const edge of edges) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", roundedWorkLink(edge.points));
    path.setAttribute("marker-end", "url(#work-link-arrow)");
    path.dataset.source = edge.source;
    path.dataset.target = edge.target;
    svg.append(path);
  }
}

async function renderWorkGraph(workGraph, request) {
  const layout = el("work-graph-layout");
  const previousScrollLeft = state.workGraphScrollLeft;
  const previousScrollTop = state.workGraphScrollTop;
  if (workGraph.status !== "valid") {
    state.workGraphScrollLeft = 0;
    state.workGraphScrollTop = 0;
    const empty = document.createElement("p");
    empty.className = "empty work-graph-state";
    empty.textContent = workGraph.status === "missing"
      ? "This project does not have a Work Graph. Files remain available."
      : "This project has an invalid Work Graph. Files remain available.";
    layout.replaceChildren(empty);
    updateWorkGraphZoomControls(false);
    clearWorkDetail({ clearSelection: true });
    return true;
  }
  const works = workGraph.works;
  if (works.length === 0) {
    state.workGraphScrollLeft = 0;
    state.workGraphScrollTop = 0;
    const empty = document.createElement("p");
    empty.className = "empty work-graph-state";
    empty.textContent = "No Works are available.";
    layout.replaceChildren(empty);
    updateWorkGraphZoomControls(false);
    clearWorkDetail({ clearSelection: true });
    return true;
  }
  if (!works.some((work) => work.id === state.workId)) state.workId = works[0].id;
  const positioned = await layoutWorkGraph(works);
  if (request !== state.sonnerRequest) return false;
  const workById = new Map(works.map((work) => [work.id, work]));
  const graph = document.createElement("div");
  graph.className = "work-graph";
  graph.setAttribute("role", "list");
  graph.setAttribute("aria-label", "Overview to downstream Works");
  graph.style.width = `${positioned.width}px`;
  graph.style.height = `${positioned.height}px`;
  const links = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  links.classList.add("work-links");
  links.setAttribute("aria-hidden", "true");
  links.setAttribute("viewBox", `0 0 ${positioned.width} ${positioned.height}`);
  links.setAttribute("width", String(positioned.width));
  links.setAttribute("height", String(positioned.height));
  graph.append(links);
  renderWorkLinks(links, positioned.edges);
  for (const node of positioned.nodes) {
    const work = workById.get(node.id);
    const item = document.createElement("div");
    item.className = `work-item${work.id === state.workId ? " is-selected" : ""}`;
    item.dataset.workId = work.id;
    item.setAttribute("role", "listitem");
    item.style.left = `${node.x - node.width / 2}px`;
    item.style.top = `${node.y - node.height / 2}px`;
    item.style.width = `${node.width}px`;
    item.style.height = `${node.height}px`;
    let card;
    card = button("", "work-card", () => selectWork(work.id, works, card));
    card.dataset.workId = work.id;
    card.setAttribute("aria-pressed", String(work.id === state.workId));
    card.setAttribute("aria-controls", "work-detail");
    card.setAttribute("aria-label", work.id);
    const id = document.createElement("strong"); id.textContent = work.id;
    card.append(id);
    item.append(card);
    graph.append(item);
  }
  const stage = document.createElement("div");
  stage.className = "work-graph-stage";
  stage.dataset.graphWidth = String(positioned.width);
  stage.dataset.graphHeight = String(positioned.height);
  stage.append(graph);
  layout.replaceChildren(stage);
  applyWorkGraphZoom();
  renderWorkDetail(works);
  layout.scrollLeft = Math.min(previousScrollLeft, Math.max(0, layout.scrollWidth - layout.clientWidth));
  layout.scrollTop = Math.min(previousScrollTop, Math.max(0, layout.scrollHeight - layout.clientHeight));
  state.workGraphScrollLeft = layout.scrollLeft;
  state.workGraphScrollTop = layout.scrollTop;
  return true;
}

function fileLabel(node, { interactive = false } = {}) {
  const row = document.createElement(interactive ? "button" : "span");
  if (interactive) row.type = "button";
  row.className = `file-row type-${node.type}`;
  if (["file", "warning"].includes(node.type)) {
    const marker = document.createElement("span");
    marker.className = "file-marker";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = node.type === "warning" ? "⚠" : "▤";
    row.append(marker);
  }
  const name = document.createElement("span");
  name.className = "file-name";
  if (node.type === "file-counts") {
    for (const { extension, count } of node.counts) {
      const line = document.createElement("span");
      line.className = "file-count-line";
      line.textContent = `${count} ${extension ?? "extensionless"}`;
      name.append(line);
    }
  } else {
    name.textContent = node.type === "warning"
      ? `Legacy WORK_NODE.xml — rename to ${node.renameTo.split("/").at(-1)}`
      : node.name;
  }
  row.append(name);
  if (node.type === "file" && node.keyPoints) {
    const keyPoints = document.createElement("span");
    keyPoints.className = "file-key-points";
    keyPoints.id = `file-key-points-${++state.fileKeyPointsSequence}`;
    keyPoints.textContent = node.keyPoints;
    keyPoints.title = node.keyPoints;
    row.setAttribute("aria-describedby", keyPoints.id);
    row.append(keyPoints);
  }
  return row;
}

async function openFile(node, row) {
  if (state.openingPaths.has(node.path)) return;
  state.openingPaths.add(node.path);
  const restoreFocus = document.activeElement === row;
  row.disabled = true;
  el("sonner-status").textContent = `Opening ${node.name}…`;
  try {
    await postApi(boardUrl("/api/sonner/open"), { path: node.path }, "Open file");
    el("sonner-status").textContent = `Opened ${node.name}.`;
  } catch (error) {
    el("sonner-status").textContent = error.status === 409
      ? `${node.name} changed or is already opening. Refresh Sonner, then explicitly try again.`
      : error.status === 404
        ? `${node.name} is no longer in the Sonner index. Refresh Sonner, then explicitly try again.`
        : error.status === 400
          ? `${node.name} is not an openable project file.`
          : `Opening ${node.name} could not be confirmed. Explicitly try again if needed.`;
  } finally {
    state.openingPaths.delete(node.path);
    row.disabled = false;
    if (restoreFocus && row.isConnected) row.focus();
  }
}

function renderFileNode(node, depth = 0) {
  const item = document.createElement("li");
  item.className = "file-node";
  item.setAttribute("role", "treeitem");
  if (typeof node.path === "string") item.dataset.path = node.path;
  item.style.setProperty("--tree-depth", depth);
  if (node.type === "directory") {
    const details = document.createElement("details");
    item.setAttribute("aria-expanded", "false");
    const summary = document.createElement("summary");
    summary.append(fileLabel(node));
    details.append(summary);
    if ((node.children ?? []).length > 0) {
      const group = document.createElement("ul");
      group.setAttribute("role", "group");
      group.append(...node.children.map((child) => renderFileNode(child, depth + 1)));
      details.append(group);
    }
    details.addEventListener("toggle", () => {
      item.setAttribute("aria-expanded", String(details.open));
    });
    item.append(details);
  } else {
    const entry = document.createElement("div");
    entry.className = "file-entry";
    const row = fileLabel(node, { interactive: node.type === "file" });
    if (node.type === "file") {
      row.addEventListener("click", () => openFile(node, row));
      row.setAttribute("aria-label", `Open ${node.name}`);
    }
    entry.append(row);
    item.append(entry);
  }
  return item;
}

async function renderSonner(projection, request) {
  if (!await renderWorkGraph(projection.workGraph, request)) return;
  const root = projection.files.root;
  if ((root.children ?? []).length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No project files are available in the Sonner index.";
    el("files-tree").replaceChildren(empty);
  } else {
    const tree = document.createElement("ul");
    tree.className = "file-tree-root";
    tree.setAttribute("role", "group");
    tree.append(...root.children.map((child) => renderFileNode(child)));
    el("files-tree").replaceChildren(tree);
  }
  renderRuntime(projection.runtime);
  el("sonner-status").textContent = "";
}

async function loadSonner() {
  const request = ++state.sonnerRequest;
  const graphLayout = el("work-graph-layout");
  if (graphLayout.querySelector(".work-graph")) {
    state.workGraphScrollLeft = graphLayout.scrollLeft;
    state.workGraphScrollTop = graphLayout.scrollTop;
  }
  el("sonner-refresh").disabled = true;
  el("sonner-status").textContent = "Loading Sonner…";
  const loading = document.createElement("p");
  loading.className = "empty";
  loading.textContent = "Reading the project overview…";
  const graphLoading = loading.cloneNode(true);
  graphLayout.replaceChildren(graphLoading);
  updateWorkGraphZoomControls(false);
  clearWorkDetail();
  el("files-tree").replaceChildren(loading);
  clearRuntimeState();
  const runtimeLoading = document.createElement("p");
  runtimeLoading.className = "empty";
  runtimeLoading.textContent = "Reading current Runtime…";
  el("runtime-overall").replaceChildren(runtimeLoading);
  try {
    const projection = await api(boardUrl("/api/sonner"), "Sonner");
    if (request !== state.sonnerRequest) return;
    state.sonner = projection;
    await renderSonner(projection, request);
    if (request !== state.sonnerRequest) return;
    state.sonnerLoadedAt = new Date();
    renderSonnerLoadedAt();
  } catch (error) {
    if (request !== state.sonnerRequest) return;
    state.sonner = null;
    el("sonner-status").textContent = error.message;
    const unavailable = document.createElement("p");
    unavailable.className = "empty";
    unavailable.textContent = "Sonner is unavailable. Refresh to retry.";
    el("work-graph-layout").replaceChildren(unavailable.cloneNode(true));
    updateWorkGraphZoomControls(false);
    clearWorkDetail();
    el("files-tree").replaceChildren(unavailable);
    clearRuntimeState();
    el("runtime-overall").replaceChildren(unavailable.cloneNode(true));
  } finally {
    if (request === state.sonnerRequest) el("sonner-refresh").disabled = false;
  }
}

function activateBoardView(name) {
  const activity = name === "activity";
  state.boardView = name;
  el("shell").dataset.view = name;
  el("activity-view").hidden = !activity;
  el("sonner-view").hidden = activity;
  el("activity-sidebar").hidden = !activity;
  el("activity-view-button").setAttribute("aria-pressed", String(activity));
  el("sonner-view-button").setAttribute("aria-pressed", String(!activity));
  if (!activity && state.sonner == null) loadSonner();
  if (activity) scheduleLiveRefresh();
  else stopLiveRefresh();
}

function renderActivities() {
  el("activities").replaceChildren(...state.activities.map((activity) => {
    const item = button(activity.name, "activity-root-button", () => selectActivity(activity.id));
    item.title = activity.name;
    item.dataset.activityId = activity.id;
    item.setAttribute("aria-current", String(activity.id === state.activityId));
    return item;
  }));
}

function metric(label, value) {
  const span = document.createElement("span");
  span.textContent = `${label} ${value}`;
  return span;
}

function position(timestamp, timeline) {
  if (!timestamp || !timeline.startedAt || !timeline.endedAt) return 0;
  const span = Math.max(1, new Date(timeline.endedAt) - new Date(timeline.startedAt));
  return Math.max(0, Math.min(99.3, ((new Date(timestamp) - new Date(timeline.startedAt)) / span) * 100));
}

function renderTimeline() {
  const { agents, cycles, timeline, metrics } = state.detail;
  const metricNodes = [metric("elapsed", hours(timeline.elapsedMs))];
  if (state.detail.partial) metricNodes.push(metric("partial", "available records shown"));
  metricNodes.push(metric(state.detail.partial ? "agents shown" : "agents", `${metrics.shownAgentCount}${metrics.agentRatePerHour == null ? "" : ` · ${metrics.agentRatePerHour}/h`}`));
  metricNodes.push(metric(state.detail.partial ? "reviews shown" : "reviews", `${metrics.shownSignalCount}${metrics.signalRatePerHour == null ? "" : ` · ${metrics.signalRatePerHour}/h`}`));
  if (metrics.cumulativeTokens != null) metricNodes.push(metric("throughput", `${formatNumber(metrics.cumulativeTokens)} tok${metrics.tokenThroughputPerHour == null ? "" : ` · ${formatNumber(metrics.tokenThroughputPerHour)}/h`}`));
  if (metrics.retainedContextTokens != null) metricNodes.push(metric("retained context", `${formatNumber(metrics.retainedContextTokens)} tok`));
  if (metrics.compactions != null) metricNodes.push(metric("compactions", formatNumber(metrics.compactions)));
  el("metrics").replaceChildren(...metricNodes);
  const grid = document.createElement("div");
  grid.className = "timeline-grid";
  const tickRow = document.createElement("div"); tickRow.className = "timeline-row timeline-ticks";
  const tickLabel = document.createElement("div"); tickLabel.className = "timeline-label"; tickLabel.textContent = "Clock";
  const tickTrack = document.createElement("div"); tickTrack.className = "track";
  for (const ratio of [0, .25, .5, .75, 1]) {
    const tick = document.createElement("span"); tick.className = "clock-tick"; tick.style.left = `${ratio * 100}%`;
    const span = Math.max(0, new Date(timeline.endedAt) - new Date(timeline.startedAt));
    tick.textContent = clock(new Date(new Date(timeline.startedAt).valueOf() + span * ratio)); tickTrack.append(tick);
  }
  tickRow.append(tickLabel, tickTrack); grid.append(tickRow);
  for (const agent of agents) {
    const row = document.createElement("div");
    row.className = `timeline-row role-${agent.role}`;
    const label = document.createElement("div");
    label.className = "timeline-label";
    label.textContent = agent.name;
    label.title = `${agent.name} · ${agent.role}`;
    const track = document.createElement("div");
    track.className = "track";
    track.setAttribute("role", "group");
    const turns = agent.turns ?? [];
    const trackLabel = agent.available === false
      ? `${agent.name}, ${agent.role}: retained history unavailable`
      : `${agent.name}, ${agent.role}: ${turns.length} Turn${turns.length === 1 ? "" : "s"} shown`;
    track.setAttribute("aria-label", trackLabel);
    track.title = trackLabel;
    for (const turn of turns) {
      const turnStart = position(turn.startedAt, timeline);
      const turnEnd = position(turn.endedAt, timeline);
      const elapsed = Math.max(0, new Date(turn.endedAt) - new Date(turn.startedAt));
      const turnName = turn.evidence === "conversation"
        ? "Conversation response"
        : `Turn ${turn.turnId ?? turn.startSequence}`;
      const fullLabel = `${agent.name}, ${turnName}: ${clock(turn.startedAt)} to ${turn.state} at ${clock(turn.endedAt)}, ${duration(elapsed)}`;
      const bar = document.createElement("span");
      bar.className = "turn-band";
      bar.style.left = `${turnStart}%`;
      bar.style.width = `${Math.max(.7, turnEnd - turnStart)}%`;
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", fullLabel);
      bar.title = fullLabel;
      track.append(bar);
    }
    row.append(label, track);
    grid.append(row);
  }
  const cycleRow = document.createElement("div");
  cycleRow.className = "timeline-row cycles";
  const cycleLabel = document.createElement("div");
  cycleLabel.className = "timeline-label";
  cycleLabel.textContent = "Cycles";
  const cycleTrack = document.createElement("div");
  cycleTrack.className = "track";
  cycles.forEach((cycle, index) => {
    const next = cycles[index + 1];
    const interval = { ...cycle, endedAt: cycle.endedAt ?? next?.startedAt ?? timeline.endedAt };
    interval.durationMs = cycle.durationMs ?? (interval.startedAt && interval.endedAt
      ? Math.max(0, new Date(interval.endedAt) - new Date(interval.startedAt)) : null);
    const band = document.createElement("span");
    band.className = "cycle-band";
    band.setAttribute("role", "img");
    band.style.left = `${position(cycle.startedAt, timeline)}%`;
    band.style.width = `${Math.max(3, (next ? position(next.startedAt, timeline) : 100) - position(cycle.startedAt, timeline))}%`;
    band.textContent = String(index + 1);
    band.tabIndex = 0;
    band.dataset.readingFocusKind = "cycle";
    band.dataset.readingFocusKey = cycle.id;
    const fullLabel = `${cycle.label}: ${clock(interval.startedAt)} to ${clock(interval.endedAt)}, ${duration(interval.durationMs)}`;
    band.setAttribute("aria-label", fullLabel); band.title = fullLabel;
    cycleTrack.append(band);
  });
  cycleRow.append(cycleLabel, cycleTrack);
  grid.append(cycleRow);
  el("timeline").replaceChildren(grid);
}

function renderAgentDetail() {
  const agent = state.detail.agents.find((item) => item.id === state.agentId);
  if (!agent) { el("agent-detail").innerHTML = '<p class="empty">Select an Agent.</p>'; return; }
  const fragment = document.createDocumentFragment();
  if (agent.available === false) {
    const note = document.createElement("p"); note.className = "output-absence";
    note.textContent = "Retained history is unavailable. Only ledger-authorized Conversation transitions can be shown.";
    fragment.append(note);
  } else if (!agent.records.some((record) => record.kind === "output")) {
    const note = document.createElement("p"); note.className = "output-absence";
    note.textContent = "No confirmed Output is available. Visible Agent messages remain Think until retained completion evidence proves finality.";
    fragment.append(note);
  }
  const activities = agent.activity ?? agent.records.map((record) => ({ ...record, type: record.kind.toUpperCase() }));
  for (const activity of activities) {
    const article = document.createElement("article"); article.className = `activity-entry ${activity.kind}`; article.tabIndex = -1;
    const readingKey = conversationReadingKey(agent.id, activity);
    if (activity.conversationId) {
      article.dataset.conversationId = activity.conversationId; article.dataset.transition = activity.transition;
      article.dataset.readingFocusKind = "conversation-entry"; article.dataset.readingFocusKey = readingKey;
    }
    const head = document.createElement("div"); head.className = "activity-head";
    const type = document.createElement("span"); type.className = "activity-type"; type.textContent = activity.type ?? activity.direction;
    const time = document.createElement("time"); time.dateTime = activity.timestamp ?? ""; time.textContent = clock(activity.timestamp);
    head.append(type, time); article.append(head);
    if (activity.kind === "conversation") {
      const line = document.createElement("p"); line.className = "conversation-event";
      line.append(`${activity.direction === "SENT" ? "To" : "From"} `);
      const navigation = conversationNavigationTarget(state.detail.agents, activity);
      if (navigation) {
        const peer = button(activity.counterpartyName, "counterparty", () => selectAgent(navigation.agentId, navigation.activity));
        peer.setAttribute("aria-label", `${activity.direction === "SENT" ? "Sent to" : "Received from"} ${activity.counterpartyName}; open Agent activity`);
        peer.dataset.readingFocusKind = "conversation-control"; peer.dataset.readingFocusKey = readingKey;
        line.append(peer);
      } else { const peer = document.createElement("span"); peer.textContent = activity.counterpartyName; line.append(peer); }
      article.append(line);
    } else {
      const p = document.createElement("p"); p.className = `record ${activity.kind}`; p.textContent = activity.text; article.append(p);
    }
    fragment.append(article);
  }
  if (activities.length === 0) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No retained activity."; fragment.append(empty); }
  el("agent-detail").replaceChildren(fragment);
}

function selectAgent(agentId, activity = null) {
  state.agentId = agentId; renderAgents();
  if (activity?.conversationId) requestAnimationFrame(() => {
    const target = [...el("agent-detail").querySelectorAll(".activity-entry")].find((entry) =>
      conversationFocusMatches(entry.dataset, activity));
    target?.scrollIntoView({ block: "center" }); target?.focus();
  });
}

function renderAgents() {
  el("agents").replaceChildren(...state.detail.agents.map((agent) => {
    const item = button("", "item-button", () => selectAgent(agent.id));
    item.dataset.agentId = agent.id;
    item.dataset.readingFocusKind = "agent"; item.dataset.readingFocusKey = agent.id;
    item.setAttribute("aria-current", String(agent.id === state.agentId));
    const name = document.createElement("span"); name.className = "item-name"; name.textContent = agent.name;
    const meta = document.createElement("span"); meta.className = "item-meta";
    meta.textContent = agent.available === false ? `${agent.role} · unavailable` : agent.role;
    item.append(name, meta); return item;
  }));
  renderAgentDetail();
}

function renderSignalDetail() {
  const signal = state.detail.signals.find((item) => item.id === state.signalId);
  if (!signal) { el("signal-detail").innerHTML = '<p class="empty">Select a Review.</p>'; return; }
  const pre = document.createElement("pre"); pre.className = "raw"; pre.textContent = signal.raw;
  el("signal-detail").replaceChildren(pre);
}

function renderSignals() {
  const nodes = [];
  for (const cycle of state.detail.cycles) {
    const heading = document.createElement("div"); heading.className = "cycle-heading"; heading.textContent = cycle.label; nodes.push(heading);
    for (const signalId of cycle.signalIds) {
      const signal = state.detail.signals.find((item) => item.id === signalId);
      if (!signal) continue;
      const item = button("", "item-button signal-item", () => { state.signalId = signal.id; renderSignals(); renderSignalDetail(); });
      item.dataset.signalId = signal.id;
      item.dataset.readingFocusKind = "signal"; item.dataset.readingFocusKey = signal.id;
      item.setAttribute("aria-current", String(signal.id === state.signalId));
      const badges = document.createElement("span"); badges.className = "badges";
      const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = signal.severity; badges.append(badge);
      const name = document.createElement("span"); name.className = "item-name"; name.append(badges, signal.name); item.append(name); nodes.push(item);
    }
  }
  if (state.detail.unresolvedSignals.length > 0) {
    const heading = document.createElement("div"); heading.className = "cycle-heading"; heading.textContent = "Unresolved snapshot"; nodes.push(heading);
    for (const signalId of state.detail.unresolvedSignals) {
      const signal = state.detail.signals.find((item) => item.id === signalId);
      if (!signal) continue;
      const item = button("", "item-button signal-item", () => { state.signalId = signal.id; renderSignals(); renderSignalDetail(); });
      item.dataset.signalId = signal.id;
      item.dataset.readingFocusKind = "signal"; item.dataset.readingFocusKey = signal.id;
      item.setAttribute("aria-current", String(signal.id === state.signalId));
      const badges = document.createElement("span"); badges.className = "badges";
      const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = signal.severity; badges.append(badge);
      const name = document.createElement("span"); name.className = "item-name"; name.append(badges, signal.name); item.append(name); nodes.push(item);
    }
  }
  if (nodes.length === 0) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No retained Reviews."; nodes.push(empty); }
  el("signals").replaceChildren(...nodes); renderSignalDetail();
}

function renderDetail() {
  el("title").textContent = state.activities.find((activity) => activity.id === state.detail.activity.id)?.name
    ?? state.detail.activity.name;
  renderTimeline(); renderAgents(); renderSignals();
  const warnings = state.detail.diagnostics;
  el("status").textContent = state.detail.partial
    ? `Partial · available records shown. ${warnings.length} bounded diagnostic${warnings.length === 1 ? "" : "s"}.`
    : warnings.length ? `${warnings.length} bounded diagnostic${warnings.length === 1 ? "" : "s"}; available records are shown.` : "";
}

function clearDetail(activityId) {
  state.activityId = activityId;
  state.detail = null;
  state.agentId = null;
  state.signalId = null;
  renderActivities();
  el("title").textContent = state.activities.find((activity) => activity.id === activityId)?.name ?? "Loading…";
  el("metrics").replaceChildren();
  el("timeline").replaceChildren();
  el("agents").replaceChildren();
  el("signals").replaceChildren();
  el("agent-detail").innerHTML = '<p class="empty">Loading selected Activity…</p>';
  el("signal-detail").innerHTML = '<p class="empty">Loading selected Activity…</p>';
}

function clearActivity(title, detailMessage) {
  state.detail = null;
  state.agentId = null;
  state.signalId = null;
  el("title").textContent = title;
  el("metrics").replaceChildren();
  el("timeline").replaceChildren();
  el("agents").replaceChildren();
  el("signals").replaceChildren();
  el("agent-detail").innerHTML = `<p class="empty">${detailMessage}</p>`;
  el("signal-detail").innerHTML = `<p class="empty">${detailMessage}</p>`;
}

const READING_SCROLL_IDS = ["timeline", "agents", "agent-detail", "signals", "signal-detail"];

function captureReadingState() {
  const active = document.activeElement;
  return {
    activityId: state.activityId,
    agentId: state.agentId,
    signalId: state.signalId,
    tab: el("signals-tab").getAttribute("aria-selected") === "true" ? "signals" : "agents",
    scroll: Object.fromEntries(READING_SCROLL_IDS.map((id) => [id, { left: el(id).scrollLeft, top: el(id).scrollTop }])),
    focus: readingFocusDescriptor(active),
  };
}

function readingFocusTarget(focus, selectedAgentId) {
  for (const candidate of readingFocusCandidates(focus, selectedAgentId)) {
    if (candidate.id) {
      const target = document.getElementById(candidate.id);
      if (target) return target;
      continue;
    }
    const target = [...document.querySelectorAll("[data-reading-focus-kind][data-reading-focus-key]")]
      .find((item) => item.dataset.readingFocusKind === candidate.kind && item.dataset.readingFocusKey === candidate.key);
    if (target) return target;
  }
  return null;
}

function restoreReadingState(reading) {
  if (!reading || reading.activityId !== state.activityId || !state.detail) return;
  if (state.detail.agents.some((agent) => agent.id === reading.agentId)) state.agentId = reading.agentId;
  if (state.detail.signals.some((signal) => signal.id === reading.signalId)) state.signalId = reading.signalId;
  activateTab(reading.tab);
  renderDetail();
  requestAnimationFrame(() => {
    restoreDeferredReadingFocus({
      activityId: reading.activityId,
      currentActivityId: state.activityId,
      hasDetail: Boolean(state.detail),
      restoreScroll() {
        for (const [id, position] of Object.entries(reading.scroll)) {
          el(id).scrollLeft = position.left;
          el(id).scrollTop = position.top;
        }
      },
      focusDisplaced() {
        const active = document.activeElement;
        return !active || active === document.body || active === document.documentElement;
      },
      resolveTarget: () => readingFocusTarget(reading.focus, state.agentId),
    });
  });
}

function stopLiveRefresh() {
  clearTimeout(state.liveTimer);
  state.liveTimer = null;
  state.liveGeneration += 1;
}

function scheduleLiveRefresh(delay = 2_000) {
  clearTimeout(state.liveTimer);
  state.liveTimer = null;
  if (document.hidden || state.boardView !== "activity" || !Number.isSafeInteger(state.liveRevision) || !state.detail) return;
  const generation = state.liveGeneration;
  state.liveTimer = setTimeout(() => refreshSelectedActivity(generation), delay);
}

async function refreshSelectedActivity(generation = state.liveGeneration) {
  if (generation !== state.liveGeneration || state.liveInFlight || document.hidden || state.boardView !== "activity"
      || !state.activityId || !Number.isSafeInteger(state.liveRevision)) return;
  state.liveInFlight = true;
  const activityId = state.activityId;
  const revision = state.liveRevision;
  try {
    const update = await api(boardUrl(`/api/activity/updates?id=${encodeURIComponent(activityId)}&revision=${revision}`));
    if (generation !== state.liveGeneration || activityId !== state.activityId) return;
    if (update.status === "changed" && update.detail) {
      const reading = captureReadingState();
      state.detail = update.detail;
      state.liveRevision = update.revision;
      restoreReadingState(reading);
    } else if (update.status === "unchanged") state.liveRevision = update.revision;
  } catch (error) {
    if (generation !== state.liveGeneration || activityId !== state.activityId) return;
    if (error.status === 409 && error.payload?.error === "ACTIVITY_REFRESH_REQUIRED") {
      state.liveRevision = null;
      el("status").textContent = "Activity changed outside this view. Refresh to continue live updates.";
      return;
    }
  } finally {
    state.liveInFlight = false;
    if (generation === state.liveGeneration) scheduleLiveRefresh();
  }
}

let pendingReadingState = null;

const activitySelection = createActivitySelection({
  loadDetail: (activityId) => api(boardUrl(`/api/activity?id=${encodeURIComponent(activityId)}`)),
  begin(activityId) {
    stopLiveRefresh();
    clearDetail(activityId);
    el("status").textContent = "Loading retained activity…";
  },
  commit(activityId, detail) {
    if (state.activityId !== activityId) return;
    state.detail = detail;
    const reading = pendingReadingState?.activityId === activityId ? pendingReadingState : null;
    pendingReadingState = null;
    state.agentId = reading && state.detail.agents.some((agent) => agent.id === reading.agentId)
      ? reading.agentId : state.detail.agents[0]?.id ?? null;
    state.signalId = reading && state.detail.signals.some((signal) => signal.id === reading.signalId)
      ? reading.signalId : state.detail.signals[0]?.id ?? null;
    state.liveRevision = detail.live?.status === "ready" ? detail.live.revision : null;
    renderDetail();
    if (reading) restoreReadingState(reading);
    scheduleLiveRefresh();
  },
  fail(activityId, error) {
    if (state.activityId !== activityId) return;
    clearDetail(activityId);
    el("agent-detail").innerHTML = '<p class="empty">Selected Activity detail is unavailable.</p>';
    el("signal-detail").innerHTML = '<p class="empty">Selected Activity detail is unavailable.</p>';
    el("status").textContent = error.message;
    state.liveRevision = null;
  },
});

async function selectActivity(activityId) {
  await activitySelection.select(activityId);
}

function activateTab(name) {
  const agents = name === "agents";
  el("agents-tab").setAttribute("aria-selected", String(agents)); el("agents-tab").tabIndex = agents ? 0 : -1;
  el("signals-tab").setAttribute("aria-selected", String(!agents)); el("signals-tab").tabIndex = agents ? -1 : 0;
  el("agents-panel").hidden = !agents; el("signals-panel").hidden = agents;
}

const load = createActivityListLoader({
  loadActivities: () => api(boardUrl("/api/activities")),
  begin() {
    pendingReadingState = state.detail ? captureReadingState() : null;
    stopLiveRefresh();
    state.liveRevision = null;
    activitySelection.invalidate();
    clearActivity("Refreshing Activity…", "Refreshing available records…");
    el("status").textContent = "Refreshing retained activity…";
  },
  commitActivities(data) {
    state.activities = data.activities;
    renderActivities();
  },
  selectActivity,
  showEmpty(data, message) {
    state.activityId = null;
    renderActivities();
    clearActivity(data.project.rootName, data.partial ? "No verified Activity detail is currently available." : "No retained Activity detail.");
    el("status").textContent = message;
  },
  fail(error) {
    state.activities = [];
    state.activityId = null;
    renderActivities();
    clearActivity("Activity unavailable", "Activity data is unavailable.");
    el("status").textContent = error.message;
    pendingReadingState = null;
  },
  preferredActivityId: () => state.activityId,
});

el("agents-tab").addEventListener("click", () => activateTab("agents"));
el("signals-tab").addEventListener("click", () => activateTab("signals"));
el("agents-tab").addEventListener("keydown", (event) => { if (event.key === "ArrowRight") { activateTab("signals"); el("signals-tab").focus(); } });
el("signals-tab").addEventListener("keydown", (event) => { if (event.key === "ArrowLeft") { activateTab("agents"); el("agents-tab").focus(); } });
el("work-graph-tab").addEventListener("click", () => activateSonnerTab("work-graph"));
el("files-tab").addEventListener("click", () => activateSonnerTab("files"));
el("runtime-tab").addEventListener("click", () => activateSonnerTab("runtime"));
const sonnerTabs = ["work-graph", "files", "runtime"];
sonnerTabs.forEach((tab, index) => el(`${tab}-tab`).addEventListener("keydown", (event) => {
  let nextIndex = null;
  if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = sonnerTabs.length - 1;
  else if (event.key === "ArrowRight") nextIndex = (index + 1) % sonnerTabs.length;
  else if (event.key === "ArrowLeft") nextIndex = (index - 1 + sonnerTabs.length) % sonnerTabs.length;
  if (nextIndex === null) return;
  event.preventDefault();
  activateSonnerTab(sonnerTabs[nextIndex], { focus: true });
}));
el("refresh").addEventListener("click", load);
el("sonner-refresh").addEventListener("click", loadSonner);
el("work-graph-zoom-out").addEventListener("click", () => setWorkGraphZoom(state.workGraphZoom - 0.1));
el("work-graph-zoom-reset").addEventListener("click", () => setWorkGraphZoom(1));
el("work-graph-zoom-in").addEventListener("click", () => setWorkGraphZoom(state.workGraphZoom + 0.1));
el("activity-view-button").addEventListener("click", () => activateBoardView("activity"));
el("sonner-view-button").addEventListener("click", () => activateBoardView("sonner"));
const activityButtons = [el("activity-view-button"), el("sonner-view-button")];
activityButtons.forEach((activityButton, index) => activityButton.addEventListener("keydown", (event) => {
  const direction = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1
    : ["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 0;
  if (direction === 0) return;
  event.preventDefault();
  const next = activityButtons[(index + direction + activityButtons.length) % activityButtons.length];
  activateBoardView(next === activityButtons[0] ? "activity" : "sonner");
  next.focus();
}));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopLiveRefresh();
  else scheduleLiveRefresh(0);
});
load();
