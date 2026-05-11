"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";
import type { LinkProposal } from "@/app/lib/mikeApi";
import type { MikeDocument } from "@/app/components/shared/types";

interface Props {
    open: boolean;
    proposals: LinkProposal[];
    docsById: Map<string, MikeDocument>;
    onClose: () => void;
    onConfirm: (accepted: LinkProposal[]) => void;
    busy?: boolean;
}

export function ExtractProposalsModal({
    open,
    proposals,
    docsById,
    onClose,
    onConfirm,
    busy,
}: Props) {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    // Per-proposal selection. Keyed by index — proposals are immutable for
    // the modal's lifetime, so index is stable. Defaults to all-on so the
    // user can hit "Accept" without ticking 30 boxes for a small project.
    const [accepted, setAccepted] = useState<boolean[]>([]);
    useEffect(() => {
        if (open) setAccepted(proposals.map(() => true));
    }, [open, proposals]);

    const acceptedCount = useMemo(
        () => accepted.filter(Boolean).length,
        [accepted],
    );

    if (!open || !mounted) return null;

    function toggle(i: number) {
        setAccepted((prev) => prev.map((v, idx) => (idx === i ? !v : v)));
    }
    function setAll(value: boolean) {
        setAccepted(proposals.map(() => value));
    }

    return createPortal(
        <div
            className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40"
            onClick={busy ? undefined : onClose}
        >
            <div
                className="bg-white rounded-xl shadow-2xl w-[640px] max-w-[92vw] max-h-[80vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
                    <div className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-amber-500" />
                        <span className="text-base font-medium font-serif text-gray-800">
                            AI-detected citations
                        </span>
                        <span className="text-xs text-gray-400 ml-1">
                            ({proposals.length} found)
                        </span>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={busy}
                        className="text-gray-400 hover:text-gray-700 disabled:opacity-50"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {proposals.length === 0 ? (
                    <div className="flex-1 px-5 py-12 text-center text-sm text-gray-500">
                        No new citation links found across this project's
                        documents.
                    </div>
                ) : (
                    <>
                        <div className="flex items-center justify-between px-5 py-2 border-b border-gray-100 text-xs text-gray-500">
                            <span>
                                {acceptedCount} of {proposals.length} selected
                            </span>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setAll(true)}
                                    className="hover:text-gray-800"
                                >
                                    Select all
                                </button>
                                <span className="text-gray-300">·</span>
                                <button
                                    onClick={() => setAll(false)}
                                    className="hover:text-gray-800"
                                >
                                    Clear
                                </button>
                            </div>
                        </div>
                        <div className="flex-1 overflow-y-auto px-5 py-2">
                            {proposals.map((p, i) => {
                                const src = docsById.get(p.source_doc_id);
                                const tgt = docsById.get(p.target_doc_id);
                                return (
                                    <label
                                        key={i}
                                        className="flex items-start gap-2 py-2 border-b border-gray-50 last:border-0 cursor-pointer"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={accepted[i] ?? false}
                                            onChange={() => toggle(i)}
                                            className="mt-1 h-3 w-3 accent-black"
                                        />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs text-gray-800">
                                                <span className="font-medium">
                                                    {src?.filename ??
                                                        p.source_doc_id}
                                                </span>{" "}
                                                <span className="text-gray-400">
                                                    →
                                                </span>{" "}
                                                <span className="font-medium">
                                                    {tgt?.filename ??
                                                        p.target_doc_id}
                                                </span>
                                                <span className="ml-2 text-[10px] uppercase tracking-wide text-amber-700 bg-amber-100 px-1 rounded">
                                                    {p.link_type}
                                                </span>
                                            </div>
                                            {p.citation_text && (
                                                <div className="mt-1 text-[11px] text-gray-500 italic line-clamp-2">
                                                    “{p.citation_text}”
                                                </div>
                                            )}
                                        </div>
                                    </label>
                                );
                            })}
                        </div>
                    </>
                )}

                <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-100">
                    <button
                        onClick={onClose}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-md text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() =>
                            onConfirm(proposals.filter((_, i) => accepted[i]))
                        }
                        disabled={busy || acceptedCount === 0}
                        className="px-3 py-1.5 rounded-md text-xs bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
                    >
                        {busy
                            ? "Saving…"
                            : `Add ${acceptedCount} link${acceptedCount === 1 ? "" : "s"}`}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
