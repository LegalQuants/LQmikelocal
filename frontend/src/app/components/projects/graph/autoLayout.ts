import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";

// Match GraphNode's rendered footprint. The layout engine needs concrete
// dimensions to space things; using the real node size keeps siblings from
// overlapping after the layout pass.
const NODE_W = 120;
const NODE_H = 120;

export type LayoutDirection = "LR" | "TB";

/**
 * Compute a connection-aware layout using dagre's directed acyclic graph
 * algorithm. Works fine on cyclic graphs too — dagre breaks cycles
 * internally — but is at its best when most edges share a direction.
 *
 * Returns NEW node objects with updated positions; callers should pass the
 * result through setNodes so React Flow sees the change.
 */
export function dagreLayout<N extends Node>(
    nodes: N[],
    edges: Edge[],
    direction: LayoutDirection = "LR",
): N[] {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({
        rankdir: direction,
        nodesep: 40,
        ranksep: 80,
        marginx: 20,
        marginy: 20,
    });

    for (const n of nodes) {
        g.setNode(n.id, { width: NODE_W, height: NODE_H });
    }
    for (const e of edges) {
        g.setEdge(e.source, e.target);
    }

    dagre.layout(g);

    return nodes.map((n) => {
        const pos = g.node(n.id);
        // dagre positions by node centre; React Flow positions by top-left.
        return {
            ...n,
            position: {
                x: pos.x - NODE_W / 2,
                y: pos.y - NODE_H / 2,
            },
        };
    });
}
