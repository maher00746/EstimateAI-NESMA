import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import type {
  ExtractedItem,
  BoqComparisonRow,
  EstimateStep,
  EstimateDraftMeta,
  DraftEstimateState,
  ItemSource,
  PriceMapping,
  PriceListRow,
  InstallationInputs,
} from "./types";
import {
  extractEstimates,
  extractBoq,
  compareLists,
  enrichBoqItems,
  getExtractJob,
  listDrafts,
  saveDraft,
  getDraft,
  priceMap,
  fetchPriceList,
  fetchDrawingPrompt,
  updateDrawingPrompt,
} from "./services/api";
import { useAuth } from "./contexts/AuthContext";
import LandingAiReview from "./LandingAiReview";
import { v4 as uuidv4 } from "uuid";

const COMPANY_LOGO_URL = "/company.png";
const COMPANY_NAME = "XYZ";
const CONTACT_NAME = "-";

const ESTIMATE_STEPS: Array<{ id: EstimateStep; label: string; description: string }> = [
  { id: "upload", label: "Upload", description: "Drawings & BOQ" },
  { id: "review", label: "Review", description: "Validate extraction" },
  { id: "compare", label: "Compare", description: "BOQ vs drawings" },
  { id: "finalize", label: "Editing", description: "Manual Preparation" },
  { id: "pricing", label: "Pricing", description: "Review prices" },
  { id: "estimate", label: "Finalize", description: "Assemble estimate" },
];

const STEP_ORDER: Record<EstimateStep, number> = {
  upload: 0,
  review: 1,
  compare: 2,
  finalize: 3,
  pricing: 4,
  estimate: 5,
};

type AppPage = "new-estimate" | "drafts" | "drawing-prompt" | "landingai-review";
type PricingAccordionId = "items" | "electrical" | "installation" | "venue";

const PRICING_SECTIONS: Array<{ id: PricingAccordionId; label: string }> = [
  { id: "items", label: "Items" },
  { id: "electrical", label: "Electrical" },
  { id: "installation", label: "Installation" },
  { id: "venue", label: "Venue services" },
];

const DRAWING_SECTIONS: Array<{ code: string; title: string; keywords?: string[] }> = [
  { code: "A", title: "Flooring", keywords: ["floor"] },
  { code: "B", title: "Wall Structure & Ceiling", keywords: ["wall", "ceiling"] },
  { code: "C", title: "Custom-made Items", keywords: ["custom", "joinery", "carpentry"] },
  { code: "D", title: "Graphics", keywords: ["graphic", "logo"] },
  { code: "E", title: "Furniture", keywords: ["furniture", "rental"] },
  { code: "F", title: "AV", keywords: ["av", "audio", "visual", "tv", "screen"] },
];

const DRAWING_SECTION_CODE_SET = new Set(DRAWING_SECTIONS.map(section => section.code));

function renderCell(value: string | undefined) {
  const text = value && value.trim() ? value : "—";
  return <span className="cell-text" title={text}>{text}</span>;
}

function matchesDescription(item: ExtractedItem, query: string) {
  const search = query.trim().toLowerCase();
  if (!search) return true;
  const haystack = [
    item.landing_ai_id,
    item.description,
    item.full_description,
    item.finishes,
    item.section_code,
    item.section_name,
    item.item_number,
    item.item_no,
    item.dimensions,
    item.size,
  ]
    .filter(Boolean)
    .map(value => value?.toString().toLowerCase())
    .join(" ");
  return haystack.includes(search);
}

function resolveSectionCode(item: ExtractedItem): string | undefined {
  const candidates = [
    item.section_code,
    item.section_name,
    item.item_no,
    item.item_number,
    item.full_description,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = candidate.toString().trim();
    if (!normalized) continue;
    const firstChar = normalized.charAt(0).toUpperCase();
    if (DRAWING_SECTION_CODE_SET.has(firstChar)) return firstChar;

    const lower = normalized.toLowerCase();
    const match = DRAWING_SECTIONS.find(section =>
      section.keywords?.some(keyword => lower.includes(keyword))
    );
    if (match) return match.code;
  }

  return undefined;
}

function buildFinalizeEntry<S extends ItemSource>(item: ExtractedItem, source: S, fallback?: ExtractedItem): { item: ExtractedItem; source: S } {
  if (source === "boq") {
    return { item: { ...item }, source };
  }
  const normalizedSize = item.size ?? fallback?.size;
  const normalizedCapacity = item.capacity ?? fallback?.capacity;
  const normalizedItem: ExtractedItem = { ...item };
  if (normalizedSize) normalizedItem.size = normalizedSize;
  if (normalizedCapacity) normalizedItem.capacity = normalizedCapacity;
  return { item: normalizedItem, source };
}

type ColumnResizeApi = {
  getStyle: (index: number) => React.CSSProperties | undefined;
  onMouseDown: (index: number, event: React.MouseEvent<HTMLSpanElement>) => void;
  resizingIndex: number | null;
};

function useColumnResize(): ColumnResizeApi {
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [resizingIndex, setResizingIndex] = useState<number | null>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const indexRef = useRef<number | null>(null);

  const getStyle = useCallback(
    (index: number) => {
      const width = widths[index];
      return width ? { width, minWidth: width } : undefined;
    },
    [widths]
  );

  const onMouseDown = useCallback((index: number, event: React.MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const th = event.currentTarget.parentElement as HTMLElement | null;
    const startWidth = th?.getBoundingClientRect().width ?? 0;
    startXRef.current = event.clientX;
    startWidthRef.current = startWidth;
    indexRef.current = index;
    setResizingIndex(index);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (indexRef.current === null) return;
      const delta = moveEvent.clientX - startXRef.current;
      const newWidth = Math.max(80, startWidthRef.current + delta);
      setWidths(prev => ({ ...prev, [indexRef.current as number]: newWidth }));
    };

    const handleMouseUp = () => {
      indexRef.current = null;
      setResizingIndex(null);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("mouseleave", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("mouseleave", handleMouseUp);
  }, []);

  return { getStyle, onMouseDown, resizingIndex };
}

function ResizableTh({ resize, index, className, children }: { resize: ColumnResizeApi; index: number; className?: string; children: React.ReactNode }) {
  const style = resize.getStyle(index);
  const classes = ["resizable-th", className, resize.resizingIndex === index ? "is-resizing" : ""].filter(Boolean).join(" ");

  return (
    <th style={style} className={classes}>
      <div className="resizable-th__content">{children}</div>
      <span className="col-resizer" onMouseDown={(event) => resize.onMouseDown(index, event)} />
    </th>
  );
}





function App() {
  const { user, logout } = useAuth();
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Close user menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setIsUserMenuOpen(false);
      }
    };

    if (isUserMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isUserMenuOpen]);
  const [matchingFiles, setMatchingFiles] = useState<File[]>([]);
  const [processingAI, setProcessingAI] = useState(false);
  const [matching, setMatching] = useState(false);
  const [extractedFiles, setExtractedFiles] = useState<
    Array<{ fileName: string; items: ExtractedItem[]; totalPrice?: string; markdown?: string; geminiDebug?: any }>
  >([]);
  const [feedback, setFeedback] = useState<string>("");
  const [loadingStage, setLoadingStage] = useState(0);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activePage, setActivePage] = useState<AppPage>("new-estimate");
  const [landingAiReviewData, setLandingAiReviewData] = useState<null | { pdfUrl: string; fileName: string; raw: unknown }>(null);
  const [prepareSelectedChunkId, setPrepareSelectedChunkId] = useState<string>("");
  const prepareTableRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const prepareTableScrollRef = useRef<HTMLDivElement | null>(null);
  const prepareSelectionSourceRef = useRef<"pdf" | "table" | null>(null);
  const [drawingPdfPreviews, setDrawingPdfPreviews] = useState<Array<{ fileName: string; url: string }>>([]);
  const [drawingPrompt, setDrawingPrompt] = useState("");
  const [drawingPromptLoading, setDrawingPromptLoading] = useState(false);
  const [drawingPromptSaving, setDrawingPromptSaving] = useState(false);
  const [drawingPromptError, setDrawingPromptError] = useState("");
  const [drawingPromptUpdatedAt, setDrawingPromptUpdatedAt] = useState<string | null>(null);
  const [drawingPromptDirty, setDrawingPromptDirty] = useState(false);
  const [activeEstimateStep, setActiveEstimateStep] = useState<EstimateStep>("upload");
  const [boqResults, setBoqResults] = useState<{ boqItems: ExtractedItem[]; comparisons: BoqComparisonRow[] }>({ boqItems: [], comparisons: [] });
  const [boqExtractLoading, setBoqExtractLoading] = useState(false);
  const [boqCompareLoading, setBoqCompareLoading] = useState(false);
  const [boqEnrichLoading, setBoqEnrichLoading] = useState(false);
  const [selectedBoqFileName, setSelectedBoqFileName] = useState<string>("");
  const [pendingBoqFile, setPendingBoqFile] = useState<File | null>(null);
  const [reviewStepActive, setReviewStepActive] = useState(false);
  const [finalizeItems, setFinalizeItems] = useState<Array<{ item: ExtractedItem; source: ItemSource }>>([]);
  const [drawingSearch, setDrawingSearch] = useState("");
  const [boqSearch, setBoqSearch] = useState("");
  // Note: Prepare panel uses section-level "+ Add row" (no global search).
  const [comparisonSelections, setComparisonSelections] = useState<Record<number, "drawing" | "boq" | "">>({});
  const [comparisonChecked, setComparisonChecked] = useState<Record<number, boolean>>({});
  const [pricingSelections, setPricingSelections] = useState<Array<{ source: ItemSource; item: ExtractedItem }>>([]);
  const [pricingSearch, setPricingSearch] = useState("");
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingStatus, setPricingStatus] = useState<string>("");
  const [pricingMatchOptions, setPricingMatchOptions] = useState<Record<number, PriceMapping[]>>({});
  const [pricingMatchChoice, setPricingMatchChoice] = useState<Record<number, number>>({});
  const pricingSelectRefs = useRef<Record<number, HTMLSelectElement | null>>({});
  const pricingTriggerRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const pricingDropdownRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const [pricingDropdownPos, setPricingDropdownPos] = useState<
    Record<number, { top: number; left: number; width: number }>
  >({});
  const [pricingDropdownOpen, setPricingDropdownOpen] = useState<Record<number, boolean>>({});
  const [priceList, setPriceList] = useState<PriceListRow[]>([]);
  const [priceListLoading, setPriceListLoading] = useState(false);
  const [priceListError, setPriceListError] = useState("");
  const [priceListSearch, setPriceListSearch] = useState<Record<number, string>>({});
  const [installationInputs, setInstallationInputs] = useState<InstallationInputs>({
    workers: "0",
    engineers: "0",
    supervisors: "0",
    location: "riyadh",
  });
  const isPrepareStep = activePage === "new-estimate" && activeEstimateStep === "finalize";

  useEffect(() => {
    const url = landingAiReviewData?.pdfUrl;
    return () => {
      if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
    };
  }, [landingAiReviewData?.pdfUrl]);

  useEffect(() => {
    return () => {
      drawingPdfPreviews.forEach((p) => {
        if (p.url.startsWith("blob:")) URL.revokeObjectURL(p.url);
      });
    };
  }, [drawingPdfPreviews]);

  // When loading a draft, we won't have local blob URLs. Rebuild PDF previews from the saved /files links.
  useEffect(() => {
    if (drawingPdfPreviews.length) return;
    const pdfs = extractedFiles
      .filter((f: any) => typeof f?.link_to_file === "string" && f.fileName?.toLowerCase?.().endsWith(".pdf"))
      .map((f: any) => ({ fileName: f.fileName as string, url: f.link_to_file as string }));
    if (pdfs.length) setDrawingPdfPreviews(pdfs);
  }, [drawingPdfPreviews.length, extractedFiles]);
  const mapSheetRows = useCallback((rows: PriceListRow[]): SheetItem[] => {
    return rows
      .map((row) => {
        const item =
          (row["Item"] as string) ||
          (row["Description"] as string) ||
          (row["Name"] as string) ||
          "";
        const price =
          row["Price"] !== undefined
            ? String(row["Price"])
            : row["Unit Price"] !== undefined
              ? String(row["Unit Price"])
              : "";
        return { item: item.toString().trim(), price: price.toString().trim(), selected: false };
      })
      .filter((r) => r.item);
  }, []);

  const loadSheetRows = useCallback(
    async (sheetName: string, setter: React.Dispatch<React.SetStateAction<SheetItem[]>>, openSetter: React.Dispatch<React.SetStateAction<boolean>>) => {
      setPriceListLoading(true);
      setPriceListError("");
      try {
        const { data } = await fetchPriceList(sheetName);
        setter(mapSheetRows(data));
        openSetter(true);
      } catch (error) {
        setPriceListError((error as Error).message || "Failed to load sheet data");
      } finally {
        setPriceListLoading(false);
      }
    },
    [mapSheetRows]
  );

  const toggleSheetSelection = (setter: React.Dispatch<React.SetStateAction<SheetItem[]>>, idx: number) => {
    setter(prev => prev.map((row, i) => (i === idx ? { ...row, selected: !row.selected } : row)));
  };

  const updateSheetPrice = (setter: React.Dispatch<React.SetStateAction<SheetItem[]>>, idx: number, value: string) => {
    setter(prev => prev.map((row, i) => (i === idx ? { ...row, price: value } : row)));
  };

  const addSelectedSheetItems = (
    sheetRows: SheetItem[],
    setter: React.Dispatch<React.SetStateAction<SelectedSheetItem[]>>,
    closeModal: React.Dispatch<React.SetStateAction<boolean>>
  ) => {
    const picked = sheetRows.filter(r => r.selected);
    if (!picked.length) {
      closeModal(false);
      return;
    }
    setter(prev => [
      ...prev,
      ...picked.map(r => ({
        item: r.item,
        price: r.price,
        qty: "1",
      })),
    ]);
    closeModal(false);
  };
  const filteredPricingSelections = useMemo(
    () => pricingSelections.map((sel, idx) => ({ sel, idx })).filter(({ sel }) => matchesDescription(sel.item, pricingSearch)),
    [pricingSelections, pricingSearch]
  );
  const [electricalModalOpen, setElectricalModalOpen] = useState(false);
  const [installationModalOpen, setInstallationModalOpen] = useState(false);
  const [venueModalOpen, setVenueModalOpen] = useState(false);
  const [markdownFileIdx, setMarkdownFileIdx] = useState(0);

  type SheetItem = { item: string; price: string; selected?: boolean };
  type SelectedSheetItem = { item: string; price: string; qty: string };

  const [electricalSheetRows, setElectricalSheetRows] = useState<SheetItem[]>([]);
  const [installationSheetRows, setInstallationSheetRows] = useState<SheetItem[]>([]);
  const [venueSheetRows, setVenueSheetRows] = useState<SheetItem[]>([]);

  const [electricalItems, setElectricalItems] = useState<SelectedSheetItem[]>([]);
  const [installationItems, setInstallationItems] = useState<SelectedSheetItem[]>([]);
  const [venueItems, setVenueItems] = useState<SelectedSheetItem[]>([]);
  const [estimateCompanyName, setEstimateCompanyName] = useState(COMPANY_NAME);
  const [estimateContactName, setEstimateContactName] = useState(CONTACT_NAME);
  const [estimateProjectName, setEstimateProjectName] = useState("");
  const [estimateSubject, setEstimateSubject] = useState("");
  const [showDrawingsOnlyConfirm, setShowDrawingsOnlyConfirm] = useState(false);

  const getMatchLabel = useCallback((match?: PriceMapping) => {
    if (!match) return "Select price";
    const row = (match.price_row || {}) as Record<string, string | number>;
    return (
      (row["Item"] as string) ||
      (row["Name"] as string) ||
      (row["Description"] as string) ||
      `Match ${match.price_list_index + 1}`
    );
  }, []);

  const getPriceListItemLabel = useCallback((row?: PriceListRow) => {
    if (!row) return "";
    const itemValue = row["Item"] ?? row["item"];
    if (itemValue !== undefined && itemValue !== null && itemValue !== "") {
      return String(itemValue);
    }
    const keys = Object.keys(row);
    const fallbackKey = keys[1] ?? keys[0];
    return fallbackKey ? String(row[fallbackKey] ?? "") : "";
  }, []);

  const openMatchDropdown = (rowIdx: number) => {
    setPricingDropdownOpen((prev) => {
      const nextOpen = !prev[rowIdx];
      const trigger = pricingTriggerRefs.current[rowIdx];
      if (nextOpen && trigger) {
        const rect = trigger.getBoundingClientRect();
        const left = Math.min(rect.left, Math.max(8, window.innerWidth - 360));
        const width = rect.width;
        const top = rect.top + rect.height + 6;
        setPricingDropdownPos((pos) => ({
          ...pos,
          [rowIdx]: { top, left, width },
        }));
      }
      const sel = pricingSelectRefs.current[rowIdx];
      if (nextOpen && sel) {
        requestAnimationFrame(() => {
          sel.focus();
          if (typeof (sel as any).showPicker === "function") {
            (sel as any).showPicker();
          } else {
            sel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            sel.click();
          }
        });
      }
      return { ...prev, [rowIdx]: nextOpen };
    });
  };
  const closeMatchDropdown = useCallback((rowIdx?: number) => {
    if (rowIdx === undefined) {
      setPricingDropdownOpen({});
      return;
    }
    setPricingDropdownOpen((prev) => ({ ...prev, [rowIdx]: false }));
  }, []);

  const indexedPriceList = useMemo(
    () => priceList.map((row, idx) => ({ row, rowIndex: idx })),
    [priceList]
  );

  const findPriceListMatches = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (trimmed.length < 3) return [];
      const lower = trimmed.toLowerCase();
      return indexedPriceList.filter(({ row }) => {
        const label = getPriceListItemLabel(row);
        return label && label.toLowerCase().includes(lower);
      });
    },
    [getPriceListItemLabel, indexedPriceList]
  );

  const applyPriceMappingToRow = (rowIdx: number, mapping: PriceMapping) => {
    const row = mapping.price_row as Record<string, string | number> | undefined;
    const rowPrice = pickFieldFromRow(row, [/price/i]);
    const rowMh = pickFieldFromRow(row, [/manhour/i, /mh/i]);
    setPricingSelections(prev => {
      const next = [...prev];
      if (!next[rowIdx]) return prev;
      const nextUnitPriceRaw =
        mapping.unit_price !== undefined ? String(mapping.unit_price) : rowPrice ?? next[rowIdx].item.unit_price;
      const nextUnitPrice = roundPrice(nextUnitPriceRaw);
      const nextUnitMh =
        mapping.unit_manhour !== undefined ? String(mapping.unit_manhour) : rowMh ?? next[rowIdx].item.unit_manhour;
      const quantity = next[rowIdx].item.quantity;
      next[rowIdx] = {
        ...next[rowIdx],
        item: {
          ...next[rowIdx].item,
          unit_price: nextUnitPrice,
          unit_manhour: nextUnitMh,
          total_price: computeTotalPrice(nextUnitPrice, quantity),
          total_manhour: computeTotalValue(nextUnitMh, quantity),
        },
      };
      return next;
    });
  };

  useEffect(() => {
    const handleOutsideInteraction = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      const openRows = Object.entries(pricingDropdownOpen)
        .filter(([, isOpen]) => isOpen)
        .map(([idx]) => Number(idx));
      if (!openRows.length) return;

      const clickedOutside = openRows.some((rowIdx) => {
        const container = pricingDropdownRefs.current[rowIdx];
        return container && !container.contains(target);
      });

      if (clickedOutside) {
        closeMatchDropdown();
      }
    };

    document.addEventListener("mousedown", handleOutsideInteraction);
    document.addEventListener("touchstart", handleOutsideInteraction);
    return () => {
      document.removeEventListener("mousedown", handleOutsideInteraction);
      document.removeEventListener("touchstart", handleOutsideInteraction);
    };
  }, [pricingDropdownOpen, closeMatchDropdown]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string>("");
  const [draftStatus, setDraftStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<EstimateDraftMeta[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const hydratingDraftRef = useRef(false);
  const [selectedDrawingRows, setSelectedDrawingRows] = useState<Record<string, boolean>>({});
  const [selectedBoqRows, setSelectedBoqRows] = useState<Record<string, boolean>>({});
  const kbResize = useColumnResize();
  const comparisonResize = useColumnResize();
  const pricingResize = useColumnResize();
  const estimateResize = useColumnResize();
  const [activePricingSection, setActivePricingSection] = useState<PricingAccordionId | null>("items");
  const compareMessages = [
    "Reading BOQ…",
    "Extracting BOQ items…",
    "Comparing with drawing items…",
    "Finalizing comparison…"
  ];
  const [compareStage, setCompareStage] = useState(0);

  useEffect(() => {
    if (activePage !== "new-estimate" || activeEstimateStep !== "pricing") return;
    if (priceList.length || priceListLoading) return;
    setPriceListLoading(true);
    setPriceListError("");
    fetchPriceList()
      .then(({ data }) => {
        setPriceList(data || []);
      })
      .catch((error) => {
        console.error("Failed to load price list", error);
        setPriceListError((error as Error).message || "Failed to load price list.");
      })
      .finally(() => setPriceListLoading(false));
  }, [activeEstimateStep, activePage, priceList.length, priceListLoading]);

  const hasDraftContent = useMemo(() => {
    return (
      extractedFiles.length > 0 ||
      boqResults.boqItems.length > 0 ||
      boqResults.comparisons.length > 0 ||
      finalizeItems.length > 0 ||
      pricingSelections.length > 0 ||
      Object.keys(comparisonSelections).length > 0 ||
      Object.keys(comparisonChecked).length > 0 ||
      Object.keys(selectedDrawingRows).length > 0 ||
      Object.keys(selectedBoqRows).length > 0 ||
      Boolean(selectedBoqFileName)
    );
  }, [
    extractedFiles,
    boqResults,
    finalizeItems,
    pricingSelections,
    comparisonSelections,
    comparisonChecked,
    selectedDrawingRows,
    selectedBoqRows,
    selectedBoqFileName,
  ]);

  const captureDraftState = useCallback((): DraftEstimateState => {
    return {
      activeEstimateStep,
      reviewStepActive,
      extractedFiles,
      boqResults,
      comparisonSelections,
      comparisonChecked,
      selectedDrawingRows,
      selectedBoqRows,
      finalizeItems,
      pricingSelections: pricingSelections as DraftEstimateState["pricingSelections"],
      pricingMatchOptions,
      pricingMatchChoice,
      selectedBoqFileName,
      electricalItems,
      installationItems,
      venueItems,
      installationInputs,
    };
  }, [
    activeEstimateStep,
    reviewStepActive,
    extractedFiles,
    boqResults,
    comparisonSelections,
    comparisonChecked,
    selectedDrawingRows,
    selectedBoqRows,
    finalizeItems,
    pricingSelections,
    pricingMatchOptions,
    pricingMatchChoice,
    selectedBoqFileName,
    electricalItems,
    installationItems,
    venueItems,
    installationInputs,
  ]);

  const persistDraft = useCallback(async (): Promise<boolean> => {
    if (activeEstimateStep === "upload" || !hasDraftContent) {
      return false;
    }
    const resolvedName =
      draftName.trim() || `Draft ${new Date().toLocaleString()}`;

    if (!draftName.trim()) {
      setDraftName(resolvedName);
    }

    setDraftStatus("saving");
    try {
      const saved = await saveDraft({
        id: draftId ?? undefined,
        name: resolvedName,
        step: activeEstimateStep,
        state: captureDraftState(),
      });
      setDraftId(saved.id);
      setLastDraftSavedAt(saved.updatedAt);
      setDraftStatus("saved");
      return true;
    } catch (error) {
      console.error("Failed to save draft", error);
      setDraftStatus("error");
      setFeedback("Unable to auto-save draft. Please try again.");
      setTimeout(() => setFeedback(""), 3500);
      return false;
    }
  }, [
    activeEstimateStep,
    captureDraftState,
    draftId,
    draftName,
    hasDraftContent,
  ]);

  const refreshDrafts = useCallback(async () => {
    setDraftsLoading(true);
    try {
      const rows = await listDrafts();
      setDrafts(rows);
      setSelectedDraftId((prev) => {
        if (prev && rows.some((d) => d.id === prev)) return prev;
        return rows[0]?.id ?? null;
      });
    } catch (error) {
      console.error("Failed to load drafts", error);
      setFeedback("Unable to load drafts.");
      setTimeout(() => setFeedback(""), 3500);
    } finally {
      setDraftsLoading(false);
    }
  }, []);

  const loadDrawingPrompt = useCallback(
    async (isCancelled?: () => boolean) => {
      setDrawingPromptLoading(true);
      setDrawingPromptError("");
      try {
        const result = await fetchDrawingPrompt();
        if (isCancelled?.()) return;
        setDrawingPrompt(result.prompt ?? "");
        setDrawingPromptUpdatedAt(result.updatedAt ?? null);
        setDrawingPromptDirty(false);
      } catch (error) {
        if (isCancelled?.()) return;
        setDrawingPromptError((error as Error).message || "Failed to load prompt");
      } finally {
        if (isCancelled?.()) return;
        setDrawingPromptLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (activeEstimateStep === "upload" || draftName) return;
    setDraftName(`Draft ${new Date().toLocaleString()}`);
  }, [activeEstimateStep, draftName]);

  useEffect(() => {
    if (activePage !== "new-estimate") return;
    if (activeEstimateStep === "upload") return;
    if (!hasDraftContent) return;
    const handle = setTimeout(() => {
      void persistDraft();
    }, 1200);
    return () => clearTimeout(handle);
  }, [activePage, activeEstimateStep, hasDraftContent, persistDraft]);

  useEffect(() => {
    if (activePage !== "drafts") return;
    void refreshDrafts();
  }, [activePage, refreshDrafts]);

  useEffect(() => {
    if (activePage !== "drawing-prompt") return;

    let cancelled = false;
    void loadDrawingPrompt(() => cancelled);

    return () => {
      cancelled = true;
    };
  }, [activePage, loadDrawingPrompt]);

  useEffect(() => {
    // When comparisons update from a new run, clear selections.
    // Skip clearing when we are hydrating a draft.
    if (hydratingDraftRef.current) return;
    setComparisonSelections({});
    setPricingSelections([]);
  }, [boqResults.comparisons]);

  // Generic user-facing progress steps (do not mention tools/vendors)
  const loadingMessages = [
    "Reading the drawing…",
    "Extracting key details…",
    "Analyzing the drawing…",
    "Finalizing results…",
  ];

  const [aiProgressMessage, setAiProgressMessage] = useState<string>("");

  const resetEstimateFlow = useCallback(() => {
    hydratingDraftRef.current = false;
    setActiveEstimateStep("upload");
    setReviewStepActive(false);
    setMatchingFiles([]);
    setProcessingAI(false);
    setMatching(false);
    setExtractedFiles([]);
    setBoqResults({ boqItems: [], comparisons: [] });
    setBoqExtractLoading(false);
    setBoqCompareLoading(false);
    setCompareStage(0);
    setSelectedBoqFileName("");
    setPendingBoqFile(null);
    setFinalizeItems([]);
    setComparisonSelections({});
    setComparisonChecked({});
    setPricingSelections([]);
    setActivePricingSection("items");
    setElectricalItems([]);
    setInstallationItems([]);
    setVenueItems([]);
    setElectricalModalOpen(false);
    setSelectedDrawingRows({});
    setSelectedBoqRows({});
    setFeedback("");
    setDraftId(null);
    setDraftName("");
    setSelectedDraftId(null);
    setDraftStatus("idle");
    setLastDraftSavedAt(null);
    setInstallationInputs({
      workers: "0",
      engineers: "0",
      supervisors: "0",
      location: "riyadh",
    });
  }, []);

  const handleStartNewEstimate = () => {
    resetEstimateFlow();
    setActivePage("new-estimate");
  };

  const handleContinueDraft = async () => {
    if (!selectedDraftId) return;
    setLoadingDraft(true);
    hydratingDraftRef.current = true;
    try {
      const draft = await getDraft(selectedDraftId);
      const state = (draft.state as DraftEstimateState) || {};
      const toNumberRecord = <T,>(input?: Record<string, T> | Record<number, T>): Record<number, T> => {
        const output: Record<number, T> = {};
        Object.entries(input ?? {}).forEach(([key, value]) => {
          const numKey = Number(key);
          if (!Number.isNaN(numKey)) {
            output[numKey] = value as T;
          }
        });
        return output;
      };

      setActivePage("new-estimate");
      setActiveEstimateStep(state.activeEstimateStep || "review");
      setReviewStepActive(state.reviewStepActive ?? true);
      setExtractedFiles(state.extractedFiles || []);
      setBoqResults(state.boqResults || { boqItems: [], comparisons: [] });
      setComparisonSelections(toNumberRecord(state.comparisonSelections));
      setComparisonChecked(toNumberRecord(state.comparisonChecked));
      setFinalizeItems(state.finalizeItems || []);
      setPricingSelections(state.pricingSelections || []);
      setPricingMatchOptions(state.pricingMatchOptions || {});
      setPricingMatchChoice(toNumberRecord(state.pricingMatchChoice));
      setSelectedBoqFileName(state.selectedBoqFileName || "");
      if (hydratingDraftRef.current && state.installationInputs) {
        setInstallationInputs(state.installationInputs);
      }
      const defaultDrawingSelection: Record<string, boolean> = {};
      (state.extractedFiles || []).forEach((file, fileIdx) =>
        (file.items || []).forEach((_, itemIdx) => {
          defaultDrawingSelection[`d-${fileIdx}-${itemIdx}`] = true;
        })
      );
      const defaultBoqSelection: Record<string, boolean> = {};
      (state.boqResults?.boqItems || []).forEach((_, idx) => {
        defaultBoqSelection[`b-${idx}`] = true;
      });
      setSelectedDrawingRows(
        state.selectedDrawingRows && Object.keys(state.selectedDrawingRows).length > 0
          ? state.selectedDrawingRows
          : defaultDrawingSelection
      );
      setSelectedBoqRows(
        state.selectedBoqRows && Object.keys(state.selectedBoqRows).length > 0
          ? state.selectedBoqRows
          : defaultBoqSelection
      );
      setElectricalItems(state.electricalItems || []);
      setInstallationItems(state.installationItems || []);
      setVenueItems(state.venueItems || []);
      setPendingBoqFile(null);
      setMatchingFiles([]);
      setDraftId(draft.id);
      setDraftName(draft.name);
      setLastDraftSavedAt(draft.updatedAt);
      setFeedback("Draft loaded. Continue your estimate.");
      setTimeout(() => setFeedback(""), 3000);
    } catch (error) {
      setFeedback((error as Error).message || "Failed to load draft.");
      setTimeout(() => setFeedback(""), 3500);
    } finally {
      setLoadingDraft(false);
      // Allow the next comparisons change (e.g., a new compare run) to clear selections
      // but keep hydration protection through the next paint.
      setTimeout(() => {
        hydratingDraftRef.current = false;
      }, 350);
    }
  };


  const handleComparisonSelect = (rowIndex: number, source: "drawing" | "boq") => {
    setComparisonSelections(prev => ({ ...prev, [rowIndex]: source }));
    setComparisonChecked(prev => ({ ...prev, [rowIndex]: true }));
  };

  const handleComparisonCheck = (rowIndex: number, checked: boolean) => {
    setComparisonChecked(prev => ({ ...prev, [rowIndex]: checked }));
  };

  const handleComparisonCellSelect = (rowIndex: number, source: "drawing" | "boq", hasItem: boolean) => {
    if (!hasItem) return;
    handleComparisonSelect(rowIndex, source);
  };

  // Note: handleProceedToPricing is not currently used - pricing selections are set in the Finalize button handler

  const processingMessage = processingAI
    ? matching
      ? (aiProgressMessage || loadingMessages[loadingStage] || loadingMessages[0])
      : "Processing documents with AI..."
    : "";

  const heroTitle =
    activePage === "drafts"
      ? "My Drafts"
      : activePage === "drawing-prompt"
        ? "Drawing Extraction Prompt"
        : activePage === "new-estimate" && activeEstimateStep === "review"
          ? "Review Extracted Items"
          : activePage === "new-estimate" && activeEstimateStep === "compare"
            ? "Select the Items to include in the Estimate"
            : activePage === "new-estimate" && activeEstimateStep === "finalize"
              ? "Prepare the items before moving to Pricing"
              : activePage === "new-estimate" && activeEstimateStep === "pricing"
                ? "Finalize the Pricing for Items, Electrical, ATG and Installation"
                : activePage === "new-estimate" && activeEstimateStep === "estimate"
                  ? "Finalize the consolidated estimate"
                  : "Upload Drawings and BOQ to start the Estimation";

  const handleDrawingPromptSave = async () => {
    setDrawingPromptSaving(true);
    setDrawingPromptError("");
    try {
      const result = await updateDrawingPrompt(drawingPrompt);
      setDrawingPrompt(result.prompt ?? drawingPrompt);
      setDrawingPromptUpdatedAt(result.updatedAt ?? new Date().toISOString());
      setDrawingPromptDirty(false);
    } catch (error) {
      setDrawingPromptError((error as Error).message || "Failed to save prompt");
    } finally {
      setDrawingPromptSaving(false);
    }
  };

  const handleBoqFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setPendingBoqFile(file);
    setSelectedBoqFileName(file.name);
  };

  const getComparisonClass = (status: string) => {
    const okStatuses = new Set(["match_exact", "exact_match", "match", "matched"]);
    const warnStatuses = new Set(["match_quantity_diff", "match_unit_diff", "partial_match", "match_size_diff"]);
    const missingStatuses = new Set(["missing_in_boq", "missing_in_drawing", "no_match"]);
    if (okStatuses.has(status)) return "compare-row--ok";
    if (warnStatuses.has(status)) return "compare-row--warn";
    if (missingStatuses.has(status)) return "compare-row--missing";
    return "";
  };

  const buildDrawingRowKey = (fileIdx: number, itemIdx: number) => `d-${fileIdx}-${itemIdx}`;
  const buildBoqRowKey = (itemIdx: number) => `b-${itemIdx}`;

  const parseGeminiItemsToExtractedItems = useCallback((text: string): ExtractedItem[] => {
    const raw = String(text || "").trim();
    if (!raw) return [];

    const tryParse = (jsonText: string): any => {
      try {
        return JSON.parse(jsonText);
      } catch {
        return null;
      }
    };

    // 1) Direct parse
    let parsed: any = tryParse(raw);

    // 2) Strip code fences if present
    if (!parsed && raw.includes("```")) {
      const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenceMatch?.[1]) parsed = tryParse(fenceMatch[1].trim());
    }

    // 3) Try extracting the first JSON array substring
    if (!parsed) {
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      if (start >= 0 && end > start) {
        parsed = tryParse(raw.slice(start, end + 1));
      }
    }

    const arr =
      Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object"
          ? (Array.isArray((parsed as any).items) ? (parsed as any).items
            : Array.isArray((parsed as any).parsed_boq) ? (parsed as any).parsed_boq
              : Array.isArray((parsed as any).result) ? (parsed as any).result
                : Array.isArray((parsed as any).data) ? (parsed as any).data
                  : null)
          : null;

    if (!Array.isArray(arr)) return [];

    return arr.map((it: any) => {
      const quantity =
        it?.quantity !== undefined && it?.quantity !== null && it?.quantity !== ""
          ? String(it.quantity)
          : "";
      const unit = String(it?.uom ?? it?.UOM ?? it?.unit ?? it?.Unit ?? "");
      const dimensions = String(it?.dimensions ?? it?.dimension ?? it?.size ?? "");
      const landingAiId =
        it?.landing_ai_id ??
        it?.landingAiId ??
        it?.landing_aiid ??
        it?.landingAIId ??
        it?.landing_ai_chunk_id ??
        it?.chunk_id ??
        it?.chunkId ??
        it?.id ??
        null;
      return {
        landing_ai_id: landingAiId ? String(landingAiId) : null,
        section_code: it?.section_code ?? it?.section ?? undefined,
        section_name: it?.section_name ?? undefined,
        item_no: it?.item_no ?? it?.itemNo ?? it?.item_number ?? it?.itemNumber ?? undefined,
        item_number: it?.item_number ?? it?.itemNumber ?? undefined,
        item_type: it?.item_type ?? undefined,
        description: it?.description ?? it?.desc ?? it?.name ?? "",
        finishes: it?.finishes ?? it?.finish ?? "",
        dimensions,
        size: dimensions,
        quantity,
        unit,
        remarks: it?.remarks ?? "",
      } satisfies ExtractedItem;
    });
  }, []);

  const drawingReviewRows = useMemo(
    () =>
      extractedFiles.flatMap((file, fileIdx) =>
        (file.items || []).map((item, itemIdx) => ({
          item,
          fileIdx,
          itemIdx,
          fileName: file.fileName,
          key: buildDrawingRowKey(fileIdx, itemIdx),
        }))
      ),
    [extractedFiles]
  );

  const boqReviewRows = useMemo(
    () =>
      (boqResults.boqItems || []).map((item, itemIdx) => ({
        item,
        itemIdx,
        key: buildBoqRowKey(itemIdx),
      })),
    [boqResults]
  );

  const filteredDrawingReviewRows = useMemo(
    () => drawingReviewRows.filter(({ item }) => matchesDescription(item, drawingSearch)),
    [drawingReviewRows, drawingSearch]
  );

  const drawingSections = useMemo(
    () => {
      const baseSections = DRAWING_SECTIONS.map(section => ({ ...section, rows: [] as typeof drawingReviewRows }));
      const sectionLookup = baseSections.reduce<Record<string, (typeof baseSections)[number]>>((acc, section) => {
        acc[section.code] = section;
        return acc;
      }, {});

      const uncategorized: typeof drawingReviewRows = [];

      filteredDrawingReviewRows.forEach(row => {
        const code = resolveSectionCode(row.item);
        if (code && sectionLookup[code]) {
          sectionLookup[code].rows.push(row);
        } else {
          uncategorized.push(row);
        }
      });

      return uncategorized.length
        ? [...baseSections, { code: "other", title: "Uncategorized", rows: uncategorized }]
        : baseSections;
    },
    [filteredDrawingReviewRows]
  );

  const filteredBoqReviewRows = useMemo(
    () => boqReviewRows.filter(({ item }) => matchesDescription(item, boqSearch)),
    [boqReviewRows, boqSearch]
  );

  const drawingSelectedCount = useMemo(
    () => filteredDrawingReviewRows.reduce((count, row) => count + (selectedDrawingRows[row.key] ? 1 : 0), 0),
    [filteredDrawingReviewRows, selectedDrawingRows]
  );

  const boqSelectedCount = useMemo(
    () => filteredBoqReviewRows.reduce((count, row) => count + (selectedBoqRows[row.key] ? 1 : 0), 0),
    [filteredBoqReviewRows, selectedBoqRows]
  );

  const prepareLandingContext = useMemo(() => {
    const file = extractedFiles[markdownFileIdx];
    const fileName = file?.fileName || "";
    const raw = (file as any)?.geminiDebug?.landingAi?.raw ?? null;
    const pdf = drawingPdfPreviews.find((p) => p.fileName === fileName) ?? drawingPdfPreviews[0] ?? null;
    return { fileName, raw, pdfUrl: pdf?.url ?? "" };
  }, [drawingPdfPreviews, extractedFiles, markdownFileIdx]);

  const updateFinalizeItemField = useCallback((idx: number, field: keyof ExtractedItem, value: string) => {
    setFinalizeItems((prev) => {
      const next = [...prev];
      if (!next[idx]) return prev;
      next[idx] = { ...next[idx], item: { ...next[idx].item, [field]: value } };
      return next;
    });
  }, []);

  const finalizeRowsForPrepare = useMemo(
    () => finalizeItems.map((entry, idx) => ({ entry, idx })),
    [finalizeItems]
  );

  const finalizeSectionsForPrepare = useMemo(() => {
    const baseSections = DRAWING_SECTIONS.map((section) => ({
      ...section,
      rows: [] as Array<{ entry: (typeof finalizeItems)[number]; idx: number }>,
    }));
    const sectionLookup = baseSections.reduce<Record<string, (typeof baseSections)[number]>>((acc, section) => {
      acc[section.code] = section;
      return acc;
    }, {});
    const uncategorized: Array<{ entry: (typeof finalizeItems)[number]; idx: number }> = [];

    finalizeRowsForPrepare.forEach(({ entry, idx }) => {
      const code = resolveSectionCode(entry.item);
      if (code && sectionLookup[code]) {
        sectionLookup[code].rows.push({ entry, idx });
      } else {
        uncategorized.push({ entry, idx });
      }
    });

    return uncategorized.length
      ? [...baseSections, { code: "other", title: "Uncategorized", rows: uncategorized }]
      : baseSections;
  }, [finalizeRowsForPrepare]);

  const addFinalizeRowForSection = useCallback((sectionCode: string) => {
    const normalized = (sectionCode || "").toUpperCase();
    const code = normalized && normalized !== "OTHER" ? normalized : "U";
    const prefix = `${code}.`;

    const parseSuffix = (value: string) => {
      const s = String(value || "").trim().toUpperCase();
      if (!s.startsWith(prefix)) return null;
      const n = Number.parseInt(s.slice(prefix.length), 10);
      return Number.isFinite(n) ? n : null;
    };

    setFinalizeItems((prev) => {
      let max = 0;
      prev.forEach((row) => {
        const num = parseSuffix(String(row.item.item_no || row.item.item_number || ""));
        if (num && num > max) max = num;
      });
      const nextNo = `${code}.${max + 1}`;

      const newEntry: { item: ExtractedItem; source: ItemSource } = {
        source: "manual",
        item: {
          landing_ai_id: null,
          section_code: code === "U" ? undefined : code,
          item_no: nextNo,
          description: "",
          finishes: "",
          dimensions: "",
          size: "",
          quantity: "",
          unit: "",
        },
      };

      // Insert after the last row that clearly belongs to this section (keeps table grouping stable).
      const belongs = (it: ExtractedItem) => {
        const sc = String(it.section_code || "").trim().toUpperCase();
        const ino = String(it.item_no || it.item_number || "").trim().toUpperCase();
        if (code === "U") {
          const first = (sc || ino.charAt(0) || "").toUpperCase();
          return !DRAWING_SECTION_CODE_SET.has(first);
        }
        if (sc === code) return true;
        if (ino.startsWith(prefix)) return true;
        return false;
      };

      let insertAt = prev.length;
      for (let i = 0; i < prev.length; i++) {
        if (belongs(prev[i].item)) insertAt = i + 1;
      }

      const next = [...prev];
      next.splice(insertAt, 0, newEntry);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!prepareSelectedChunkId) return;
    // Avoid feedback loop: only scroll the table when selection originated from PDF.
    if (prepareSelectionSourceRef.current !== "pdf") return;
    const root = prepareTableScrollRef.current;
    if (!root) return;
    const row = prepareTableRowRefs.current[prepareSelectedChunkId];
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    prepareSelectionSourceRef.current = null;
  }, [prepareSelectedChunkId]);

  const setAllDrawingSelection = useCallback(
    (checked: boolean) => {
      setSelectedDrawingRows(prev => {
        const next = { ...prev };
        filteredDrawingReviewRows.forEach(row => {
          next[row.key] = checked;
        });
        return next;
      });
    },
    [filteredDrawingReviewRows]
  );

  const setAllBoqSelection = useCallback(
    (checked: boolean) => {
      setSelectedBoqRows(prev => {
        const next = { ...prev };
        filteredBoqReviewRows.forEach(row => {
          next[row.key] = checked;
        });
        return next;
      });
    },
    [filteredBoqReviewRows]
  );

  const hasDrawingData = drawingReviewRows.length > 0;
  const hasBoqData = boqReviewRows.length > 0;

  const markdownCandidates = useMemo(
    () =>
      extractedFiles
        .map((f, idx) => ({ idx, fileName: f.fileName, markdown: (f.markdown ?? "").trim() }))
        .filter((row) => row.markdown.length > 0),
    [extractedFiles]
  );

  useEffect(() => {
    if (!markdownCandidates.length) return;
    const hasCurrent = markdownCandidates.some((row) => row.idx === markdownFileIdx);
    if (!hasCurrent) {
      setMarkdownFileIdx(markdownCandidates[0].idx);
    }
  }, [markdownCandidates, markdownFileIdx]);

  const buildBoqSelection = useCallback(
    (items: ExtractedItem[]) => {
      const rows = items.map((item, itemIdx) => ({
        item,
        key: buildBoqRowKey(itemIdx),
      }));
      const picked = rows.filter(row => selectedBoqRows[row.key]).map(row => row.item);
      return picked.length ? picked : items;
    },
    [selectedBoqRows]
  );

  const getSelectedDrawingItems = useCallback(
    () => {
      const picked = drawingReviewRows.filter(row => selectedDrawingRows[row.key]).map(row => row.item);
      return picked.length ? picked : drawingReviewRows.map(row => row.item);
    },
    [drawingReviewRows, selectedDrawingRows]
  );

  const getSelectedBoqItems = useCallback(
    (itemsOverride?: ExtractedItem[]) => {
      const items = itemsOverride ?? boqResults.boqItems ?? [];
      return buildBoqSelection(items);
    },
    [boqResults.boqItems, buildBoqSelection]
  );

  const enrichBoqSizeAndCapacity = useCallback(async (itemsArg?: ExtractedItem[]): Promise<ExtractedItem[]> => {
    const items = itemsArg ?? boqResults.boqItems ?? [];
    const needsEnrichment = items.some(item => {
      const hasSize = !!item.size && item.size.trim().length > 0;
      const hasCapacity = !!item.capacity && item.capacity.trim().length > 0;
      return !hasSize || !hasCapacity;
    });
    if (!needsEnrichment) return items;

    setBoqEnrichLoading(true);
    try {
      const resp = await enrichBoqItems(items);
      if (resp.items?.length) {
        setBoqResults(prev => ({ ...prev, boqItems: resp.items, comparisons: [] }));
        setComparisonSelections({});
        setComparisonChecked({});
        // Ensure table shows enriched rows immediately
        const selection: Record<string, boolean> = {};
        resp.items.forEach((_, idx) => {
          selection[`b-${idx}`] = true;
        });
        setSelectedBoqRows(selection);
        return resp.items;
      }
    } catch (error) {
      setFeedback((error as Error).message || "Failed to enrich BOQ items.");
      setTimeout(() => setFeedback(""), 4000);
    } finally {
      setBoqEnrichLoading(false);
    }
    return items;
  }, [boqResults.boqItems]);

  const runExtract = useCallback(
    async (hasDrawings: boolean, hasBoq: boolean) => {
      setMatching(hasDrawings);
      setProcessingAI(hasDrawings || hasBoq);
      setReviewStepActive(false);
      setActiveEstimateStep("upload");
      setFeedback("");
      if (hasDrawings) {
        setExtractedFiles([]);
        setLoadingStage(0);
      }
      setSelectedDrawingRows({});
      setSelectedBoqRows({});
      // Progress is now driven by backend job stage polling (no timer-based fake progress).

      try {
        let drawingsSucceeded = false;
        if (hasDrawings) {
          const idempotencyKey = uuidv4();
          const startResp = await extractEstimates(matchingFiles, idempotencyKey) as any;

          // If backend returns the legacy synchronous shape, accept it.
          let payload: any = startResp;

          // Async job flow: poll until job is done.
          if (!payload?.files && startResp?.jobId) {
            const jobId = String(startResp.jobId);
            const startedAt = Date.now();
            const maxWaitMs = 20 * 60 * 1000; // 20 minutes
            while (Date.now() - startedAt < maxWaitMs) {
              const job = await getExtractJob(jobId);
              const stage = String(job?.stage || "").toLowerCase();
              // Map backend stages to our existing UI steps (no vendor/tool names)
              if (stage === "landingai-parse") {
                setLoadingStage(0);
                setAiProgressMessage("Reading the drawing…");
              } else if (stage === "landingai-extract") {
                setLoadingStage(1);
                setAiProgressMessage("Extracting key details…");
              } else if (stage === "gemini") {
                setLoadingStage(2);
                setAiProgressMessage("Analyzing the drawing…");
              } else if (stage === "finalizing") {
                setLoadingStage(3);
                setAiProgressMessage("Finalizing results…");
              } else if (job?.message) {
                // fallback: allow backend to drive a generic message
                setAiProgressMessage(String(job.message));
              }
              if (job?.status === "done") {
                payload = job.result ?? { files: [] };
                break;
              }
              if (job?.status === "failed") {
                throw new Error(job?.error?.message || "Extraction job failed");
              }
              await new Promise((r) => setTimeout(r, 1500));
            }
            if (!payload?.files) {
              throw new Error("Extraction job timed out");
            }
          }

          const files = (payload.files ?? []).map((f: any) => {
            const existingItems = Array.isArray(f?.items) ? f.items : [];
            const parsedFromGemini = existingItems.length ? existingItems : parseGeminiItemsToExtractedItems(String(f?.markdown ?? ""));
            return { ...f, items: parsedFromGemini };
          });
          setExtractedFiles(files);
          // Debug logs (browser console): Gemini results + LandingAI result + Gemini request summary per file
          try {
            if (files.length) {
              console.groupCollapsed(`[Extraction Debug] ${files.length} file(s)`);
              files.forEach((f: any) => {
                if (!f?.geminiDebug) return;
                console.groupCollapsed(`File: ${f.fileName}`);
                console.log("Gemini Items:", f.items);
                console.log("LandingAI:", f.geminiDebug?.landingAi);
                console.log("Gemini Request:", f.geminiDebug?.geminiRequest);
                console.groupEnd();
              });
              console.groupEnd();
            }
          } catch (e) {
            console.warn("Failed to log extraction debug", e);
          }
          setMarkdownFileIdx(0);
          const drawingSelection: Record<string, boolean> = {};
          files.forEach((file: any, fileIdx: number) =>
            (file.items || []).forEach((_item: ExtractedItem, itemIdx: number) => {
              drawingSelection[`d-${fileIdx}-${itemIdx}`] = true;
            })
          );
          setSelectedDrawingRows(drawingSelection);
          setMatchingFiles([]);
          drawingsSucceeded = !!(payload.files && payload.files.length > 0);
          const message = drawingsSucceeded ? "Drawings extracted." : "No drawing items returned.";
          setFeedback(message);
          setTimeout(() => setFeedback(""), 3000);
        }

        let boqSucceeded = false;
        if (hasBoq && pendingBoqFile) {
          setBoqExtractLoading(true);
          try {
            const extractResp = await extractBoq(pendingBoqFile);
            let boqItems = extractResp.boqItems || [];
            boqItems = await enrichBoqSizeAndCapacity(boqItems);
            setBoqResults({ boqItems, comparisons: [] });
            const boqSelection: Record<string, boolean> = {};
            boqItems.forEach((_, idx) => {
              boqSelection[`b-${idx}`] = true;
            });
            setSelectedBoqRows(boqSelection);
            boqSucceeded = !!(boqItems && boqItems.length > 0);
            const msg = boqSucceeded ? "BOQ extracted." : "No BOQ items were parsed from this file.";
            setFeedback(msg);
            setTimeout(() => setFeedback(""), 3000);
          } catch (error) {
            setFeedback((error as Error).message);
            setTimeout(() => setFeedback(""), 5000);
          } finally {
            setBoqExtractLoading(false);
            setPendingBoqFile(null);
          }
        }

        if (drawingsSucceeded || boqSucceeded) {
          setReviewStepActive(true);
          setActiveEstimateStep("review");
        }
      } catch (error) {
        const errorMessage = (error as Error).message;
        setFeedback(errorMessage);
        setTimeout(() => setFeedback(""), 5000);
        if (hasDrawings) {
          setExtractedFiles([]);
        }
      } finally {
        setMatching(false);
        setProcessingAI(false);
        setLoadingStage(0);
        setAiProgressMessage("");
      }
    },
    [enrichBoqSizeAndCapacity, loadingMessages.length, matchingFiles, pendingBoqFile, parseGeminiItemsToExtractedItems]
  );

  const handleExtract = async (event: React.FormEvent, skipConfirm?: boolean) => {
    event.preventDefault();
    const hasDrawings = matchingFiles.length > 0;
    const hasBoq = !!pendingBoqFile;

    if (!hasDrawings && !hasBoq) {
      setFeedback("Upload a BOQ file to start a review (drawings optional).");
      setTimeout(() => setFeedback(""), 3000);
      return;
    }

    if (hasDrawings && !hasBoq && !skipConfirm) {
      setShowDrawingsOnlyConfirm(true);
      return;
    }

    await runExtract(hasDrawings, hasBoq);
  };

  const handleConfirmDrawingsOnly = useCallback(async () => {
    setShowDrawingsOnlyConfirm(false);
    await runExtract(true, false);
  }, [runExtract]);

  const handleCancelDrawingsOnly = useCallback(() => {
    setShowDrawingsOnlyConfirm(false);
  }, []);

  const updateDrawingItemField = useCallback(
    (fileIdx: number, itemIdx: number, field: keyof ExtractedItem, value: string) => {
      setExtractedFiles(prev => {
        if (!prev[fileIdx]) return prev;
        const next = [...prev];
        const file = next[fileIdx];
        const items = [...(file.items || [])];
        items[itemIdx] = { ...items[itemIdx], [field]: value };
        next[fileIdx] = { ...file, items };
        return next;
      });
      // Edited data invalidates previous comparisons
      setBoqResults(prev => ({ ...prev, comparisons: [] }));
      setComparisonSelections({});
      setComparisonChecked({});
    },
    []
  );

  const updateBoqItemField = useCallback(
    (itemIdx: number, field: keyof ExtractedItem, value: string) => {
      setBoqResults(prev => {
        const items = [...(prev.boqItems || [])];
        if (!items[itemIdx]) return prev;
        items[itemIdx] = { ...items[itemIdx], [field]: value };
        return { ...prev, boqItems: items, comparisons: [] };
      });
      setComparisonSelections({});
      setComparisonChecked({});
    },
    []
  );


  const hasAnyComparisonChecked = useMemo(
    () => boqResults.comparisons.some((_, idx) => comparisonChecked[idx]),
    [boqResults.comparisons, comparisonChecked]
  );
  const hasMissingComparisonSelection = useMemo(() => {
    let missing = false;
    boqResults.comparisons.forEach((row, idx) => {
      if (!comparisonChecked[idx]) return;
      if (row.status === "match_exact") return;
      const chosen = comparisonSelections[idx];
      if (!chosen) missing = true;
    });
    return missing;
  }, [boqResults.comparisons, comparisonChecked, comparisonSelections]);

  const getStepStatus = (stepId: EstimateStep): "complete" | "current" | "upcoming" => {
    const order = STEP_ORDER[stepId];
    if (order < STEP_ORDER[activeEstimateStep]) return "complete";
    if (order === STEP_ORDER[activeEstimateStep]) return "current";
    return "upcoming";
  };

  const canNavigateToStep = (stepId: EstimateStep) => {
    switch (stepId) {
      case "upload":
        return true;
      case "review":
        return reviewStepActive || hasDrawingData || hasBoqData;
      case "compare":
        return boqResults.comparisons.length > 0;
      case "finalize":
        return finalizeItems.length > 0 || activeEstimateStep === "finalize";
      case "pricing":
        return pricingSelections.length > 0 || finalizeItems.length > 0 || activeEstimateStep === "pricing";
      case "estimate":
        return pricingSelections.length > 0 || finalizeItems.length > 0 || activeEstimateStep === "estimate";
      default:
        return false;
    }
  };

  const computeTotalPrice = (unitPrice: string | number | undefined, quantity: string | undefined) => {
    const qty = Number(quantity ?? "0");
    const price = Number(unitPrice ?? "0");
    if (!Number.isFinite(qty) || !Number.isFinite(price)) return "";
    return (price * qty).toFixed(2);
  };

  const roundPrice = (value: string | number | undefined) => {
    if (value === undefined || value === null) return "";
    const num = Number(typeof value === "string" ? value.replace(/,/g, "") : value);
    if (!Number.isFinite(num)) return value.toString();
    return num.toFixed(2);
  };

  const computeTotalValue = (unitValue: string | number | undefined, quantity: string | undefined) => {
    const qty = Number(quantity ?? "0");
    const value = Number(unitValue ?? "0");
    if (!Number.isFinite(qty) || !Number.isFinite(value)) return "";
    return (value * qty).toFixed(2);
  };

  const parseNumeric = (value: string | number | undefined) => {
    if (value === undefined || value === null) return 0;
    const normalised = typeof value === "string" ? value.replace(/,/g, "") : value;
    const num = Number(normalised);
    return Number.isFinite(num) ? num : 0;
  };

  const formatNumber = (value: number) => {
    return Number.isFinite(value)
      ? value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "—";
  };

  const estimateTableRows = useMemo(() => {
    const rows: Array<{
      categoryCode?: string;
      category?: string;
      description?: string;
      finishes?: string;
      size?: string;
      quantity?: string;
      unit?: string;
      unitPrice?: string;
      totalPrice?: string;
    }> = [];

    const normalizeValue = (value: string | number | undefined) => {
      if (value === undefined || value === null) return "";
      return typeof value === "number" ? value.toString() : value;
    };

    pricingSelections.forEach((sel) => {
      const categoryCode = (sel.item.section_code || sel.item.section_name || "").trim().toUpperCase();
      rows.push({
        categoryCode,
        category: sel.item.section_name || sel.item.section_code || sel.item.item_type || "Items",
        description: sel.item.description || sel.item.full_description || sel.item.item_type,
        finishes: normalizeValue(sel.item.finishes),
        size: normalizeValue(sel.item.dimensions || sel.item.size),
        quantity: normalizeValue(sel.item.quantity),
        unit: normalizeValue(sel.item.unit),
        unitPrice: normalizeValue(sel.item.unit_price),
        totalPrice: normalizeValue(sel.item.total_price),
      });
    });

    electricalItems.forEach((row) => {
      rows.push({
        category: "Electrical",
        categoryCode: "G",
        description: row.item,
        finishes: "",
        size: "",
        quantity: row.qty,
        unit: "Unit",
        unitPrice: row.price,
        totalPrice: computeTotalPrice(row.price, row.qty),
      });
    });

    installationItems.forEach((row) => {
      rows.push({
        category: "Installation",
        categoryCode: "H",
        description: row.item,
        finishes: "",
        size: "",
        quantity: row.qty,
        unit: "Unit",
        unitPrice: row.price,
        totalPrice: computeTotalPrice(row.price, row.qty),
      });
    });

    venueItems.forEach((row) => {
      rows.push({
        category: "Venue services",
        categoryCode: "I",
        description: row.item,
        finishes: "",
        size: "",
        quantity: row.qty,
        unit: "Unit",
        unitPrice: row.price,
        totalPrice: computeTotalPrice(row.price, row.qty),
      });
    });

    return rows.filter((row) =>
      Object.values(row).some((value) => (value ?? "").toString().trim().length > 0)
    );
  }, [pricingSelections, electricalItems, installationItems, venueItems]);

  const estimateTotals = useMemo(() => {
    const totalCost = estimateTableRows.reduce((sum, row) => {
      return sum + parseNumeric(row.totalPrice);
    }, 0);
    return {
      totalCost,
    };
  }, [estimateTableRows]);

  const groupedEstimateRows = useMemo(
    () => {
      const groups: Record<string, { label: string; code?: string; rows: typeof estimateTableRows }> = {};
      estimateTableRows.forEach(row => {
        const code = (row.categoryCode || row.category || "").trim().toUpperCase();
        const section = DRAWING_SECTIONS.find(s => s.code === code);
        let label = section ? section.title : (row.category || "Other");
        let resolvedCode = section?.code || (code || undefined);
        if (!resolvedCode) {
          if (row.category === "Electrical") resolvedCode = "G";
          else if (row.category === "Installation") resolvedCode = "H";
          else if (row.category === "Venue services") resolvedCode = "I";
        }
        if (!groups[label]) groups[label] = { label, code: section?.code || code || undefined, rows: [] };
        groups[label].code = resolvedCode;
        groups[label].rows.push(row);
      });
      return Object.values(groups);
    },
    [estimateTableRows]
  );

  const groupedEstimateRowsWithIds = useMemo(
    () =>
      groupedEstimateRows.map(group => ({
        ...group,
        rows: group.rows.map((row, idx) => ({
          ...row,
          id: group.code ? `${group.code}.${idx + 1}` : `${idx + 1}`,
        })),
      })),
    [groupedEstimateRows]
  );

  const estimateInputStyle: React.CSSProperties = { height: "2.6rem" };
  const estimateInputPaddedStyle: React.CSSProperties = { ...estimateInputStyle, padding: "0.6rem 0.9rem" };

  const fetchLogoDataUrl = useCallback(async (): Promise<string> => {
    const candidates = [
      COMPANY_LOGO_URL,
      `${window.location.origin}${COMPANY_LOGO_URL}`,
      "/data/company.png",
      `${window.location.origin}/data/company.png`,
      "/company.png",
      `${window.location.origin}/company.png`,
    ];
    for (const url of candidates) {
      try {
        const response = await fetch(url, { cache: "no-cache" });
        if (!response.ok) continue;
        const blob = await response.blob();
        if (!blob.size) continue;
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : "");
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        if (dataUrl) return dataUrl;
      } catch {
        continue;
      }
    }
    return "";
  }, []);

  const handleGenerateEstimatePdf = useCallback(async () => {
    if (!groupedEstimateRowsWithIds.length) return;

    const quotationDate = new Date();
    const expirationDate = new Date();
    expirationDate.setDate(quotationDate.getDate() + 30);

    const formatDate = (date: Date) =>
      date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

    const tableRowsHtml = groupedEstimateRowsWithIds
      .map((group) => {
        const groupHeading = `
          <tr class="group-row">
            <td colspan="8">${group.label} ${group.code ? `(${group.code})` : ""} — ${group.rows.length} item(s)</td>
          </tr>
        `;
        const items = group.rows
          .map((row) => {
            return `
              <tr class="item-row">
                <td>${row.id || ""}</td>
                <td>${row.description || "—"}</td>
                <td>${row.finishes || "—"}</td>
                <td>${row.size || "—"}</td>
                <td>${row.quantity || "—"}</td>
                <td>${row.unit || "—"}</td>
                <td>${row.unitPrice || "—"}</td>
                <td>${row.totalPrice || "—"}</td>
              </tr>
            `;
          })
          .join("");
        return `${groupHeading}${items}`;
      })
      .join("");

    const summaryRowsHtml = `
      <tr class="summary-row">
        <td></td>
        <td class="summary-label">Total Cost</td>
        <td colspan="4"></td>
        <td></td>
        <td class="summary-value"><strong>${formatNumber(estimateTotals.totalCost)}</strong></td>
      </tr>
    `;

    const companyNameForPrint = estimateCompanyName || COMPANY_NAME;
    const contactNameForPrint = estimateContactName || CONTACT_NAME;
    const printableHtml = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Estimate</title>
          <style>
            @page {
              size: A4;
              margin: 12mm;
            }
            * { box-sizing: border-box; }
            body {
              margin: 12mm;
              font-family: "Segoe UI", Tahoma, sans-serif;
              color: #222;
            }
            .logo-banner {
              display: flex;
              justify-content: flex-start;
              align-items: center;
              margin-bottom: 8px;
            }
            .logo-banner img {
              height: 160px;
              object-fit: contain;
              display: block;
            }
            .logo-separator {
              border-bottom: 2px solid #b10d27;
              margin: 8px 0 12px 0;
            }
            .header {
              display: flex;
              justify-content: space-between;
              align-items: flex-start;
              gap: 16px;
              border-bottom: 2px solid #b10d27;
              padding-bottom: 12px;
            }
            .company-block {
              display: flex;
              gap: 12px;
              align-items: center;
            }
            .company-logo img {
              height: 60px;
              object-fit: contain;
            }
            .company-details {
              font-size: 12px;
              line-height: 1.4;
            }
            .quote-title {
              font-size: 24px;
              font-weight: 700;
              margin: 16px 0 6px 0;
              color: #000;
            }
            .meta-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
              gap: 8px 16px;
              margin-bottom: 16px;
              font-size: 12px;
            }
            .meta-grid strong {
              display: inline-block;
              min-width: 110px;
            }
            table {
              width: 100%;
              border-collapse: collapse;
              font-size: 11px;
            }
            thead th {
              text-align: left;
              border-bottom: 2px solid #b10d27;
              padding: 6px 5px;
              font-weight: 700;
              font-size: 11px;
            }
            tbody td {
              border-bottom: 1px solid #e4e7eb;
              padding: 5px;
              vertical-align: top;
            }
            tbody tr.group-row td {
              background: #f5f7fb;
              border-bottom: 1px solid #dce1ea;
              font-weight: 700;
              padding: 7px 6px;
            }
            tbody tr.item-row td:first-child {
              font-weight: 600;
            }
            tfoot td {
              padding: 5px;
            }
            .summary-row td {
              border-top: 1px solid #d7dce4;
            }
            .summary-label {
              font-weight: 600;
            }
            .summary-value {
              text-align: right;
            }
            .notes {
              margin-top: 18px;
              font-size: 11px;
              line-height: 1.45;
            }
            .right {
              text-align: right;
            }
            @media print {
              body { margin: 12mm; }
              .no-print { display: none; }
              thead { display: table-header-group; }
              tfoot { display: table-row-group; }
              tr { page-break-inside: avoid; }
            }
          </style>
        </head>
        <body>
          <div class="logo-banner">
            <img src="__LOGO_SRC__" alt="Company Logo" />
          </div>
          <div class="header">
            <div class="company-details">
              <div><strong>Company Name:</strong> ${companyNameForPrint}</div>
              <div><strong>Contact Name:</strong> ${contactNameForPrint}</div>
            </div>
            <div class="company-details">

              <div><strong>Project Name:</strong> ${estimateProjectName || "—"}</div>
              <div><strong>Subject:</strong> ${estimateSubject || "—"}</div>
            </div>
          </div>

          <div class="quote-title">Quotation #110000027</div>

          <div class="meta-grid">
            <div><strong>Quotation Date:</strong> ${formatDate(quotationDate)}</div>
            <div><strong>Expiration:</strong> ${formatDate(expirationDate)}</div>
            <div><strong>Salesperson:</strong> —</div>
          </div>

          <table>
            <thead>
              <tr>
                <th style="width: 36px;">S.N</th>
                <th style="min-width: 220px;">Description</th>
                <th style="min-width: 140px;">Finishes</th>
                <th style="min-width: 140px;">Dimensions</th>
                <th style="width: 70px;">Quantity</th>
                <th style="width: 60px;">Unit</th>
                <th style="width: 90px;">Unit Price</th>
                <th style="width: 100px;">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${tableRowsHtml}
            </tbody>
            <tfoot>
              ${summaryRowsHtml}
            </tfoot>
          </table>

          <div class="notes">
            <p><strong>Payment terms:</strong> 100% advance payment</p>
            <p><strong>Delivery Terms:</strong> DDP</p>
            <p><strong>Delivery Period:</strong> TBD</p>
            <p><strong>Scope of Work:</strong> Supply only</p>
            <p><strong>Important Notes:</strong> Prices are based on complete system supply under one PO. Partial orders or quantity changes may cause price revisions.</p>
          </div>
        </body>
      </html>
    `;

    const logoDataUrl = await fetchLogoDataUrl();
    const logoUrlForPrint =
      logoDataUrl || `${window.location.origin}${COMPANY_LOGO_URL}`;

    const waitForImages = (doc: Document, timeoutMs = 2500) =>
      new Promise<void>((resolve) => {
        try {
          const images = Array.from(doc.images || []);
          if (!images.length) return resolve();
          let loaded = 0;
          const done = () => {
            loaded += 1;
            if (loaded >= images.length) resolve();
          };
          images.forEach((img) => {
            if (img.complete) {
              done();
            } else {
              img.addEventListener("load", done, { once: true });
              img.addEventListener("error", done, { once: true });
            }
          });
          setTimeout(() => resolve(), timeoutMs);
        } catch {
          resolve();
        }
      });

    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.setAttribute("sandbox", "allow-same-origin allow-scripts allow-modals");
    document.body.appendChild(iframe);

    const frameDoc = iframe.contentWindow?.document;
    if (!frameDoc) return;
    frameDoc.open();
    frameDoc.write(printableHtml.replace(/__LOGO_SRC__/g, logoUrlForPrint));
    frameDoc.close();

    await waitForImages(frameDoc);

    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();

    setTimeout(() => {
      iframe.remove();
    }, 1000);
  }, [
    estimateCompanyName,
    estimateContactName,
    estimateTotals.totalCost,
    estimateProjectName,
    estimateSubject,
    fetchLogoDataUrl,
    formatNumber,
    groupedEstimateRowsWithIds,
  ]);

  const handleGenerateEstimateExcel = useCallback(() => {
    if (!groupedEstimateRowsWithIds.length) return;

    const header = ["Id", "Description", "Finishes", "Dimensions", "Quantity", "Unit", "Unit Price", "Amount"];
    const rows: Array<Array<string | number>> = [header];

    const toNumber = (value: string | number | undefined) => {
      if (value === undefined || value === null || value === "") return undefined;
      const normalised = typeof value === "string" ? value.replace(/,/g, "") : value;
      const num = Number(normalised);
      return Number.isFinite(num) ? num : undefined;
    };

    groupedEstimateRowsWithIds.forEach((group) => {
      rows.push([`${group.label}${group.code ? ` (${group.code})` : ""} — ${group.rows.length} item(s)`]);
      group.rows.forEach((row) => {
        rows.push([
          row.id || "",
          row.description || "—",
          row.finishes || "—",
          row.size || "—",
          toNumber(row.quantity) ?? row.quantity ?? "—",
          row.unit || "—",
          toNumber(row.unitPrice) ?? row.unitPrice ?? "—",
          toNumber(row.totalPrice) ?? row.totalPrice ?? "—",
        ]);
      });
    });

    rows.push(["", "Total Cost", "", "", "", "", "", toNumber(estimateTotals.totalCost) ?? estimateTotals.totalCost]);

    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet["!cols"] = [
      { wch: 8 },
      { wch: 40 },
      { wch: 24 },
      { wch: 20 },
      { wch: 12 },
      { wch: 10 },
      { wch: 14 },
      { wch: 16 },
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Estimate");
    XLSX.writeFile(workbook, "estimate.xlsx");
  }, [estimateTotals.totalCost, groupedEstimateRowsWithIds]);

  const handleGenerateEstimateFiles = useCallback(async () => {
    await handleGenerateEstimatePdf();
    handleGenerateEstimateExcel();
  }, [handleGenerateEstimateExcel, handleGenerateEstimatePdf]);

  const pickFieldFromRow = (
    row: Record<string, string | number> | undefined,
    patterns: RegExp[]
  ): string | undefined => {
    if (!row) return undefined;
    for (const [key, value] of Object.entries(row)) {
      if (patterns.some((re) => re.test(key))) {
        return typeof value === "number" ? value.toString() : String(value);
      }
    }
    return undefined;
  };

  const runPriceMapping = async (selections: Array<{ source: ItemSource; item: ExtractedItem }>) => {
    if (!selections.length) return;
    setPricingLoading(true);
    setPricingStatus("Matching items to price list with AI…");
    try {
      const resp = await priceMap(selections.map(s => s.item));
      console.log("priceMap response", resp);
      setPricingStatus("Applying matched prices and manhours…");
      if (resp?.mappings?.length) {
        const grouped = resp.mappings.reduce<Record<number, PriceMapping[]>>((acc, mapping) => {
          if (mapping.item_index === undefined || mapping.item_index === null) return acc;
          if (!acc[mapping.item_index]) acc[mapping.item_index] = [];
          const exists = acc[mapping.item_index].some(
            (m) => m.price_list_index === mapping.price_list_index
          );
          if (!exists) {
            acc[mapping.item_index].push(mapping);
          }
          return acc;
        }, {});
        setPricingMatchOptions(grouped);
        const defaultChoices: Record<number, number> = {};
        Object.keys(grouped).forEach((key) => {
          defaultChoices[Number(key)] = 0;
        });
        setPricingMatchChoice(defaultChoices);
        setPricingSelections(prev => {
          return prev.map((entry, idx) => {
            const match = grouped[idx]?.[0];
            if (!match) return entry;
            const row = match.price_row as Record<string, string | number> | undefined;
            const rowPrice = pickFieldFromRow(row, [/price/i]);
            const rowMh = pickFieldFromRow(row, [/manhour/i, /mh/i]);
            const nextUnitPriceRaw =
              match.unit_price !== undefined ? String(match.unit_price) : rowPrice ?? entry.item.unit_price;
            const nextUnitPrice = roundPrice(nextUnitPriceRaw);
            const nextUnitMh =
              match.unit_manhour !== undefined ? String(match.unit_manhour) : rowMh ?? entry.item.unit_manhour;
            return {
              ...entry,
              item: {
                ...entry.item,
                unit_price: nextUnitPrice,
                unit_manhour: nextUnitMh,
                total_price: computeTotalPrice(nextUnitPrice, entry.item.quantity),
                total_manhour: computeTotalValue(nextUnitMh, entry.item.quantity),
              },
            };
          });
        });
        setPricingStatus("Pricing data filled for matched items.");
      } else {
        setPricingStatus("No price list matches returned.");
      }
    } catch (error) {
      console.error("price map failed", error);
      setFeedback((error as Error).message || "Failed to map prices.");
      setTimeout(() => setFeedback(""), 3500);
    } finally {
      setTimeout(() => setPricingStatus(""), 2000);
      setPricingLoading(false);
    }
  };


  const handleStepChange = (stepId: EstimateStep) => {
    if (stepId === activeEstimateStep) return;
    if (!canNavigateToStep(stepId)) {
      setFeedback("This step is not ready yet.");
      setTimeout(() => setFeedback(""), 2500);
      return;
    }
    setActiveEstimateStep(stepId);
  };

  const handleGoToPricing = () => {
    if (finalizeItems.length === 0) {
      setFeedback("Add items before going to pricing.");
      setTimeout(() => setFeedback(""), 2500);
      return;
    }
    const nextSelections = finalizeItems.map((entry) => ({ item: entry.item, source: entry.source }));
    setPricingSelections(nextSelections);
    setActiveEstimateStep("pricing");
    void runPriceMapping(nextSelections);
  };

  const handlePricingItemChange = (idx: number, field: keyof ExtractedItem, value: string) => {
    setPricingSelections(prev => {
      const next = [...prev];
      if (!next[idx]) return prev;
      const nextValue = field === "unit_price" ? roundPrice(value) : value;
      const updatedItem = { ...next[idx].item, [field]: nextValue };
      if (field === "unit_price" || field === "quantity") {
        updatedItem.total_price = computeTotalPrice(updatedItem.unit_price, updatedItem.quantity);
      }
      if (field === "unit_manhour" || field === "quantity") {
        updatedItem.total_manhour = computeTotalValue(updatedItem.unit_manhour, updatedItem.quantity);
      }
      next[idx] = { ...next[idx], item: updatedItem };
      return next;
    });
  };

  const handlePriceListSearchChange = (rowIdx: number, query: string) => {
    setPriceListSearch(prev => ({ ...prev, [rowIdx]: query }));
  };

  const handleApplyPriceListRow = (rowIdx: number, priceListIndex: number) => {
    const row = priceList[priceListIndex];
    if (!row) return;
    const mapping: PriceMapping = {
      item_index: rowIdx,
      price_list_index: priceListIndex,
      price_row: row,
    };
    let nextChoice = 0;
    setPricingMatchOptions(prev => {
      const existing = prev[rowIdx] || [];
      const foundIdx = existing.findIndex(m => m.price_list_index === priceListIndex);
      if (foundIdx >= 0) {
        nextChoice = foundIdx;
        return prev;
      }
      nextChoice = existing.length;
      return { ...prev, [rowIdx]: [...existing, mapping] };
    });
    setPricingMatchChoice(prev => ({ ...prev, [rowIdx]: nextChoice }));
    applyPriceMappingToRow(rowIdx, mapping);
    setPriceListSearch(prev => ({ ...prev, [rowIdx]: "" }));
    setPricingDropdownOpen((prev) => ({ ...prev, [rowIdx]: false }));
  };

  const handlePricingMatchChange = (rowIdx: number, optionIdx: number) => {
    const options = pricingMatchOptions[rowIdx];
    if (!options || !options[optionIdx]) return;
    setPricingMatchChoice((prev) => ({ ...prev, [rowIdx]: optionIdx }));
    const match = options[optionIdx];
    applyPriceMappingToRow(rowIdx, match);
  };

  const handleProceedFromReview = async () => {
    const drawingSelection = hasDrawingData ? getSelectedDrawingItems() : [];
    const boqSelection = hasBoqData ? getSelectedBoqItems() : [];

    if (hasDrawingData && hasBoqData) {
      await handleRunCompare(drawingSelection, boqSelection);
      return;
    }
    const sourceItems = hasDrawingData ? drawingSelection : boqSelection;
    const source: ItemSource = hasDrawingData ? "drawing" : "boq";
    setFinalizeItems(sourceItems.map(item => buildFinalizeEntry(item, source)));
    setActiveEstimateStep("finalize");
  };

  // Lock body scroll when modal is open
  useEffect(() => {
    if (electricalModalOpen) {
      document.body.classList.add("modal-open");
    } else {
      document.body.classList.remove("modal-open");
    }
    return () => document.body.classList.remove("modal-open");
  }, [electricalModalOpen]);

  const handleRunCompare = async (drawingItemsParam?: ExtractedItem[], boqItemsParam?: ExtractedItem[]) => {
    const drawingItems = drawingItemsParam ?? getSelectedDrawingItems();
    const boqItems = boqItemsParam ?? getSelectedBoqItems();
    if (!drawingItems.length || !boqItems.length) return;
    setBoqCompareLoading(true);
    setCompareStage(0);
    const stageInterval = setInterval(() => {
      setCompareStage((prev) => {
        if (prev >= compareMessages.length - 1) {
          clearInterval(stageInterval);
          return prev;
        }
        return prev + 1;
      });
    }, 2500);
    try {
      const compareResp = await compareLists(drawingItems, boqItems);
      const raw = compareResp.rawContent;
      let comparisons = compareResp.comparisons || [];
      if ((!comparisons || comparisons.length === 0) && raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            comparisons = parsed as any;
          } else if (parsed.comparisons || parsed.matches || parsed.result) {
            comparisons = parsed.comparisons || parsed.matches || parsed.result || [];
          }
        } catch (e) {
          console.warn("Failed to parse raw comparison content", e);
        }
      }
      setBoqResults((prev) => ({
        ...prev,
        comparisons: comparisons || [],
      }));
      setFeedback("Comparison completed.");
      setTimeout(() => setFeedback(""), 3000);
      setActiveEstimateStep("compare");
    } catch (error) {
      setFeedback((error as Error).message);
      setTimeout(() => setFeedback(""), 5000);
    } finally {
      setBoqCompareLoading(false);
      clearInterval(stageInterval);
      setCompareStage(0);
    }
  };

  return (
    <div className={`app-shell ${isSidebarOpen ? "sidebar-open" : "sidebar-collapsed"}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__icon">
            <img
              src="/logo2.png"
              alt="Logo"
              style={{ width: "34px", height: "34px", objectFit: "contain" }}
            />
          </div>
          <div>
            <p className="brand__title">AI Powered Estimation System</p>
          </div>
        </div>

        <nav className="sidebar__nav">
          <button
            type="button"
            className={`nav-link ${activePage === "new-estimate" ? "is-active" : ""}`}
            onClick={handleStartNewEstimate}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="M10 6v8M6 10h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>New Estimate</span>
          </button>
          <button
            type="button"
            className={`nav-link ${activePage === "drafts" ? "is-active" : ""}`}
            onClick={() => setActivePage("drafts")}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M4 5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z" stroke="currentColor" strokeWidth="2" />
              <path d="M7 8h6M7 12h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>My Drafts</span>
          </button>
          <button
            type="button"
            className={`nav-link ${activePage === "drawing-prompt" ? "is-active" : ""}`}
            onClick={() => setActivePage("drawing-prompt")}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M4 13.5V16h2.5L15 7.5 12.5 5 4 13.5z" stroke="currentColor" strokeWidth="2" />
              <path d="M11 4l2.5 2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>Drawing Prompt</span>
          </button>
        </nav>
        <div className="sidebar__footer" style={{ marginTop: "auto", padding: "1rem 0 0.5rem", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <p className="eyebrow" style={{ marginBottom: "0.25rem" }}>Draft</p>
          <p className="status" style={{ margin: 0 }}>
            {draftStatus === "saving"
              ? "Saving..."
              : draftStatus === "error"
                ? "Save failed"
                : draftStatus === "saved" && lastDraftSavedAt
                  ? `Saved ${new Date(lastDraftSavedAt).toLocaleTimeString()}`
                  : "Not saved yet"}
          </p>
        </div>
      </aside>
      <main
        className="content"
        style={
          activePage === "landingai-review"
            ? {
              padding: 0,
              maxWidth: "none",
              height: "100vh",
              overflow: "hidden",
            }
            : isPrepareStep
              ? {
                maxWidth: "none",
                height: "100vh",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                padding: "1rem",
                boxSizing: "border-box",
              }
              : undefined
        }
      >
        {processingMessage && (
          <div className="processing-overlay">
            <div className="processing-indicator">
              <div className="processing-indicator__spinner">
                <svg width="40" height="40" viewBox="0 0 40 40" className="spinner">
                  <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="80" strokeDashoffset="20" strokeLinecap="round" />
                </svg>
              </div>
              <div className="processing-indicator__text">
                <p className="processing-indicator__message">{processingMessage}</p>
                {matching && (
                  <div className="processing-indicator__progress">
                    <div className="progress-bar">
                      <div
                        className="progress-bar__fill"
                        style={{ width: `${Math.min(((loadingStage + 1) / loadingMessages.length) * 100, 100)}%` }}
                      />
                    </div>
                    <span className="progress-text">Step {Math.min(loadingStage + 1, loadingMessages.length)} of {loadingMessages.length}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {boqCompareLoading && (
          <div className="processing-overlay" style={{ zIndex: 3500 }}>
            <div className="processing-indicator">
              <div className="processing-indicator__spinner">
                <svg width="40" height="40" viewBox="0 0 40 40" className="spinner">
                  <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="80" strokeDashoffset="20" strokeLinecap="round" />
                </svg>
              </div>
              <div className="processing-indicator__text">
                <p className="processing-indicator__message">{compareMessages[compareStage] || compareMessages[0]}</p>
                <div className="processing-indicator__progress">
                  <div className="progress-bar">
                    <div className="progress-bar__fill" style={{ width: `${((compareStage + 1) / compareMessages.length) * 100}%` }} />
                  </div>
                  <span className="progress-text">Step {compareStage + 1} of {compareMessages.length}</span>
                </div>
              </div>
            </div>
          </div>
        )}
        {pricingLoading && (
          <div className="processing-overlay" style={{ zIndex: 3600 }}>
            <div className="processing-indicator">
              <div className="processing-indicator__spinner">
                <svg width="40" height="40" viewBox="0 0 40 40" className="spinner">
                  <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="80" strokeDashoffset="20" strokeLinecap="round" />
                </svg>
              </div>
              <div className="processing-indicator__text">
                <p className="processing-indicator__message">{pricingStatus || "Getting pricing from AI…"}</p>
              </div>
            </div>
          </div>
        )}

        {activePage === "landingai-review" && landingAiReviewData && (
          <LandingAiReview
            pdfUrl={landingAiReviewData.pdfUrl}
            landingAiRaw={landingAiReviewData.raw}
            fileName={landingAiReviewData.fileName}
            onBack={() => {
              setLandingAiReviewData(null);
              setActivePage("new-estimate");
              setReviewStepActive(true);
              setActiveEstimateStep("review");
            }}
          />
        )}

        {activePage !== "landingai-review" && (
          <>
            <header className="hero">
              <div>
                <h1>{heroTitle}</h1>
              </div>
              <div style={{ position: "relative" }} ref={userMenuRef}>
                <button
                  type="button"
                  onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
                  className="user-menu-trigger"
                  aria-label="User menu"
                  aria-expanded={isUserMenuOpen}
                >
                  <div className="user-avatar">
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                      <circle cx="10" cy="7" r="3" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M4 17c0-3.314 2.686-6 6-6s6 2.686 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </div>
                  <span className="user-menu-username">{user?.username || "User"}</span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    style={{
                      transform: isUserMenuOpen ? "rotate(180deg)" : "rotate(0deg)",
                      transition: "transform 0.2s ease"
                    }}
                  >
                    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {isUserMenuOpen && (
                  <div className="user-menu-dropdown">
                    <div className="user-menu-header">
                      <div className="user-avatar user-avatar--large">
                        <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                          <circle cx="10" cy="7" r="3" stroke="currentColor" strokeWidth="1.5" />
                          <path d="M4 17c0-3.314 2.686-6 6-6s6 2.686 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </div>
                      <div className="user-menu-info">
                        <p className="user-menu-name">{user?.username || "User"}</p>
                        <p className="user-menu-email">{user?.email || ""}</p>
                      </div>
                    </div>
                    <div className="user-menu-divider"></div>
                    <button
                      type="button"
                      className="user-menu-item user-menu-item--danger"
                      onClick={async () => {
                        setIsUserMenuOpen(false);
                        await logout();
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
                        <path d="M6 2H4a2 2 0 00-2 2v12a2 2 0 002 2h2M12 2h2a2 2 0 012 2v12a2 2 0 01-2 2h-2M6 9h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span>Logout</span>
                    </button>
                  </div>
                )}
              </div>
            </header>

            {activePage === "new-estimate" && (
              <div className="stepper" role="navigation" aria-label="Estimate workflow">
                {ESTIMATE_STEPS.map((step, idx) => {
                  const status = getStepStatus(step.id);
                  const isClickable = canNavigateToStep(step.id);
                  return (
                    <div className="stepper__segment" key={step.id}>
                      <button
                        type="button"
                        className={`stepper__item stepper__item--${status} ${isClickable ? "is-clickable" : "is-disabled"}`}
                        onClick={() => handleStepChange(step.id)}
                        disabled={!isClickable}
                        aria-current={status === "current" ? "step" : undefined}
                      >
                        <span className={`stepper__circle ${status === "complete" ? "is-complete" : ""}`}>
                          {status === "complete" ? (
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path d="M4 8l3 3 5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : (
                            idx + 1
                          )}
                        </span>
                        <span className="stepper__meta">
                          <span className="stepper__label">{step.label}</span>
                          <span className="stepper__desc">{step.description}</span>
                        </span>
                      </button>
                      {idx < ESTIMATE_STEPS.length - 1 && (
                        <div
                          className={`stepper__connector ${STEP_ORDER[step.id] < STEP_ORDER[activeEstimateStep] ? "is-complete" : ""}`}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div style={isPrepareStep ? { flex: 1, minHeight: 0, overflow: "hidden" } : undefined}>

              {activePage === "drawing-prompt" && (
                <section id="drawing-prompt" className="panel">
                  <div className="panel__header">
                    <div>
                      <p className="eyebrow">OpenAI</p>
                      <h2>Drawing Extraction Prompt</h2>
                      <p className="eyebrow" style={{ opacity: 0.7, marginTop: "0.35rem" }}>
                        Used when extracting items from drawings or BOQ images.
                      </p>
                    </div>
                    <div className="upload-actions" style={{ gap: "0.5rem", flexDirection: "column", alignItems: "flex-end" }}>
                      <span className="status" style={{ fontSize: "0.9rem" }}>
                        {drawingPromptSaving
                          ? "Saving..."
                          : drawingPromptDirty
                            ? "Unsaved changes"
                            : drawingPromptUpdatedAt
                              ? `Last updated ${new Date(drawingPromptUpdatedAt).toLocaleString()}`
                              : "Using default prompt"}
                      </span>
                      <div style={{ display: "flex", gap: "0.5rem" }}>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => loadDrawingPrompt()}
                          disabled={drawingPromptLoading || drawingPromptSaving}
                        >
                          Reload
                        </button>
                        <button
                          type="button"
                          className="btn-match"
                          onClick={handleDrawingPromptSave}
                          disabled={drawingPromptLoading || drawingPromptSaving || !drawingPromptDirty}
                        >
                          {drawingPromptSaving ? "Saving…" : "Save prompt"}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="panel__body">
                    {drawingPromptLoading ? (
                      <div className="loading-container">
                        <div className="loading-spinner">
                          <svg width="48" height="48" viewBox="0 0 48 48" className="spinner">
                            <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="100" strokeDashoffset="25" strokeLinecap="round" />
                          </svg>
                        </div>
                        <p className="loading-text">Loading prompt...</p>
                      </div>
                    ) : (
                      <>
                        {drawingPromptError && (
                          <div className="error-text" style={{ color: "#ffb6b6", marginBottom: "0.75rem" }}>
                            {drawingPromptError}
                          </div>
                        )}
                        <div className="form-group">
                          <label htmlFor="drawingPrompt">OpenAI prompt</label>
                          <textarea
                            id="drawingPrompt"
                            className="form-input"
                            style={{ minHeight: "360px", fontFamily: "monospace", lineHeight: "1.4" }}
                            value={drawingPrompt}
                            onChange={(event) => {
                              setDrawingPrompt(event.target.value);
                              setDrawingPromptDirty(true);
                            }}
                            placeholder="Enter the prompt used to extract items from drawings"
                          />
                        </div>
                      </>
                    )}
                  </div>
                </section>
              )}

              {activePage === "drafts" && (
                <section id="drafts" className="panel">
                  <div className="panel__header">
                    <div>
                      <p className="eyebrow">Drafts</p>
                      <h2>My Drafts</h2>
                    </div>
                    <div className="upload-actions" style={{ gap: "0.5rem" }}>
                      <button type="button" onClick={() => refreshDrafts()} disabled={draftsLoading}>
                        {draftsLoading ? "Refreshing…" : "Refresh"}
                      </button>
                    </div>
                  </div>

                  {draftsLoading ? (
                    <div className="loading-container">
                      <div className="loading-spinner">
                        <svg width="48" height="48" viewBox="0 0 48 48" className="spinner">
                          <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="100" strokeDashoffset="25" strokeLinecap="round" />
                        </svg>
                      </div>
                      <p className="loading-text">Loading drafts...</p>
                    </div>
                  ) : drafts.length === 0 ? (
                    <p className="empty-state">No drafts saved yet. Start an estimate to create one.</p>
                  ) : (
                    <div className="table-wrapper table-wrapper--no-x">
                      <table className="kb-table kb-table--compact resizable-table">
                        <thead>
                          <tr>
                            <ResizableTh resize={kbResize} index={0} className="kb-table__col-filename">Name</ResizableTh>
                            <ResizableTh resize={kbResize} index={1} className="kb-table__col-date">Last Updated</ResizableTh>
                            <ResizableTh resize={kbResize} index={2}>Step</ResizableTh>
                          </tr>
                        </thead>
                        <tbody>
                          {drafts.map((draft) => {
                            const isSelected = selectedDraftId === draft.id;
                            return (
                              <tr
                                key={draft.id}
                                onClick={() => setSelectedDraftId(draft.id)}
                                className={`kb-table__row ${isSelected ? "is-active" : ""}`}
                                style={isSelected ? { backgroundColor: "rgba(76,110,245,0.08)" } : undefined}
                              >
                                <td className="kb-table__filename">{renderCell(draft.name)}</td>
                                <td className="kb-table__date">{renderCell(new Date(draft.updatedAt).toLocaleString())}</td>
                                <td>{renderCell(draft.step)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="panel__footer" style={{ justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      className="btn-match"
                      onClick={handleContinueDraft}
                      disabled={!selectedDraftId || loadingDraft}
                    >
                      {loadingDraft ? "Opening…" : "Continue"}
                    </button>
                  </div>
                </section>
              )}

              {activePage === "new-estimate" && activeEstimateStep === "review" && (
                <section id="review" className="panel">
                  <div className="panel__header">
                    <div>
                      <h2 className="review-title">Review Extraction</h2>
                    </div>
                    <div className="upload-actions">
                      <button
                        type="button"
                        className="btn-match"
                        onClick={handleProceedFromReview}
                        disabled={boqCompareLoading || boqEnrichLoading}
                      >
                        {boqEnrichLoading
                          ? "Completing BOQ…"
                          : hasDrawingData && hasBoqData
                            ? "Compare"
                            : "Finalize items"}
                      </button>
                    </div>
                  </div>
                  <div className="review-grid">
                    {hasDrawingData && (
                      <div className="review-block">
                        <p className="eyebrow">Extracted Items from Drawings</p>
                        <div className="table-toolbar">
                          <span className="table-count">Selected {drawingSelectedCount} / {filteredDrawingReviewRows.length}</span>
                          <div className="table-toolbar__actions" style={{ gap: "0.5rem" }}>
                            <input
                              className="form-input form-input--table"
                              placeholder="Search description…"
                              value={drawingSearch}
                              onChange={(e) => setDrawingSearch(e.target.value)}
                              style={{ width: "240px" }}
                            />
                            <button type="button" className="btn-ghost" onClick={() => setAllDrawingSelection(true)}>Check all</button>
                            <button type="button" className="btn-ghost" onClick={() => setAllDrawingSelection(false)}>Uncheck all</button>
                          </div>
                        </div>
                        <div className="table-wrapper">
                          <table className="matches-table resizable-table">
                            <thead>
                              <tr>
                                <th className="checkbox-col"></th>
                                <th>No.</th>
                                <th className="col--description">Description</th>
                                <th className="col--finishes">Finishes</th>
                                <th className="col--dimensions">Dimensions</th>
                                <th className="col--qty">Quantity</th>
                                <th className="col--uom">UOM</th>
                              </tr>
                            </thead>
                            {drawingSections.map(section => (
                              <tbody key={section.code || section.title}>
                                <tr className="matches-table__section-row">
                                  <td colSpan={7} style={{ fontWeight: 600, background: "rgba(76,110,245,0.08)" }}>
                                    {section.title} {section.code && `(${section.code})`} — {section.rows.length ? `${section.rows.length} item(s)` : "No items"}
                                  </td>
                                </tr>
                                {section.rows.length ? (
                                  section.rows.map(({ item, fileIdx, itemIdx, key }) => {
                                    const isSelected = !!selectedDrawingRows[key];
                                    const handleRowClick = (event: React.MouseEvent<HTMLTableRowElement>) => {
                                      const target = event.target as HTMLElement;
                                      if (target.closest("input, textarea, button, select")) return;
                                      setSelectedDrawingRows(prev => ({ ...prev, [key]: !prev[key] }));
                                    };
                                    const displayNumber = item.item_no || item.item_number || item.section_code || section.code || "—";
                                    return (
                                      <tr
                                        key={key}
                                        className={`matches-table__row ${isSelected ? "is-selected" : ""}`}
                                        onClick={handleRowClick}
                                      >
                                        <td className="checkbox-col">
                                          <input
                                            type="checkbox"
                                            checked={isSelected}
                                            onChange={(e) => {
                                              e.stopPropagation();
                                              const checked = e.target.checked;
                                              setSelectedDrawingRows(prev => ({ ...prev, [key]: checked }));
                                            }}
                                          />
                                        </td>
                                        <td className="finalize-col finalize-col--number">
                                          <span className="cell-text" title={displayNumber}>{displayNumber}</span>
                                        </td>
                                        <td className="finalize-col finalize-col--description finalize-col--description-narrow" title={item.description || item.full_description || ""}>
                                          <textarea
                                            className="form-input form-input--table finalize-textarea"
                                            value={item.description || item.full_description || ""}
                                            onChange={(e) => {
                                              e.stopPropagation();
                                              updateDrawingItemField(fileIdx, itemIdx, "description", e.target.value);
                                            }}
                                            placeholder="Description"
                                            rows={1}
                                          />
                                        </td>
                                        <td className="finalize-col finalize-col--finishes finalize-col--finishes-wide" title={item.finishes || ""}>
                                          <input
                                            className="form-input form-input--table"
                                            value={item.finishes || ""}
                                            onChange={(e) => {
                                              e.stopPropagation();
                                              updateDrawingItemField(fileIdx, itemIdx, "finishes", e.target.value);
                                            }}
                                            placeholder="Finishes"
                                          />
                                        </td>
                                        <td className="finalize-col finalize-col--dimensions finalize-col--dimensions-wide" title={item.dimensions || item.size || ""}>
                                          <input
                                            className="form-input form-input--table"
                                            value={item.dimensions || item.size || ""}
                                            onChange={(e) => {
                                              e.stopPropagation();
                                              updateDrawingItemField(fileIdx, itemIdx, "dimensions", e.target.value);
                                              updateDrawingItemField(fileIdx, itemIdx, "size", e.target.value);
                                            }}
                                            placeholder="Dimensions"
                                          />
                                        </td>
                                        <td className="finalize-col finalize-col--qty">
                                          <input
                                            className="form-input form-input--table"
                                            value={item.quantity || ""}
                                            onChange={(e) => {
                                              e.stopPropagation();
                                              updateDrawingItemField(fileIdx, itemIdx, "quantity", e.target.value);
                                            }}
                                            placeholder="Qty"
                                          />
                                        </td>
                                        <td className="finalize-col finalize-col--unit">
                                          <input
                                            className="form-input form-input--table"
                                            value={item.unit || ""}
                                            onChange={(e) => {
                                              e.stopPropagation();
                                              updateDrawingItemField(fileIdx, itemIdx, "unit", e.target.value);
                                            }}
                                            placeholder="UOM"
                                          />
                                        </td>
                                      </tr>
                                    );
                                  })
                                ) : (
                                  <tr>
                                    <td colSpan={7} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>
                                      No drawing items detected in this section.
                                    </td>
                                  </tr>
                                )}
                              </tbody>
                            ))}
                          </table>
                        </div>
                      </div>
                    )}

                    {hasBoqData && (
                      <div className="review-block">
                        <p className="eyebrow">Extracted BOQ Items</p>
                        <div className="table-toolbar">
                          <span className="table-count">Selected {boqSelectedCount} / {filteredBoqReviewRows.length}</span>
                          <div className="table-toolbar__actions" style={{ gap: "0.5rem" }}>
                            <input
                              className="form-input form-input--table"
                              placeholder="Search description…"
                              value={boqSearch}
                              onChange={(e) => setBoqSearch(e.target.value)}
                              style={{ width: "240px" }}
                            />
                            <button type="button" className="btn-ghost" onClick={() => setAllBoqSelection(true)}>Check all</button>
                            <button type="button" className="btn-ghost" onClick={() => setAllBoqSelection(false)}>Uncheck all</button>
                          </div>
                        </div>
                        <div className="table-wrapper table-wrapper--no-x">
                          <table className="matches-table resizable-table">
                            <thead>
                              <tr>
                                <th className="checkbox-col"></th>
                                <th className="col--description">No.</th>
                                <th className="col--description">Description</th>
                                <th className="col--finishes">Finishes</th>
                                <th className="col--dimensions">Dimensions</th>
                                <th className="col--qty">Quantity</th>
                                <th className="col--uom">UOM</th>
                              </tr>
                            </thead>
                            <tbody>
                              {filteredBoqReviewRows.length ? (
                                filteredBoqReviewRows.map(({ item, itemIdx, key }) => {
                                  const isSelected = !!selectedBoqRows[key];
                                  const handleRowClick = (event: React.MouseEvent<HTMLTableRowElement>) => {
                                    const target = event.target as HTMLElement;
                                    if (target.closest("input, textarea, button, select")) return;
                                    setSelectedBoqRows(prev => ({ ...prev, [key]: !prev[key] }));
                                  };
                                  const displayNumber = item.item_no || item.item_number || "—";
                                  return (
                                    <tr
                                      key={key}
                                      className={`matches-table__row ${isSelected ? "is-selected" : ""}`}
                                      onClick={handleRowClick}
                                    >
                                      <td className="checkbox-col">
                                        <input
                                          type="checkbox"
                                          checked={isSelected}
                                          onChange={(e) => {
                                            e.stopPropagation();
                                            const checked = e.target.checked;
                                            setSelectedBoqRows(prev => ({ ...prev, [key]: checked }));
                                          }}
                                        />
                                      </td>
                                      <td className="finalize-col finalize-col--number">
                                        <span className="cell-text" title={displayNumber}>{displayNumber}</span>
                                      </td>
                                      <td className="finalize-col finalize-col--description finalize-col--description-narrow" title={item.description || item.full_description || ""}>
                                        <textarea
                                          className="form-input form-input--table finalize-textarea"
                                          value={item.description || item.full_description || ""}
                                          onChange={(e) => {
                                            e.stopPropagation();
                                            updateBoqItemField(itemIdx, "description", e.target.value);
                                          }}
                                          placeholder="Description"
                                          rows={1}
                                        />
                                      </td>
                                      <td className="finalize-col finalize-col--finishes finalize-col--finishes-wide" title={item.finishes || ""}>
                                        <input
                                          className="form-input form-input--table"
                                          value={item.finishes || ""}
                                          onChange={(e) => {
                                            e.stopPropagation();
                                            updateBoqItemField(itemIdx, "finishes", e.target.value);
                                          }}
                                          placeholder="Finishes"
                                        />
                                      </td>
                                      <td className="finalize-col finalize-col--dimensions finalize-col--dimensions-wide" title={item.dimensions || item.size || ""}>
                                        <input
                                          className="form-input form-input--table"
                                          value={item.dimensions || item.size || ""}
                                          onChange={(e) => {
                                            e.stopPropagation();
                                            updateBoqItemField(itemIdx, "dimensions", e.target.value);
                                            updateBoqItemField(itemIdx, "size", e.target.value);
                                          }}
                                          placeholder="Dimensions"
                                        />
                                      </td>
                                      <td className="finalize-col finalize-col--qty">
                                        <input
                                          className="form-input form-input--table"
                                          value={item.quantity || ""}
                                          onChange={(e) => {
                                            e.stopPropagation();
                                            updateBoqItemField(itemIdx, "quantity", e.target.value);
                                          }}
                                          placeholder="Qty"
                                        />
                                      </td>
                                      <td className="finalize-col finalize-col--unit">
                                        <input
                                          className="form-input form-input--table"
                                          value={item.unit || ""}
                                          onChange={(e) => {
                                            e.stopPropagation();
                                            updateBoqItemField(itemIdx, "unit", e.target.value);
                                          }}
                                          placeholder="UOM"
                                        />
                                      </td>
                                    </tr>
                                  );
                                })
                              ) : (
                                <tr>
                                  <td colSpan={6} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>
                                    No BOQ items match this description search.
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {activePage === "new-estimate" && activeEstimateStep === "compare" && (
                <section id="compare" className="panel">
                  <div className="panel__header">
                    <div>
                      <p className="eyebrow">Comparison</p>
                      <h2>Press on a row to include, or choose the source from the dropdown</h2>
                    </div>
                  </div>
                  {boqResults.comparisons.length > 0 ? (
                    <>
                      <div className="table-wrapper table-wrapper--no-x" style={{ marginTop: "1.25rem" }}>
                        <table className="matches-table resizable-table compare-table">
                          <thead>
                            <tr>
                              <th />
                              <ResizableTh resize={comparisonResize} index={0}>BOQ item</ResizableTh>
                              <ResizableTh resize={comparisonResize} index={1}>Drawing item</ResizableTh>
                              <ResizableTh resize={comparisonResize} index={2} className="compare-action-col">Action</ResizableTh>
                            </tr>
                          </thead>
                          <tbody>
                            {boqResults.comparisons.map((row, idx) => (
                              <tr key={`combined-compare-${idx}`} className={getComparisonClass(row.status)}>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={!!comparisonChecked[idx]}
                                    onChange={(e) => handleComparisonCheck(idx, e.target.checked)}
                                  />
                                </td>
                                <td
                                  className={`selectable-cell ${row.boq_item ? "is-clickable" : "is-disabled"} ${comparisonSelections[idx] === "boq" ? "is-selected" : ""
                                    }`}
                                  onClick={() => handleComparisonCellSelect(idx, "boq", !!row.boq_item)}
                                >
                                  {renderCell(
                                    row.boq_item
                                      ? `${row.boq_item.description || "—"} (${row.boq_item.quantity || "?"} ${row.boq_item.unit || ""}${row.boq_item.size ? `, ${row.boq_item.size}` : ""})`
                                      : "—"
                                  )}
                                </td>
                                <td
                                  className={`selectable-cell ${row.drawing_item ? "is-clickable" : "is-disabled"} ${comparisonSelections[idx] === "drawing" ? "is-selected" : ""
                                    }`}
                                  onClick={() => handleComparisonCellSelect(idx, "drawing", !!row.drawing_item)}
                                >
                                  {renderCell(
                                    row.drawing_item
                                      ? `${row.drawing_item.description || "—"} (${row.drawing_item.quantity || "?"} ${row.drawing_item.unit || ""}${row.drawing_item.size ? `, ${row.drawing_item.size}` : ""})`
                                      : "—"
                                  )}
                                </td>
                                <td className="compare-action-col">
                                  <select
                                    className="form-input form-input--table"
                                    value={comparisonSelections[idx] || ""}
                                    onChange={(e) => handleComparisonSelect(idx, e.target.value as "drawing" | "boq")}
                                  >
                                    <option value="">Choose source</option>
                                    {row.boq_item && <option value="boq">Select from BOQ</option>}
                                    {row.drawing_item && <option value="drawing">Select from Drawings</option>}
                                  </select>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="table-actions" style={{ paddingTop: "0.75rem" }}>
                        <button
                          type="button"
                          className={`btn-match ${hasAnyComparisonChecked && hasMissingComparisonSelection ? "is-disabled" : ""}`}
                          onClick={() => {
                            if (hasAnyComparisonChecked && hasMissingComparisonSelection) {
                              setFeedback("Choose a source (BOQ or Drawing) for each selected row.");
                              setTimeout(() => setFeedback(""), 3000);
                              return;
                            }
                            const selections: Array<{ item: ExtractedItem; source: "drawing" | "boq" }> = [];
                            let missingSource = false;
                            boqResults.comparisons.forEach((row, idx) => {
                              if (!comparisonChecked[idx]) return;
                              const chosen = comparisonSelections[idx];
                              if (chosen === "boq" && row.boq_item) {
                                selections.push(buildFinalizeEntry(row.boq_item, "boq", row.drawing_item || undefined));
                                return;
                              }
                              if (chosen === "drawing" && row.drawing_item) {
                                selections.push(buildFinalizeEntry(row.drawing_item, "drawing", row.boq_item || undefined));
                                return;
                              }

                              // Fallbacks when no selection provided
                              if (row.status === "match_exact") {
                                if (row.boq_item) {
                                  selections.push(buildFinalizeEntry(row.boq_item, "boq", row.drawing_item || undefined));
                                  return;
                                }
                                if (row.drawing_item) {
                                  selections.push(buildFinalizeEntry(row.drawing_item, "drawing", row.boq_item || undefined));
                                  return;
                                }
                              }

                              missingSource = true;
                            });
                            if (missingSource) {
                              setFeedback("Select source for all checked rows (unless they are auto-matched).");
                              setTimeout(() => setFeedback(""), 3000);
                              return;
                            }
                            setFinalizeItems(selections);
                            setActiveEstimateStep("finalize");
                          }}
                        >
                          Finalize
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="empty-state">No comparisons yet.</p>
                  )}
                </section>
              )}

              {activePage === "new-estimate" && activeEstimateStep === "finalize" && (
                <LandingAiReview
                  pdfUrl={prepareLandingContext.pdfUrl}
                  landingAiRaw={prepareLandingContext.raw}
                  fileName={prepareLandingContext.fileName}
                  selectedChunkId={prepareSelectedChunkId}
                  onSelectedChunkIdChange={(id) => {
                    prepareSelectionSourceRef.current = "pdf";
                    setPrepareSelectedChunkId(id);
                  }}
                  headerLeft={null}
                  headerCompact
                  initialSplitPct={70}
                  headerActions={
                    <>
                      <button
                        type="button"
                        className="btn-match btn-outline"
                        onClick={handleGoToPricing}
                        style={{ padding: "0.45rem 0.9rem", fontSize: "0.9rem", borderRadius: "0.5rem" }}
                      >
                        Go to Pricing
                      </button>
                    </>
                  }
                  rightPane={
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", minHeight: 0, height: "100%", overflow: "hidden" }}>
                      {!prepareLandingContext.raw ? (
                        <div style={{ color: "rgba(227,233,255,0.75)" }}>
                          LandingAI data is not available for this file (check `LANDINGAI_API_KEY`). Items will still be shown, but PDF linking is disabled.
                        </div>
                      ) : null}

                      <div
                        className="table-wrapper"
                        ref={prepareTableScrollRef}
                        style={{ flex: 1, minHeight: 0, overflow: "auto", fontSize: "0.88rem" }}
                      >
                        <table className="matches-table resizable-table">
                          <thead>
                            <tr>
                              <th>No.</th>
                              <th className="col--description">Description</th>
                              <th className="col--finishes">Finishes</th>
                              <th className="col--dimensions">Dimensions</th>
                              <th className="col--qty">Quantity</th>
                              <th className="col--uom">UOM</th>
                            </tr>
                          </thead>
                          {finalizeSectionsForPrepare.map((section) => (
                            <tbody key={`prepare-${section.code || section.title}`}>
                              <tr className="matches-table__section-row">
                                <td colSpan={6} style={{ fontWeight: 600, background: "rgba(76,110,245,0.08)" }}>
                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
                                    <span>
                                      {section.title} {section.code && `(${section.code})`}
                                    </span>
                                    <button
                                      type="button"
                                      className="btn-ghost"
                                      style={{ padding: "0.25rem 0.5rem", fontSize: "0.8rem", borderRadius: "0.45rem" }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        addFinalizeRowForSection(section.code);
                                      }}
                                    >
                                      + Add row
                                    </button>
                                  </div>
                                </td>
                              </tr>
                              {section.rows.length ? (
                                section.rows.map(({ entry, idx }) => {
                                  const item = entry.item;
                                  const linked = !!prepareSelectedChunkId && !!item.landing_ai_id && item.landing_ai_id === prepareSelectedChunkId;
                                  const displayNumber = item.item_no || item.item_number || item.section_code || section.code || "—";
                                  const handleRowClick = (event: React.MouseEvent<HTMLTableRowElement>) => {
                                    const target = event.target as HTMLElement;
                                    if (target.closest("input, textarea, button, select")) return;
                                    if (item.landing_ai_id) {
                                      prepareSelectionSourceRef.current = "table";
                                      setPrepareSelectedChunkId(String(item.landing_ai_id));
                                    }
                                  };
                                  const linkId = item.landing_ai_id ? String(item.landing_ai_id) : "";
                                  return (
                                    <tr
                                      key={`prepare-row-${idx}`}
                                      className={`matches-table__row ${linked ? "is-linked" : ""}`}
                                      onClick={handleRowClick}
                                      ref={(el) => {
                                        if (!linkId) return;
                                        prepareTableRowRefs.current[linkId] = el;
                                      }}
                                    >
                                      <td className="finalize-col finalize-col--number">
                                        <span className="cell-text" title={displayNumber}>{displayNumber}</span>
                                      </td>
                                      <td className="finalize-col finalize-col--description finalize-col--description-narrow" title={item.description || item.full_description || ""}>
                                        <textarea
                                          className="form-input form-input--table finalize-textarea"
                                          value={item.description || item.full_description || ""}
                                          onChange={(e) => updateFinalizeItemField(idx, "description", e.target.value)}
                                          placeholder="Description"
                                          rows={1}
                                        />
                                      </td>
                                      <td className="finalize-col finalize-col--finishes finalize-col--finishes-wide" title={item.finishes || ""}>
                                        <input
                                          className="form-input form-input--table"
                                          value={item.finishes || ""}
                                          onChange={(e) => updateFinalizeItemField(idx, "finishes", e.target.value)}
                                          placeholder="Finishes"
                                        />
                                      </td>
                                      <td className="finalize-col finalize-col--dimensions finalize-col--dimensions-wide" title={item.dimensions || item.size || ""}>
                                        <input
                                          className="form-input form-input--table"
                                          value={item.dimensions || item.size || ""}
                                          onChange={(e) => {
                                            updateFinalizeItemField(idx, "dimensions", e.target.value);
                                            updateFinalizeItemField(idx, "size", e.target.value);
                                          }}
                                          placeholder="Dimensions"
                                        />
                                      </td>
                                      <td className="finalize-col finalize-col--qty">
                                        <input
                                          className="form-input form-input--table"
                                          value={item.quantity || ""}
                                          onChange={(e) => updateFinalizeItemField(idx, "quantity", e.target.value)}
                                          placeholder="Qty"
                                        />
                                      </td>
                                      <td className="finalize-col finalize-col--unit">
                                        <input
                                          className="form-input form-input--table"
                                          value={item.unit || ""}
                                          onChange={(e) => updateFinalizeItemField(idx, "unit", e.target.value)}
                                          placeholder="UOM"
                                        />
                                      </td>
                                    </tr>
                                  );
                                })
                              ) : (
                                <tr>
                                  <td colSpan={6} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>
                                    No items in this section.
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          ))}
                        </table>
                      </div>
                    </div>
                  }
                />
              )}

              {activePage === "new-estimate" && activeEstimateStep === "pricing" && (
                <section id="pricing" className="panel">
                  <div className="panel__header">
                    <div>
                      <p className="eyebrow">Pricing</p>
                    </div>
                  </div>
                  <div className="pricing-accordion">
                    {PRICING_SECTIONS.map(section => {
                      const isOpen = activePricingSection === section.id;
                      return (
                        <div key={section.id} className={`pricing-accordion__card ${isOpen ? "is-open" : ""}`}>
                          <button
                            type="button"
                            className="pricing-accordion__header"
                            onClick={() => setActivePricingSection(isOpen ? null : section.id)}
                            aria-pressed={isOpen}
                          >
                            <span className="pricing-accordion__label">{section.label}</span>
                            <span className={`pricing-accordion__chevron ${isOpen ? "is-open" : ""}`} aria-hidden="true">▾</span>
                          </button>

                          {isOpen && (
                            <div className="pricing-accordion__panel">
                              {section.id === "items" ? (
                                pricingSelections.length === 0 ? (
                                  <p className="empty-state" style={{ margin: 0 }}>No items available for pricing yet.</p>
                                ) : (
                                  <>
                                    <div className="table-toolbar" style={{ justifyContent: "flex-end", margin: "0.25rem 0 0.5rem" }}>
                                      <input
                                        className="form-input form-input--table"
                                        placeholder="Search description…"
                                        value={pricingSearch}
                                        onChange={(e) => setPricingSearch(e.target.value)}
                                        style={{ width: "260px" }}
                                      />
                                    </div>
                                    <div className="table-wrapper table-wrapper--no-x pricing-table-wrapper" style={{ marginTop: "0.5rem" }}>
                                      <table className="matches-table resizable-table pricing-table">
                                        <thead>
                                          <tr>
                                            <ResizableTh resize={pricingResize} index={0}>Id</ResizableTh>
                                            <ResizableTh resize={pricingResize} index={1}>Item</ResizableTh>
                                            <ResizableTh resize={pricingResize} index={2}>Description</ResizableTh>
                                            <ResizableTh resize={pricingResize} index={3}>Finishes</ResizableTh>
                                            <ResizableTh resize={pricingResize} index={4}>Dimensions</ResizableTh>
                                            <ResizableTh resize={pricingResize} index={5}>Qty</ResizableTh>
                                            <ResizableTh resize={pricingResize} index={6}>Unit</ResizableTh>
                                            <ResizableTh resize={pricingResize} index={7}>Unit Price</ResizableTh>
                                            <ResizableTh resize={pricingResize} index={8}>Total Price</ResizableTh>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {filteredPricingSelections.length ? (
                                            filteredPricingSelections.map(({ sel, idx }) => {
                                              const rowIdx = idx;
                                              const matchOptions = pricingMatchOptions[rowIdx] || [];
                                              return (
                                                <tr key={`pricing-${rowIdx}`} className="matches-table__row">
                                                  <td>{rowIdx + 1}</td>
                                                  <td>
                                                    {renderCell(sel.item.item_type)}
                                                  </td>
                                                  <td>
                                                    <div
                                                      className="pricing-desc-cell"
                                                      ref={(node) => {
                                                        pricingDropdownRefs.current[rowIdx] = node;
                                                      }}
                                                      onBlurCapture={(e) => {
                                                        const nextTarget = e.relatedTarget as Node | null;
                                                        if (!nextTarget || !e.currentTarget.contains(nextTarget)) {
                                                          closeMatchDropdown(rowIdx);
                                                        }
                                                      }}
                                                      onMouseLeave={() => closeMatchDropdown(rowIdx)}
                                                    >
                                                      <span className="pricing-desc-text">
                                                        {renderCell(sel.item.description || sel.item.full_description)}
                                                      </span>
                                                      <>
                                                        <button
                                                          type="button"
                                                          className="pricing-match-trigger"
                                                          aria-label="Select pricing option"
                                                          aria-expanded={pricingDropdownOpen[rowIdx] || false}
                                                          ref={(node) => {
                                                            pricingTriggerRefs.current[rowIdx] = node;
                                                          }}
                                                          onClick={() => openMatchDropdown(rowIdx)}
                                                        >
                                                          ▾
                                                        </button>
                                                        {pricingDropdownOpen[rowIdx] && (
                                                          <div
                                                            className="pricing-match-menu"
                                                            style={
                                                              pricingDropdownPos[rowIdx]
                                                                ? {
                                                                  top: pricingDropdownPos[rowIdx].top,
                                                                  left: pricingDropdownPos[rowIdx].left,
                                                                  minWidth: Math.max(180, pricingDropdownPos[rowIdx].width + 8),
                                                                  fontSize: "0.85rem",
                                                                  padding: "0.3rem",
                                                                }
                                                                : undefined
                                                            }
                                                            onMouseLeave={() => closeMatchDropdown(rowIdx)}
                                                          >
                                                            {matchOptions.length > 0 ? (
                                                              matchOptions.map((opt, optIdx) => (
                                                                <button
                                                                  key={`${rowIdx}-match-${optIdx}`}
                                                                  type="button"
                                                                  className={`pricing-match-menu__item ${pricingMatchChoice[rowIdx] === optIdx ? "is-active" : ""
                                                                    }`}
                                                                  style={{ padding: "0.3rem 0.45rem", fontSize: "0.85rem" }}
                                                                  onClick={() => {
                                                                    handlePricingMatchChange(rowIdx, optIdx);
                                                                    setPricingDropdownOpen((prev) => ({
                                                                      ...prev,
                                                                      [rowIdx]: false,
                                                                    }));
                                                                  }}
                                                                >
                                                                  {getMatchLabel(opt)}
                                                                </button>
                                                              ))
                                                            ) : (
                                                              <p className="pricing-match-menu__hint">No suggestions yet. Use search below.</p>
                                                            )}
                                                            <div
                                                              className="pricing-match-search"
                                                              style={{
                                                                borderTop: "1px solid #e0e0e0",
                                                                marginTop: "0.4rem",
                                                                paddingTop: "0.4rem",
                                                                display: "flex",
                                                                flexDirection: "column",
                                                                gap: "0.35rem",
                                                              }}
                                                            >
                                                              <input
                                                                id={`pricing-search-${rowIdx}`}
                                                                className="form-input form-input--table"
                                                                type="text"
                                                                placeholder="Search Pricing List…"
                                                                value={priceListSearch[rowIdx] || ""}
                                                                style={{ fontSize: "0.85rem", height: "1.9rem" }}
                                                                onChange={(e) => handlePriceListSearchChange(rowIdx, e.target.value)}
                                                              />
                                                              {(() => {
                                                                const query = priceListSearch[rowIdx] || "";
                                                                const matches = findPriceListMatches(query);
                                                                const canSearch = query.trim().length >= 3;
                                                                if (priceListLoading) {
                                                                  return <p className="pricing-match-menu__hint">Loading pricing list…</p>;
                                                                }
                                                                if (priceListError) {
                                                                  return <p className="pricing-match-menu__hint" style={{ color: "#c00" }}>{priceListError}</p>;
                                                                }
                                                                if (!canSearch) {
                                                                  return <p className="pricing-match-menu__hint">Type at least 3 characters to search</p>;
                                                                }
                                                                if (!matches.length) {
                                                                  return <p className="pricing-match-menu__hint">No matches found</p>;
                                                                }
                                                                return (
                                                                  <div
                                                                    className="pricing-match-search__results"
                                                                    style={{
                                                                      display: "flex",
                                                                      flexDirection: "column",
                                                                      gap: "0.25rem",
                                                                      maxHeight: "140px",
                                                                      overflowY: "auto",
                                                                    }}
                                                                  >
                                                                    {matches.map(({ row: priceRow, rowIndex }) => {
                                                                      const label = getPriceListItemLabel(priceRow) || `Item ${rowIndex + 1}`;
                                                                      const description =
                                                                        (priceRow["Description"] as string) ||
                                                                        (priceRow["Desc"] as string) ||
                                                                        "";
                                                                      return (
                                                                        <button
                                                                          key={`pricing-search-${rowIdx}-${rowIndex}`}
                                                                          type="button"
                                                                          className="pricing-match-menu__item"
                                                                          style={{ padding: "0.3rem 0.45rem", fontSize: "0.85rem" }}
                                                                          onClick={() => handleApplyPriceListRow(rowIdx, rowIndex)}
                                                                        >
                                                                          <span style={{ display: "block", fontWeight: 600 }}>{label}</span>
                                                                          {description && (
                                                                            <span className="pricing-match-menu__note" style={{ display: "block", fontSize: "0.85rem", color: "#444" }}>
                                                                              {description}
                                                                            </span>
                                                                          )}
                                                                        </button>
                                                                      );
                                                                    })}
                                                                  </div>
                                                                );
                                                              })()}
                                                            </div>
                                                          </div>
                                                        )}
                                                      </>
                                                    </div>
                                                  </td>
                                                  <td>{renderCell(sel.item.finishes)}</td>
                                                  <td>{renderCell(sel.item.dimensions || sel.item.size)}</td>
                                                  <td>
                                                    <input
                                                      className="form-input form-input--table"
                                                      type="number"
                                                      min="0"
                                                      step="1"
                                                      value={sel.item.quantity || ""}
                                                      onChange={(e) => handlePricingItemChange(rowIdx, "quantity", e.target.value)}
                                                      placeholder="QTY"
                                                    />
                                                  </td>
                                                  <td>{renderCell(sel.item.unit)}</td>
                                                  <td>
                                                    {renderCell(sel.item.unit_price)}
                                                  </td>
                                                  <td>{renderCell(sel.item.total_price)}</td>
                                                </tr>
                                              );
                                            })
                                          ) : (
                                            <tr>
                                              <td colSpan={9} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>
                                                No items match this description search.
                                              </td>
                                            </tr>
                                          )}
                                        </tbody>
                                      </table>
                                    </div>
                                  </>
                                )
                              ) : section.id === "electrical" ? (
                                <div className="pricing-electrical">
                                  <div className="table-actions" style={{ justifyContent: "flex-start", gap: "0.75rem", marginBottom: "0.75rem" }}>
                                    <button
                                      type="button"
                                      className="btn-secondary"
                                      onClick={() => loadSheetRows("Electrical", setElectricalSheetRows, setElectricalModalOpen)}
                                      disabled={priceListLoading}
                                    >
                                      Add Items
                                    </button>
                                    {priceListError && <span style={{ color: "#c0392b" }}>{priceListError}</span>}
                                  </div>
                                  <div className="table-wrapper table-wrapper--no-x pricing-table-wrapper" style={{ marginTop: "0.5rem" }}>
                                    <table className="matches-table resizable-table pricing-table">
                                      <thead>
                                        <tr>
                                          <ResizableTh resize={pricingResize} index={0}>Item</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={1}>Finishes</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={2}>Dimensions</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={1}>Price</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={2}>Quantity</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={3}>Total</ResizableTh>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {electricalItems.length ? electricalItems.map((row, idx) => (
                                          <tr key={`electrical-${idx}`} className="matches-table__row">
                                            <td>{renderCell(row.item)}</td>
                                            <td>{renderCell("")}</td>
                                            <td>{renderCell("")}</td>
                                            <td>
                                              <input
                                                className="form-input form-input--table"
                                                value={row.price}
                                                onChange={(e) => setElectricalItems(prev => prev.map((r, i) => i === idx ? { ...r, price: e.target.value } : r))}
                                              />
                                            </td>
                                            <td>
                                              <input
                                                className="form-input form-input--table"
                                                type="number"
                                                min="1"
                                                step="1"
                                                value={row.qty}
                                                onChange={(e) => setElectricalItems(prev => prev.map((r, i) => i === idx ? { ...r, qty: e.target.value } : r))}
                                              />
                                            </td>
                                            <td>{renderCell(computeTotalPrice(row.price, row.qty))}</td>
                                          </tr>
                                        )) : (
                                          <tr>
                                            <td colSpan={4} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>No electrical items added.</td>
                                          </tr>
                                        )}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              ) : section.id === "installation" ? (
                                <div className="pricing-installation">
                                  <div className="table-actions" style={{ justifyContent: "flex-start", gap: "0.75rem", marginBottom: "0.75rem" }}>
                                    <button
                                      type="button"
                                      className="btn-secondary"
                                      onClick={() => loadSheetRows("Installation", setInstallationSheetRows, setInstallationModalOpen)}
                                      disabled={priceListLoading}
                                    >
                                      Add Items
                                    </button>
                                    {priceListError && <span style={{ color: "#c0392b" }}>{priceListError}</span>}
                                  </div>
                                  <div className="table-wrapper table-wrapper--no-x pricing-table-wrapper" style={{ marginTop: "0.5rem" }}>
                                    <table className="matches-table resizable-table pricing-table">
                                      <thead>
                                        <tr>
                                          <ResizableTh resize={pricingResize} index={0}>Item</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={1}>Finishes</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={2}>Dimensions</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={1}>Price</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={2}>Quantity</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={3}>Total</ResizableTh>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {installationItems.length ? installationItems.map((row, idx) => (
                                          <tr key={`installation-${idx}`} className="matches-table__row">
                                            <td>{renderCell(row.item)}</td>
                                            <td>{renderCell("")}</td>
                                            <td>{renderCell("")}</td>
                                            <td>
                                              <input
                                                className="form-input form-input--table"
                                                value={row.price}
                                                onChange={(e) => setInstallationItems(prev => prev.map((r, i) => i === idx ? { ...r, price: e.target.value } : r))}
                                              />
                                            </td>
                                            <td>
                                              <input
                                                className="form-input form-input--table"
                                                type="number"
                                                min="1"
                                                step="1"
                                                value={row.qty}
                                                onChange={(e) => setInstallationItems(prev => prev.map((r, i) => i === idx ? { ...r, qty: e.target.value } : r))}
                                              />
                                            </td>
                                            <td>{renderCell(computeTotalPrice(row.price, row.qty))}</td>
                                          </tr>
                                        )) : (
                                          <tr>
                                            <td colSpan={4} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>No installation items added.</td>
                                          </tr>
                                        )}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              ) : section.id === "venue" ? (
                                <div className="pricing-venue">
                                  <div className="table-actions" style={{ justifyContent: "flex-start", gap: "0.75rem", marginBottom: "0.75rem" }}>
                                    <button
                                      type="button"
                                      className="btn-secondary"
                                      onClick={() => loadSheetRows("Venue services", setVenueSheetRows, setVenueModalOpen)}
                                      disabled={priceListLoading}
                                    >
                                      Add Items
                                    </button>
                                    {priceListError && <span style={{ color: "#c0392b" }}>{priceListError}</span>}
                                  </div>
                                  <div className="table-wrapper table-wrapper--no-x pricing-table-wrapper" style={{ marginTop: "0.5rem" }}>
                                    <table className="matches-table resizable-table pricing-table">
                                      <thead>
                                        <tr>
                                          <ResizableTh resize={pricingResize} index={0}>Item</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={1}>Finishes</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={2}>Dimensions</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={1}>Price</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={2}>Quantity</ResizableTh>
                                          <ResizableTh resize={pricingResize} index={3}>Total</ResizableTh>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {venueItems.length ? venueItems.map((row, idx) => (
                                          <tr key={`venue-${idx}`} className="matches-table__row">
                                            <td>{renderCell(row.item)}</td>
                                            <td>{renderCell("")}</td>
                                            <td>{renderCell("")}</td>
                                            <td>
                                              <input
                                                className="form-input form-input--table"
                                                value={row.price}
                                                onChange={(e) => setVenueItems(prev => prev.map((r, i) => i === idx ? { ...r, price: e.target.value } : r))}
                                              />
                                            </td>
                                            <td>
                                              <input
                                                className="form-input form-input--table"
                                                type="number"
                                                min="1"
                                                step="1"
                                                value={row.qty}
                                                onChange={(e) => setVenueItems(prev => prev.map((r, i) => i === idx ? { ...r, qty: e.target.value } : r))}
                                              />
                                            </td>
                                            <td>{renderCell(computeTotalPrice(row.price, row.qty))}</td>
                                          </tr>
                                        )) : (
                                          <tr>
                                            <td colSpan={4} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>No venue services items added.</td>
                                          </tr>
                                        )}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              ) : (
                                <div className="pricing-placeholder">
                                  <h3>{section.label} pricing</h3>
                                  <p>We will implement this section soon.</p>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="table-actions" style={{ paddingTop: "1rem" }}>
                    <button
                      type="button"
                      className="btn-match btn-outline"
                      onClick={() => setActiveEstimateStep("estimate")}
                    >
                      Go to Estimate Generation
                    </button>
                  </div>
                </section>
              )}

              {activePage === "new-estimate" && activeEstimateStep === "estimate" && (
                <section id="estimate" className="panel">
                  <div className="panel__header">
                    <div>
                      <p className="eyebrow">Finalize</p>
                      <h2 className="section-title section-title--compact">Final Estimate</h2>
                    </div>
                  </div>
                  <div
                    className="form-grid"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                      gap: "0.75rem",
                      marginBottom: "1rem",
                      alignItems: "flex-start",
                    }}
                  >
                    <div className="form-field" style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                      <span className="form-label">Company Name</span>
                      <input
                        className="form-input"
                        type="text"
                        value={estimateCompanyName}
                        onChange={(e) => setEstimateCompanyName(e.target.value)}
                        style={estimateInputPaddedStyle}
                      />
                    </div>
                    <div className="form-field" style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                      <span className="form-label">Contact Name</span>
                      <input
                        className="form-input"
                        type="text"
                        value={estimateContactName}
                        onChange={(e) => setEstimateContactName(e.target.value)}
                        style={estimateInputPaddedStyle}
                      />
                    </div>
                    <div className="form-field" style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                      <label className="form-label" htmlFor="estimate-project-name">Project Name</label>
                      <input
                        id="estimate-project-name"
                        className="form-input"
                        type="text"
                        value={estimateProjectName}
                        onChange={(e) => setEstimateProjectName(e.target.value)}
                        placeholder="Enter project name"
                        style={estimateInputPaddedStyle}
                      />
                    </div>
                    <div className="form-field" style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                      <label className="form-label" htmlFor="estimate-subject">Subject</label>
                      <input
                        id="estimate-subject"
                        className="form-input"
                        type="text"
                        value={estimateSubject}
                        onChange={(e) => setEstimateSubject(e.target.value)}
                        placeholder="Enter subject"
                        style={estimateInputPaddedStyle}
                      />
                    </div>
                  </div>
                  {estimateTableRows.length ? (
                    <div className="table-wrapper table-wrapper--no-x pricing-table-wrapper" style={{ marginTop: "0.5rem" }}>
                      <table className="matches-table resizable-table pricing-table">
                        <thead>
                          <tr>
                            <ResizableTh resize={estimateResize} index={0}>Id</ResizableTh>
                            <ResizableTh resize={estimateResize} index={1}>Description</ResizableTh>
                            <ResizableTh resize={estimateResize} index={2}>Finishes</ResizableTh>
                            <ResizableTh resize={estimateResize} index={3}>Dimensions</ResizableTh>
                            <ResizableTh resize={estimateResize} index={4}>Quantity</ResizableTh>
                            <ResizableTh resize={estimateResize} index={5}>Unit</ResizableTh>
                            <ResizableTh resize={estimateResize} index={6}>Unit Price</ResizableTh>
                            <ResizableTh resize={estimateResize} index={7}>Amount</ResizableTh>
                          </tr>
                        </thead>
                        <tbody>
                          {groupedEstimateRows.map(group => (
                            <React.Fragment key={group.label}>
                              <tr className="matches-table__section-row">
                                <td colSpan={8} style={{ fontWeight: 600, background: "rgba(76,110,245,0.08)" }}>
                                  {group.label} {group.code ? `(${group.code})` : ""} — {group.rows.length} item(s)
                                </td>
                              </tr>
                              {group.rows.map((row, idx) => (
                                <tr key={`estimate-${group.label}-${idx}`} className="matches-table__row">
                                  <td>{group.code ? `${group.code}.${idx + 1}` : `${idx + 1}`}</td>
                                  <td>{renderCell(row.description)}</td>
                                  <td>{renderCell(row.finishes)}</td>
                                  <td>{renderCell(row.size)}</td>
                                  <td>{renderCell(row.quantity)}</td>
                                  <td>{renderCell(row.unit)}</td>
                                  <td>{renderCell(row.unitPrice)}</td>
                                  <td>{renderCell(row.totalPrice)}</td>
                                </tr>
                              ))}
                            </React.Fragment>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="matches-table__row estimate-summary-row">
                            <td />
                            <td className="estimate-summary-label">Total Cost</td>
                            <td colSpan={4} />
                            <td />
                            <td className="estimate-summary-value"><strong>{formatNumber(estimateTotals.totalCost)}</strong></td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  ) : (
                    <p className="empty-state">No estimate data to show yet.</p>
                  )}
                  <div className="table-actions" style={{ marginTop: "0.75rem", justifyContent: "flex-end" }}>
                    <button type="button" className="btn-match" onClick={() => void handleGenerateEstimateFiles()}>
                      Generate
                    </button>
                  </div>
                </section>
              )}

              {activePage === "new-estimate" && activeEstimateStep === "upload" && (
                <section id="matches" className="panel">
                  <div className="panel__header">
                    <div>
                      <h2 className="section-title section-title--compact">Upload Drawings, BOQ, or both</h2>
                    </div>
                    <span className="status">{matching ? "Processing…" : "Idle"}</span>
                  </div>
                  <form className="estimate-form" onSubmit={handleExtract}>
                    <div className="uploaders-grid">
                      <label className="dropzone dropzone--estimate uploader-card">
                        <input
                          type="file"
                          accept=".pdf,.docx,.txt"
                          multiple
                          onChange={(event) => {
                            const files = Array.from(event.target.files || []);
                            setMatchingFiles(files);
                            setReviewStepActive(false);
                            // Prepare PDF previews for "manual parse" (LandingAI visualizer) without re-calling the API.
                            drawingPdfPreviews.forEach((p) => {
                              if (p.url.startsWith("blob:")) URL.revokeObjectURL(p.url);
                            });
                            const pdfs = files.filter(
                              (f) => (f.type || "").toLowerCase() === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")
                            );
                            setDrawingPdfPreviews(pdfs.map((f) => ({ fileName: f.name, url: URL.createObjectURL(f) })));
                          }}
                        />
                        <div className="dropzone__content">
                          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="dropzone__icon">
                            <path d="M24 16v16M16 24h16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                            <rect x="8" y="8" width="32" height="32" rx="4" stroke="currentColor" strokeWidth="2" />
                          </svg>
                          <p className="dropzone__text">
                            {matchingFiles.length
                              ? `${matchingFiles.length} drawing file(s): ${matchingFiles.map(f => f.name).join(", ")}`
                              : "Drag & drop or browse drawings (PDF, DOCX, TXT)"}
                          </p>
                          <p className="dropzone__hint">You can upload multiple drawing files together.</p>
                        </div>
                      </label>

                      <label className="dropzone dropzone--estimate uploader-card">
                        <input
                          type="file"
                          accept=".pdf,.png,.jpg,.jpeg,.docx,.txt,.xlsx,.xls,.csv"
                          onChange={(event) => {
                            handleBoqFileChange(event);
                            setReviewStepActive(false);
                          }}
                        />
                        <div className="dropzone__content">
                          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="dropzone__icon">
                            <path d="M14 16h20M14 22h20M14 28h14M10 12h2v24h-2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <p className="dropzone__text">
                            {selectedBoqFileName
                              ? `BOQ selected: ${selectedBoqFileName}`
                              : "Drag & drop or browse BOQ (PDF, Excel, Images)"}
                          </p>
                          <p className="dropzone__hint">Upload a single BOQ file to proceed; drawings are optional.</p>
                        </div>
                      </label>
                    </div>
                    <div className="upload-actions">
                      <button
                        type="submit"
                        className="btn-match"
                        disabled={
                          matching ||
                          boqExtractLoading ||
                          (!matchingFiles.length && !pendingBoqFile)
                        }
                      >
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" />
                          <path d="M13 13l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                        {matching || boqExtractLoading ? "Processing…" : "Review Extraction"}
                      </button>
                    </div>
                  </form>

                </section>
              )}

              {electricalModalOpen && (
                <div className="modal-backdrop">
                  <div className="modal" style={{ maxWidth: "620px" }}>
                    <h3>Add Electrical Items</h3>
                    <div className="table-wrapper table-wrapper--no-x pricing-table-wrapper" style={{ marginTop: "0.5rem", maxHeight: "360px", overflowY: "auto" }}>
                      <table className="matches-table resizable-table pricing-table">
                        <thead>
                          <tr>
                            <th className="checkbox-col"></th>
                            <th>Item</th>
                            <th>Price</th>
                          </tr>
                        </thead>
                        <tbody>
                          {electricalSheetRows.length ? electricalSheetRows.map((row, idx) => (
                            <tr key={`electrical-modal-${idx}`} className="matches-table__row">
                              <td className="checkbox-col">
                                <input type="checkbox" checked={!!row.selected} onChange={() => toggleSheetSelection(setElectricalSheetRows, idx)} />
                              </td>
                              <td>{renderCell(row.item)}</td>
                              <td>
                                <input
                                  className="form-input form-input--table"
                                  value={row.price}
                                  onChange={(e) => updateSheetPrice(setElectricalSheetRows, idx, e.target.value)}
                                />
                              </td>
                            </tr>
                          )) : (
                            <tr>
                              <td colSpan={3} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>No data in sheet.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    <div className="modal__actions">
                      <button type="button" className="btn-secondary" onClick={() => setElectricalModalOpen(false)}>Cancel</button>
                      <button type="button" className="btn-match" onClick={() => addSelectedSheetItems(electricalSheetRows, setElectricalItems, setElectricalModalOpen)}>Add</button>
                    </div>
                  </div>
                </div>
              )}

              {installationModalOpen && (
                <div className="modal-backdrop">
                  <div className="modal" style={{ maxWidth: "620px" }}>
                    <h3>Add Installation Items</h3>
                    <div className="table-wrapper table-wrapper--no-x pricing-table-wrapper" style={{ marginTop: "0.5rem", maxHeight: "360px", overflowY: "auto" }}>
                      <table className="matches-table resizable-table pricing-table">
                        <thead>
                          <tr>
                            <th className="checkbox-col"></th>
                            <th>Item</th>
                            <th>Price</th>
                          </tr>
                        </thead>
                        <tbody>
                          {installationSheetRows.length ? installationSheetRows.map((row, idx) => (
                            <tr key={`installation-modal-${idx}`} className="matches-table__row">
                              <td className="checkbox-col">
                                <input type="checkbox" checked={!!row.selected} onChange={() => toggleSheetSelection(setInstallationSheetRows, idx)} />
                              </td>
                              <td>{renderCell(row.item)}</td>
                              <td>
                                <input
                                  className="form-input form-input--table"
                                  value={row.price}
                                  onChange={(e) => updateSheetPrice(setInstallationSheetRows, idx, e.target.value)}
                                />
                              </td>
                            </tr>
                          )) : (
                            <tr>
                              <td colSpan={3} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>No data in sheet.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    <div className="modal__actions">
                      <button type="button" className="btn-secondary" onClick={() => setInstallationModalOpen(false)}>Cancel</button>
                      <button type="button" className="btn-match" onClick={() => addSelectedSheetItems(installationSheetRows, setInstallationItems, setInstallationModalOpen)}>Add</button>
                    </div>
                  </div>
                </div>
              )}

              {venueModalOpen && (
                <div className="modal-backdrop">
                  <div className="modal" style={{ maxWidth: "620px" }}>
                    <h3>Add Venue Services Items</h3>
                    <div className="table-wrapper table-wrapper--no-x pricing-table-wrapper" style={{ marginTop: "0.5rem", maxHeight: "360px", overflowY: "auto" }}>
                      <table className="matches-table resizable-table pricing-table">
                        <thead>
                          <tr>
                            <th className="checkbox-col"></th>
                            <th>Item</th>
                            <th>Price</th>
                          </tr>
                        </thead>
                        <tbody>
                          {venueSheetRows.length ? venueSheetRows.map((row, idx) => (
                            <tr key={`venue-modal-${idx}`} className="matches-table__row">
                              <td className="checkbox-col">
                                <input type="checkbox" checked={!!row.selected} onChange={() => toggleSheetSelection(setVenueSheetRows, idx)} />
                              </td>
                              <td>{renderCell(row.item)}</td>
                              <td>
                                <input
                                  className="form-input form-input--table"
                                  value={row.price}
                                  onChange={(e) => updateSheetPrice(setVenueSheetRows, idx, e.target.value)}
                                />
                              </td>
                            </tr>
                          )) : (
                            <tr>
                              <td colSpan={3} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>No data in sheet.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    <div className="modal__actions">
                      <button type="button" className="btn-secondary" onClick={() => setVenueModalOpen(false)}>Cancel</button>
                      <button type="button" className="btn-match" onClick={() => addSelectedSheetItems(venueSheetRows, setVenueItems, setVenueModalOpen)}>Add</button>
                    </div>
                  </div>
                </div>
              )}

              {showDrawingsOnlyConfirm && (
                <div className="modal-backdrop">
                  <div className="modal">
                    <p>You only uploaded Drawings, no BOQ is provided, Proceed?</p>
                    <div className="modal__actions">
                      <button type="button" className="btn-secondary" onClick={handleCancelDrawingsOnly}>
                        No
                      </button>
                      <button type="button" className="btn-match" onClick={handleConfirmDrawingsOnly}>
                        Yes, proceed
                      </button>
                    </div>
                  </div>
                </div>
              )}

            </div>

          </>
        )}

        {feedback && <p className="feedback">{feedback}</p>}
      </main>

      <button
        type="button"
        className={`sidebar-toggle sidebar-toggle--floating ${isSidebarOpen ? "is-open" : ""}`}
        onClick={() => setIsSidebarOpen(prev => !prev)}
        aria-label={isSidebarOpen ? "Hide navigation menu" : "Show navigation menu"}
        aria-pressed={isSidebarOpen}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          {isSidebarOpen ? (
            <path d="M6 4l8 6-8 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <path d="M14 4l-8 6 8 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>
      </button>
    </div>
  );
}

export default App;
