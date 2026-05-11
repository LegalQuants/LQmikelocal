"use client";

import {
    Background,
    Controls,
    MiniMap,
    ReactFlow,
    ReactFlowProvider,
    addEdge,
    useEdgesState,
    useNodesState,
    useReactFlow,
    type Connection,
    type Edge,
    type Node,
    type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutGrid, Save, Sparkles } from "lucide-react";
import { dagreLayout } from "./autoLayout";
import type { MikeDocument } from "@/app/components/shared/types";
import {
    bulkCreateDocumentLinks,
    createDocumentLink,
    deleteDocumentLink,
    extractDocumentLinks,
    getGraphLayout,
    listDocumentLinks,
    saveGraphLayout,
    type DocumentLink,
    type GraphPositions,
    type LinkProposal,
} from "@/app/lib/mikeApi";
import { GraphNode, type GraphNodeData } from "./GraphNode";
import { GraphSidePanel } from "./GraphSidePanel";
import { LinkTypeModal } from "./LinkTypeModal";
import { ExtractProposalsModal } from "./ExtractProposalsModal";

interface Props {
    projectId: string;
    documents: MikeDocument[];
    onOpenDoc: (doc: MikeDocument) => void;
    onOpenInChat: (doc: MikeDocument) => void;
}

const nodeTypes = { doc: GraphNode };

// Lay nodes out in a simple grid on mount. Good enough for typical project
// sizes (≤ ~30 docs); a real force-directed layout can come later if the
// graph starts to get crowded.
function gridLayout(docs: MikeDocument[]): Node<GraphNodeData>[] {
    const COLS = Math.max(1, Math.ceil(Math.sqrt(docs.length)));
    const CELL_W = 160;
    const CELL_H = 160;
    return docs.map((d, i) => ({
        id: d.id,
        type: "doc",
        position: {
            x: (i % COLS) * CELL_W,
            y: Math.floor(i / COLS) * CELL_H,
        },
        data: {
            label: d.filename,
            fileType: d.file_type,
            // latest_version_number is attached by the backend; fall back
            // to 1 (the initial upload always counts).
            versionCount:
                (d as { latest_version_number?: number | null })
                    .latest_version_number ?? 1,
        },
    }));
}

function linkToEdge(link: DocumentLink): Edge {
    return {
        id: link.id,
        source: link.source_doc_id,
        target: link.target_doc_id,
        label: link.link_type,
        animated: link.created_by === "llm",
        style:
            link.created_by === "llm"
                ? { stroke: "#d97706" }
                : { stroke: "#6b7280" },
        labelStyle: { fontSize: 10, fill: "#6b7280" },
        labelBgStyle: { fill: "#fff" },
        data: { linkType: link.link_type, createdBy: link.created_by },
    };
}

function ProjectGraphInner({
    projectId,
    documents,
    onOpenDoc,
    onOpenInChat,
}: Props) {
    const [nodes, setNodes, onNodesChange] = useNodesState<Node<GraphNodeData>>(
        [],
    );
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const [rawLinks, setRawLinks] = useState<DocumentLink[]>([]);
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
    const [pending, setPending] = useState<Connection | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [extracting, setExtracting] = useState(false);
    const [extractError, setExtractError] = useState<string | null>(null);
    const [proposals, setProposals] = useState<LinkProposal[] | null>(null);
    const [savingProposals, setSavingProposals] = useState(false);
    const [savingLayout, setSavingLayout] = useState(false);
    const [layoutSavedFlash, setLayoutSavedFlash] = useState(false);
    // savedPositions starts as undefined while we fetch; null means "no
    // saved layout, use default grid"; an object means "apply these".
    const [savedPositions, setSavedPositions] = useState<
        GraphPositions | null | undefined
    >(undefined);
    const reactFlow = useReactFlow();

    const applyAutoLayout = useCallback(() => {
        // Use the current edge state so the layout reflects whatever links
        // exist right now (including ones the user just created or just
        // accepted from the AI extraction modal).
        setNodes((curNodes) => dagreLayout(curNodes, edges, "LR"));
        // Defer fitView until after React Flow has re-measured the new
        // positions; otherwise it fits the pre-layout viewport.
        setTimeout(() => reactFlow.fitView({ padding: 0.2, duration: 400 }), 50);
    }, [edges, reactFlow, setNodes]);

    const docsById = useMemo(() => {
        const m = new Map<string, MikeDocument>();
        for (const d of documents) m.set(d.id, d);
        return m;
    }, [documents]);

    // Fetch the saved layout on mount. Result is consumed by the node-build
    // effect below; we DON'T set nodes here directly so the build path stays
    // single-sourced.
    useEffect(() => {
        let cancelled = false;
        getGraphLayout(projectId)
            .then((res) => {
                if (cancelled) return;
                setSavedPositions(
                    res.positions && Object.keys(res.positions).length > 0
                        ? res.positions
                        : null,
                );
            })
            .catch(() => {
                if (!cancelled) setSavedPositions(null);
            });
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    // Rebuild nodes when the document set changes OR when the saved-layout
    // fetch resolves. While `savedPositions === undefined` we wait so the
    // user doesn't see a grid flash before the saved layout snaps in.
    useEffect(() => {
        if (savedPositions === undefined) return;
        const fresh = gridLayout(documents);
        if (savedPositions) {
            for (const n of fresh) {
                const saved = savedPositions[n.id];
                if (saved) n.position = { x: saved.x, y: saved.y };
            }
        }
        setNodes(fresh);
    }, [documents, savedPositions, setNodes]);

    // Load links on mount + whenever the project changes.
    useEffect(() => {
        let cancelled = false;
        listDocumentLinks(projectId)
            .then((links) => {
                if (cancelled) return;
                setRawLinks(links);
                setEdges(links.map(linkToEdge));
            })
            .catch((e: Error) => {
                if (!cancelled) setLoadError(e.message);
            });
        return () => {
            cancelled = true;
        };
    }, [projectId, setEdges]);

    const saveCurrentLayout = useCallback(async () => {
        const positions: GraphPositions = {};
        for (const n of nodes) {
            positions[n.id] = { x: n.position.x, y: n.position.y };
        }
        setSavingLayout(true);
        try {
            await saveGraphLayout(projectId, positions);
            setSavedPositions(positions);
            setLayoutSavedFlash(true);
            setTimeout(() => setLayoutSavedFlash(false), 1800);
        } catch (e) {
            console.warn("saveGraphLayout failed", e);
        } finally {
            setSavingLayout(false);
        }
    }, [nodes, projectId]);

    const onConnect: OnConnect = useCallback((conn) => {
        // Defer the actual create until the user picks a link_type. We
        // optimistically draw nothing until the modal confirms.
        if (!conn.source || !conn.target || conn.source === conn.target) return;
        setPending(conn);
    }, []);

    const confirmLink = useCallback(
        async (linkType: string) => {
            if (!pending?.source || !pending?.target) {
                setPending(null);
                return;
            }
            try {
                const link = await createDocumentLink(projectId, {
                    source_doc_id: pending.source,
                    target_doc_id: pending.target,
                    link_type: linkType,
                });
                setRawLinks((prev) => [...prev, link]);
                setEdges((eds) => addEdge(linkToEdge(link), eds));
            } catch (e) {
                // 409 = duplicate; surface as a console warn rather than a
                // toast since we don't have a toast system here yet.
                console.warn("createDocumentLink failed", e);
            } finally {
                setPending(null);
            }
        },
        [pending, projectId, setEdges],
    );

    const handleNodeClick = useCallback((_: unknown, node: Node) => {
        setSelectedDocId(node.id);
    }, []);

    const handleNodeDoubleClick = useCallback(
        (_: unknown, node: Node) => {
            const doc = docsById.get(node.id);
            if (doc) onOpenDoc(doc);
        },
        [docsById, onOpenDoc],
    );

    // Delete selected edges with Delete/Backspace. Wire to the React Flow
    // `onEdgesDelete` callback rather than handling key events ourselves —
    // RF surfaces the user-driven delete and we then call the backend.
    const handleEdgesDelete = useCallback(
        async (deleted: Edge[]) => {
            for (const e of deleted) {
                try {
                    await deleteDocumentLink(projectId, e.id);
                    setRawLinks((prev) => prev.filter((l) => l.id !== e.id));
                } catch (err) {
                    console.warn("deleteDocumentLink failed", err);
                }
            }
        },
        [projectId],
    );

    const deleteLinkById = useCallback(
        async (linkId: string) => {
            try {
                await deleteDocumentLink(projectId, linkId);
                setRawLinks((prev) => prev.filter((l) => l.id !== linkId));
                setEdges((eds) => eds.filter((e) => e.id !== linkId));
            } catch (err) {
                console.warn("deleteDocumentLink failed", err);
            }
        },
        [projectId, setEdges],
    );

    const runExtract = useCallback(async () => {
        setExtractError(null);
        setExtracting(true);
        try {
            const result = await extractDocumentLinks(projectId);
            setProposals(result.proposals);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setExtractError(msg);
        } finally {
            setExtracting(false);
        }
    }, [projectId]);

    const persistProposals = useCallback(
        async (accepted: LinkProposal[]) => {
            if (accepted.length === 0) {
                setProposals(null);
                return;
            }
            setSavingProposals(true);
            try {
                const { inserted } = await bulkCreateDocumentLinks(
                    projectId,
                    accepted,
                );
                setRawLinks((prev) => [...prev, ...inserted]);
                setEdges((eds) => [...eds, ...inserted.map(linkToEdge)]);
                setProposals(null);
            } catch (e) {
                console.warn("bulkCreateDocumentLinks failed", e);
                setExtractError(e instanceof Error ? e.message : String(e));
            } finally {
                setSavingProposals(false);
            }
        },
        [projectId, setEdges],
    );

    const selectedDoc = selectedDocId ? docsById.get(selectedDocId) : null;
    const sourceLabel = pending?.source
        ? docsById.get(pending.source)?.filename ?? pending.source
        : "";
    const targetLabel = pending?.target
        ? docsById.get(pending.target)?.filename ?? pending.target
        : "";

    if (documents.length === 0) {
        return (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
                Add documents to this project to start building the graph.
            </div>
        );
    }

    return (
        <div className="relative flex-1 min-h-0 w-full bg-white">
            <div className="absolute top-2 right-2 z-20 flex items-center gap-2">
                {extractError && (
                    <span className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded px-2 py-1 max-w-xs truncate">
                        {extractError}
                    </span>
                )}
                <button
                    onClick={applyAutoLayout}
                    disabled={documents.length === 0}
                    className="inline-flex items-center gap-1.5 rounded-full bg-white border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 shadow-sm"
                    title="Re-arrange nodes based on their connections"
                >
                    <LayoutGrid className="h-3 w-3" />
                    Auto-layout
                </button>
                <button
                    onClick={saveCurrentLayout}
                    disabled={savingLayout || documents.length === 0}
                    className="inline-flex items-center gap-1.5 rounded-full bg-white border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 shadow-sm"
                    title="Save the current node positions so this view reopens the same way"
                >
                    <Save className="h-3 w-3" />
                    {savingLayout
                        ? "Saving…"
                        : layoutSavedFlash
                          ? "Saved"
                          : "Save layout"}
                </button>
                <button
                    onClick={runExtract}
                    disabled={extracting || documents.length < 2}
                    className="inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50 shadow-md"
                >
                    <Sparkles className="h-3 w-3" />
                    {extracting ? "Detecting…" : "Detect citations with AI"}
                </button>
            </div>
            {loadError && (
                <div className="absolute top-2 left-2 z-20 text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded px-2 py-1">
                    Failed to load links: {loadError}
                </div>
            )}
            <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={handleNodeClick}
                onNodeDoubleClick={handleNodeDoubleClick}
                onEdgesDelete={handleEdgesDelete}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                proOptions={{ hideAttribution: true }}
            >
                <Background gap={20} size={1} color="#e5e7eb" />
                <Controls position="bottom-left" showInteractive={false} />
                <MiniMap
                    pannable
                    zoomable
                    style={{ width: 120, height: 80 }}
                    nodeStrokeWidth={2}
                />
            </ReactFlow>

            {selectedDoc && (
                <GraphSidePanel
                    doc={selectedDoc}
                    links={rawLinks}
                    docsById={docsById}
                    onClose={() => setSelectedDocId(null)}
                    onOpenDoc={onOpenDoc}
                    onOpenInChat={onOpenInChat}
                    onDeleteLink={deleteLinkById}
                />
            )}

            <LinkTypeModal
                open={!!pending}
                sourceLabel={sourceLabel}
                targetLabel={targetLabel}
                onCancel={() => setPending(null)}
                onConfirm={confirmLink}
            />

            <ExtractProposalsModal
                open={proposals !== null}
                proposals={proposals ?? []}
                docsById={docsById}
                onClose={() => setProposals(null)}
                onConfirm={persistProposals}
                busy={savingProposals}
            />
        </div>
    );
}

export function ProjectGraph(props: Props) {
    // ReactFlowProvider keeps internal state scoped to this tab so
    // remounting (e.g. on tab switch) doesn't leak between projects.
    const keyRef = useRef(props.projectId);
    if (keyRef.current !== props.projectId) keyRef.current = props.projectId;
    return (
        <ReactFlowProvider>
            <ProjectGraphInner {...props} />
        </ReactFlowProvider>
    );
}
