import { isLibraryFileType, type LibraryFileType } from "./file-kind";
import type { LibraryQuery, LibrarySortDir, LibrarySortField } from "./types";

const SORT_FIELDS: LibrarySortField[] = ["name", "modified", "size", "type"];
const SORT_DIRS: LibrarySortDir[] = ["asc", "desc"];

function one(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 从页面 searchParams 解析资源库搜索/排序参数，非法值静默回落 */
export function parseLibraryQuery(
  sp: Record<string, string | string[] | undefined>,
): LibraryQuery {
  const q = one(sp.q)?.trim().slice(0, 100) ?? "";
  const typeRaw = one(sp.type);
  const sortRaw = one(sp.sort);
  const dirRaw = one(sp.dir);
  return {
    q,
    type: typeRaw && isLibraryFileType(typeRaw) ? typeRaw : "all",
    sort:
      sortRaw && (SORT_FIELDS as string[]).includes(sortRaw)
        ? (sortRaw as LibrarySortField)
        : "modified",
    dir:
      dirRaw && (SORT_DIRS as string[]).includes(dirRaw)
        ? (dirRaw as LibrarySortDir)
        : "desc",
  };
}

export type { LibraryFileType };
