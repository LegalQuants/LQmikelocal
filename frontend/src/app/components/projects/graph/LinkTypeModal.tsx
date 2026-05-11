"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const PRESET_TYPES = [
    "references",
    "amends",
    "supersedes",
    "exhibit-of",
    "cited-by",
    "related",
];

interface Props {
    open: boolean;
    sourceLabel: string;
    targetLabel: string;
    onCancel: () => void;
    onConfirm: (linkType: string) => void;
}

export function LinkTypeModal({
    open,
    sourceLabel,
    targetLabel,
    onCancel,
    onConfirm,
}: Props) {
    const [mounted, setMounted] = useState(false);
    const [selected, setSelected] = useState("references");
    const [custom, setCustom] = useState("");

    useEffect(() => setMounted(true), []);
    // Reset when reopened so the next link doesn't inherit prior input.
    useEffect(() => {
        if (open) {
            setSelected("references");
            setCustom("");
        }
    }, [open]);

    if (!open || !mounted) return null;

    function handleConfirm() {
        const value =
            selected === "__custom"
                ? custom.trim() || "references"
                : selected;
        onConfirm(value);
    }

    return createPortal(
        <div
            className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40"
            onClick={onCancel}
        >
            <div
                className="bg-white rounded-xl shadow-2xl w-[420px] max-w-[90vw] p-5"
                onClick={(e) => e.stopPropagation()}
            >
                <h3 className="text-base font-medium font-serif text-gray-800 mb-1">
                    Link type
                </h3>
                <p className="text-xs text-gray-500 mb-4">
                    <span className="font-medium">{sourceLabel}</span> →{" "}
                    <span className="font-medium">{targetLabel}</span>
                </p>
                <div className="flex flex-wrap gap-1.5 mb-3">
                    {PRESET_TYPES.map((t) => (
                        <button
                            key={t}
                            onClick={() => setSelected(t)}
                            className={`px-2 py-1 rounded-full text-xs border transition-colors ${
                                selected === t
                                    ? "bg-gray-900 text-white border-gray-900"
                                    : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                            }`}
                        >
                            {t}
                        </button>
                    ))}
                    <button
                        onClick={() => setSelected("__custom")}
                        className={`px-2 py-1 rounded-full text-xs border transition-colors ${
                            selected === "__custom"
                                ? "bg-gray-900 text-white border-gray-900"
                                : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                        }`}
                    >
                        custom…
                    </button>
                </div>
                {selected === "__custom" && (
                    <input
                        autoFocus
                        value={custom}
                        maxLength={64}
                        placeholder="e.g. defined-in"
                        onChange={(e) => setCustom(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") handleConfirm();
                            if (e.key === "Escape") onCancel();
                        }}
                        className="w-full border border-gray-300 rounded-md px-2.5 py-1.5 text-sm mb-3 outline-none focus:border-gray-500"
                    />
                )}
                <div className="flex justify-end gap-2 mt-2">
                    <button
                        onClick={onCancel}
                        className="px-3 py-1.5 rounded-md text-xs text-gray-600 hover:bg-gray-100"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleConfirm}
                        className="px-3 py-1.5 rounded-md text-xs bg-gray-900 text-white hover:bg-gray-700"
                    >
                        Create link
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
