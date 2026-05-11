"use client";

import { ExternalLink, MessageSquare, X } from "lucide-react";
import type { DocumentLink } from "@/app/lib/mikeApi";
import type { MikeDocument } from "@/app/components/shared/types";

interface Props {
    doc: MikeDocument;
    links: DocumentLink[];
    docsById: Map<string, MikeDocument>;
    onClose: () => void;
    onOpenDoc: (doc: MikeDocument) => void;
    onOpenInChat: (doc: MikeDocument) => void;
    onDeleteLink: (linkId: string) => void;
}

export function GraphSidePanel({
    doc,
    links,
    docsById,
    onClose,
    onOpenDoc,
    onOpenInChat,
    onDeleteLink,
}: Props) {
    const outgoing = links.filter((l) => l.source_doc_id === doc.id);
    const incoming = links.filter((l) => l.target_doc_id === doc.id);

    return (
        <div className="absolute top-0 right-0 h-full w-72 bg-white border-l border-gray-200 shadow-lg z-10 flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                <span className="text-sm font-medium font-serif text-gray-800 truncate pr-2">
                    {doc.filename}
                </span>
                <button
                    onClick={onClose}
                    className="text-gray-400 hover:text-gray-700"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
            <div className="px-4 py-3 border-b border-gray-100 text-xs text-gray-500 space-y-1">
                <div>
                    Type:{" "}
                    <span className="text-gray-700">
                        {doc.file_type ?? "—"}
                    </span>
                </div>
                {doc.size_bytes != null && (
                    <div>
                        Size:{" "}
                        <span className="text-gray-700">
                            {(doc.size_bytes / 1024).toFixed(1)} KB
                        </span>
                    </div>
                )}
                {doc.page_count != null && (
                    <div>
                        Pages:{" "}
                        <span className="text-gray-700">{doc.page_count}</span>
                    </div>
                )}
            </div>
            <div className="px-4 mt-3 mb-1 flex flex-col gap-1.5">
                <button
                    onClick={() => onOpenDoc(doc)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-full bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
                >
                    <ExternalLink className="h-3 w-3" /> Open document
                </button>
                <button
                    onClick={() => onOpenInChat(doc)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-full bg-white border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                    <MessageSquare className="h-3 w-3" /> Open in Assistant
                </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 pb-4">
                <Section title={`Outgoing (${outgoing.length})`}>
                    {outgoing.length === 0 && <EmptyHint />}
                    {outgoing.map((l) => (
                        <LinkRow
                            key={l.id}
                            link={l}
                            otherDoc={docsById.get(l.target_doc_id)}
                            arrow="→"
                            onDelete={() => onDeleteLink(l.id)}
                        />
                    ))}
                </Section>
                <Section title={`Incoming (${incoming.length})`}>
                    {incoming.length === 0 && <EmptyHint />}
                    {incoming.map((l) => (
                        <LinkRow
                            key={l.id}
                            link={l}
                            otherDoc={docsById.get(l.source_doc_id)}
                            arrow="←"
                            onDelete={() => onDeleteLink(l.id)}
                        />
                    ))}
                </Section>
            </div>
        </div>
    );
}

function Section({
    title,
    children,
}: {
    title: string;
    children: React.ReactNode;
}) {
    return (
        <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1.5">
                {title}
            </div>
            {children}
        </div>
    );
}

function EmptyHint() {
    return <div className="text-xs text-gray-400">No links.</div>;
}

function LinkRow({
    link,
    otherDoc,
    arrow,
    onDelete,
}: {
    link: DocumentLink;
    otherDoc: MikeDocument | undefined;
    arrow: string;
    onDelete: () => void;
}) {
    return (
        <div className="group flex items-center gap-2 py-1 text-xs">
            <span className="text-gray-400 w-3 shrink-0">{arrow}</span>
            <span className="text-gray-700 truncate flex-1">
                {otherDoc?.filename ?? "(missing)"}
            </span>
            <span className="text-[10px] text-gray-400 shrink-0">
                {link.link_type}
            </span>
            {link.created_by === "llm" && (
                <span className="text-[9px] uppercase tracking-wide bg-amber-100 text-amber-700 px-1 rounded shrink-0">
                    AI
                </span>
            )}
            <button
                onClick={onDelete}
                className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-rose-600 shrink-0 text-xs"
                title="Delete link"
            >
                ×
            </button>
        </div>
    );
}
