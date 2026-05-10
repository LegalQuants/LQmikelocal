-- Email-based workflow sharing was removed when the app went fully offline.
-- Workflows are now transferred between machines as JSON files instead.
DROP INDEX IF EXISTS workflow_shares_email_idx;
DROP INDEX IF EXISTS workflow_shares_workflow_id_idx;
DROP TABLE IF EXISTS workflow_shares;
