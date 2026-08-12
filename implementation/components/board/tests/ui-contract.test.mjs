import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { conversationFocusMatches, conversationNavigationTarget, conversationReadingKey, createActivityListLoader,
  createActivitySelection, emptyActivityMessage, readingFocusCandidates, readingFocusDescriptor,
  restoreDeferredReadingFocus } from "../public/activity-selection.js";

const elkModule = await import("../public/vendor/elk.bundled.js");
globalThis.ELK = elkModule.default;
const { layoutWorkGraph, roundedWorkLink } = await import("../public/sonner-view.js");

const boardComponentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Activity UI preserves the Timeline, tabs, accessibility, and responsive contract", async () => {
  const [html, css, js] = await Promise.all([
    readFile(path.join(boardComponentRoot, "public/index.html"), "utf8"),
    readFile(path.join(boardComponentRoot, "public/styles.css"), "utf8"),
    readFile(path.join(boardComponentRoot, "public/app.js"), "utf8"),
  ]);
  assert.match(html, /id="timeline"[^>]*role="region"[^>]*aria-labelledby="timeline-title"[^>]*tabindex="-1"/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, />Reviews<\/button>/); assert.match(html, /aria-label="Reviews"/); assert.doesNotMatch(html, />Signals<\/button>/);
  assert.match(css, /color-scheme:\s*light/);
  assert.match(css, /@media\(max-width:\s*720px\)/);
  assert.match(css, /html, body\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden/);
  assert.match(css, /\.shell\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%/);
  assert.match(css, /main\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0/);
  assert.match(css, /header\s*>\s*div\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.timeline-scroll\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*overflow:\s*auto/);
  assert.match(css, /\.split\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.turn-band\s*\{[^}]*border-radius:\s*2px/); assert.doesNotMatch(`${css}\n${js}`, /\.mark|outside-cycle/);
  assert.match(js, /textContent = signal\.raw/);
  assert.match(js, /badge\.textContent = signal\.severity/);
  assert.doesNotMatch(js, /signal\.disposition/);
  assert.match(js, /agent\.activity/); assert.match(js, /activity\.type \?\? activity\.direction/);
  assert.match(js, /No confirmed Output is available\. Visible Agent messages remain Think until retained completion evidence proves finality\./);
  assert.match(js, /conversationNavigationTarget/); assert.match(js, /scrollIntoView/); assert.match(js, /target\?\.focus/);
  assert.match(js, /ArrowRight/);
  assert.match(js, /ArrowLeft/);
  assert.match(js, /partial.*available records shown/is);
  assert.match(js, /metrics\.cumulativeTokens != null/);
  assert.match(js, /\$\{label\} is busy\. Retry with Refresh/);
  assert.match(js, /Unresolved snapshot/);
  assert.match(js, /state\.detail\.cycles/);
  assert.match(js, /band\.textContent = String\(index \+ 1\)/); assert.match(js, /band\.setAttribute\("aria-label", fullLabel\)/);
  assert.match(js, /track\.setAttribute\("role", "group"\)/); assert.match(js, /bar\.setAttribute\("role", "img"\)/); assert.match(js, /band\.setAttribute\("role", "img"\)/);
  assert.doesNotMatch(js, /pointerenter|focus", highlight/); assert.match(js, /clock-tick/);
  assert.match(js, /for \(const turn of turns\)/);
  assert.match(js, /retained history unavailable/);
  assert.match(js, /Retained history is unavailable\. Only ledger-authorized Conversation transitions can be shown\./);
  assert.match(css, /\.activity-view\s*\{[^}]*height:\s*100%;[^}]*grid-template-rows:[^}]*minmax\(0, 1fr\)[^}]*overflow:\s*hidden/);
  assert.match(css, /\.detail-panel\s*\{[^}]*min-height:\s*0;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  assert.match(js, /No retained Reviews/); assert.match(js, /reviews shown/);
  assert.match(js, /\/api\/activity\/updates\?id=/);
  assert.match(js, /document\.hidden/);
  assert.match(js, /state\.liveInFlight/);
  assert.match(js, /captureReadingState/);
  assert.match(js, /restoreReadingState/);
  assert.match(js, /data-reading-focus-kind/);
  assert.match(js, /band\.dataset\.readingFocusKind = "cycle"/);
  assert.match(js, /article\.dataset\.readingFocusKind = "conversation-entry"/);
  assert.match(js, /peer\.dataset\.readingFocusKind = "conversation-control"/);
  assert.match(js, /item\.dataset\.readingFocusKind = "agent"/);
  assert.match(js, /item\.dataset\.readingFocusKind = "signal"/);
  assert.match(js, /restoreDeferredReadingFocus/);
  assert.match(js, /restoreScroll\(\) \{[\s\S]*scrollLeft = position\.left;[\s\S]*scrollTop = position\.top;[\s\S]*focusDisplaced\(\)/);
  assert.match(js, /!active \|\| active === document\.body \|\| active === document\.documentElement/);
  assert.match(js, /Activity changed outside this view\. Refresh to continue live updates\./);
  assert.doesNotMatch(js, /EventSource\(boardUrl\("\/api\/activity\/updates/);
});

test("Activity Bar switches Activity and Sonner while Work Graph, Files, and Runtime remain accessible", async () => {
  const [html, css, js] = await Promise.all([
    readFile(path.join(boardComponentRoot, "public/index.html"), "utf8"),
    readFile(path.join(boardComponentRoot, "public/styles.css"), "utf8"),
    readFile(path.join(boardComponentRoot, "public/app.js"), "utf8"),
  ]);
  assert.match(html, /class="activity-bar" aria-label="Board views"/);
  assert.match(html, /id="activity-view-button"[^>]*aria-pressed="true"[^>]*aria-controls="activity-view"/);
  assert.match(html, /id="sonner-view-button"[^>]*aria-pressed="false"[^>]*aria-controls="sonner-view"/);
  assert.match(html, /id="activity-view-button"[^>]*aria-label="Activity"/);
  assert.match(html, /id="sonner-view-button"[^>]*aria-label="Sonner"/);
  assert.match(html, /id="activity-view-button"[^>]*data-label="Activity"/);
  assert.match(html, /id="sonner-view-button"[^>]*data-label="Sonner"/);
  assert.match(html, /class="task-glyph"/);
  assert.match(html, /id="sonner-view"[^>]*aria-label="Sonner"[^>]*hidden/);
  assert.match(html, /id="sonner-status" role="status" aria-live="polite"/);
  assert.match(html, /class="tabs sonner-tabs" role="tablist" aria-label="Sonner details"/);
  assert.match(html, /id="work-graph-tab"[^>]*aria-selected="true"[^>]*aria-controls="work-graph-panel"/);
  assert.match(html, /id="files-tab"[^>]*aria-selected="false"[^>]*aria-controls="files-panel"[^>]*tabindex="-1"/);
  assert.match(html, /id="runtime-tab"[^>]*aria-selected="false"[^>]*aria-controls="runtime-panel"[^>]*tabindex="-1"/);
  assert.match(html, /id="work-graph-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="work-graph-tab"/);
  assert.match(html, /id="files-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="files-tab"[^>]*hidden/);
  assert.match(html, /id="runtime-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="runtime-tab"[^>]*hidden/);
  assert.match(html, /id="work-graph-layout"[^>]*role="region"[^>]*aria-label="Sonner Work Graph"/);
  assert.match(html, /class="work-graph-toolbar"[^>]*role="group"[^>]*aria-label="Work Graph zoom"/);
  assert.match(html, /id="work-graph-zoom-out"[^>]*aria-label="Zoom out"[^>]*disabled/);
  assert.match(html, /id="work-graph-zoom-reset"[^>]*>100%<\/button>/);
  assert.match(html, /id="work-graph-zoom-in"[^>]*aria-label="Zoom in"[^>]*disabled/);
  assert.match(html, /id="work-detail"[^>]*aria-label="Selected Work details"[^>]*aria-live="polite"/);
  assert.match(html, /id="files-tree"[^>]*role="tree"[^>]*aria-label="Sonner Files tree"/);
  assert.match(html, /id="runtime-task-list"[^>]*class="runtime-task-list"/);
  assert.doesNotMatch(html, /id="runtime-task-list"[^>]*role="list"/);
  assert.match(html, /class="runtime-view"[^>]*aria-label="Current Runtime health"/);
  assert.match(html, /id="runtime-task-list"[^>]*role="region"[^>]*tabindex="-1"[^>]*aria-label="Active Tasks"/);
  assert.doesNotMatch(`${html}\n${js}\n${css}`, /runtime-task-tree/);
  assert.match(html, /<script src="\/vendor\/elk\.bundled\.js"><\/script>/);
  assert.doesNotMatch(html, /class="section-head work-graph-heading"/);
  assert.doesNotMatch(html, /class="section-head files-section-head"/);
  assert.match(js, /boardUrl\("\/api\/sonner"\)/);
  assert.match(js, /boardUrl\("\/api\/sonner\/open"\)/);
  assert.match(js, /method: "POST"/);
  assert.match(js, /item\.setAttribute\("role", "treeitem"\)/);
  assert.match(js, /item\.setAttribute\("aria-expanded", "false"\)/);
  assert.match(js, /details\.addEventListener\("toggle"/);
  assert.match(js, /row\.addEventListener\("click", \(\) => openFile/);
  assert.match(js, /row\.setAttribute\("aria-describedby", summary\.id\)/);
  assert.match(js, /summary\.title = node\.summary/);
  assert.match(js, /renderFileNode\(node, depth = 0\)/);
  assert.match(js, /style\.setProperty\("--tree-depth", depth\)/);
  assert.match(js, /if \(node\.type === "directory"\)/);
  assert.match(js, /name: "…", type: "omission", summary: node\.summary/);
  assert.match(js, /layoutWorkGraph\(works\)/);
  assert.match(js, /\["Inputs", work\.inputs\]/);
  assert.match(js, /\["Outputs", work\.outputs\]/);
  assert.match(js, /value\.length === 0[\s\S]*description\.textContent = "—"/);
  assert.match(js, /button\(workId, "work-relation-link"/);
  assert.match(js, /selectWork\(workId, works, card, \{ reveal: true \}\)/);
  assert.match(js, /if \(reveal\) card\.scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/);
  assert.match(js, /card\.setAttribute\("aria-pressed"/);
  assert.match(js, /card\.setAttribute\("aria-controls", "work-detail"\)/);
  assert.match(js, /card\.addEventListener|button\("", "work-card"/);
  assert.match(js, /item\.className = `work-item\$\{work\.id === state\.workId \? " is-selected" : ""\}`/);
  assert.doesNotMatch(js, /selectedItem\?\.append\(workDetail\)/);
  assert.doesNotMatch(js, /workDetail\.scrollIntoView/);
  assert.match(js, /function renderWorkLinks\(svg, edges\)/);
  assert.match(js, /document\.createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "svg"\)/);
  assert.match(js, /path\.setAttribute\("marker-end", "url\(#work-link-arrow\)"\)/);
  assert.match(js, /roundedWorkLink\(edge\.points\)/);
  assert.match(js, /item\.style\.left = `\$\{node\.x - node\.width \/ 2\}px`/);
  assert.match(js, /graph\.style\.width = `\$\{positioned\.width\}px`/);
  assert.match(js, /function setWorkGraphZoom\(value\)/);
  assert.match(js, /Math\.max\(0\.5, Math\.min\(2, Math\.round\(value \* 10\) \/ 10\)\)/);
  assert.match(js, /graph\.style\.transform = `scale\(\$\{state\.workGraphZoom\}\)`/);
  assert.match(js, /stage\.dataset\.graphWidth = String\(positioned\.width\)/);
  assert.doesNotMatch(js, /laneOffset|function drawWorkLinks/);
  assert.match(js, /card\.focus\(\{ preventScroll: true \}\)/);
  assert.match(js, /if \(graphLayout\.querySelector\("\.work-graph"\)\) \{[\s\S]*state\.workGraphScrollLeft = graphLayout\.scrollLeft;[\s\S]*state\.workGraphScrollTop = graphLayout\.scrollTop/);
  assert.match(js, /previousScrollLeft = state\.workGraphScrollLeft[\s\S]*previousScrollTop = state\.workGraphScrollTop[\s\S]*layout\.scrollLeft = Math\.min\(previousScrollLeft[\s\S]*layout\.scrollTop = Math\.min\(previousScrollTop/);
  assert.match(js, /clearWorkDetail\(\{ clearSelection: true \}\)/);
  assert.match(js, /clearWorkDetail\(\);/);
  assert.match(js, /Open Folder/);
  assert.match(js, /openingPaths\.has\(node\.path\)/);
  assert.match(js, /row\.disabled = true;[\s\S]*Opening \$\{node\.name\}/);
  assert.match(js, /restoreFocus = document\.activeElement === row[\s\S]*row\.isConnected[\s\S]*row\.focus\(\)/);
  assert.match(js, /error\.status === 409[\s\S]*changed or is already opening/);
  assert.match(js, /error\.status === 404[\s\S]*no longer in the Sonner index/);
  assert.match(js, /Opening \$\{node\.name\} could not be confirmed/);
  assert.match(js, /path: directoryPath/);
  assert.match(js, /await renderWorkGraph\(projection\.workGraph, request\)/);
  assert.match(js, /renderRuntime\(projection\.runtime\)/);
  assert.match(js, /function runtimeTaskList\(tasks\)/);
  assert.match(js, /list\.setAttribute\("aria-label", "Active Tasks"\)/);
  assert.doesNotMatch(js, /renderRuntimeActivities|selectRuntimeActivity|runtime\.activities|runtimeActivityId/);
  assert.match(js, /function runtimeHealthLabel\(value\)/);
  for (const label of ["OK", "Attention", "Unknown"]) assert.match(js, new RegExp(`"${label}"`));
  assert.match(js, /function runtimeTaskStateLabel\(value\)/);
  for (const label of ["Not started", "Running", "Aborted", "Unknown"]) assert.match(js, new RegExp(`"${label}"`));
  assert.doesNotMatch(js, /"Ended"|Settlement|runtimeCounts|runtimeCoordination/);
  assert.match(js, /function runtimeHealth\(health\)/);
  assert.match(js, /term\.textContent = "Health:"/);
  assert.match(js, /No active Tasks\./);
  assert.match(html, /id="sonner-loaded-at"[^>]*aria-live="polite"/);
  assert.match(js, /function renderSonnerLoadedAt\(\)/);
  assert.match(js, /state\.sonnerLoadedAt = new Date\(\)/);
  assert.match(js, /function runtimeReasonLabel\(value\)/);
  assert.match(js, /runtime-task-id/);
  assert.doesNotMatch(js, /runtime-ended-group|runtime-root-button/);
  assert.match(js, /listRegion\.tabIndex = runtime\.tasks\.length > 0 \? 0 : -1/);
  assert.match(js, /clearRuntimeState\(\{ focusFallback = true \} = \{\}\)/);
  assert.match(js, /listHadFocus[\s\S]*runtime-tab[\s\S]*focus\(\{ preventScroll: true \}\)/);
  assert.match(js, /Reading current Runtime…/);
  assert.doesNotMatch(js, /work\.type/);
  assert.match(js, /This project does not have a Work Graph\. Files remain available\./);
  assert.match(js, /This project has an invalid Work Graph\. Files remain available\./);
  assert.match(js, /const sonnerTabs = \["work-graph", "files", "runtime"\]/);
  assert.match(js, /activateSonnerTab\(sonnerTabs\[nextIndex\], \{ focus: true \}\)/);
  assert.doesNotMatch(js, /node\.type === "directory" \? "📁"/);
  assert.doesNotMatch(js, /node\.omission|omitted-badge|Valid Work Graph/);
  assert.match(js, /Loading Sonner/);
  assert.match(js, /Sonner is unavailable\. Refresh to retry/);
  assert.match(js, /ArrowDown/); assert.match(js, /ArrowUp/);
  assert.match(css, /\.activity-bar\s*\{[^}]*flex-direction:\s*column/);
  assert.match(css, /\.activity-button:focus-visible/);
  assert.match(css, /\.activity-button:hover::after, \.activity-button:focus-visible::after/);
  assert.match(css, /\.shell\[data-view="sonner"\]/);
  assert.match(css, /\.file-row\s*\{[^}]*grid-template-columns:/);
  assert.match(css, /--summary-column:/);
  assert.match(css, /var\(--tree-depth\) \* var\(--tree-indent\)/);
  assert.match(css, /\.type-file \.file-name\s*\{[^}]*text-decoration:\s*underline/);
  assert.match(css, /\.file-summary\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.doesNotMatch(css, /\.file-tooltip/);
  assert.doesNotMatch(css, /\.omitted-badge|\.graph-status/);
  assert.match(css, /\.file-node details > summary:focus-visible/);
  assert.match(css, /\.shell\[data-view="sonner"\]\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden/);
  assert.match(css, /\.sonner-view\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\)/);
  assert.match(css, /#work-graph-panel:not\(\[hidden\]\)\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[^}]*overflow:\s*hidden/);
  assert.match(css, /\.work-graph-toolbar\s*\{[^}]*justify-content:\s*flex-end/);
  assert.match(css, /\.work-graph-layout\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.work-graph-stage\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.work-graph\s*\{[^}]*position:\s*absolute;[^}]*transform-origin:\s*top left/);
  assert.match(css, /#runtime-panel:not\(\[hidden\]\)\s*\{[^}]*display:\s*block;[^}]*overflow:\s*hidden/);
  assert.match(css, /\.runtime-view\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);[^}]*overflow:\s*hidden/);
  assert.match(css, /\.runtime-task-list\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.runtime-task-list:focus-visible/);
  assert.doesNotMatch(css, /\.runtime-task-list li > ul::before/);
  assert.doesNotMatch(css, /runtime-root-button|runtime-roots|runtime-ended-group/);
  assert.doesNotMatch(css, /\.work-rank\s*\{/);
  assert.match(css, /\.work-item\s*\{[^}]*position:\s*absolute;[^}]*display:\s*grid/);
  assert.doesNotMatch(css, /\.work-item\.is-selected\s*\{[^}]*width:/);
  assert.match(css, /\.work-links\s*\{[^}]*position:\s*absolute;[^}]*pointer-events:\s*none/);
  assert.match(css, /\.work-links path\s*\{[^}]*stroke:/);
  assert.match(css, /\.work-card:focus-visible/);
  assert.match(css, /\.work-card\[aria-pressed="true"\]/);
  assert.match(css, /\.work-card strong\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.work-detail\s*\{[^}]*width:\s*100%;[^}]*min-height:\s*0;[^}]*max-height:\s*clamp\([^}]*overflow:\s*auto;[^}]*border-top:/);
  assert.match(css, /\.sonner-tab-panel\[hidden\]\s*\{\s*display:\s*none/);
});

test("Sonner uses deterministic compact ELK coordinates and orthogonal edge routes", async () => {
  const works = [
    { id: "overview", inputs: [] },
    { id: "product", inputs: ["overview"] },
    { id: "interaction", inputs: ["overview", "product"] },
    { id: "system", inputs: ["overview", "product"] },
    { id: "technical", inputs: ["interaction", "system"] },
    { id: "implementation", inputs: ["technical"] },
    { id: "guide", inputs: ["implementation"] },
  ];
  const first = await layoutWorkGraph(works);
  const second = await layoutWorkGraph(works);
  assert.deepEqual(first, second);
  assert.equal(first.nodes.length, works.length);
  assert.equal(first.edges.length, works.reduce((count, work) => count + work.inputs.length, 0));
  assert.ok(first.width > 190);
  assert.ok(first.height > 38);
  assert.ok(first.edges.every((edge) => edge.points.length >= 2));
  assert.ok(first.nodes.every((node) => node.height === 38 && node.width >= 92));
  assert.equal(new Set(first.nodes.map((node) => `${node.x},${node.y}`)).size, works.length);
});

test("Sonner rounds only ELK route corners without moving their endpoints", () => {
  assert.equal(roundedWorkLink([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 30, y: 20 }]),
    "M 0 0 L 0 12 Q 0 20 8 20 L 30 20");
  assert.equal(roundedWorkLink([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 20 }]),
    "M 0 0 L 0 10 L 0 20");
  assert.equal(roundedWorkLink([{ x: 4, y: 7 }, { x: 4, y: 11 }]), "M 4 7 L 4 11");
});

test("899px desktop constrains the document while Timeline owns horizontal overflow", async () => {
  const css = await readFile(path.join(boardComponentRoot, "public/styles.css"), "utf8");
  const px = (name) => Number(css.match(new RegExp(`--${name}:\\s*(\\d+)px`))?.[1]);
  const viewport = 899;
  const desktopBreakpoint = 720;
  const activity = px("activity-width");
  const sidebar = px("sidebar-width");
  const gutter = px("main-gutter");
  const timelineMinimum = px("timeline-min-width");
  assert.ok(viewport > desktopBreakpoint);
  assert.deepEqual({ activity, sidebar, gutter, timelineMinimum }, { activity: 52, sidebar: 230, gutter: 22, timelineMinimum: 680 });
  const mainWidth = viewport - activity - sidebar;
  const panelContentWidth = mainWidth - (2 * gutter);
  assert.equal(mainWidth, 617);
  assert.equal(panelContentWidth, 573);
  assert.ok(timelineMinimum > panelContentWidth - 28, "Timeline content requires its internal scroller at 899px");
  assert.match(css, /html, body\s*\{[^}]*max-width:\s*100%/);
  assert.match(css, /\.shell\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%/);
  assert.match(css, /main\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0/);
  assert.match(css, /\.panel\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow:\s*hidden/);
  assert.match(css, /\.timeline-scroll\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*overflow:\s*auto/);
});

test("Conversation counterparty focus selects only the matching durable transition", () => {
  const activity = { conversationId: "conversation-1", transition: "reply" };
  assert.equal(conversationFocusMatches({ conversationId: "conversation-1", transition: "reply" }, activity), true);
  assert.equal(conversationFocusMatches({ conversationId: "conversation-1", transition: "send" }, activity), false);
  assert.equal(conversationFocusMatches({ conversationId: "conversation-2", transition: "reply" }, activity), false);
  assert.equal(conversationFocusMatches({}, activity), false);
});

test("Conversation navigation requires a projected Agent and its exact retained opposite transition", () => {
  const source = { kind: "conversation", taskId: "activity", conversationId: "conversation-1", transition: "reply",
    direction: "RECEIVED", counterpartyTaskId: "primary", counterpartyAvailable: true };
  const target = { kind: "conversation", taskId: "primary", conversationId: "conversation-1", transition: "reply",
    direction: "SENT", counterpartyTaskId: "activity" };
  assert.deepEqual(conversationNavigationTarget([{ id: "primary", activity: [target] }], source),
    { agentId: "primary", activity: target });
  for (const agents of [[], [{ id: "primary", activity: [] }],
    [{ id: "primary", activity: [{ ...target, transition: "send" }] }]]) {
    assert.equal(conversationNavigationTarget(agents, source), null);
  }
  assert.equal(conversationNavigationTarget([{ id: "primary", activity: [target] }],
    { ...source, counterpartyAvailable: false }), null);
});

test("reading focus identities and bounded fallbacks are semantic and stable", () => {
  const activity = { conversationId: "conversation-1", transition: "reply", timestamp: "ignored", text: "ignored" };
  const conversationKey = conversationReadingKey("agent-1", activity);
  assert.equal(conversationKey, JSON.stringify(["agent-1", "conversation-1", "reply"]));
  assert.equal(conversationReadingKey("agent-1", { transition: "reply" }), null);
  assert.deepEqual(readingFocusDescriptor({ id: "agents-tab", dataset: {} }), { id: "agents-tab" });
  assert.deepEqual(readingFocusDescriptor({ id: "", dataset: { readingFocusKind: "cycle", readingFocusKey: "primary:snapshot" } }),
    { kind: "cycle", key: "primary:snapshot" });
  assert.equal(readingFocusDescriptor({ id: "", dataset: { agentId: "legacy-index-free" } }), null);

  assert.deepEqual(readingFocusCandidates({ kind: "cycle", key: "primary:snapshot" }, "agent-1"), [
    { kind: "cycle", key: "primary:snapshot" }, { id: "timeline" },
  ]);
  assert.deepEqual(readingFocusCandidates({ kind: "conversation-control", key: conversationKey }, "agent-1"), [
    { kind: "conversation-control", key: conversationKey },
    { kind: "conversation-entry", key: conversationKey },
    { kind: "agent", key: "agent-1" },
    { id: "agents-tab" },
  ]);
  assert.deepEqual(readingFocusCandidates({ kind: "conversation-entry", key: conversationKey }, "agent-1"), [
    { kind: "conversation-entry", key: conversationKey }, { kind: "agent", key: "agent-1" }, { id: "agents-tab" },
  ]);
  assert.deepEqual(readingFocusCandidates({ kind: "agent", key: "agent-1" }, "agent-1"), [
    { kind: "agent", key: "agent-1" }, { id: "agents-tab" },
  ]);
  assert.deepEqual(readingFocusCandidates({ kind: "signal", key: "signal-1" }, "agent-1"), [
    { kind: "signal", key: "signal-1" }, { id: "signals-tab" },
  ]);
  assert.deepEqual(readingFocusCandidates({ id: "signals-tab" }, "agent-1"), [{ id: "signals-tab" }]);
});

test("deferred reading focus restores scroll first and never steals newer focus", () => {
  const calls = [];
  const target = { focus(options) { calls.push(["focus", options]); } };
  const run = (overrides = {}) => restoreDeferredReadingFocus({
    activityId: "activity-1", currentActivityId: "activity-1", hasDetail: true,
    restoreScroll() { calls.push("scroll"); },
    focusDisplaced() { calls.push("displaced"); return true; },
    resolveTarget() { calls.push("resolve"); return target; },
    ...overrides,
  });
  assert.equal(run(), "restored");
  assert.deepEqual(calls, ["scroll", "displaced", "resolve", ["focus", { preventScroll: true }]]);

  calls.length = 0;
  assert.equal(run({ focusDisplaced() { calls.push("displaced"); return false; } }), "focus-preserved");
  assert.deepEqual(calls, ["scroll", "displaced"]);

  calls.length = 0;
  assert.equal(run({ currentActivityId: "activity-2" }), "stale");
  assert.deepEqual(calls, []);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function selectionHarness(loadDetail) {
  const view = { activityId: null, detail: null, error: null, transitions: [] };
  const selection = createActivitySelection({
    loadDetail,
    begin(activityId) {
      view.activityId = activityId;
      view.detail = null;
      view.error = null;
      view.transitions.push(["begin", activityId]);
    },
    commit(activityId, detail) {
      view.activityId = activityId;
      view.detail = detail;
      view.transitions.push(["commit", activityId]);
    },
    fail(activityId, error) {
      view.activityId = activityId;
      view.detail = null;
      view.error = error.message;
      view.transitions.push(["fail", activityId]);
    },
  });
  return { selection, view };
}

test("Activity selection ignores reverse-order stale completion", async () => {
  const requests = new Map([["A", deferred()], ["B", deferred()]]);
  const { selection, view } = selectionHarness((activityId) => requests.get(activityId).promise);

  const selectingA = selection.select("A");
  const selectingB = selection.select("B");
  requests.get("B").resolve({ activity: { id: "B" } });
  assert.equal((await selectingB).status, "committed");
  requests.get("A").resolve({ activity: { id: "A" } });
  assert.equal((await selectingA).status, "stale");

  assert.equal(view.activityId, "B");
  assert.equal(view.detail.activity.id, "B");
  assert.deepEqual(view.transitions, [["begin", "A"], ["begin", "B"], ["commit", "B"]]);
});

test("failed selection clears prior detail and a 429 retry cannot be clobbered", async () => {
  const firstA = deferred();
  const firstB = deferred();
  const retryB = deferred();
  let bAttempts = 0;
  const { selection, view } = selectionHarness((activityId) => {
    if (activityId === "A") return firstA.promise;
    bAttempts += 1;
    return bAttempts === 1 ? firstB.promise : retryB.promise;
  });

  const selectingA = selection.select("A");
  const selectingB = selection.select("B");
  const busy = new Error("Activity is busy. Retry with Refresh.");
  busy.status = 429;
  firstB.reject(busy);
  assert.equal((await selectingB).status, "failed");
  assert.equal(view.activityId, "B");
  assert.equal(view.detail, null);
  assert.equal(view.error, busy.message);

  const retryingB = selection.select("B");
  firstA.resolve({ activity: { id: "A" } });
  assert.equal((await selectingA).status, "stale");
  retryB.resolve({ activity: { id: "B", attempt: 2 } });
  assert.equal((await retryingB).status, "committed");
  assert.equal(view.activityId, "B");
  assert.deepEqual(view.detail, { activity: { id: "B", attempt: 2 } });
  assert.equal(view.error, null);
});

test("partial empty Activity state stays recoverable and Refresh commits later verified Activities", async () => {
  const responses = [
    { project: { activityName: "project" }, activities: [], partial: true },
    { project: { activityName: "project" }, activities: [{ id: "B", name: "Activity B" }], partial: false },
  ];
  const view = { activities: [], selected: null, empty: null, clears: 0 };
  const loadActivities = createActivityListLoader({
    loadActivities: async () => responses.shift(),
    begin() { view.clears += 1; view.selected = null; },
    commitActivities(data) { view.activities = data.activities; },
    async selectActivity(activityId) { view.selected = activityId; },
    showEmpty(data, message) { view.empty = { partial: data.partial, message }; },
    fail(error) { throw error; },
    preferredActivityId: () => view.selected,
  });
  assert.equal((await loadActivities()).status, "committed");
  assert.equal(view.selected, null);
  assert.equal(view.empty.partial, true);
  assert.equal(view.empty.message, emptyActivityMessage({ partial: true }));
  assert.match(view.empty.message, /Partial.*Refresh/);
  assert.equal((await loadActivities()).status, "committed");
  assert.equal(view.selected, "B");
  assert.deepEqual(view.activities, [{ id: "B", name: "Activity B" }]);
  assert.equal(view.clears, 2);
});
