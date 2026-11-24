"use client";

/**
 * 抽屉挤压工作台：**单层**整体模糊渐变，不做旧快照叠加。
 *
 * 之前的双层快照会透出透明卡片底色，看起来像文字残影；现在改成：
 * - 点击首帧就把工作台锁到最终宽度，直接画最终版式（不出现未压缩帧）；
 * - 整个工作台网格（卡片底色、文字、月历、任务池）作为一个合成层，
 *   从 35% 透明度 + 6px 模糊，600ms 内渐变到 100% + 清晰；
 * - 外层 padding 继续做压缩动画，工作台宽度不变，只被外层裁切；
 * - 渐变结束正好就是最终清晰版式，不留中间未压缩状态，也不会平移到某个地方停住。
 *
 * 拖动宽度不传 targetPadding：直接操作保持实时跟随，不做首尾冻结。
 */
let activeCleanup: (() => void) | null = null;

/**
 * 常驻栏开合后工作台的最终宽度（纯计算，便于测试）：
 * - 正文可用宽 = 当前正文宽 - 左右 padding + 常驻栏释放的宽度；
 * - 再受 page-wide 的 max-width 封顶。
 * 常驻栏变窄（收起）释放宽度为正；变宽（展开）为负。
 */
export function railFinalShellWidth({
  contentWidth,
  paddingX,
  railNow,
  targetRailWidth,
  maxWidth,
}: {
  contentWidth: number;
  paddingX: number;
  railNow: number;
  targetRailWidth: number;
  /** NaN = 没有 max-width 限制 */
  maxWidth: number;
}): number {
  const available = contentWidth - paddingX + (railNow - targetRailWidth);
  return Number.isFinite(maxWidth) ? Math.min(maxWidth, available) : available;
}

/**
 * 左侧常驻栏收起/展开：**只有真正挤占/释放了工作台宽度**时才做首尾帧冻结 + 模糊。
 *
 * 宽屏下工作台被 90rem 的 page-wide 封顶，开合常驻栏吃掉的只是居中留白，shell 宽度
 * 不变——这时不做任何冻结或模糊，只让常驻栏自己的 width 过渡把工作台平移过去。
 * 宽度确实变化时，点击帧直接锁到最终宽度（只画首尾两帧），再用 500ms 模糊连接。
 *
 * 模糊只作用于工作台；其它页面完全没有模糊动画（直接不处理）。
 */
export function beginRailPaintBlur(nextCollapsed: boolean): void {
  if (typeof document === "undefined") return;
  if (!window.matchMedia("(min-width: 1024px)").matches) return;

  const shell = document.querySelector<HTMLElement>(".dashboard-shell");
  const rail = document.querySelector<HTMLElement>(".app-rail");
  const appContent = document.querySelector<HTMLElement>(".app-content");
  // 非工作台页面：常驻栏开合只走 CSS 过渡，不模糊
  if (!shell || !rail || !appContent) return;

  // 常规栏宽 304px / 收起 30px（见 dashboard.css）。收起释放 274px，展开占用 274px。
  const targetRailWidth = nextCollapsed ? 30 : 304;
  const railNow = rail.getBoundingClientRect().width;
  const rect = appContent.getBoundingClientRect();
  const style = getComputedStyle(appContent);
  const padX =
    (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const maxWidth = parseFloat(getComputedStyle(shell.parentElement!).maxWidth);
  const finalShellWidth = railFinalShellWidth({
    contentWidth: rect.width,
    paddingX: padX,
    railNow,
    targetRailWidth,
    maxWidth,
  });

  // 宽度没变（宽屏封顶 / 居中留白吸收）：没有重排可遮掩，只平移，不冻结、不模糊。
  if (Math.abs(finalShellWidth - shell.getBoundingClientRect().width) < 1) return;
  if (finalShellWidth <= 0) return;

  beginDashboardPaintFreeze({ targetWidth: finalShellWidth });
}

const FADE_MS = 500;
const CLEANUP_MS = FADE_MS + 80;

type ShellPrev = {
  width: string;
  height: string;
  maxWidth: string;
  opacity: string;
  transition: string;
  transform: string;
  willChange: string;
};

type GridPrev = {
  opacity: string;
  filter: string;
  transform: string;
  willChange: string;
};

export function beginDashboardPaintFreeze(opts: {
  /** 挤压结束后的最终右侧 padding（px）；不传 = 拖动中，不做首尾帧冻结 */
  targetPadding?: number;
  /** 直接指定工作台最终宽度（左侧常驻栏开合用） */
  targetWidth?: number;
} = {}): () => void {
  if (typeof document === "undefined") return () => {};

  const widgets = Array.from(
    document.querySelectorAll<HTMLElement>(".dashboard-widget"),
  );
  const shell = document.querySelector<HTMLElement>(".dashboard-shell");
  if (widgets.length === 0 || !shell) return () => {};

  activeCleanup?.();

  const root = document.documentElement;
  root.dataset.panelSqueezing = "1";

  const wrapper = document.querySelector<HTMLElement>(".assistant-shell-push");
  const grid = shell.querySelector<HTMLElement>(".dashboard-grid");
  const shrinking = opts.targetPadding !== undefined || opts.targetWidth !== undefined;

  let shellPrev: ShellPrev | null = null;
  let gridPrev: GridPrev | null = null;

  if (shrinking) {
    let finalWidth = opts.targetWidth ?? 0;
    if (opts.targetWidth === undefined && wrapper && opts.targetPadding !== undefined) {
      // 最终宽度 = 当前内容宽度 + padding 差；不临时改 padding、不强制布局
      const currentPadding = parseFloat(getComputedStyle(wrapper).paddingRight) || 0;
      const appContent = document.querySelector<HTMLElement>(".app-content");
      finalWidth = shell.getBoundingClientRect().width + currentPadding - opts.targetPadding;
      if (appContent) {
        const rect = appContent.getBoundingClientRect();
        const style = getComputedStyle(appContent);
        const padX =
          (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        const available = rect.width - padX + currentPadding - opts.targetPadding;
        const maxWidth = parseFloat(getComputedStyle(shell.parentElement!).maxWidth);
        finalWidth = Number.isFinite(maxWidth) ? Math.min(maxWidth, available) : available;
      }
    }

    if (finalWidth > 0) {
      root.dataset.dashboardFreezing = "1";
      shellPrev = {
        width: shell.style.width,
        height: shell.style.height,
        maxWidth: shell.style.maxWidth,
        opacity: shell.style.opacity,
        transition: shell.style.transition,
        transform: shell.style.transform,
        willChange: shell.style.willChange,
      };
      // 点击帧直接切最终宽度：首帧就是最终版式，没有"未压缩网格"中间态
      shell.style.transition = "none";
      shell.style.width = `${finalWidth}px`;
      shell.style.maxWidth = "none";

      if (grid) {
        gridPrev = {
          opacity: grid.style.opacity,
          filter: grid.style.filter,
          transform: grid.style.transform,
          willChange: grid.style.willChange,
        };
        // 整个网格一个合成层：卡片底色 + 文字 + 月历 + 任务池一起模糊渐变
        grid.style.transform = "translateZ(0)";
        grid.style.willChange = "opacity, filter";
        grid.classList.add("dashboard-squeeze-blur");
      } else {
        shell.classList.add("dashboard-squeeze-blur");
      }
    }
  }

  const mark = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const visible =
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth;
    el.dataset.panelOffscreen = visible ? "0" : "1";
  };
  for (const el of widgets) mark(el);

  let observer: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          (entry.target as HTMLElement).dataset.panelOffscreen =
            entry.isIntersecting ? "0" : "1";
        }
      },
      { threshold: 0 },
    );
    for (const el of widgets) observer.observe(el);
  }

  let cleared = false;
  const cleanup = () => {
    if (cleared) return;
    cleared = true;
    observer?.disconnect();
    for (const el of widgets) delete el.dataset.panelOffscreen;
    delete root.dataset.panelSqueezing;

    if (grid && gridPrev) {
      grid.classList.remove("dashboard-squeeze-blur");
      grid.style.opacity = gridPrev.opacity;
      grid.style.filter = gridPrev.filter;
      grid.style.transform = gridPrev.transform;
      grid.style.willChange = gridPrev.willChange;
      gridPrev = null;
    } else {
      shell.classList.remove("dashboard-squeeze-blur");
    }

    if (shellPrev) {
      delete root.dataset.dashboardFreezing;
      shell.style.width = shellPrev.width;
      shell.style.height = shellPrev.height;
      shell.style.maxWidth = shellPrev.maxWidth;
      shell.style.opacity = shellPrev.opacity;
      shell.style.transition = shellPrev.transition;
      shell.style.transform = shellPrev.transform;
      shell.style.willChange = shellPrev.willChange;
      shellPrev = null;
    }

    if (activeCleanup === cleanup) activeCleanup = null;
  };
  activeCleanup = cleanup;
  const timer = window.setTimeout(cleanup, CLEANUP_MS);
  return () => {
    window.clearTimeout(timer);
    cleanup();
  };
}
