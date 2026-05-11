-- Phase 09: graph view link table.
-- Stores typed edges between documents in the same project. Created either
-- manually by the user (created_by='user') or proposed by the LLM citation
-- extraction tool and accepted by the user (created_by='llm').
--
-- ON DELETE CASCADE on every FK so deleting a project or a document
-- transparently removes its links — the graph view never has to deal with
-- dangling edges.

CREATE TABLE IF NOT EXISTS document_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT 'references',
  citation_text TEXT,
  created_by TEXT NOT NULL DEFAULT 'user'
    CHECK (created_by IN ('user','llm')),
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_doc_id, target_doc_id, link_type)
);

CREATE INDEX IF NOT EXISTS idx_document_links_project ON document_links(project_id);
CREATE INDEX IF NOT EXISTS idx_document_links_source ON document_links(source_doc_id);
CREATE INDEX IF NOT EXISTS idx_document_links_target ON document_links(target_doc_id);
CREATE INDEX IF NOT EXISTS idx_document_links_user ON document_links(user_id);
