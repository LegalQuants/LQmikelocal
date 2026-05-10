import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";

export const workflowsRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;

type WorkflowRecord = {
  id: string;
  user_id: string | null;
  is_system: boolean;
  [key: string]: unknown;
};

function withWorkflowAccess<T extends Record<string, unknown>>(workflow: T) {
  // Sharing was removed when the app went fully offline. Every accessible
  // workflow is either owned by the current user (full edit) or a built-in
  // system workflow (read-only). The fields below are kept on the response
  // so existing client code that reads them continues to work.
  const isSystem = (workflow as { is_system?: boolean }).is_system === true;
  return {
    ...workflow,
    allow_edit: !isSystem,
    is_owner: !isSystem,
    shared_by_name: null,
  };
}

async function findOwnedWorkflow(
  workflowId: string,
  userId: string,
  db: Db,
): Promise<WorkflowRecord | null> {
  const { data: workflow } = await db
    .from("workflows")
    .select("*")
    .eq("id", workflowId)
    .single();
  if (!workflow) return null;
  const record = workflow as WorkflowRecord;
  if (record.user_id !== userId) return null;
  return record;
}

type WorkflowInsertPayload = {
  title: string;
  type: string;
  prompt_md?: string | null;
  columns_config?: unknown;
  practice?: string | null;
  source_label?: string | null;
};

function normalizeSourceLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function validateWorkflowPayload(
  body: Partial<WorkflowInsertPayload>,
): { ok: true; payload: WorkflowInsertPayload } | { ok: false; detail: string } {
  const title = body.title?.trim();
  if (!title) return { ok: false, detail: "title is required" };
  const type = body.type;
  if (type !== "assistant" && type !== "tabular") {
    return { ok: false, detail: "type must be 'assistant' or 'tabular'" };
  }
  return {
    ok: true,
    payload: {
      title,
      type,
      prompt_md: body.prompt_md ?? null,
      columns_config: body.columns_config ?? null,
      practice: body.practice ?? null,
      source_label: normalizeSourceLabel(body.source_label),
    },
  };
}

async function insertWorkflow(
  db: Db,
  userId: string,
  payload: WorkflowInsertPayload,
) {
  return db
    .from("workflows")
    .insert({
      user_id: userId,
      title: payload.title,
      type: payload.type,
      prompt_md: payload.prompt_md ?? null,
      columns_config: payload.columns_config ?? null,
      practice: payload.practice ?? null,
      source_label: payload.source_label ?? null,
      is_system: false,
    })
    .select("*")
    .single();
}

// GET /workflows
workflowsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { type } = req.query as { type?: string };
  const db = createServerSupabase();

  let ownQuery = db
    .from("workflows")
    .select("*")
    .eq("user_id", userId)
    .eq("is_system", false)
    .order("created_at", { ascending: false });
  if (type) ownQuery = ownQuery.eq("type", type);
  const { data: own, error: ownErr } = await ownQuery;
  if (ownErr) return void res.status(500).json({ detail: ownErr.message });

  res.json((own ?? []).map((wf) => withWorkflowAccess(wf)));
});

// POST /workflows
workflowsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const validation = validateWorkflowPayload(req.body ?? {});
  if (!validation.ok) return void res.status(400).json({ detail: validation.detail });

  const db = createServerSupabase();
  const { data, error } = await insertWorkflow(db, userId, validation.payload);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json(data);
});

// POST /workflows/import — create workflow from a .mikeworkflow.json envelope
workflowsRouter.post("/import", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (body.format !== "mikelocal.workflow") {
    return void res
      .status(400)
      .json({ detail: "Invalid file: expected format 'mikelocal.workflow'" });
  }
  if (body.version !== 1) {
    return void res
      .status(400)
      .json({ detail: `Unsupported workflow file version: ${String(body.version)}` });
  }
  if (
    body.columns_config != null &&
    !Array.isArray(body.columns_config)
  ) {
    return void res
      .status(400)
      .json({ detail: "columns_config must be an array" });
  }

  const validation = validateWorkflowPayload({
    title: body.title as string | undefined,
    type: body.type as string | undefined,
    prompt_md: (body.prompt_md as string | null | undefined) ?? null,
    columns_config: body.columns_config,
    practice: (body.practice as string | null | undefined) ?? null,
    source_label: body.source_label as string | null | undefined,
  });
  if (!validation.ok) return void res.status(400).json({ detail: validation.detail });

  const db = createServerSupabase();
  const { data, error } = await insertWorkflow(db, userId, validation.payload);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json(data);
});

async function handleWorkflowUpdate(
  req: import("express").Request,
  res: import("express").Response,
) {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const updates: Record<string, unknown> = {};
  if (req.body.title != null) updates.title = req.body.title;
  if (req.body.prompt_md != null) updates.prompt_md = req.body.prompt_md;
  if (req.body.columns_config != null)
    updates.columns_config = req.body.columns_config;
  if ("practice" in req.body) updates.practice = req.body.practice ?? null;
  if ("source_label" in req.body)
    updates.source_label = normalizeSourceLabel(req.body.source_label);

  const db = createServerSupabase();
  const owned = await findOwnedWorkflow(workflowId, userId, db);
  if (!owned || owned.is_system) {
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  }
  const { data, error } = await db
    .from("workflows")
    .update(updates)
    .eq("id", workflowId)
    .eq("is_system", false)
    .select("*")
    .single();
  if (error || !data)
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  res.json(withWorkflowAccess(data));
}

// PUT /workflows/:workflowId
workflowsRouter.put("/:workflowId", requireAuth, handleWorkflowUpdate);

// PATCH /workflows/:workflowId
workflowsRouter.patch("/:workflowId", requireAuth, handleWorkflowUpdate);

// DELETE /workflows/:workflowId
workflowsRouter.delete("/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerSupabase();
  const { error } = await db
    .from("workflows")
    .delete()
    .eq("id", workflowId)
    .eq("user_id", userId)
    .eq("is_system", false);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// GET /workflows/hidden
workflowsRouter.get("/hidden", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("hidden_workflows")
    .select("workflow_id")
    .eq("user_id", userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json((data ?? []).map((r) => r.workflow_id));
});

// POST /workflows/hidden
workflowsRouter.post("/hidden", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflow_id } = req.body as { workflow_id: string };
  if (!workflow_id?.trim())
    return void res.status(400).json({ detail: "workflow_id is required" });
  const db = createServerSupabase();
  const { error } = await db
    .from("hidden_workflows")
    .upsert({ user_id: userId, workflow_id }, { onConflict: "user_id,workflow_id" });
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// DELETE /workflows/hidden/:workflowId
workflowsRouter.delete("/hidden/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerSupabase();
  const { error } = await db
    .from("hidden_workflows")
    .delete()
    .eq("user_id", userId)
    .eq("workflow_id", workflowId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// GET /workflows/:workflowId
workflowsRouter.get("/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerSupabase();

  const { data: workflow } = await db
    .from("workflows")
    .select("*")
    .eq("id", workflowId)
    .single();
  if (!workflow)
    return void res.status(404).json({ detail: "Workflow not found" });
  const record = workflow as WorkflowRecord;
  if (record.user_id !== userId && !record.is_system) {
    return void res.status(404).json({ detail: "Workflow not found" });
  }
  res.json(withWorkflowAccess(record));
});
