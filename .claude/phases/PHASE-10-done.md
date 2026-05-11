# Phase 10 — Document Graph: Frontend
Status: DONE

## Goal
Add a "Graph" tab to `ProjectPage` that renders documents as nodes and `document_links` as edges, with manual link create/delete, a selection side panel, and double-click-to-open via the existing `DocViewModal`.

## Tasks
- [x] Install `@xyflow/react` (v12, the rebrand of reactflow v12) in `frontend/`.
- [x] Add API client helpers in `mikeApi.ts` (list / create / delete links).
- [x] Build `ProjectGraph.tsx` with React Flow (custom nodes, edges, controls, minimap).
- [x] Build `GraphNode.tsx` (title, file-type colour, version badge).
- [x] Build `GraphSidePanel.tsx` (selected node metadata, incoming/outgoing links, "Open" button).
- [x] Build `LinkTypeModal.tsx` (asks for link_type on edge create).
- [x] Hook into `ProjectPage.tsx`: add tab, parse `?tab=graph`, render conditional, wire `onOpenDoc` to existing `setViewingDoc`.
- [x] Bump `package.json` to 0.3.3.

## Acceptance Criteria
- [x] Graph tab appears as a fourth toolbar entry.
- [x] All project documents render as nodes on mount (grid layout, fitView centres them).
- [x] Drag handle → drop on another node opens `LinkTypeModal` → confirms → edge persists (POST + state update).
- [x] Selecting a node opens side panel listing incoming + outgoing links with delete buttons.
- [x] React Flow's built-in edge delete (`onEdgesDelete`) calls the backend.
- [x] Double-click on a node calls `onOpenDoc(doc)` which routes to `DocViewModal`.
- [x] `npx tsc --noEmit` in `frontend/` is clean.

## Decisions Made This Phase
- **Package choice:** `@xyflow/react@^12` instead of the older `reactflow@^11`. v12 was renamed to the `@xyflow` namespace and is the maintained line; it explicitly supports React 19 (the frontend is on React 19.2.0).
- **Layout:** simple grid (sqrt-of-N columns, 220×110 cells) on mount, with `fitView` to centre. Force-directed/dagre layouts deferred until graphs in the wild start feeling cramped — not worth the dep weight for typical project sizes.
- **Edge ID = link ID:** keeps `onEdgesDelete` trivial (the deleted edge's `id` is the link to remove) without maintaining a parallel id map.
- **LLM edge styling:** orange stroke + `animated: true` so AI-proposed links are visually distinct from manual ones. Will get its real workout in Phase 11.
- **Empty state:** "Add documents to this project to start building the graph." rendered before mounting the canvas so users with empty projects don't see a blank `<ReactFlow />`.
