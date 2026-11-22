"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as XLSX from "xlsx";
import {
  cellDisplay,
  cellRaw,
  ensureSheetLimits,
  markFullCalc,
  parseSheet,
  setCellValue,
  sheetRange,
  writeSheet,
  type SheetBook,
} from "@/lib/documents/sheet.client";
import {
  SHEET_MAX_COLS,
  SHEET_MAX_ROWS,
  type SheetBookType,
} from "@/lib/documents/format";

export type SheetEditorApi = {
  /** 序列化为保存用的字节；解析失败或关闭时返回 null */
  getBytes: () => Uint8Array | null;
  isDirty: () => boolean;
};

type Props = {
  bytes: ArrayBuffer | null;
  bookType: SheetBookType;
  reloadToken: number;
  readOnly: boolean;
  apiRef: { current: SheetEditorApi | null };
  onDirty: () => void;
  onSave: () => void;
};

const PAGE_ROWS = 100;
const DEFAULT_COL_WIDTH = 96;
const DEFAULT_ROW_HEIGHT = 28;
const MIN_COL_WIDTH = 32;
const MIN_ROW_HEIGHT = 18;

/** 读取 worksheet 的列宽（像素）；SheetJS 写入时 `!cols[].wpx` 会被保留 */
function colWidth(ws: XLSX.WorkSheet, c: number): number {
  const col = ws["!cols"]?.[c];
  if (!col) return DEFAULT_COL_WIDTH;
  if (typeof col.wpx === "number") return col.wpx;
  if (typeof col.wch === "number") return Math.round(col.wch * 7 + 5);
  if (typeof col.width === "number") return Math.round(col.width * 7 + 5);
  return DEFAULT_COL_WIDTH;
}

function rowHeight(ws: XLSX.WorkSheet, r: number): number {
  const row = ws["!rows"]?.[r];
  if (row && typeof row.hpx === "number") return row.hpx;
  if (row && typeof row.hpt === "number") return Math.round(row.hpt * 4 / 3);
  return DEFAULT_ROW_HEIGHT;
}

/**
 * 表格编辑器：SheetJS 直接改 worksheet 单元格，保留未编辑单元格的
 * 类型/公式/数字格式；只做单元格内容编辑，不做样式/行列增删。
 */
export function SheetEditor({
  bytes,
  bookType,
  reloadToken,
  readOnly,
  apiRef,
  onDirty,
  onSave,
}: Props) {
  const [wb, setWb] = useState<SheetBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [selected, setSelected] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);
  const [formula, setFormula] = useState("");
  const [startRow, setStartRow] = useState(0);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    // 解析放到下一拍：避免 effect 内同步 setState 触发级联渲染
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const parsed = parseSheet(bytes, bookType);
        const first = parsed.Sheets[parsed.SheetNames[0]];
        setWb(parsed);
        setError(null);
        setActiveSheet(0);
        setSelected({ r: 0, c: 0 });
        setEditing(null);
        setStartRow(0);
        setDirty(false);
        setFormula(first ? cellRaw(first, 0, 0) : "");
      } catch (e) {
        setWb(null);
        setError(e instanceof Error ? e.message : "表格解析失败");
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bytes, bookType, reloadToken]);

  const sheetName = wb?.SheetNames[activeSheet] ?? null;
  const ws = sheetName && wb ? wb.Sheets[sheetName] : null;

  const range = useMemo(() => {
    const r = ws ? sheetRange(ws) : { rows: 0, cols: 0 };
    return {
      rows: Math.max(r.rows, 30),
      cols: Math.min(Math.max(r.cols, 8), SHEET_MAX_COLS),
    };
  }, [ws]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFormula(ws ? cellRaw(ws, selected.r, selected.c) : "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ws, selected]);

  const markDirty = useCallback(() => {
    setDirty(true);
    onDirty();
  }, [onDirty]);

  // 拖动列宽 / 行高：写回 worksheet 的 !cols / !rows，保存时随文件一起写出。
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  function startResize(
    kind: "col" | "row",
    index: number,
    e: ReactPointerEvent<HTMLElement>,
  ) {
    if (readOnly || !ws) return;
    e.preventDefault();
    e.stopPropagation();
    resizeCleanupRef.current?.();

    const startPos = kind === "col" ? e.clientX : e.clientY;
    const base = kind === "col" ? colWidth(ws, index) : rowHeight(ws, index);
    const min = kind === "col" ? MIN_COL_WIDTH : MIN_ROW_HEIGHT;
    const max = kind === "col" ? 600 : 300;
    let latest = base;
    let raf = 0;

    const apply = () => {
      raf = 0;
      if (kind === "col") {
        const cols = ws["!cols"] ?? [];
        cols[index] = { ...(cols[index] ?? {}), wpx: latest };
        ws["!cols"] = cols;
      } else {
        const rows = ws["!rows"] ?? [];
        rows[index] = { ...(rows[index] ?? {}), hpx: latest };
        ws["!rows"] = rows;
      }
      setWb((prev) => (prev ? { ...prev } : prev));
      markDirty();
    };

    const onMove = (ev: PointerEvent) => {
      const delta = (kind === "col" ? ev.clientX : ev.clientY) - startPos;
      latest = Math.min(max, Math.max(min, base + delta));
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const finish = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        apply();
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      resizeCleanupRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    resizeCleanupRef.current = finish;
  }

  const commitCell = useCallback(
    (r: number, c: number, value: string) => {
      if (!ws || readOnly) return;
      if (r >= SHEET_MAX_ROWS || c >= SHEET_MAX_COLS) {
        window.alert(`表格最多 ${SHEET_MAX_ROWS} 行 × ${SHEET_MAX_COLS} 列`);
        return;
      }
      setCellValue(ws, r, c, value, bookType);
      setWb({ ...wb! });
      markDirty();
      setFormula(cellRaw(ws, r, c));
    },
    [ws, wb, readOnly, bookType, markDirty],
  );

  // 暴露命令式 API 给父组件的保存流程
  useEffect(() => {
    apiRef.current = {
      getBytes: () => {
        if (!wb) return null;
        ensureSheetLimits(wb);
        markFullCalc(wb);
        return writeSheet(wb, bookType);
      },
      isDirty: () => dirty,
    };
  }, [apiRef, wb, bookType, dirty]);

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setEditing(null);
        setFormula(ws ? cellRaw(ws, editing.r, editing.c) : "");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, ws]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-danger">{error}</div>
    );
  }
  if (!wb || !ws) {
    return <div className="flex flex-1 items-center justify-center p-8 text-sm text-ink-faint">表格加载中…</div>;
  }

  const visibleRows = Math.min(PAGE_ROWS, Math.max(range.rows - startRow, 1));
  const rows = Array.from({ length: visibleRows }, (_, i) => startRow + i);
  const cols = Array.from({ length: range.cols }, (_, i) => i);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 公式栏 */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="min-w-[64px] rounded border border-line bg-surface-2 px-2 py-0.5 text-center text-xs text-ink-soft">
          {XLSX.utils.encode_cell({ r: selected.r, c: selected.c })}
        </span>
        <span className="text-xs text-ink-faint">fx</span>
        <input
          className="ac-field flex-1 py-1 font-mono text-[13px]"
          value={formula}
          readOnly={readOnly}
          placeholder="单元格内容，直接输入；公式以 = 开头"
          onChange={(e) => setFormula(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitCell(selected.r, selected.c, formula);
              e.currentTarget.blur();
            }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              onSave();
            }
          }}
          onBlur={() => {
            if (!readOnly && formula !== cellRaw(ws, selected.r, selected.c)) {
              commitCell(selected.r, selected.c, formula);
            }
          }}
        />
      </div>

      {/* 网格 */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-[13px]" style={{ tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: 40 }} />
            {cols.map((c) => (
              <col key={c} style={{ width: colWidth(ws, c) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 w-10 border border-line bg-surface-2 px-1 py-1 text-xs font-normal text-ink-faint" />
              {cols.map((c) => (
                <th
                  key={c}
                  className={`sticky top-0 z-10 border border-line bg-surface-2 px-2 py-1 text-xs font-normal ${
                    selected.c === c ? "text-ink" : "text-ink-faint"
                  }`}
                >
                  {XLSX.utils.encode_col(c)}
                  {!readOnly && (
                    <span
                      role="separator"
                      aria-label={`调整 ${XLSX.utils.encode_col(c)} 列宽`}
                      title="拖动调整列宽"
                      className="absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize select-none hover:bg-primary/40"
                      onPointerDown={(e) => startResize("col", c, e)}
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r} style={{ height: rowHeight(ws, r) }}>
                <th
                  className={`sticky left-0 z-10 w-10 border border-line bg-surface-2 px-1 py-1 text-xs font-normal ${
                    selected.r === r ? "text-ink" : "text-ink-faint"
                  }`}
                >
                  {r + 1}
                  {!readOnly && (
                    <span
                      role="separator"
                      aria-label={`调整第 ${r + 1} 行行高`}
                      title="拖动调整行高"
                      className="absolute bottom-0 left-0 h-1.5 w-full cursor-row-resize select-none hover:bg-primary/40"
                      onPointerDown={(e) => startResize("row", r, e)}
                    />
                  )}
                </th>
                {cols.map((c) => {
                  const isEditing = editing?.r === r && editing.c === c;
                  const isSelected = selected.r === r && selected.c === c;
                  return (
                    <td
                      key={c}
                      className={`max-w-[320px] cursor-cell truncate border border-line px-2 ${
                        isSelected ? "bg-accent-soft/40 outline outline-1 outline-accent" : ""
                      }`}
                      onClick={() => {
                        setSelected({ r, c });
                        setEditing(null);
                      }}
                      onDoubleClick={() => {
                        if (readOnly) return;
                        setSelected({ r, c });
                        setEditing({ r, c, value: cellRaw(ws, r, c) });
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          className="w-full bg-transparent font-mono text-[13px] outline-none"
                          value={editing.value}
                          onChange={(e) => setEditing({ r, c, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitCell(r, c, editing.value);
                              setEditing(null);
                              setSelected({ r: Math.min(r + 1, range.rows - 1), c });
                            }
                            if (e.key === "Tab") {
                              e.preventDefault();
                              commitCell(r, c, editing.value);
                              setEditing({ r, c: Math.min(c + 1, range.cols - 1), value: "" });
                              setSelected({ r, c: Math.min(c + 1, range.cols - 1) });
                            }
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setEditing(null);
                            }
                          }}
                          onBlur={() => {
                            if (editing.value !== cellRaw(ws, r, c)) {
                              commitCell(r, c, editing.value);
                            }
                            setEditing(null);
                          }}
                        />
                      ) : (
                        cellDisplay(ws, r, c)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 工作表页签 + 翻页 */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-1">
          {wb.SheetNames.map((name, i) => (
            <button
              key={name}
              type="button"
              onClick={() => {
                setActiveSheet(i);
                setStartRow(0);
                setSelected({ r: 0, c: 0 });
                setEditing(null);
              }}
              className={`ac-btn-ghost px-2 py-1 text-xs ${
                i === activeSheet ? "bg-surface-2 text-ink" : "text-ink-soft"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-ink-faint">
          <span>
            {startRow + 1}–{startRow + visibleRows} / {range.rows} 行 · {range.cols} 列
          </span>
          <button
            type="button"
            className="ac-btn-ghost px-2 py-1 text-xs"
            disabled={startRow === 0}
            onClick={() => setStartRow(Math.max(0, startRow - PAGE_ROWS))}
          >
            上一页
          </button>
          <button
            type="button"
            className="ac-btn-ghost px-2 py-1 text-xs"
            disabled={startRow + PAGE_ROWS >= range.rows}
            onClick={() => setStartRow(startRow + PAGE_ROWS)}
          >
            下一页
          </button>
          {readOnly && <span>只读</span>}
        </div>
      </div>
      <div className="border-t border-line px-3 py-1 text-[11px] text-ink-faint">
        双击单元格编辑；公式以 = 开头 · 拖动列标右缘调列宽、行号下缘调行高 ·
        字体/颜色/图表/条件格式不随社区版 SheetJS 保存
      </div>
    </div>
  );
}
