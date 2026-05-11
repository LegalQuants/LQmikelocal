import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
} from "../lib/documentVersions";
import { downloadFile, uploadFile, storageKey } from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import { checkProjectAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";
import { completeText } from "../lib/llm";
import { extractPdfText, loadCurrentVersionBytes } from "../lib/chatTools";
import { extractDocxBodyText } from "../lib/docxTrackedChanges";
import { getUserModelSettings } from "../lib/userSettings";

export const projectsRouter = Router();
const ALLOWED_TYPES = new Set(["pdf", "docx", "doc"]);

// GET /projects
projectsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const db = createServerSupabase();

  const { data: ownProjects, error: ownError } = await db
    .from("projects")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (ownError) return void res.status(500).json({ detail: ownError.message });

  const { data: sharedProjects, error: sharedError } = userEmail
    ? await db
        .from("projects")
        .select("*")
        .contains("shared_with", [userEmail])
        .neq("user_id", userId)
        .order("created_at", { ascending: false })
    : { data: [], error: null };
  if (sharedError)
    return void res.status(500).json({ detail: sharedError.message });

  const projects = [...(ownProjects ?? []), ...(sharedProjects ?? [])].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const result = await Promise.all(
    projects.map(async (p) => {
      const [docs, chats, reviews] = await Promise.all([
        db
          .from("documents")
          .select("id", { count: "exact", head: true })
          .eq("project_id", p.id),
        db
          .from("chats")
          .select("id", { count: "exact", head: true })
          .eq("project_id", p.id),
        db
          .from("tabular_reviews")
          .select("id", { count: "exact", head: true })
          .eq("project_id", p.id),
      ]);
      return {
        ...p,
        is_owner: p.user_id === userId,
        document_count: docs.count ?? 0,
        chat_count: chats.count ?? 0,
        review_count: reviews.count ?? 0,
      };
    }),
  );
  res.json(result);
});

// POST /projects
projectsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { name, cm_number, shared_with } = req.body as {
    name: string;
    cm_number?: string;
    shared_with?: string[];
  };
  if (!name?.trim())
    return void res.status(400).json({ detail: "name is required" });

  const db = createServerSupabase();
  const { data, error } = await db
    .from("projects")
    .insert({
      user_id: userId,
      name: name.trim(),
      cm_number: cm_number ?? null,
      shared_with: shared_with ?? [],
    })
    .select("*")
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json({ ...data, documents: [] });
});

// GET /projects/:projectId
projectsRouter.get("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const { data: project, error } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error || !project)
    return void res.status(404).json({ detail: "Project not found" });

  const canAccess =
    project.user_id === userId ||
    (userEmail &&
      Array.isArray(project.shared_with) &&
      project.shared_with.includes(userEmail));
  if (!canAccess)
    return void res.status(404).json({ detail: "Project not found" });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
    db.from("project_subfolders").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docsTyped);
  await attachActiveVersionPaths(db, docsTyped);
  res.json({
    ...project,
    is_owner: project.user_id === userId,
    documents: docsTyped,
    folders: folderData ?? [],
  });
});

// GET /projects/:projectId/people
// Resolve the owner + every shared member to {email, display_name}. Used
// by the People modal so the UI can show display names where available
// and tag the current user as "You".
projectsRouter.get("/:projectId/people", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const { data: project } = await db
    .from("projects")
    .select("id, user_id, shared_with")
    .eq("id", projectId)
    .single();
  if (!project)
    return void res.status(404).json({ detail: "Project not found" });

  const isOwner = project.user_id === userId;
  const sharedWith = (Array.isArray(project.shared_with)
    ? (project.shared_with as string[])
    : []
  ).map((e) => e.toLowerCase());
  const isShared =
    !!userEmail && sharedWith.includes(userEmail.toLowerCase());
  if (!isOwner && !isShared)
    return void res.status(404).json({ detail: "Project not found" });

  // Pull every auth user (matching the lookup endpoint's pattern). For
  // larger deployments this should page or be replaced with a bulk-by-id
  // RPC, but it keeps things simple while user counts are modest.
  const { data: usersData } = await db.auth.admin.listUsers({ perPage: 1000 });
  const allUsers = usersData?.users ?? [];
  const userByEmail = new Map<string, { id: string; email: string }>();
  const userById = new Map<string, { id: string; email: string }>();
  for (const u of allUsers) {
    if (!u.email) continue;
    const lower = u.email.toLowerCase();
    userByEmail.set(lower, { id: u.id, email: u.email });
    userById.set(u.id, { id: u.id, email: u.email });
  }

  const memberUserIds: string[] = [];
  for (const email of sharedWith) {
    const u = userByEmail.get(email);
    if (u) memberUserIds.push(u.id);
  }

  const profileIds = [
    project.user_id as string,
    ...memberUserIds,
  ].filter((x, i, arr) => arr.indexOf(x) === i);

  const profileByUserId = new Map<
    string,
    { display_name: string | null; organisation: string | null }
  >();
  if (profileIds.length > 0) {
    const { data: profiles } = await db
      .from("user_profiles")
      .select("user_id, display_name, organisation")
      .in("user_id", profileIds);
    for (const p of profiles ?? []) {
      profileByUserId.set(p.user_id as string, {
        display_name: (p.display_name as string | null) ?? null,
        organisation: (p.organisation as string | null) ?? null,
      });
    }
  }

  const ownerInfo = userById.get(project.user_id as string);
  const owner = {
    user_id: project.user_id,
    email: ownerInfo?.email ?? null,
    display_name:
      profileByUserId.get(project.user_id as string)?.display_name ?? null,
  };
  const members = sharedWith.map((email) => {
    const u = userByEmail.get(email);
    const display_name = u
      ? profileByUserId.get(u.id)?.display_name ?? null
      : null;
    return { email, display_name };
  });

  res.json({ owner, members });
});

// PATCH /projects/:projectId
projectsRouter.patch("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  const updates: Record<string, unknown> = {};
  if (req.body.name != null) updates.name = req.body.name;
  if (req.body.cm_number != null) updates.cm_number = req.body.cm_number;
  if (Array.isArray(req.body.shared_with)) {
    // Normalise: lowercase + dedupe + drop empties.
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of req.body.shared_with) {
      if (typeof raw !== "string") continue;
      const e = raw.trim().toLowerCase();
      if (!e || seen.has(e)) continue;
      seen.add(e);
      cleaned.push(e);
    }
    updates.shared_with = cleaned;
  }

  const db = createServerSupabase();
  const { data, error } = await db
    .from("projects")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error || !data)
    return void res.status(404).json({ detail: "Project not found" });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
    db.from("project_subfolders").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  res.json({ ...data, documents: docsTyped, folders: folderData ?? [] });
});

// DELETE /projects/:projectId
projectsRouter.delete("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  const db = createServerSupabase();
  const { error } = await db
    .from("projects")
    .delete()
    .eq("id", projectId)
    .eq("user_id", userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// GET /projects/:projectId/documents
projectsRouter.get("/:projectId/documents", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data: docs } = await db
    .from("documents")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  res.json(docsTyped);
});

// POST /projects/:projectId/documents/:documentId — assign or copy existing doc into project
projectsRouter.post(
  "/:projectId/documents/:documentId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    // Adding-by-id pulls a doc into the project — only the doc's owner
    // is allowed to do that, so other people's standalone docs can't be
    // siphoned into a project the requester happens to share.
    const { data: doc } = await db
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .eq("user_id", userId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

    // Already in this project — idempotent
    if (doc.project_id === projectId) return void res.json(doc);

    if (doc.project_id === null) {
      // Standalone → assign project_id
      const { data: updated, error } = await db
        .from("documents")
        .update({ project_id: projectId, updated_at: new Date().toISOString() })
        .eq("id", documentId)
        .select("*")
        .single();
      if (error || !updated)
        return void res.status(500).json({ detail: "Failed to update document" });
      return void res.json(updated);
    } else {
      // Belongs to another project → duplicate record AND copy the
      // underlying storage objects so each project's copy is fully
      // independent (edits/version bumps on one don't leak into the
      // other).
      const { data: copy, error } = await db
        .from("documents")
        .insert({
          project_id: projectId,
          user_id: userId,
          filename: doc.filename,
          file_type: doc.file_type,
          size_bytes: doc.size_bytes,
          page_count: doc.page_count,
          structure_tree: doc.structure_tree,
          status: doc.status,
        })
        .select("*")
        .single();
      if (error || !copy)
        return void res.status(500).json({ detail: "Failed to copy document" });

      let copyVersionRowId: string | null = null;
      if (doc.current_version_id) {
        const { data: srcV } = await db
          .from("document_versions")
          .select(
            "storage_path, pdf_storage_path, version_number, display_name, source",
          )
          .eq("id", doc.current_version_id)
          .single();
        if (srcV?.storage_path) {
          const srcBytes = await downloadFile(srcV.storage_path);
          if (!srcBytes) {
            return void res
              .status(500)
              .json({ detail: "Failed to read source document bytes" });
          }
          const newKey = storageKey(userId, copy.id as string, doc.filename);
          const contentType =
            doc.file_type === "pdf"
              ? "application/pdf"
              : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          await uploadFile(newKey, srcBytes, contentType);

          // PDFs share one object for source + display rendition. DOCX
          // store the converted PDF at a separate `converted-pdfs/` key —
          // copy that too if it exists so the copy renders without going
          // back through libreoffice.
          let newPdfPath: string | null = null;
          if (srcV.pdf_storage_path) {
            if (srcV.pdf_storage_path === srcV.storage_path) {
              newPdfPath = newKey;
            } else {
              const pdfBytes = await downloadFile(srcV.pdf_storage_path);
              if (pdfBytes) {
                const newPdfKey = convertedPdfKey(userId, copy.id as string);
                await uploadFile(newPdfKey, pdfBytes, "application/pdf");
                newPdfPath = newPdfKey;
              }
            }
          }

          const { data: newV } = await db
            .from("document_versions")
            .insert({
              document_id: copy.id,
              storage_path: newKey,
              pdf_storage_path: newPdfPath,
              source: (srcV.source as string | null) ?? "upload",
              version_number: srcV.version_number ?? 1,
              display_name: srcV.display_name ?? doc.filename,
            })
            .select("id")
            .single();
          copyVersionRowId = (newV?.id as string | null) ?? null;
          if (copyVersionRowId) {
            await db
              .from("documents")
              .update({ current_version_id: copyVersionRowId })
              .eq("id", copy.id);
          }
        }
      }
      return void res.status(201).json(copy);
    }
  },
);

// POST /projects/:projectId/documents
projectsRouter.post(
  "/:projectId/documents",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    await handleDocumentUpload(req, res, userId, projectId, db);
  },
);

// GET /projects/:projectId/chats — every assistant chat under this project
// (any author with project access). Used by the project page's chat tab so
// it doesn't have to filter the global GET /chat list — and so collaborators
// see each other's chats inside the project even though those don't appear
// in the global list.
projectsRouter.get("/:projectId/chats", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data, error } = await db
    .from("chats")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data ?? []);
});

// ── Folder routes ─────────────────────────────────────────────────────────────

// POST /projects/:projectId/folders
projectsRouter.post("/:projectId/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const { name, parent_folder_id } = req.body as { name: string; parent_folder_id?: string | null };
  if (!name?.trim()) return void res.status(400).json({ detail: "name is required" });

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Verify parent folder belongs to this project
  if (parent_folder_id) {
    const { data: parent } = await db.from("project_subfolders").select("id").eq("id", parent_folder_id).eq("project_id", projectId).single();
    if (!parent) return void res.status(404).json({ detail: "Parent folder not found" });
  }

  const { data, error } = await db.from("project_subfolders").insert({
    project_id: projectId,
    user_id: userId,
    name: name.trim(),
    parent_folder_id: parent_folder_id ?? null,
  }).select("*").single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json(data);
});

// PATCH /projects/:projectId/folders/:folderId
projectsRouter.patch("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const body = req.body as { name?: string; parent_folder_id?: string | null };

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name != null) updates.name = body.name.trim();
  if ("parent_folder_id" in body) {
    // Cycle check: walk up the tree from the proposed parent to ensure folderId is not an ancestor
    if (body.parent_folder_id) {
      let cur: string | null = body.parent_folder_id;
      while (cur) {
        if (cur === folderId) return void res.status(400).json({ detail: "Cannot move a folder into itself or a descendant" });
        const { data: p }: { data: { parent_folder_id: string | null } | null } =
          await db.from("project_subfolders").select("parent_folder_id").eq("id", cur).single();
        cur = p?.parent_folder_id ?? null;
      }
    }
    updates.parent_folder_id = body.parent_folder_id ?? null;
  }

  const { data, error } = await db.from("project_subfolders")
    .update(updates)
    .eq("id", folderId).eq("project_id", projectId)
    .select("*").single();
  if (error || !data) return void res.status(404).json({ detail: "Folder not found" });
  res.json(data);
});

// DELETE /projects/:projectId/folders/:folderId
projectsRouter.delete("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Move direct documents to root before cascade-deleting subfolders.
  // Scope by project_id to avoid touching documents in other projects on
  // the off chance two folder IDs collide (defence-in-depth, post-RLS).
  await db
    .from("documents")
    .update({ folder_id: null })
    .eq("folder_id", folderId)
    .eq("project_id", projectId);

  const { error } = await db.from("project_subfolders")
    .delete().eq("id", folderId).eq("project_id", projectId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// PATCH /projects/:projectId/documents/:documentId/folder — move doc to a folder
projectsRouter.patch("/:projectId/documents/:documentId/folder", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const { folder_id } = req.body as { folder_id: string | null };

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const { data, error } = await db.from("documents")
    .update({ folder_id: folder_id ?? null, updated_at: new Date().toISOString() })
    .eq("id", documentId).eq("project_id", projectId)
    .select("*").single();
  if (error || !data) return void res.status(404).json({ detail: "Document not found" });
  res.json(data);
});

// ---------------------------------------------------------------------------
// Document graph links (Phase 09)
//
// Per-project typed edges between documents, surfaced in the Graph tab of
// ProjectPage. Manual links carry created_by='user'; LLM-extracted ones
// (Phase 11) carry created_by='llm'. The unique (source, target, type)
// constraint keeps the graph tidy when the same proposal is accepted twice.
// ---------------------------------------------------------------------------

const ALLOWED_LINK_TYPES = new Set([
  "references",
  "amends",
  "supersedes",
  "exhibit-of",
  "cited-by",
  "related",
]);

function normaliseLinkType(raw: unknown): string | null {
  if (typeof raw !== "string") return "references";
  const trimmed = raw.trim();
  if (!trimmed) return "references";
  // Accept the curated vocabulary case-insensitively; otherwise allow a free
  // string but cap its length so a misbehaving caller can't store essays.
  const lower = trimmed.toLowerCase();
  if (ALLOWED_LINK_TYPES.has(lower)) return lower;
  if (trimmed.length > 64) return null;
  return trimmed;
}

// GET /projects/:projectId/links
projectsRouter.get("/:projectId/links", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data, error } = await db
    .from("document_links")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data ?? []);
});

// POST /projects/:projectId/links
projectsRouter.post("/:projectId/links", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const { source_doc_id, target_doc_id, link_type } = req.body as {
    source_doc_id?: string;
    target_doc_id?: string;
    link_type?: string;
  };

  if (!source_doc_id || !target_doc_id)
    return void res
      .status(400)
      .json({ detail: "source_doc_id and target_doc_id are required" });
  if (source_doc_id === target_doc_id)
    return void res
      .status(400)
      .json({ detail: "source and target must differ" });
  const type = normaliseLinkType(link_type);
  if (type === null)
    return void res.status(400).json({ detail: "link_type too long" });

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  // Both documents must live in this project — protects against linking
  // documents the caller can see in another project.
  const { data: docs } = await db
    .from("documents")
    .select("id, project_id")
    .in("id", [source_doc_id, target_doc_id]);
  const found = (docs ?? []) as { id: string; project_id: string | null }[];
  if (found.length !== 2 || found.some((d) => d.project_id !== projectId))
    return void res
      .status(400)
      .json({ detail: "Both documents must belong to this project" });

  const { data, error } = await db
    .from("document_links")
    .insert({
      project_id: projectId,
      source_doc_id,
      target_doc_id,
      link_type: type,
      created_by: "user",
      user_id: userId,
    })
    .select("*")
    .single();
  if (error) {
    // SQLite UNIQUE constraint failure → 409, treat as "already linked"
    if (/UNIQUE/i.test(error.message))
      return void res
        .status(409)
        .json({ detail: "Link already exists" });
    return void res.status(500).json({ detail: error.message });
  }
  res.status(201).json(data);
});

// DELETE /projects/:projectId/links/:linkId
projectsRouter.delete(
  "/:projectId/links/:linkId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, linkId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    // Only the link's creator (or project owner) can delete it. Shared
    // members can add their own links but not erase someone else's.
    const { data: link } = await db
      .from("document_links")
      .select("id, user_id, project_id")
      .eq("id", linkId)
      .eq("project_id", projectId)
      .single();
    if (!link)
      return void res.status(404).json({ detail: "Link not found" });
    if (link.user_id !== userId && !access.isOwner)
      return void res.status(403).json({ detail: "Not allowed" });

    const { error } = await db
      .from("document_links")
      .delete()
      .eq("id", linkId)
      .eq("project_id", projectId);
    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
  },
);

// POST /projects/:projectId/links/bulk
// Persist a list of accepted LLM proposals in one round trip. Each entry is
// validated the same way as the manual POST; duplicates inside the project
// are skipped silently so the caller can re-submit without 4xx-ing.
projectsRouter.post(
  "/:projectId/links/bulk",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const { proposals } = req.body as {
      proposals?: Array<{
        source_doc_id?: string;
        target_doc_id?: string;
        link_type?: string;
        citation_text?: string;
      }>;
    };
    if (!Array.isArray(proposals) || proposals.length === 0)
      return void res.status(400).json({ detail: "proposals[] required" });

    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    // Pre-fetch the project's documents once so we can validate every
    // proposal against the in-project doc set without N round-trips.
    const { data: projectDocs } = await db
      .from("documents")
      .select("id")
      .eq("project_id", projectId);
    const projectDocIds = new Set(
      ((projectDocs ?? []) as { id: string }[]).map((d) => d.id),
    );

    const inserted: unknown[] = [];
    const skipped: { reason: string; proposal: unknown }[] = [];

    for (const p of proposals) {
      if (
        !p.source_doc_id ||
        !p.target_doc_id ||
        p.source_doc_id === p.target_doc_id ||
        !projectDocIds.has(p.source_doc_id) ||
        !projectDocIds.has(p.target_doc_id)
      ) {
        skipped.push({ reason: "invalid_docs", proposal: p });
        continue;
      }
      const type = normaliseLinkType(p.link_type);
      if (type === null) {
        skipped.push({ reason: "invalid_type", proposal: p });
        continue;
      }
      const { data, error } = await db
        .from("document_links")
        .insert({
          project_id: projectId,
          source_doc_id: p.source_doc_id,
          target_doc_id: p.target_doc_id,
          link_type: type,
          citation_text: p.citation_text ?? null,
          created_by: "llm",
          user_id: userId,
        })
        .select("*")
        .single();
      if (error) {
        skipped.push({ reason: "db_error", proposal: p });
        continue;
      }
      inserted.push(data);
    }
    res.json({ inserted, skipped });
  },
);

// POST /projects/:projectId/links/extract
// Run the LLM citation-extraction pass. Returns proposed edges without
// persisting them — the frontend renders them in a review modal so the user
// can accept/reject before they land in document_links via /links/bulk.
//
// Cost discipline: we send the model a per-doc summary (filename + first
// ~3 KB of extracted text), not the full body. Project size is capped at
// 40 docs per call to keep the prompt bounded; larger projects will need
// a chunked pass (deferred).
const EXTRACT_MAX_DOCS = 40;
const EXTRACT_SLICE_CHARS = 3000;

interface ExtractProposal {
  source_doc_id: string;
  target_doc_id: string;
  link_type: string;
  citation_text: string;
}

async function loadDocText(
  doc: { id: string; file_type: string | null; filename: string },
  db: ReturnType<typeof createServerSupabase>,
): Promise<string> {
  // Try the active version first (matches read_document behaviour); fall back
  // to nothing if bytes unavailable. Silent fallback — extraction shouldn't
  // hard-fail because one doc didn't load.
  try {
    const current = await loadCurrentVersionBytes(doc.id, db);
    if (!current) return "";
    if (doc.file_type === "pdf") {
      const ab = current.bytes.buffer.slice(
        current.bytes.byteOffset,
        current.bytes.byteOffset + current.bytes.byteLength,
      ) as ArrayBuffer;
      return (await extractPdfText(ab)).slice(0, EXTRACT_SLICE_CHARS);
    }
    if (doc.file_type === "docx" || doc.file_type === "doc") {
      const t = await extractDocxBodyText(current.bytes);
      return (t ?? "").slice(0, EXTRACT_SLICE_CHARS);
    }
    return current.bytes.toString("utf8").slice(0, EXTRACT_SLICE_CHARS);
  } catch (e) {
    console.warn(`[extract-links] failed to load text for ${doc.id}`, e);
    return "";
  }
}

projectsRouter.post(
  "/:projectId/links/extract",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    const settings = await getUserModelSettings(userId, db);
    const hasKey = !!(settings.api_keys.claude || settings.api_keys.gemini);
    if (!hasKey)
      return void res.status(400).json({
        detail:
          "No model API key configured. Add one in Settings → Models & API Keys.",
      });

    const { data: docs } = await db
      .from("documents")
      .select("id, filename, file_type, status, current_version_id")
      .eq("project_id", projectId);
    const allDocs = (docs ?? []) as {
      id: string;
      filename: string;
      file_type: string | null;
      status: string;
      current_version_id: string | null;
    }[];
    const readyDocs = allDocs.filter((d) => d.status === "ready");
    if (readyDocs.length < 2)
      return void res.json({
        proposals: [],
        note: "Need at least 2 ready documents.",
      });
    if (readyDocs.length > EXTRACT_MAX_DOCS)
      return void res.status(400).json({
        detail: `Project has ${readyDocs.length} documents; extraction is capped at ${EXTRACT_MAX_DOCS} per call.`,
      });

    // Preload text in parallel — bounded by readyDocs.length ≤ 40.
    const texts = await Promise.all(readyDocs.map((d) => loadDocText(d, db)));

    // Index docs by their position in the prompt; the model is asked to use
    // these compact IDs in its output instead of full UUIDs, which (a) saves
    // tokens and (b) makes us robust to the model truncating UUID strings.
    const indexed = readyDocs.map((d, i) => ({
      tag: `D${i + 1}`,
      doc: d,
      text: texts[i],
    }));

    const promptDocs = indexed
      .map(
        ({ tag, doc, text }) =>
          `### ${tag}: ${doc.filename}\n${text || "(text unavailable)"}`,
      )
      .join("\n\n");

    const system = `You are a legal-document analyst. Identify cross-references between the supplied documents: when one document references, amends, supersedes, or otherwise relates to another. Be precise — only emit a link when the source text clearly refers to the target.`;
    const user = `For each pair of documents below, identify any cross-references from one to another.

Documents (each labelled with a tag like D1, D2):

${promptDocs}

Reply with ONLY a JSON object in this exact shape, no prose, no markdown fence:
{
  "proposals": [
    {
      "source": "D1",
      "target": "D2",
      "link_type": "references | amends | supersedes | exhibit-of | cited-by | related",
      "citation": "short verbatim snippet from the source"
    }
  ]
}
Keep each citation under 120 characters. If there are no cross-references, return {"proposals": []}.`;

    let raw: string;
    try {
      raw = await completeText({
        model: settings.tabular_model,
        systemPrompt: system,
        user,
        maxTokens: 8192,
        apiKeys: settings.api_keys,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return void res
        .status(502)
        .json({ detail: `LLM call failed: ${msg.slice(0, 200)}` });
    }

    // Models routinely wrap JSON in prose ("Here are the citations:…") or in
    // ```json fences despite instructions. Strategy: strip an outer fence,
    // then fall back to slicing between the first `{` and the matching last
    // `}` so leading/trailing prose doesn't kill the parse.
    function tryParse(text: string): { proposals?: unknown } | null {
      try {
        return JSON.parse(text) as { proposals?: unknown };
      } catch {
        return null;
      }
    }

    const stripped = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let parsed = tryParse(stripped);
    if (!parsed) {
      const first = stripped.indexOf("{");
      const last = stripped.lastIndexOf("}");
      if (first !== -1 && last > first) {
        parsed = tryParse(stripped.slice(first, last + 1));
      }
    }
    if (!parsed) {
      console.warn(
        `[extract-links] model returned non-JSON (len=${raw.length}): ${raw.slice(0, 500)}`,
      );
      return void res.status(502).json({
        detail: "Model did not return valid JSON.",
        sample: raw.slice(0, 300),
      });
    }

    const ALLOWED_TYPES = new Set([
      "references",
      "amends",
      "supersedes",
      "exhibit-of",
      "cited-by",
      "related",
    ]);
    const tagToId = new Map(indexed.map((x) => [x.tag, x.doc.id]));

    const proposals: ExtractProposal[] = [];
    const rawProposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
    for (const r of rawProposals as Record<string, unknown>[]) {
      const sourceTag = typeof r.source === "string" ? r.source : "";
      const targetTag = typeof r.target === "string" ? r.target : "";
      const type = typeof r.link_type === "string" ? r.link_type.toLowerCase() : "";
      const citation = typeof r.citation === "string" ? r.citation : "";
      const sourceId = tagToId.get(sourceTag);
      const targetId = tagToId.get(targetTag);
      if (
        !sourceId ||
        !targetId ||
        sourceId === targetId ||
        !ALLOWED_TYPES.has(type)
      ) {
        continue;
      }
      proposals.push({
        source_doc_id: sourceId,
        target_doc_id: targetId,
        link_type: type,
        citation_text: citation.slice(0, 500),
      });
    }

    // De-duplicate against existing links so the modal doesn't waste the
    // user's time asking about edges that already exist.
    const { data: existing } = await db
      .from("document_links")
      .select("source_doc_id, target_doc_id, link_type")
      .eq("project_id", projectId);
    const existingKey = new Set(
      ((existing ?? []) as {
        source_doc_id: string;
        target_doc_id: string;
        link_type: string;
      }[]).map((l) => `${l.source_doc_id}|${l.target_doc_id}|${l.link_type}`),
    );
    const novel = proposals.filter(
      (p) =>
        !existingKey.has(`${p.source_doc_id}|${p.target_doc_id}|${p.link_type}`),
    );

    res.json({ proposals: novel, model: settings.tabular_model });
  },
);

// ---------------------------------------------------------------------------
// Graph layout (saved node positions, per-user)
// ---------------------------------------------------------------------------

// GET /projects/:projectId/graph-layout
// Returns { positions: { [docId]: { x, y } } } or { positions: {} } if the
// user hasn't saved one yet. Layouts are per-user, so the renderer always
// reads via the authenticated user's row.
projectsRouter.get(
  "/:projectId/graph-layout",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    const { data } = await db
      .from("document_graph_layouts")
      .select("positions")
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .maybeSingle();
    res.json({ positions: data?.positions ?? {} });
  },
);

// PUT /projects/:projectId/graph-layout
// Upserts the saved layout for this user. Body: { positions: {...} }.
projectsRouter.put(
  "/:projectId/graph-layout",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const positions = (req.body as { positions?: unknown })?.positions;

    if (
      typeof positions !== "object" ||
      positions === null ||
      Array.isArray(positions)
    )
      return void res
        .status(400)
        .json({ detail: "positions must be an object" });

    // Validate the shape: every value must be {x: number, y: number}. Reject
    // anything else so we don't store garbage that crashes the renderer on
    // the next load.
    for (const [k, v] of Object.entries(positions as Record<string, unknown>)) {
      if (typeof k !== "string" || !v || typeof v !== "object") {
        return void res
          .status(400)
          .json({ detail: "invalid position entry" });
      }
      const pos = v as { x?: unknown; y?: unknown };
      if (typeof pos.x !== "number" || typeof pos.y !== "number") {
        return void res
          .status(400)
          .json({ detail: "x/y must be numbers" });
      }
    }

    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    // Upsert manually: the shim doesn't support PostgREST `upsert()`. Check
    // for an existing row, then UPDATE or INSERT accordingly.
    const { data: existing } = await db
      .from("document_graph_layouts")
      .select("id")
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .maybeSingle();

    if (existing?.id) {
      const { error } = await db
        .from("document_graph_layouts")
        .update({
          positions,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (error) return void res.status(500).json({ detail: error.message });
    } else {
      const { error } = await db.from("document_graph_layouts").insert({
        project_id: projectId,
        user_id: userId,
        positions,
      });
      if (error) return void res.status(500).json({ detail: error.message });
    }
    res.json({ ok: true });
  },
);

export async function handleDocumentUpload(
  req: import("express").Request,
  res: import("express").Response,
  userId: string,
  projectId: string | null,
  db: ReturnType<typeof createServerSupabase>,
) {
  const file = req.file;
  if (!file) return void res.status(400).json({ detail: "file is required" });

  const filename = file.originalname;
  const suffix = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  if (!ALLOWED_TYPES.has(suffix))
    return void res
      .status(400)
      .json({
        detail: `Unsupported file type: ${suffix}. Allowed: pdf, docx, doc`,
      });

  const content = file.buffer;
  const { data: doc, error: insertErr } = await db
    .from("documents")
    .insert({
      project_id: projectId,
      user_id: userId,
      filename,
      file_type: suffix,
      size_bytes: content.byteLength,
      status: "processing",
    })
    .select("*")
    .single();

  if (insertErr || !doc)
    return void res
      .status(500)
      .json({ detail: "Failed to create document record" });

  try {
    const docId = doc.id as string;
    const key = storageKey(userId, docId, filename);
    const contentType =
      suffix === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await uploadFile(
      key,
      content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer,
      contentType,
    );

    const rawBuf = content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
    const tree = await extractStructureTree(rawBuf, suffix, filename);
    const pageCount = suffix === "pdf" ? await countPdfPages(rawBuf) : null;

    // Convert DOCX/DOC → PDF for display. PDFs are their own rendition.
    let pdfStoragePath: string | null = null;
    if (suffix === "docx" || suffix === "doc") {
      try {
        const pdfBuf = await docxToPdf(content);
        const pdfKey = convertedPdfKey(userId, docId);
        await uploadFile(
          pdfKey,
          pdfBuf.buffer.slice(
            pdfBuf.byteOffset,
            pdfBuf.byteOffset + pdfBuf.byteLength,
          ) as ArrayBuffer,
          "application/pdf",
        );
        pdfStoragePath = pdfKey;
      } catch (err) {
        console.error(
          `[upload] DOCX→PDF conversion failed for ${filename}:`,
          err,
        );
      }
    } else if (suffix === "pdf") {
      pdfStoragePath = key;
    }

    // Storage paths live on document_versions — create the V1 row and
    // point documents.current_version_id at it.
    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: docId,
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: "upload",
        version_number: 1,
        display_name: filename,
      })
      .select("id")
      .single();
    if (verErr || !versionRow) {
      throw new Error(
        `Failed to record upload version: ${verErr?.message ?? "unknown"}`,
      );
    }

    await db
      .from("documents")
      .update({
        current_version_id: versionRow.id,
        size_bytes: content.byteLength,
        page_count: pageCount,
        structure_tree: tree ?? null,
        status: "ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", docId);

    const { data: updated } = await db
      .from("documents")
      .select("*")
      .eq("id", docId)
      .single();
    const responseDoc = updated
      ? {
            ...updated,
            storage_path: key,
            pdf_storage_path: pdfStoragePath,
        }
      : updated;
    return void res.status(201).json(responseDoc);
  } catch (e) {
    await db.from("documents").update({ status: "error" }).eq("id", doc.id);
    return void res
      .status(500)
      .json({ detail: `Document processing failed: ${String(e)}` });
  }
}

async function countPdfPages(buf: ArrayBuffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{ numPages: number }>;
        };
      }
    ).getDocument({ data: new Uint8Array(buf) }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}

async function extractStructureTree(
  content: ArrayBuffer,
  fileType: string,
  filename: string,
): Promise<unknown[] | null> {
  try {
    if (fileType === "pdf") {
      const pdfjsLib = await import(
        "pdfjs-dist/legacy/build/pdf.mjs" as string
      );
      const pdf = await (
        pdfjsLib as unknown as {
          getDocument: (opts: unknown) => {
            promise: Promise<{
              numPages: number;
              getOutline: () => Promise<{ title?: string }[]>;
            }>;
          };
        }
      ).getDocument({ data: new Uint8Array(content) }).promise;
      if (pdf.numPages <= 5) return null;
      const outline = await pdf.getOutline();
      if (outline?.length) {
        return outline.map((item, i) => ({
          id: `h1-${i}`,
          title: item.title ?? `Item ${i + 1}`,
          level: 1,
          page_number: null,
          children: [],
        }));
      }
      return Array.from({ length: pdf.numPages }, (_, i) => ({
        id: `page-${i + 1}`,
        title: `Page ${i + 1}`,
        level: 1,
        page_number: i + 1,
        children: [],
      }));
    } else {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(content),
      });
      const lines = result.value.split("\n").filter((l) => l.trim());
      const nodes = lines
        .slice(0, 30)
        .map((line, i) => ({
          id: `h1-${i}`,
          title: line.slice(0, 100),
          level: 1,
          page_number: null,
          children: [],
        }));
      return nodes.length ? nodes : null;
    }
  } catch {
    return null;
  }
}
