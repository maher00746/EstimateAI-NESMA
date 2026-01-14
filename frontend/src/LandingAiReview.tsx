import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

type NormalizedBox = { left: number; top: number; right: number; bottom: number };
type LandingAiChunk = {
  id?: string;
  type?: string;
  markdown?: string;
  grounding?: { box?: NormalizedBox; page?: number };
  page?: number;
};

function looksLikeImageChunk(type: string | undefined): boolean {
  const t = String(type || "").toLowerCase();
  return t === "figure" || t === "image" || t.includes("figure") || t.includes("image");
}

function cssEscape(value: string): string {
  // CSS.escape isn't available in all environments.
  // This is a minimal safe-ish fallback for ids we control (UUIDs).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const esc = (globalThis as any)?.CSS?.escape;
  if (typeof esc === "function") return esc(value);
  return value.replace(/[^a-zA-Z0-9_\-]/g, "\\$&");
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function normalizeBox(box?: Partial<NormalizedBox> | null): NormalizedBox | null {
  if (!box) return null;
  const left = clamp01(Number(box.left));
  const top = clamp01(Number(box.top));
  const right = clamp01(Number(box.right));
  const bottom = clamp01(Number(box.bottom));
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

function extractChunks(raw: unknown): LandingAiChunk[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as any;

  const direct =
    (Array.isArray(root.chunks) && root.chunks) ||
    (Array.isArray(root?.data?.chunks) && root.data.chunks) ||
    (Array.isArray(root?.result?.chunks) && root.result.chunks) ||
    null;
  if (direct) return direct as LandingAiChunk[];

  // Fallback: shallow search for "chunks" key somewhere inside.
  const queue: any[] = [root];
  const seen = new Set<any>();
  let scanned = 0;
  while (queue.length && scanned < 5000) {
    const cur = queue.shift();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    scanned++;

    if (Array.isArray(cur.chunks)) return cur.chunks as LandingAiChunk[];
    for (const v of Object.values(cur)) {
      if (!v) continue;
      if (typeof v === "object") queue.push(v);
    }
  }

  return [];
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function getChunkPageIndex(chunk: LandingAiChunk): number {
  const p = Number(chunk?.grounding?.page ?? chunk?.page ?? 0);
  return Number.isFinite(p) ? p : 0;
}

function getChunkBoxForSort(chunk: LandingAiChunk): { top: number; left: number } {
  const b = normalizeBox(chunk?.grounding?.box as any);
  if (!b) return { top: 1, left: 1 };
  return { top: b.top, left: b.left };
}

export type LandingAiReviewProps = {
  pdfUrl: string;
  landingAiRaw: unknown;
  fileName?: string;
  onBack?: () => void;
  headerActions?: ReactNode;
  /** Override header left content. Use null to hide. */
  headerLeft?: ReactNode | null;
  /** Reduce header spacing (more room for panes) */
  headerCompact?: boolean;
  /** Initial split between PDF (left) and right pane, in percent */
  initialSplitPct?: number;
  /** If provided, overrides the default markdown pane */
  rightPane?: ReactNode;
  /** Controlled selection (optional) */
  selectedChunkId?: string;
  hoveredChunkId?: string;
  onSelectedChunkIdChange?: (id: string) => void;
  onHoveredChunkIdChange?: (id: string) => void;
};

function PdfPageWithOverlay(props: {
  pageIndex: number; // 0-based
  width: number;
  overlayChunks: LandingAiChunk[];
  selectedChunkId: string;
  hoveredChunkId: string;
  overlayEnabled?: boolean;
  labelById: Record<string, string>;
  onSelectChunk: (chunk: LandingAiChunk) => void;
  pageContainerRef?: (el: HTMLDivElement | null) => void;
}) {
  const { pageIndex, width, overlayChunks, selectedChunkId, hoveredChunkId, overlayEnabled = false, labelById, onSelectChunk, pageContainerRef } = props;
  const pageWrapperRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({ width: 1, height: 1 });

  const measureCanvas = () => {
    const root = pageWrapperRef.current;
    const canvas = root?.querySelector(".react-pdf__Page__canvas") as HTMLCanvasElement | null;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    setCanvasSize({ width: Math.max(1, Math.floor(rect.width)), height: Math.max(1, Math.floor(rect.height)) });
  };

  // Draw boxes for all grounded chunks so users can link any region (figure/text/table/etc) back to extracted items.
  const overlay = useMemo(() => overlayChunks, [overlayChunks]);

  const overlayWidth = canvasSize.width > 1 ? canvasSize.width : width;
  const overlayHeight = canvasSize.height > 1 ? canvasSize.height : Math.floor(width * 1.3);

  const handleDoubleClickOnPage = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!overlayChunks.length) return;
    const root = pageWrapperRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (px < 0 || py < 0 || px > rect.width || py > rect.height) return;

    const nx = overlayWidth > 0 ? px / overlayWidth : 0;
    const ny = overlayHeight > 0 ? py / overlayHeight : 0;

    // Pick the smallest box that contains the click (helps when boxes overlap).
    let best: { chunk: LandingAiChunk; area: number } | null = null;
    for (const c of overlayChunks) {
      const box = normalizeBox(c.grounding?.box as any);
      if (!box || !c.id) continue;
      const inside = nx >= box.left && nx <= box.right && ny >= box.top && ny <= box.bottom;
      if (!inside) continue;
      const area = (box.right - box.left) * (box.bottom - box.top);
      if (!best || area < best.area) best = { chunk: c, area };
    }
    if (best) onSelectChunk(best.chunk);
  };

  return (
    <div
      ref={(el) => {
        pageWrapperRef.current = el;
        pageContainerRef?.(el);
      }}
      onDoubleClick={handleDoubleClickOnPage}
      style={{
        position: "relative",
        width: "fit-content",
        margin: "0 auto 1rem",
      }}
    >
      <Page
        pageNumber={pageIndex + 1}
        width={width}
        renderTextLayer={false}
        renderAnnotationLayer={false}
        loading={<div style={{ color: "rgba(227,233,255,0.75)" }}>Rendering page…</div>}
        onRenderSuccess={() => {
          requestAnimationFrame(() => measureCanvas());
        }}
      />

      <div style={{ position: "absolute", inset: 0 }}>
        {!overlayEnabled
          ? null
          : overlay.map((c) => {
          const box = normalizeBox(c.grounding?.box as any);
          if (!box || !c.id) return null;
          const isSelected = c.id === selectedChunkId;
          const isHovered = c.id === hoveredChunkId;
          const isActive = isSelected || isHovered;
          // Only render the selected box when enabled (no "always-on" overlays).
          if (!isSelected) return null;
          const x = box.left * overlayWidth;
          const y = box.top * overlayHeight;
          const w = (box.right - box.left) * overlayWidth;
          const h = (box.bottom - box.top) * overlayHeight;
          const label = labelById[c.id] || (c.type ? String(c.type) : c.id.slice(0, 8));
          return (
            <div
              key={c.id}
              data-overlay-id={c.id}
              title={c.id}
              style={{
                position: "absolute",
                left: x,
                top: y,
                width: w,
                height: h,
                border: isActive ? "2px solid #ff3bd4" : "2px solid rgba(255,59,212,0.40)",
                background: isActive ? "rgba(255,59,212,0.10)" : "rgba(255,59,212,0.05)",
                boxShadow: isActive ? "0 0 0 3px rgba(255,59,212,0.14)" : "none",
                pointerEvents: "none",
                borderRadius: 6,
              }}
            >
              {(isActive || isHovered) && (
                <div
                  style={{
                    position: "absolute",
                    top: -14,
                    left: -2,
                    background: "#ff3bd4",
                    color: "#0b1020",
                    fontWeight: 700,
                    fontSize: 12,
                    padding: "2px 8px",
                    borderRadius: 6,
                    letterSpacing: "0.2px",
                  }}
                >
                  {label}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function LandingAiReview(props: LandingAiReviewProps) {
  const { pdfUrl, landingAiRaw, fileName, onBack, headerActions, rightPane, headerLeft, headerCompact } = props;

  const chunks = useMemo(() => {
    const list = extractChunks(landingAiRaw);
    return list
      .map((c) => {
        const page = Number(c?.grounding?.page ?? c?.page ?? 0);
        const id = typeof c?.id === "string" ? c.id : "";
        return {
          ...c,
          id,
          page: Number.isFinite(page) ? page : 0,
          grounding: { ...c.grounding, box: normalizeBox(c?.grounding?.box) ?? undefined },
        };
      })
      .filter((c) => !!c.id && !!c.grounding?.box);
  }, [landingAiRaw]);

  const [numPages, setNumPages] = useState(0);
  const [selectedChunkIdState, setSelectedChunkIdState] = useState<string>("");
  const [hoveredChunkIdState, setHoveredChunkIdState] = useState<string>("");
  const selectedChunkId = props.selectedChunkId ?? selectedChunkIdState;
  const hoveredChunkId = props.hoveredChunkId ?? hoveredChunkIdState;

  const setSelectedChunkId = (id: string) => {
    props.onSelectedChunkIdChange?.(id);
    if (props.selectedChunkId === undefined) setSelectedChunkIdState(id);
  };
  const setHoveredChunkId = (id: string) => {
    props.onHoveredChunkIdChange?.(id);
    if (props.hoveredChunkId === undefined) setHoveredChunkIdState(id);
  };
  const [leftPaneWidth, setLeftPaneWidth] = useState(800);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const pdfPaneRef = useRef<HTMLDivElement>(null);
  const mdPaneRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const [splitPct, setSplitPct] = useState(() => {
    const n = Number(props.initialSplitPct);
    return Number.isFinite(n) ? clamp(n, 25, 75) : 50;
  }); // PDF vs right pane
  const [isDragging, setIsDragging] = useState(false);
  const [pdfZoom, setPdfZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [pdfOverlayEnabled, setPdfOverlayEnabled] = useState(false);

  const pdfZoomRef = useRef(1);
  const pendingWheelZoomRef = useRef<{
    x: number;
    y: number;
    padLeft: number;
    padTop: number;
    scrollLeft: number;
    scrollTop: number;
    oldZoom: number;
    newZoom: number;
  } | null>(null);
  const panRef = useRef<{
    active: boolean;
    started: boolean;
    startX: number;
    startY: number;
    startScrollLeft: number;
    startScrollTop: number;
  }>({ active: false, started: false, startX: 0, startY: 0, startScrollLeft: 0, startScrollTop: 0 });

  const pendingZoomScrollRef = useRef<{ left: number; top: number; triesLeft: number } | null>(null);

  const selectedChunk = useMemo(
    () => (selectedChunkId ? chunks.find((c) => c.id === selectedChunkId) : undefined),
    [chunks, selectedChunkId]
  );

  const labelById = useMemo(() => {
    // Build stable labels like "5.figure" across the whole PDF (sorted by page, then box position).
    const result: Record<string, string> = {};
    const sortedAll = [...chunks]
      .filter((c) => !!c.id)
      .sort((a, b) => {
        const pa = getChunkPageIndex(a);
        const pb = getChunkPageIndex(b);
        if (pa !== pb) return pa - pb;
        const aa = getChunkBoxForSort(a);
        const bb = getChunkBoxForSort(b);
        return aa.top !== bb.top ? aa.top - bb.top : aa.left - bb.left;
      });

    // Counters per label group (figure/text/table/etc), global across the full PDF.
    const counters: Record<string, number> = {};
    const groupOf = (c: LandingAiChunk) => {
      if (looksLikeImageChunk(c.type)) return "figure";
      const t = String(c.type || "text").toLowerCase().trim();
      return t || "text";
    };

    sortedAll.forEach((c) => {
      const id = String(c.id || "");
      if (!id) return;
      const group = groupOf(c);
      counters[group] = (counters[group] ?? 0) + 1;
      result[id] = `${counters[group]}.${group}`;
    });

    return result;
  }, [chunks]);

  const combinedMarkdown = useMemo(() => {
    if (!chunks.length) return "";
    // Wrap each chunk in a div with id, so box-click can scroll to it.
    return chunks
      .map((c) => {
        const id = String(c.id || "");
        const body = String(c.markdown || "").trim();
        const label = (labelById[id] || (c.type ? String(c.type) : id.slice(0, 8))).replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<div id="${id}" data-chunk-id="${id}" style="position:relative; padding:12px 12px 10px; margin:0 0 12px; border:1px solid rgba(255,255,255,0.10); border-radius:12px; background:rgba(255,255,255,0.03);">
  <div data-chunk-label="1" style="display:none; position:absolute; top:-14px; left:-2px; background:#ff3bd4; color:#0b1020; font-weight:700; font-size:12px; padding:2px 8px; border-radius:6px; letter-spacing:0.2px;">${label}</div>
  ${body || "*[empty]*"}
</div>`;
      })
      .join("\n\n");
  }, [chunks, labelById]);

  useEffect(() => {
    if (!selectedChunkId) return;
    const root = mdPaneRef.current;
    if (!root) return;
    // If multiple rows/items share the same id, scroll to the *first* match (DOM order).
    // Do this via attribute comparison (more reliable than CSS escaping inside selectors).
    let first: HTMLElement | null = null;

    const byData = root.querySelectorAll<HTMLElement>("[data-chunk-id]");
    for (const el of Array.from(byData)) {
      if (el.getAttribute("data-chunk-id") === selectedChunkId) {
        first = el;
        break;
      }
    }

    if (!first) {
      const byId = root.querySelectorAll<HTMLElement>("[id]");
      for (const el of Array.from(byId)) {
        if (el.id === selectedChunkId) {
          first = el;
          break;
        }
      }
    }

    first?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selectedChunkId]);

  useEffect(() => {
    const el = selectedChunk ? pageRefs.current[getChunkPageIndex(selectedChunk)] : null;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedChunk]);

  useEffect(() => {
    if (!selectedChunkId) return;
    const root = pdfPaneRef.current;
    if (!root) return;
    const overlayEl = root.querySelector(`[data-overlay-id="${cssEscape(selectedChunkId)}"]`) as HTMLElement | null;
    overlayEl?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  }, [selectedChunkId]);

  useEffect(() => {
    const root = mdPaneRef.current;
    if (!root) return;
    const reset = (el: HTMLElement) => {
      el.style.outline = "";
      el.style.background = "rgba(255,255,255,0.03)";
      el.style.borderColor = "rgba(255,255,255,0.10)";
      const label = el.querySelector("[data-chunk-label='1']") as HTMLElement | null;
      if (label) label.style.display = "none";
    };
    const activate = (el: HTMLElement) => {
      el.style.outline = "2px solid rgba(255,59,212,0.75)";
      el.style.background = "rgba(255,59,212,0.10)";
      el.style.borderColor = "rgba(255,59,212,0.45)";
      const label = el.querySelector("[data-chunk-label='1']") as HTMLElement | null;
      if (label) label.style.display = "inline-block";
    };

    // Reset previous active nodes quickly.
    root.querySelectorAll("[data-active-chunk='1'], [data-hover-chunk='1']").forEach((node) => {
      const el = node as HTMLElement;
      el.removeAttribute("data-active-chunk");
      el.removeAttribute("data-hover-chunk");
      reset(el);
    });

    const selectedEl = selectedChunkId ? (root.querySelector(`#${cssEscape(selectedChunkId)}`) as HTMLElement | null) : null;
    const hoveredEl = hoveredChunkId ? (root.querySelector(`#${cssEscape(hoveredChunkId)}`) as HTMLElement | null) : null;

    if (hoveredEl && hoveredChunkId !== selectedChunkId) {
      hoveredEl.setAttribute("data-hover-chunk", "1");
      activate(hoveredEl);
    }
    if (selectedEl) {
      selectedEl.setAttribute("data-active-chunk", "1");
      activate(selectedEl);
    }
  }, [hoveredChunkId, selectedChunkId]);

  useEffect(() => {
    const el = pdfPaneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setLeftPaneWidth(Math.max(320, Math.floor(rect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    pdfZoomRef.current = pdfZoom;
  }, [pdfZoom]);

  // Wheel zoom inside PDF pane (disable wheel scrolling).
  useEffect(() => {
    const el = pdfPaneRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();

      const direction = e.deltaY < 0 ? 1 : -1;
      const step = 1.12;
      const oldZoom = pdfZoomRef.current;
      const next = direction > 0 ? oldZoom * step : oldZoom / step;
      const newZoom = clamp(next, 0.5, 3.5);
      if (Math.abs(newZoom - oldZoom) < 0.0001) return;

      // Requirement: if user zooms in/out, hide any PDF selection box.
      setPdfOverlayEnabled(false);

      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const padLeft = Number.parseFloat(style.paddingLeft || "0") || 0;
      const padTop = Number.parseFloat(style.paddingTop || "0") || 0;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      pendingWheelZoomRef.current = {
        x,
        y,
        padLeft,
        padTop,
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
        oldZoom,
        newZoom,
      };

      setPdfZoom(newZoom);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel as any);
  }, []);

  // Keep the point under cursor fixed while zooming.
  useLayoutEffect(() => {
    const el = pdfPaneRef.current;
    const pending = pendingWheelZoomRef.current;
    if (!el || !pending) return;

    pendingWheelZoomRef.current = null;
    const { x, y, padLeft, padTop, scrollLeft, scrollTop, oldZoom, newZoom } = pending;
    const localX = x - padLeft;
    const localY = y - padTop;
    const contentX = (scrollLeft + localX) / oldZoom;
    const contentY = (scrollTop + localY) / oldZoom;
    const targetLeft = contentX * newZoom - localX;
    const targetTop = contentY * newZoom - localY;

    // Apply multiple times to avoid early clamping while the PDF pages re-render at the new size.
    pendingZoomScrollRef.current = { left: Math.max(0, targetLeft), top: Math.max(0, targetTop), triesLeft: 6 };
    const tick = () => {
      const t = pendingZoomScrollRef.current;
      if (!t || !pdfPaneRef.current) return;
      const root = pdfPaneRef.current;
      root.scrollLeft = t.left;
      root.scrollTop = t.top;
      t.triesLeft -= 1;
      if (t.triesLeft <= 0) {
        pendingZoomScrollRef.current = null;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [pdfZoom]);

  // Drag-to-pan: only starts after a small movement threshold so double-click doesn't "grab".
  useEffect(() => {
    if (!isPanning) return;
    // While panning, don't keep applying zoom anchoring attempts.
    pendingZoomScrollRef.current = null;
  }, [isPanning]);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      const rect = splitContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const pct = (x / rect.width) * 100;
      setSplitPct(clamp(pct, 25, 75));
    };
    const onUp = () => setIsDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging]);

  const handleSelectChunk = (chunk: LandingAiChunk) => {
    if (chunk.id) {
      setSelectedChunkId(chunk.id);
      setPdfOverlayEnabled(true);
    }
  };
  const handleHoverChunk = (id: string) => {
    if (hoveredChunkId !== id) setHoveredChunkId(id);
  };

  const basePdfWidth = clamp(Math.floor(leftPaneWidth - 24), 420, 1100);
  const pdfWidth = Math.floor(basePdfWidth * pdfZoom);

  const defaultHeaderLeft = (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <h2 className="review-title" style={{ marginBottom: 4 }}>LandingAI Visual Review</h2>
      <div style={{ color: "rgba(227,233,255,0.75)", fontSize: "0.9rem" }}>
        {fileName ? fileName : "Drawings"} • {numPages || "—"} page(s) • {chunks.length} grounded chunk(s)
      </div>
    </div>
  );
  const headerLeftNode = headerLeft === undefined ? defaultHeaderLeft : headerLeft;

  return (
    <section
      className="panel"
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        marginBottom: 0, // prevent outer page scroll
        overflow: "hidden", // panes handle their own scrolling
      }}
    >
      <div
        className="panel__header"
        style={{
          gap: "0.75rem",
          marginBottom: headerCompact ? "0.5rem" : undefined,
          justifyContent: headerLeftNode ? "space-between" : "flex-end",
        }}
      >
        {headerLeftNode}
        <div style={{ marginLeft: "auto", display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {headerActions}
          {onBack && (
            <button type="button" className="btn-secondary" onClick={onBack}>
              Back
            </button>
          )}
        </div>
      </div>

      <div
        ref={splitContainerRef}
        style={{
          display: "flex",
          gap: "1rem",
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* Left: PDF */}
        <div
          ref={pdfPaneRef}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            const root = pdfPaneRef.current;
            if (!root) return;
            panRef.current = {
              active: true,
              started: false,
              startX: e.clientX,
              startY: e.clientY,
              startScrollLeft: root.scrollLeft,
              startScrollTop: root.scrollTop,
            };

            const onMove = (ev: MouseEvent) => {
              const r = pdfPaneRef.current;
              if (!r || !panRef.current.active) return;
              const dx = ev.clientX - panRef.current.startX;
              const dy = ev.clientY - panRef.current.startY;
              const moved = Math.hypot(dx, dy);
              if (!panRef.current.started) {
                if (moved < 4) return; // threshold
                panRef.current.started = true;
                setIsPanning(true);
              }
              ev.preventDefault();
              r.scrollLeft = panRef.current.startScrollLeft - dx;
              r.scrollTop = panRef.current.startScrollTop - dy;
            };
            const onUp = () => {
              panRef.current.active = false;
              panRef.current.started = false;
              setIsPanning(false);
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };

            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
          style={{
            position: "relative",
            background: "rgba(0,0,0,0.25)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 14,
            padding: "0.75rem",
            overflowY: "auto",
            overflowX: "auto",
            flex: `0 0 calc(${splitPct}% - 0.5rem)`,
            minWidth: 320,
            cursor: isPanning ? "grabbing" : pdfZoom > 1 ? "grab" : "default",
            userSelect: isPanning ? "none" : undefined,
          }}
        >
          <Document
            file={pdfUrl}
            onLoadSuccess={(doc) => {
              setNumPages(doc.numPages);
            }}
            loading={<div style={{ color: "rgba(227,233,255,0.75)" }}>Loading PDF…</div>}
            error={<div style={{ color: "#ffb4b4" }}>Failed to load PDF.</div>}
          >
            <div style={{ paddingTop: "0.25rem" }}>
              {Array.from({ length: numPages || 0 }, (_, i) => {
                const pageChunks = chunks.filter((c) => getChunkPageIndex(c) === i);
                return (
                  <PdfPageWithOverlay
                    key={`page-${i}`}
                    pageIndex={i}
                    width={pdfWidth}
                    overlayChunks={pageChunks}
                    selectedChunkId={selectedChunkId}
                    hoveredChunkId={hoveredChunkId}
                    overlayEnabled={pdfOverlayEnabled}
                    labelById={labelById}
                    onSelectChunk={handleSelectChunk}
                    pageContainerRef={(el) => {
                      pageRefs.current[i] = el;
                    }}
                  />
                );
              })}
            </div>
          </Document>

        </div>

        {/* Draggable splitter */}
        <div
          onMouseDown={() => setIsDragging(true)}
          style={{
            width: 10,
            cursor: "col-resize",
            borderRadius: 999,
            background: isDragging ? "rgba(76,110,245,0.45)" : "rgba(255,255,255,0.08)",
            alignSelf: "stretch",
            flex: "0 0 10px",
            boxShadow: isDragging ? "0 0 0 3px rgba(76,110,245,0.15)" : "none",
          }}
          title="Drag to resize"
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={splitPct}
        />

        {/* Right: Markdown (or custom pane) */}
        <div
          ref={mdPaneRef}
          style={{
            background: "rgba(0,0,0,0.25)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 14,
            padding: "0.75rem",
            overflow: rightPane ? "hidden" : "auto",
            minHeight: 0,
            flex: `1 1 calc(${100 - splitPct}% - 0.5rem)`,
            minWidth: 320,
            fontSize: "0.9rem",
          }}
          {...(rightPane
            ? {}
            : {
              onMouseMove: (e: ReactMouseEvent<HTMLDivElement>) => {
                const target = e.target as HTMLElement | null;
                if (!target) return;
                const holder = target.closest("[data-chunk-id]") as HTMLElement | null;
                const id = holder?.getAttribute("data-chunk-id") || holder?.id || "";
                if (id) handleHoverChunk(id);
              },
              onMouseLeave: () => setHoveredChunkId(""),
              onClick: (e: ReactMouseEvent<HTMLDivElement>) => {
                const target = e.target as HTMLElement | null;
                if (!target) return;
                const holder = target.closest("[data-chunk-id]") as HTMLElement | null;
                const id = holder?.getAttribute("data-chunk-id") || holder?.id || "";
                if (!id) return;
                const found = chunks.find((c) => c.id === id);
                if (found) handleSelectChunk(found);
              },
            })}
        >
          {rightPane ? (
            rightPane
          ) : chunks.length === 0 ? (
            <div style={{ color: "rgba(227,233,255,0.75)" }}>
              No grounded chunks were found in the LandingAI response.
            </div>
          ) : (
            <div style={{ color: "#e3e9ff", lineHeight: 1.5 }}>
              <ReactMarkdown rehypePlugins={[rehypeRaw]}>
                {combinedMarkdown}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

