-- Per-user saved layouts for the project graph view. One row per
-- (project, user); the `positions` JSON blob maps document_id → {x, y}.
-- Layouts are personal: User A saving doesn't affect User B's view of the
-- same shared project.

CREATE TABLE IF NOT EXISTS document_graph_layouts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  positions TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_doc_graph_layouts_project_user
  ON document_graph_layouts(project_id, user_id);
