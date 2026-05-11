"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { FileText, FileType2 } from "lucide-react";

export interface GraphNodeData {
    label: string;
    fileType: string | null;
    versionCount: number;
    selected?: boolean;
    [key: string]: unknown;
}

// Tailwind colour swatches by file type. Anything else (incl. null) falls
// through to slate so an unknown type still renders cleanly.
function colourFor(ft: string | null): string {
    switch ((ft ?? "").toLowerCase()) {
        case "pdf":
            return "border-rose-300 bg-rose-50";
        case "docx":
        case "doc":
            return "border-sky-300 bg-sky-50";
        case "txt":
            return "border-emerald-300 bg-emerald-50";
        default:
            return "border-slate-300 bg-slate-50";
    }
}

export function GraphNode({ data, selected }: NodeProps) {
    const d = data as GraphNodeData;
    const colour = colourFor(d.fileType);
    return (
        <div
            className={`rounded-xl border shadow-sm h-[120px] w-[120px] flex flex-col items-center justify-center px-3 py-2 text-center ${colour} ${
                selected ? "ring-2 ring-gray-900" : ""
            }`}
        >
            <Handle
                type="target"
                position={Position.Left}
                className="!w-2 !h-2 !bg-gray-400"
            />
            {d.fileType === "pdf" ? (
                <FileText className="h-6 w-6 text-rose-500 mb-1.5" />
            ) : (
                <FileType2 className="h-6 w-6 text-sky-500 mb-1.5" />
            )}
            <div className="text-[11px] font-medium text-gray-800 leading-tight line-clamp-3 break-all">
                {d.label}
            </div>
            {d.versionCount > 1 && (
                <div className="text-[9px] text-gray-500 mt-1">
                    v{d.versionCount}
                </div>
            )}
            <Handle
                type="source"
                position={Position.Right}
                className="!w-2 !h-2 !bg-gray-400"
            />
        </div>
    );
}
