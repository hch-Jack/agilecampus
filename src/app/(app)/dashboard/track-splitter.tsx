"use client";

import { useEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

// 卡片内部的分区拖拽条：指针拖动改比例，方向键微调。
// 测量基准固定是**父元素**（也就是分区所在的 flex 容器），所以调用方只要把
// 拖拽条放在两段之间，比例就按父容器的宽度（x）或高度（y）换算。

const KEY_STEP = 0.02;
const COMMIT_DELAY_MS = 500;

export function TrackSplitter({
  orientation,
  label,
  min,
  max,
  value,
  onPreview,
  onCommit,
  className,
}: {
  /** x = 左右分区（竖向拖拽条），y = 上下分区（横向拖拽条） */
  orientation: "x" | "y";
  label: string;
  min: number;
  max: number;
  /** 当前比例，供方向键从现值加减；缺省按中点 */
  value?: number;
  onPreview: (ratio: number) => void;
  /** 松手 / 键盘调整后提交，内部已做 500ms 防抖 */
  onCommit: (ratio: number) => void;
  className?: string;
}) {
  const clamp = (ratio: number) => Math.min(Math.max(ratio, min), max);
  // 方向键连按合并成一次提交，避免每按一下发一个保存请求
  const keyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (keyTimer.current) window.clearTimeout(keyTimer.current);
    },
    [],
  );

  function startDrag(e: ReactPointerEvent<HTMLDivElement>) {
    const box = e.currentTarget.parentElement;
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = box.getBoundingClientRect();
    const size = orientation === "x" ? rect.width : rect.height;
    if (size <= 0) return;

    const ratioAt = (ev: PointerEvent) =>
      clamp(
        ((orientation === "x" ? ev.clientX - rect.left : ev.clientY - rect.top) || 0) / size,
      );

    // 拖动期间禁掉文本选择，松手（含取消）时还原
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    let moved = false;
    let lastRatio = clamp(ratioAt(e.nativeEvent));

    const onMove = (ev: PointerEvent) => {
      moved = true;
      lastRatio = ratioAt(ev);
      onPreview(lastRatio);
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      document.body.style.userSelect = prevSelect;
      if (!moved) return; // 只是点了一下，没有拖动，不必写库
      // pointercancel 也按最后位置提交：调用方靠 onCommit 清掉拖拽预览态，
      // 不提交的话预览会一直停在松手前的位置，且永远不落库
      onPreview(lastRatio);
      onCommit(lastRatio);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const back = orientation === "x" ? "ArrowLeft" : "ArrowUp";
    const forward = orientation === "x" ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    const current = clamp(value ?? (min + max) / 2);
    const next = clamp(current + (e.key === forward ? KEY_STEP : -KEY_STEP));
    onPreview(next);
    if (keyTimer.current) window.clearTimeout(keyTimer.current);
    keyTimer.current = window.setTimeout(() => {
      keyTimer.current = null;
      onCommit(next);
    }, COMMIT_DELAY_MS);
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      aria-valuenow={Math.round((value ?? (min + max) / 2) * 100)}
      tabIndex={0}
      className={className}
      onPointerDown={startDrag}
      onKeyDown={onKeyDown}
    />
  );
}
