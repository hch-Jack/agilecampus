import type { DocumentFormat, DocumentEvent, LockView, PresenceUser } from "@/lib/documents/types";

export type DocumentVersionDto = {
  version: number;
  filename: string;
  size: number;
  note: string | null;
  creatorName: string | null;
  createdAt: string;
};

export type DocumentEditorInitial = {
  document: {
    id: string;
    sourceType: string;
    sourceId: string;
    taskId: string | null;
    format: DocumentFormat;
    filename: string;
    mimeType: string | null;
    currentVersion: number;
    collaborationEnabled: boolean;
    createdById: string | null;
  };
  source: {
    filename: string;
    mimeType: string | null;
    size: number;
    ownerUserId: string;
    taskId: string | null;
    projectId: string | null;
  };
  canEdit: boolean;
  canManage: boolean;
  editVia: "owner" | "admin" | "grant" | null;
  role: "admin" | "teacher" | "student" | null;
  lock: LockView | null;
  editorState: unknown | null;
  versions: DocumentVersionDto[];
  editors: { userId: string; name: string | null }[];
  members: { userId: string; name: string | null; role: "admin" | "teacher" | "student" }[];
  contentUrl: string;
  currentUserId: string;
  currentUserName: string;
};

export type { DocumentEvent, LockView, PresenceUser };
