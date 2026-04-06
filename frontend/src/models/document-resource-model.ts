import type { DocStructureNode } from "../types/shared.js";
import { apiClient } from "../services/api-client";
import type { DocumentSection } from "../pages/document-page-utils";

/**
 * REST-backed resource model for document-level operations.
 * Session transport state intentionally stays outside this model.
 */
export class DocumentResourceModel {
  private lastDocPath: string | null = null;

  async loadSections(docPath: string): Promise<DocumentSection[]> {
    const response = await apiClient.getDocumentSections(docPath);
    this.lastDocPath = docPath;
    return response.sections;
  }

  async reloadSections(): Promise<DocumentSection[]> {
    if (!this.lastDocPath) return [];
    return this.loadSections(this.lastDocPath);
  }

  async loadStructure(docPath: string): Promise<DocStructureNode[]> {
    const response = await apiClient.getDocumentStructure(docPath);
    return response.structure;
  }

  async renameDocument(docPath: string, newPath: string): Promise<void> {
    await apiClient.renameDocument(docPath, newPath);
  }

  async deleteDocument(docPath: string): Promise<void> {
    await apiClient.deleteDocument(docPath);
  }
}

