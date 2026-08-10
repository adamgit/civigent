import type { DocPath, DocStructureNode } from "../types/shared.js";
import { apiClient } from "../services/api-client";
import type { WorkspaceSectionDto } from "../pages/document-page-utils";

/**
 * REST-backed resource model for document-level operations.
 *
 * Reads are workspace (working-copy) reads: `loadSections()`/`reloadSections()`
 * and `loadStructure()` call the `apiClient.getWorkspace*` methods, which resolve
 * the in-progress proposal for the doc (if any) first, with canonical fallback —
 * so the human editor sees its own working copy. Proposal-scoped reads still go
 * through the dedicated proposal APIs. Live CRDT/transport state is owned by the
 * editor/transport layer and intentionally stays outside this model.
 */
export class DocumentResourceModel {
  private lastDocPath: DocPath | null = null;

  async loadSections(docPath: DocPath): Promise<WorkspaceSectionDto[]> {
    const response = await apiClient.getWorkspaceDocumentSections(docPath);
    this.lastDocPath = docPath;
    return response.sections;
  }

  async reloadSections(): Promise<WorkspaceSectionDto[]> {
    if (!this.lastDocPath) return [];
    return this.loadSections(this.lastDocPath);
  }

  async loadStructure(docPath: DocPath): Promise<DocStructureNode[]> {
    const response = await apiClient.getWorkspaceDocumentStructure(docPath);
    return response.structure;
  }

  async renameDocument(docPath: DocPath, newPath: DocPath): Promise<void> {
    await apiClient.renameDocument(docPath, newPath);
  }

  async deleteDocument(docPath: DocPath): Promise<void> {
    await apiClient.deleteDocument(docPath);
  }
}

