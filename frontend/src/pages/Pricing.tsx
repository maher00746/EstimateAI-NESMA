import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { v4 as uuidv4 } from "uuid";
import type { EstimationRow, PricingPayload, ProductivityRatesBlock, ProjectItem } from "../types";
import {
  getPricing,
  getProductivityRates,
  savePricing,
  suggestProductivityItems,
  searchPricingBlocks,
} from "../services/api";
import type {
  ProductivitySuggestResponse,
  SearchBlocksBlock,
  SearchBlocksSubitem,
} from "../services/api";

type PricingProps = {
  boqItems: ProjectItem[];
  scheduleItems: ProjectItem[];
  drawingItems: ProjectItem[];
  projectName?: string;
  projectId?: string;
  headerTop?: ReactNode;
  onDirtyChange?: (isDirty: boolean) => void;
  onRegisterSave?: (save: () => Promise<boolean>) => void;
  onGoToEstimation?: (rows: EstimationRow[]) => void;
};

type PricingPayloadWithTracking = PricingPayload & {
  collapsedByItemId?: Record<string, unknown>;
  completedByItemId?: Record<string, unknown>;
  sellRateFactor?: string;
  sellRateOverridesByItemId?: Record<string, unknown>;
};

type PricingSubItem = {
  id: string;
  /** Prod rate item code; editable, used to lookup and populate from productivity rates */
  code?: string;
  description: string;
  /** User note linked from CAD detail rows */
  note?: string;
  /** Thickness in mm; when set, sub row qty = main row qty * thickness * 0.001 */
  thickness?: number | null;
  productivityId?: string;
  suggestedIds?: string[];
  qty?: string;
  /** Unit from productivity rate item when set; otherwise main item unit is used for display */
  unit?: string;
  unitMh: number;
  unitWagesRate?: number;
  unitEquipRate: number;
  materialsRate: string;
  subconRate: string;
  toolsRate: string;
};

type ProductivityOption = {
  id: string;
  code: string;
  description: string;
  unit: string;
  unitMh: number;
  unitWagesRate: number;
  equipmentRate: number;
};

type PricingEntry = { type: "item"; item: ProjectItem };

type PricingRenderEntry =
  | { type: "priced"; item: ProjectItem; notes: ProjectItem[]; category: string };

type SuggestionLogLevel = "info" | "warning" | "error";

type SuggestionLog = {
  id: string;
  level: SuggestionLogLevel;
  message: string;
  createdAt: string;
};

type SuggestionStatus = "idle" | "running" | "success" | "failed";

type PricingHeaderRateKey = "wages" | "materials" | "subcon" | "equip" | "other";

type PricingHeader = {
  key: string;
  label: string;
  group: "direct" | "sell";
  rateKey?: PricingHeaderRateKey;
};

const DIRECT_HEADERS: PricingHeader[] = [
  { key: "action", label: "", group: "direct" },
  { key: "code", label: "CODE", group: "direct" },
  { key: "description", label: "Description", group: "direct" },
  { key: "note", label: "Note", group: "direct" },
  { key: "thickness", label: "Thickness", group: "direct" },
  { key: "qty", label: "Qty", group: "direct" },
  { key: "unit", label: "Unit", group: "direct" },
  { key: "unit-mh", label: "Unit MH", group: "direct" },
  { key: "total-mh", label: "Total MH", group: "direct" },
  { key: "unit-wages", label: "Unit Rate (Wages)", group: "direct" },
  { key: "total-wages", label: "Total Rate (Wages)", group: "direct" },
  { key: "unit-materials", label: "Unit Rate (Materials)", group: "direct" },
  { key: "total-materials", label: "Total Rate (Materials)", group: "direct" },
  { key: "unit-subcon", label: "Unit Rate (Subcon)", group: "direct" },
  { key: "total-subcon", label: "Total Rate (Subcon)", group: "direct" },
  { key: "unit-equip", label: "Unit Rate (Equip)", group: "direct" },
  { key: "total-equip", label: "Total Rate (Equip)", group: "direct" },
  { key: "unit-tools", label: "Unit Rate (Tools)", group: "direct" },
  { key: "total-tools", label: "Total Rate (Tools)", group: "direct" },
  { key: "unit-price", label: "UNIT PRICE", group: "direct" },
  { key: "total-price", label: "TOTAL PRICE", group: "direct" },
];

const SELL_HEADERS: PricingHeader[] = [
  { key: "sell-unit-wages", label: "Unit Rate (Wages)", group: "sell", rateKey: "wages" },
  { key: "sell-total-wages", label: "Total Rate (Wages)", group: "sell" },
  { key: "sell-unit-materials", label: "Unit Rate (Materials)", group: "sell", rateKey: "materials" },
  { key: "sell-total-materials", label: "Total Rate (Materials)", group: "sell" },
  { key: "sell-unit-subcon", label: "Unit Rate (Subcon)", group: "sell", rateKey: "subcon" },
  { key: "sell-total-subcon", label: "Total Rate (Subcon)", group: "sell" },
  { key: "sell-unit-equip", label: "Unit Rate (Equip)", group: "sell", rateKey: "equip" },
  { key: "sell-total-equip", label: "Total Rate (Equip)", group: "sell" },
  { key: "sell-unit-other", label: "Unit Rate (Other)", group: "sell", rateKey: "other" },
  { key: "sell-total-other", label: "Total Rate (Other)", group: "sell" },
  { key: "sell-unit-price", label: "UNIT PRICE", group: "sell" },
  { key: "sell-total-price", label: "TOTAL PRICE", group: "sell" },
];

const PRICING_HEADERS = [...DIRECT_HEADERS, ...SELL_HEADERS];

const SUMMARY_HEADERS = [
  { key: "label", label: "Summary" },
  { key: "total-mh", label: "Total MH" },
  { key: "total-wages", label: "Total Rate (Wages)" },
  { key: "total-materials", label: "Total Rate (Materials)" },
  { key: "total-subcon", label: "Total Rate (Subcon)" },
  { key: "total-equip", label: "Total Rate (Equip)" },
  { key: "total-tools", label: "Total Rate (Tools)" },
  { key: "total-price", label: "TOTAL PRICE" },
  { key: "sell-total-wages", label: "Total Rate (Wages)", group: "sell" },
  { key: "sell-total-materials", label: "Total Rate (Materials)", group: "sell" },
  { key: "sell-total-subcon", label: "Total Rate (Subcon)", group: "sell" },
  { key: "sell-total-equip", label: "Total Rate (Equip)", group: "sell" },
  { key: "sell-total-tools", label: "Total Rate (Tools)", group: "sell" },
  { key: "sell-total-price", label: "TOTAL PRICE", group: "sell" },
];

const normalizeColumn = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const normalizeCode = (value: string): string =>
  String(value ?? "").trim().toLowerCase();

const parseNumber = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const cleaned = trimmed.replace(/,/g, "");
  const match = cleaned.match(/-?\d+(\.\d+)?/);
  if (!match) return 0;
  const numberValue = Number(match[0]);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const parseStrictNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const numberValue = Number(cleaned);
  return Number.isFinite(numberValue) ? numberValue : null;
};

const parseThickness = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const strict = parseStrictNumber(value);
    return strict === null ? null : strict;
  }
  return null;
};

/** Effective qty for a sub row: when thickness is set, qty = mainQty * thickness (mm) * 0.001 */
const getSubRowEffectiveQty = (row: PricingSubItem, mainQtyDisplay: string): number => {
  const mainQty = parseNumber(mainQtyDisplay);
  const thick = row.thickness != null && Number.isFinite(row.thickness) ? row.thickness : null;
  if (thick !== null) return mainQty * thick * 0.001;
  return parseNumber(row.qty ?? mainQtyDisplay);
};

const formatRounded = (value: number): string => {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(2);
};

const roundTo2 = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(2));
};

const buildPricingEntries = (items: ProjectItem[]): PricingEntry[] =>
  items.map((item) => ({ type: "item", item }));

const getBoqFieldValue = (item: ProjectItem, field: "qty" | "unit" | "rate"): string => {
  const fields = item.metadata?.fields ?? {};
  const findField = (candidates: string[]) =>
    fields[Object.keys(fields).find((key) => candidates.includes(normalizeColumn(key))) ?? ""];
  if (field === "qty") {
    return findField(["qty", "quantity", "q'ty", "qnty"]) ?? "";
  }
  if (field === "unit") {
    return findField(["unit", "uom", "unit of measure"]) ?? "";
  }
  return findField(["rate", "unit rate", "unit price", "price"]) ?? "";
};

const computeManpowerMh = (block: ProductivityRatesBlock): number => {
  const hoursValue = parseNumber(block.hoursPerDay);
  const productivityValue = parseNumber(block.dailyProductivity);
  const manpowerSum = block.manpowerRows.reduce((sum, row) => sum + parseNumber(row.quantity), 0);
  return productivityValue ? (manpowerSum * hoursValue) / productivityValue : 0;
};

const computeEquipmentRateSum = (block: ProductivityRatesBlock): number => {
  return block.equipmentRows.reduce((sum, row) => {
    const savedRate = row.rate !== undefined ? parseNumber(row.rate) : null;
    if (savedRate !== null && Number.isFinite(savedRate)) return sum + savedRate;
    const rowQty = parseNumber(row.quantity);
    const rowHours = parseNumber(row.hoursPerDay ?? "");
    const rowProductivity = parseNumber(row.dailyProductivity ?? "");
    const rowMh = rowProductivity ? (rowQty * rowHours) / rowProductivity : 0;
    const hourlyRateValue = parseNumber(row.hourlyRate ?? "");
    const rowRate = rowMh * hourlyRateValue;
    return sum + rowRate;
  }, 0);
};

export default function Pricing({
  boqItems,
  scheduleItems,
  drawingItems,
  projectName,
  projectId,
  headerTop,
  onDirtyChange,
  onRegisterSave,
  onGoToEstimation,
}: PricingProps) {
  const [percentage, setPercentage] = useState("10");
  const [idleText, setIdleText] = useState("idle time");
  const [poRate, setPoRate] = useState("8");
  const [mpHourlyRate, setMpHourlyRate] = useState("0");
  const [totalPriceFactor, setTotalPriceFactor] = useState("0");
  const [projectDuration, setProjectDuration] = useState("2");
  const [sellRateFactor, setSellRateFactor] = useState("12.14");
  const [sellRateOverridesByItemId, setSellRateOverridesByItemId] = useState<
    Record<string, Partial<Record<PricingHeaderRateKey, string>>>
  >({});
  const [productivityBlocks, setProductivityBlocks] = useState<ProductivityRatesBlock[]>([]);
  const [loadingRates, setLoadingRates] = useState(false);
  const [ratesError, setRatesError] = useState("");
  const [loadingPricing, setLoadingPricing] = useState(false);
  const [subItemsByItemId, setSubItemsByItemId] = useState<Record<string, PricingSubItem[]>>({});
  const [autoRowQtyByItemId, setAutoRowQtyByItemId] = useState<Record<string, string>>({});
  const [qtyOverrideByItemId, setQtyOverrideByItemId] = useState<Record<string, string>>({});
  const [collapsedByItemId, setCollapsedByItemId] = useState<Record<string, boolean>>({});
  const [completedByItemId, setCompletedByItemId] = useState<Record<string, boolean>>({});
  const [blockCodeByItemId, setBlockCodeByItemId] = useState<Record<string, string>>({});
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [rowCodeErrorByRowId, setRowCodeErrorByRowId] = useState<Record<string, string>>({});
  const [codeLoadingByRowId, setCodeLoadingByRowId] = useState<Record<string, boolean>>({});
  const [blockCodeLoadingByItemId, setBlockCodeLoadingByItemId] = useState<Record<string, boolean>>({});
  const menuAnchorRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [menuPositionTick, setMenuPositionTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [suggestionStatus, setSuggestionStatus] = useState<SuggestionStatus>("idle");
  const [suggestionLogs, setSuggestionLogs] = useState<SuggestionLog[]>([]);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [suggestionCallsTotal, setSuggestionCallsTotal] = useState(0);
  const [suggestionCallsCompleted, setSuggestionCallsCompleted] = useState(0);
  const [showSuggestionLogs, setShowSuggestionLogs] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [copyFromProjectOpen, setCopyFromProjectOpen] = useState(false);
  const [copyFromProjectItemId, setCopyFromProjectItemId] = useState<string | null>(null);
  const [copyFromProjectBlockCode, setCopyFromProjectBlockCode] = useState("");
  const [copyFromProjectText, setCopyFromProjectText] = useState("");
  const [copyFromProjectBlocks, setCopyFromProjectBlocks] = useState<SearchBlocksBlock[]>([]);
  const [copyFromProjectTotal, setCopyFromProjectTotal] = useState(0);
  const [copyFromProjectPage, setCopyFromProjectPage] = useState(1);
  const COPY_FROM_PROJECT_PAGE_SIZE = 5;
  const [copyFromProjectSelected, setCopyFromProjectSelected] = useState<SearchBlocksBlock | null>(null);
  const [copyFromProjectLoading, setCopyFromProjectLoading] = useState(false);
  const subItemsByItemIdRef = useRef<Record<string, PricingSubItem[]>>({});
  const lastSavedSnapshotRef = useRef<string>("");
  const initializingRef = useRef(false);
  const lastLoadedProjectIdRef = useRef<string | undefined>(undefined);
  const autoUpdateRef = useRef(false);
  const portalTarget = typeof document !== "undefined" ? document.body : null;
  const activeMenuRef = useRef<HTMLDivElement | null>(null);

  const buildPricingPayload = useCallback(
    (): PricingPayloadWithTracking => ({
      percentage,
      idleText,
      poRate,
      mpHourlyRate,
      totalPriceFactor,
      projectDuration,
      sellRateFactor,
      sellRateOverridesByItemId,
      subItemsByItemId,
      autoRowQtyByItemId,
      qtyOverrideByItemId,
      collapsedByItemId,
      completedByItemId,
      blockCodeByItemId,
    }),
    [
      percentage,
      idleText,
      poRate,
      mpHourlyRate,
      totalPriceFactor,
      projectDuration,
      sellRateFactor,
      sellRateOverridesByItemId,
      subItemsByItemId,
      autoRowQtyByItemId,
      qtyOverrideByItemId,
      collapsedByItemId,
      completedByItemId,
      blockCodeByItemId,
    ]
  );

  const applyPricingPayload = useCallback((payload: PricingPayloadWithTracking) => {
    setPercentage(payload.percentage ?? "10");
    setIdleText(payload.idleText ?? "idle time");
    setPoRate(payload.poRate ?? "8");
    if (payload.mpHourlyRate) {
      setMpHourlyRate(payload.mpHourlyRate);
    }
    setTotalPriceFactor(payload.totalPriceFactor ?? "0");
    setProjectDuration(payload.projectDuration ?? "2");
    setSellRateFactor(payload.sellRateFactor ?? "12.14");
    setSellRateOverridesByItemId(
      (payload.sellRateOverridesByItemId as Record<string, Partial<Record<PricingHeaderRateKey, string>>>) ?? {}
    );
    setSubItemsByItemId((payload.subItemsByItemId as Record<string, PricingSubItem[]>) ?? {});
    setAutoRowQtyByItemId((payload.autoRowQtyByItemId as Record<string, string>) ?? {});
    setQtyOverrideByItemId((payload.qtyOverrideByItemId as Record<string, string>) ?? {});
    setCollapsedByItemId((payload.collapsedByItemId as Record<string, boolean>) ?? {});
    setCompletedByItemId((payload.completedByItemId as Record<string, boolean>) ?? {});
    setBlockCodeByItemId((payload.blockCodeByItemId as Record<string, string>) ?? {});
  }, []);

  useEffect(() => {
    setLoadingRates(true);
    setRatesError("");
    getProductivityRates()
      .then((payload) => {
        setProductivityBlocks(payload.blocks ?? []);
        setMpHourlyRate(payload.factor ?? "0");
      })
      .catch((error: unknown) => {
        setRatesError((error as Error).message || "Failed to load productivity rates.");
      })
      .finally(() => setLoadingRates(false));
  }, []);

  useEffect(() => {
    if (!projectId) return;
    if (lastLoadedProjectIdRef.current === projectId) return;
    lastLoadedProjectIdRef.current = projectId;
    setLoadingPricing(true);
    lastSavedSnapshotRef.current = "";
    getPricing(projectId)
      .then((payload) => {
        initializingRef.current = true;
        applyPricingPayload(payload);
        lastSavedSnapshotRef.current = JSON.stringify(payload);
        onDirtyChange?.(false);
        setIsDirty(false);
      })
      .catch(() => {
        if (!lastSavedSnapshotRef.current) {
          lastSavedSnapshotRef.current = JSON.stringify(buildPricingPayload());
          onDirtyChange?.(false);
          setIsDirty(false);
        }
        initializingRef.current = false;
        // ignore load errors; page can still be edited
      })
      .finally(() => setLoadingPricing(false));
  }, [projectId, applyPricingPayload, onDirtyChange, buildPricingPayload]);

  useEffect(() => {
    subItemsByItemIdRef.current = subItemsByItemId;
  }, [subItemsByItemId]);

  useEffect(() => {
    if (copyFromProjectOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [copyFromProjectOpen]);

  const sortedBoqItems = useMemo(() => {
    return [...boqItems].sort((a, b) => {
      const aSheet = a.metadata?.sheetIndex ?? 0;
      const bSheet = b.metadata?.sheetIndex ?? 0;
      if (aSheet !== bSheet) return aSheet - bSheet;
      const aIndex = a.metadata?.rowIndex ?? 0;
      const bIndex = b.metadata?.rowIndex ?? 0;
      return aIndex - bIndex;
    });
  }, [boqItems]);

  const pricingEntries = useMemo(() => buildPricingEntries(sortedBoqItems), [sortedBoqItems]);
  const pricingBlocks = useMemo<PricingRenderEntry[]>(() => {
    const blocks: PricingRenderEntry[] = [];
    let pendingNotes: ProjectItem[] = [];
    let lastPricedIndex = -1;

    pricingEntries.forEach((entry) => {
      const item = entry.item;
      const isNoteRow = String(item.item_code ?? "").trim() === "ITEM";
      if (isNoteRow) {
        pendingNotes = [...pendingNotes, item];
        return;
      }
      const category = (item.metadata?.category ?? "").trim() || "Uncategorized";
      blocks.push({ type: "priced", item, notes: pendingNotes, category });
      lastPricedIndex = blocks.length - 1;
      pendingNotes = [];
    });

    if (pendingNotes.length > 0 && lastPricedIndex >= 0) {
      const last = blocks[lastPricedIndex];
      if (last.type === "priced") {
        last.notes = [...last.notes, ...pendingNotes];
      }
    }

    return blocks;
  }, [pricingEntries]);

  const productivityOptions = useMemo<ProductivityOption[]>(
    () =>
      productivityBlocks.map((block) => ({
        id: block.id,
        code: String(block.code ?? "").trim(),
        description: block.description || "Untitled",
        unit: block.unit,
        unitMh: computeManpowerMh(block),
        unitWagesRate: block.manpowerRate
          ? parseNumber(block.manpowerRate)
          : computeManpowerMh(block) * parseNumber(mpHourlyRate),
        equipmentRate: computeEquipmentRateSum(block),
      })),
    [productivityBlocks, mpHourlyRate]
  );

  const productivitySuggestionItems = useMemo(
    () => productivityOptions.map((option) => ({ id: option.id, description: option.description })),
    [productivityOptions]
  );

  const productivityOptionsById = useMemo(() => {
    return new Map(productivityOptions.map((option) => [option.id, option]));
  }, [productivityOptions]);

  const productivityOptionsByCode = useMemo(() => {
    const map = new Map<string, ProductivityOption>();
    productivityOptions.forEach((option) => {
      const key = normalizeCode(option.code);
      if (key) map.set(key, option);
    });
    return map;
  }, [productivityOptions]);

  useEffect(() => {
    if (productivityOptions.length === 0) return;
    setSubItemsByItemId((current) => {
      let changed = false;
      const next: Record<string, PricingSubItem[]> = {};
      Object.entries(current).forEach(([itemId, rows]) => {
        const updatedRows = rows.map((row) => {
          if (!row.productivityId) return row;
          const match = productivityOptions.find((option) => option.id === row.productivityId);
          if (!match) return row;
          if (
            row.unitMh === match.unitMh &&
            row.unitEquipRate === match.equipmentRate &&
            row.unitWagesRate === match.unitWagesRate
          ) {
            return row;
          }
          changed = true;
          return {
            ...row,
            unit: match.unit,
            unitMh: match.unitMh,
            unitWagesRate: match.unitWagesRate,
            unitEquipRate: match.equipmentRate,
          };
        });
        next[itemId] = updatedRows;
      });
      if (changed) {
        autoUpdateRef.current = true;
      }
      return changed ? next : current;
    });
  }, [productivityOptions]);

  const pricedItems = useMemo(
    () => sortedBoqItems.filter((item) => String(item.item_code ?? "").trim() !== "ITEM"),
    [sortedBoqItems]
  );

  const defaultQtyByItemId = useMemo(() => {
    const map = new Map<string, string>();
    pricedItems.forEach((item) => {
      const baseQty = getBoqFieldValue(item, "qty");
      const qty = String(qtyOverrideByItemId[item.id] ?? baseQty ?? "1").trim();
      map.set(item.id, qty || "1");
    });
    return map;
  }, [pricedItems, qtyOverrideByItemId]);

  const scheduleCodeEntries = useMemo(() => {
    const codes = new Map<string, string>();
    scheduleItems.forEach((item) => {
      const code = String(item.item_code ?? "").trim();
      if (code && code.toUpperCase() !== "ITEM") {
        codes.set(code.toLowerCase(), code);
      }
      const fields = item.metadata?.fields ?? {};
      Object.entries(fields).forEach(([key, value]) => {
        const normalized = normalizeColumn(key);
        if (normalized === "item" || normalized === "item code" || normalized === "code") {
          const fieldCode = String(value ?? "").trim();
          if (fieldCode && fieldCode.toUpperCase() !== "ITEM") {
            codes.set(fieldCode.toLowerCase(), fieldCode);
          }
        }
      });
    });
    return Array.from(codes.entries()).map(([lower, original]) => ({ lower, original }));
  }, [scheduleItems]);

  const drawingItemsByCode = useMemo(() => {
    const map = new Map<string, ProjectItem[]>();
    drawingItems.forEach((item) => {
      const code = String(item.item_code ?? "").trim();
      if (!code || code.toUpperCase() === "ITEM") return;
      const key = code.toLowerCase();
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    });
    return map;
  }, [drawingItems]);

  // CAD details are usually saved as ITEM rows under the previous non-ITEM code.
  // Build a lookup to recover detail notes per main code for pricing sub-rows.
  const drawingDetailNotesByMainCode = useMemo(() => {
    const map = new Map<string, Array<{ productivityRateId?: string; note: string }>>();
    let currentMainCode = "";
    drawingItems.forEach((item) => {
      const code = String(item.item_code ?? "").trim();
      if (!code) return;
      const productivityRateId = String(item.productivityRateId ?? "").trim();
      const note = String(item.notes ?? "").trim();
      if (code.toUpperCase() !== "ITEM") {
        currentMainCode = code.toLowerCase();
        if (!map.has(currentMainCode)) map.set(currentMainCode, []);
        // Some CAD rows may carry direct productivity links on non-ITEM codes.
        if (productivityRateId) {
          const list = map.get(currentMainCode) ?? [];
          list.push({ productivityRateId, note });
          map.set(currentMainCode, list);
        }
        return;
      }
      if (!currentMainCode) return;
      const list = map.get(currentMainCode) ?? [];
      list.push({ ...(productivityRateId ? { productivityRateId } : {}), note });
      map.set(currentMainCode, list);
    });
    return map;
  }, [drawingItems]);

  const drawingNotesByProductivityId = useMemo(() => {
    const map = new Map<string, string[]>();
    drawingItems.forEach((item) => {
      const productivityRateId = String(item.productivityRateId ?? "").trim();
      if (!productivityRateId) return;
      const note = String(item.notes ?? "").trim();
      if (!note) return;
      const list = map.get(productivityRateId) ?? [];
      list.push(note);
      map.set(productivityRateId, list);
    });
    return map;
  }, [drawingItems]);

  const findScheduleMatches = useCallback(
    (description: string) => {
      const descriptionLower = description.toLowerCase();
      const matches = scheduleCodeEntries
        .filter((entry) => descriptionLower && descriptionLower.includes(entry.lower))
        .map((entry) => entry.original);
      return Array.from(new Set(matches));
    },
    [scheduleCodeEntries]
  );

  const isRateOnlyItem = useCallback((item: ProjectItem): boolean => {
    const rateValue = getBoqFieldValue(item, "rate");
    return rateValue.trim().toLowerCase() === "rate only";
  }, []);

  useEffect(() => {
    setSubItemsByItemId((current) => {
      const next = { ...current };
      pricedItems.forEach((item) => {
        if (!next[item.id]) {
          next[item.id] = [];
        }
      });
      return next;
    });
    setAutoRowQtyByItemId((current) => {
      const next = { ...current };
      pricedItems.forEach((item) => {
        if (!next[item.id]) {
          next[item.id] = "1";
        }
      });
      return next;
    });
    setCollapsedByItemId((current) => {
      const next = { ...current };
      pricedItems.forEach((item) => {
        if (next[item.id] === undefined) {
          next[item.id] = false;
        }
      });
      return next;
    });
    setCompletedByItemId((current) => {
      const next = { ...current };
      pricedItems.forEach((item) => {
        if (next[item.id] === undefined) {
          next[item.id] = false;
        }
      });
      return next;
    });
  }, [pricedItems]);

  useEffect(() => {
    if (!initializingRef.current) return;
    const defaultsReady = pricedItems.every(
      (item) => subItemsByItemId[item.id] && autoRowQtyByItemId[item.id] !== undefined
    );
    if (!defaultsReady) return;
    const payload = buildPricingPayload();
    lastSavedSnapshotRef.current = JSON.stringify(payload);
    onDirtyChange?.(false);
    setIsDirty(false);
    initializingRef.current = false;
  }, [pricedItems, subItemsByItemId, autoRowQtyByItemId, buildPricingPayload, onDirtyChange]);

  const addSubItem = useCallback((itemId: string, defaultQty: string) => {
    setSubItemsByItemId((current) => ({
      ...current,
      [itemId]: [
        ...(current[itemId] ?? []),
        {
          id: uuidv4(),
          description: "",
          note: "",
          qty: defaultQty,
          unitMh: 0,
          unitEquipRate: 0,
          materialsRate: "0.00",
          subconRate: "0.00",
          toolsRate: "0.00",
        },
      ],
    }));
  }, []);

  const removeSubItem = useCallback((itemId: string, rowId: string) => {
    setSubItemsByItemId((current) => ({
      ...current,
      [itemId]: (current[itemId] ?? []).filter((row) => row.id !== rowId),
    }));
  }, []);

  const updateSubItem = useCallback(
    (itemId: string, rowId: string, updater: (row: PricingSubItem) => PricingSubItem) => {
      setSubItemsByItemId((current) => ({
        ...current,
        [itemId]: (current[itemId] ?? []).map((row) => (row.id === rowId ? updater(row) : row)),
      }));
    },
    []
  );

  const handleSelectProductivity = useCallback(
    (itemId: string, rowId: string, optionId: string) => {
      const selected = productivityOptions.find((option) => option.id === optionId);
      if (!selected) return;
      const defaultQty = defaultQtyByItemId.get(itemId) ?? "1";
      setRowCodeErrorByRowId((prev) => {
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
      updateSubItem(itemId, rowId, (row) => ({
        ...row,
        code: selected.code,
        productivityId: selected.id,
        description: selected.description,
        qty: row.qty && row.qty.trim() ? row.qty : defaultQty,
        unit: selected.unit,
        unitMh: selected.unitMh,
        unitWagesRate: selected.unitWagesRate,
        unitEquipRate: selected.equipmentRate,
        suggestedIds: row.suggestedIds?.includes(selected.id)
          ? row.suggestedIds
          : row.suggestedIds
            ? [selected.id, ...row.suggestedIds]
            : row.suggestedIds,
      }));
    },
    [defaultQtyByItemId, productivityOptions, updateSubItem]
  );

  const handleBlockCodeChange = useCallback(
    (itemId: string, newCode: string) => {
      setBlockCodeLoadingByItemId((prev) => ({ ...prev, [itemId]: true }));
      const trimmed = String(newCode ?? "").trim();
      setBlockCodeByItemId((current) => ({ ...current, [itemId]: trimmed }));
      const run = () => {
        if (!trimmed) {
          setBlockCodeLoadingByItemId((prev) => ({ ...prev, [itemId]: false }));
          return;
        }
        const normalizedNew = normalizeCode(trimmed);
        const sourceEntry = pricingBlocks.find(
          (entry) => entry.item.id !== itemId && normalizeCode(blockCodeByItemId[entry.item.id] ?? "") === normalizedNew
        );
        if (!sourceEntry) {
          setBlockCodeLoadingByItemId((prev) => ({ ...prev, [itemId]: false }));
          return;
        }
        const sourceRows = subItemsByItemId[sourceEntry.item.id] ?? [];
        if (sourceRows.length === 0) {
          setBlockCodeLoadingByItemId((prev) => ({ ...prev, [itemId]: false }));
          return;
        }
        const defaultQty = defaultQtyByItemId.get(itemId) ?? "1";
        const defaultQtyValue = parseNumber(defaultQty);
        const existing = subItemsByItemId[itemId] ?? [];
        const newRows: PricingSubItem[] = sourceRows.map((row) => {
          const thickness = row.thickness != null ? row.thickness : undefined;
          const qty =
            thickness != null && Number.isFinite(thickness)
              ? String(defaultQtyValue * thickness * 0.001)
              : defaultQty;
          const option = row.productivityId ? productivityOptionsById.get(row.productivityId) : null;
          if (!option) {
            return {
              id: uuidv4(),
              code: row.code,
              description: row.description,
              note: row.note,
              thickness: row.thickness ?? undefined,
              productivityId: row.productivityId,
              suggestedIds: row.suggestedIds,
              qty,
              unit: row.unit,
              unitMh: row.unitMh,
              unitWagesRate: row.unitWagesRate,
              unitEquipRate: row.unitEquipRate,
              materialsRate: row.materialsRate ?? "0.00",
              subconRate: row.subconRate ?? "0.00",
              toolsRate: row.toolsRate ?? "0.00",
            };
          }
          return {
            id: uuidv4(),
            code: option.code,
            description: option.description,
            note: row.note,
            thickness: row.thickness ?? undefined,
            productivityId: option.id,
            suggestedIds: [option.id],
            qty,
            unit: option.unit,
            unitMh: option.unitMh,
            unitWagesRate: option.unitWagesRate,
            unitEquipRate: option.equipmentRate,
            materialsRate: "0.00",
            subconRate: "0.00",
            toolsRate: "0.00",
          };
        });
        setSubItemsByItemId((current) => ({
          ...current,
          [itemId]: [...existing, ...newRows],
        }));
        onDirtyChange?.(true);
        setIsDirty(true);
        setTimeout(() => setBlockCodeLoadingByItemId((prev) => ({ ...prev, [itemId]: false })), 220);
      };
      setTimeout(run, 0);
    },
    [
      pricingBlocks,
      blockCodeByItemId,
      subItemsByItemId,
      defaultQtyByItemId,
      productivityOptionsById,
      onDirtyChange,
    ]
  );

  const openCopyFromProjectModal = useCallback((itemId: string) => {
    setCopyFromProjectItemId(itemId);
    setCopyFromProjectOpen(true);
    setCopyFromProjectBlockCode("");
    setCopyFromProjectText("");
    setCopyFromProjectBlocks([]);
    setCopyFromProjectTotal(0);
    setCopyFromProjectPage(1);
    setCopyFromProjectSelected(null);
  }, []);

  const fetchCopyFromProjectPage = useCallback(
    async (page: number) => {
      if (!projectId) return;
      const blockCode = copyFromProjectBlockCode.trim() || undefined;
      const text = copyFromProjectText.trim() || undefined;
      if (!blockCode && !text) {
        setCopyFromProjectBlocks([]);
        setCopyFromProjectTotal(0);
        return;
      }
      setCopyFromProjectLoading(true);
      try {
        const { blocks, total } = await searchPricingBlocks(projectId, {
          blockCode,
          text,
          page,
          pageSize: COPY_FROM_PROJECT_PAGE_SIZE,
        });
        setCopyFromProjectBlocks(blocks);
        setCopyFromProjectTotal(total);
        setCopyFromProjectPage(page);
        setCopyFromProjectSelected(null);
      } finally {
        setCopyFromProjectLoading(false);
      }
    },
    [projectId, copyFromProjectBlockCode, copyFromProjectText]
  );

  const filterCopyFromProject = useCallback(() => {
    fetchCopyFromProjectPage(1);
  }, [fetchCopyFromProjectPage]);

  const goToCopyFromProjectPage = useCallback(
    (page: number) => {
      if (page < 1 || page > Math.ceil(copyFromProjectTotal / COPY_FROM_PROJECT_PAGE_SIZE)) return;
      fetchCopyFromProjectPage(page);
    },
    [copyFromProjectTotal, fetchCopyFromProjectPage]
  );

  const applyCopyFromProject = useCallback(() => {
    const itemId = copyFromProjectItemId;
    const selected = copyFromProjectSelected;
    if (!itemId || !selected || selected.subitems.length === 0) return;
    const currentBlockQty = defaultQtyByItemId.get(itemId) ?? "1";
    const currentBlockQtyValue = parseNumber(currentBlockQty);
    const newRows: PricingSubItem[] = selected.subitems.map((sub: SearchBlocksSubitem) => {
      const code = String(sub.code ?? "").trim();
      const option = code ? productivityOptionsByCode.get(normalizeCode(code)) : null;
      const thickness = sub.thickness != null && Number.isFinite(sub.thickness) ? sub.thickness : null;
      const qty =
        thickness != null && Number.isFinite(thickness)
          ? String(currentBlockQtyValue * thickness * 0.001)
          : currentBlockQty;
      if (option) {
        return {
          id: uuidv4(),
          code: option.code,
          description: option.description,
          note: "",
          productivityId: option.id,
          suggestedIds: [option.id],
          qty,
          thickness: thickness ?? undefined,
          unit: option.unit,
          unitMh: option.unitMh,
          unitWagesRate: option.unitWagesRate,
          unitEquipRate: option.equipmentRate,
          materialsRate: "0.00",
          subconRate: "0.00",
          toolsRate: "0.00",
        };
      }
      return {
        id: uuidv4(),
        code: code || undefined,
        description: String(sub.description ?? "").trim() || "—",
        note: "",
        qty,
        thickness: thickness ?? undefined,
        unitMh: 0,
        unitWagesRate: 0,
        unitEquipRate: 0,
        materialsRate: "0.00",
        subconRate: "0.00",
        toolsRate: "0.00",
      };
    });
    setSubItemsByItemId((current) => ({
      ...current,
      [itemId]: newRows,
    }));
    onDirtyChange?.(true);
    setIsDirty(true);
    setCopyFromProjectOpen(false);
    setCopyFromProjectItemId(null);
    setCopyFromProjectSelected(null);
  }, [
    copyFromProjectItemId,
    copyFromProjectSelected,
    defaultQtyByItemId,
    productivityOptionsByCode,
    onDirtyChange,
  ]);

  const handleSubItemCodeChange = useCallback(
    (itemId: string, rowId: string, codeValue: string) => {
      setCodeLoadingByRowId((prev) => ({ ...prev, [rowId]: true }));
      setRowCodeErrorByRowId((prev) => {
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
      const trimmed = String(codeValue ?? "").trim();
      updateSubItem(itemId, rowId, (row) => ({ ...row, code: trimmed }));
      const clearLoading = () => setTimeout(() => setCodeLoadingByRowId((prev) => ({ ...prev, [rowId]: false })), 220);
      if (!trimmed) {
        clearLoading();
        return;
      }
      const option = productivityOptionsByCode.get(normalizeCode(trimmed));
      if (option) {
        handleSelectProductivity(itemId, rowId, option.id);
      } else {
        setRowCodeErrorByRowId((prev) => ({ ...prev, [rowId]: "No productivity rate item with this code." }));
      }
      clearLoading();
    },
    [productivityOptionsByCode, updateSubItem, handleSelectProductivity]
  );

  const updateAutoQty = useCallback((itemId: string, value: string) => {
    setAutoRowQtyByItemId((current) => ({ ...current, [itemId]: value }));
  }, []);

  const toggleCollapsed = useCallback((itemId: string) => {
    setCollapsedByItemId((current) => ({ ...current, [itemId]: !current[itemId] }));
  }, []);

  const toggleCompleted = useCallback((itemId: string) => {
    setCompletedByItemId((current) => {
      const nextValue = !current[itemId];
      if (nextValue) {
        setCollapsedByItemId((collapsed) => ({ ...collapsed, [itemId]: true }));
      }
      return { ...current, [itemId]: nextValue };
    });
  }, []);

  const formatTime = useCallback((value: string) => new Date(value).toLocaleTimeString(), []);

  const pushSuggestionLog = useCallback((message: string, level: SuggestionLogLevel = "info") => {
    const createdAt = new Date().toISOString();
    setSuggestionLogs((prev) => [
      { id: `${createdAt}-${Math.random()}`, level, message, createdAt },
      ...prev,
    ]);
  }, []);

  const handleAutoSuggest = useCallback(async () => {
    if (suggestionStatus === "running") return;
    setShowSuggestionLogs(true);
    setSuggestionStatus("running");
    setSuggestionError(null);
    setSuggestionLogs([]);
    setSuggestionCallsCompleted(0);
    setSuggestionCallsTotal(0);

    if (pricingBlocks.length === 0) {
      pushSuggestionLog("No priced items available for suggestions.", "warning");
      setSuggestionStatus("failed");
      return;
    }

    const scheduleBlocks = pricingBlocks.filter((entry) => {
      const description = String(entry.item.description ?? "");
      return findScheduleMatches(description).length > 0;
    });
    const aiBlocks = pricingBlocks.filter((entry) => {
      const description = String(entry.item.description ?? "");
      return findScheduleMatches(description).length === 0;
    });

    let scheduleAddedCount = 0;
    let scheduleBlockCount = 0;
    let scheduleDetailCount = 0;
    let scheduleEligibleDetailCount = 0;
    if (scheduleBlocks.length > 0) {
      setSubItemsByItemId((current) => {
        const next = { ...current };
        scheduleBlocks.forEach((entry) => {
          const itemId = entry.item.id;
          const description = String(entry.item.description ?? "");
          const matchedCodes = findScheduleMatches(description);
          if (matchedCodes.length === 0) return;
          const baseQty = getBoqFieldValue(entry.item, "qty");
          const qty = String(qtyOverrideByItemId[entry.item.id] ?? baseQty ?? "").trim() || "1";
          const baseQtyValue = parseStrictNumber(qty);
          const details = matchedCodes.flatMap((code) => drawingItemsByCode.get(code.toLowerCase()) ?? []);
          if (details.length === 0) return;
          scheduleDetailCount += details.length;
          scheduleBlockCount += 1;
          const existing = next[itemId] ?? [];
          const existingIds = new Set(existing.map((row) => row.productivityId).filter(Boolean));
          const newRows = details
            .map((detail) => {
              const detailProductivityId = detail.productivityRateId ?? undefined;
              if (!detailProductivityId) return null;
              if (existingIds.has(detailProductivityId)) return null;
              const option = productivityOptionsById.get(detailProductivityId);
              if (!option) return null;
              scheduleEligibleDetailCount += 1;
              const thickValue = parseThickness(detail.thickness);
              const computedQty =
                thickValue !== null && baseQtyValue !== null
                  ? String(baseQtyValue * thickValue * 0.001)
                  : qty;
              return {
                id: uuidv4(),
                code: option.code,
                description: option.description,
                note: String(detail.notes ?? "").trim(),
                thickness: thickValue ?? undefined,
                productivityId: option.id,
                suggestedIds: [option.id],
                qty: computedQty,
                unit: option.unit,
                unitMh: option.unitMh,
                unitWagesRate: option.unitWagesRate,
                unitEquipRate: option.equipmentRate,
                materialsRate: "0.00",
                subconRate: "0.00",
                toolsRate: "0.00",
              } as PricingSubItem;
            })
            .filter(Boolean) as PricingSubItem[];
          if (newRows.length > 0) {
            next[itemId] = [...existing, ...newRows];
            scheduleAddedCount += newRows.length;
          }
        });
        return next;
      });
      if (scheduleBlockCount > 0) {
        if (scheduleAddedCount > 0) {
          pushSuggestionLog(
            `Schedule-based details: added ${scheduleAddedCount} sub-item(s) across ${scheduleBlockCount} block(s).`
          );
        } else {
          pushSuggestionLog(
            `Schedule-based details processed for ${scheduleBlockCount} block(s), no eligible sub-items added.`
          );
        }
      }
      if (scheduleDetailCount > 0 && scheduleEligibleDetailCount === 0) {
        pushSuggestionLog(
          "No drawing details with productivity rate IDs were found for schedule-coded blocks.",
          "warning"
        );
      }
      if (scheduleAddedCount > 0) {
        onDirtyChange?.(true);
        setIsDirty(true);
      }
    }

    if (aiBlocks.length === 0) {
      setSuggestionStatus("success");
      return;
    }

    if (productivitySuggestionItems.length === 0) {
      pushSuggestionLog("No productivity items available to suggest from.", "warning");
      setSuggestionStatus("failed");
      return;
    }

    const suggestionBlocks = aiBlocks.map((entry) => {
      const description = entry.item.description ?? "";
      const baseQty = getBoqFieldValue(entry.item, "qty");
      const qty = String(qtyOverrideByItemId[entry.item.id] ?? baseQty ?? "").trim();
      const drawingDetails = entry.notes
        .map((note) => String(note.description ?? "").trim())
        .filter(Boolean);
      return {
        blockId: entry.item.id,
        itemCode: String(entry.item.item_code ?? "").trim(),
        description,
        qty,
        drawingDetails,
        scheduleCodes: [],
      };
    });
    const cadDetailsByBlockId = new Map(
      aiBlocks.map((entry) => {
        const mainCode = String(entry.item.item_code ?? "").trim().toLowerCase();
        return [entry.item.id, mainCode ? drawingDetailNotesByMainCode.get(mainCode) ?? [] : []] as const;
      })
    );
    const defaultQtyByBlockId = new Map(
      suggestionBlocks.map((block) => [block.blockId, block.qty || "1"])
    );

    const chunkSize = 10;
    const chunks: typeof suggestionBlocks[] = [];
    for (let i = 0; i < suggestionBlocks.length; i += chunkSize) {
      chunks.push(suggestionBlocks.slice(i, i + chunkSize));
    }

    setSuggestionCallsTotal(chunks.length);
    pushSuggestionLog(`Prepared ${suggestionBlocks.length} blocks in ${chunks.length} API call(s).`);

    chunks.forEach((chunk, index) => {
      pushSuggestionLog(
        `Calling AI for blocks ${index + 1}/${chunks.length} (${chunk.length} items).`
      );
    });

    const callResults = await Promise.allSettled<ProductivitySuggestResponse>(
      chunks.map(async (chunk, index) => {
        try {
          const response = await suggestProductivityItems({
            productivityItems: productivitySuggestionItems,
            blocks: chunk,
          });
          const validBlockIds = new Set(chunk.map((block) => block.blockId));
          const results = (response.results ?? []).filter((result) => validBlockIds.has(result.blockId));
          const suggestedCount = results.reduce(
            (sum, result) =>
              sum +
              (result.items ?? []).reduce(
                (itemSum, item) => itemSum + (item.suggestedIds?.length ?? 0),
                0
              ),
            0
          );
          let addedCount = 0;

          setSubItemsByItemId((current) => {
            const next = { ...current };
            results.forEach((result) => {
              const itemId = result.blockId;
              const existing = next[itemId] ?? [];
              const existingIds = new Set(existing.map((row) => row.productivityId).filter(Boolean));
              const defaultQty = defaultQtyByBlockId.get(itemId) ?? "1";
              const cadDetails = cadDetailsByBlockId.get(itemId) ?? [];
              const usedCadIndexes = new Set<number>();
              const usedGlobalNotesByProductivity = new Map<string, number>();
              const takeCadNoteForProductivity = (productivityId: string): string => {
                if (!productivityId) return "";
                const matchWithNoteIdx = cadDetails.findIndex(
                  (detail, idx) =>
                    !usedCadIndexes.has(idx) &&
                    detail.productivityRateId === productivityId &&
                    Boolean(detail.note)
                );
                if (matchWithNoteIdx >= 0) {
                  usedCadIndexes.add(matchWithNoteIdx);
                  return cadDetails[matchWithNoteIdx].note;
                }
                const firstMatchIdx = cadDetails.findIndex(
                  (detail, idx) => !usedCadIndexes.has(idx) && detail.productivityRateId === productivityId
                );
                if (firstMatchIdx >= 0) {
                  usedCadIndexes.add(firstMatchIdx);
                  return cadDetails[firstMatchIdx].note;
                }
                const fallbackAnyNoteIdx = cadDetails.findIndex(
                  (detail, idx) => !usedCadIndexes.has(idx) && Boolean(detail.note)
                );
                if (fallbackAnyNoteIdx >= 0) {
                  usedCadIndexes.add(fallbackAnyNoteIdx);
                  return cadDetails[fallbackAnyNoteIdx].note;
                }
                const globalNotes = drawingNotesByProductivityId.get(productivityId) ?? [];
                if (globalNotes.length > 0) {
                  const usedCount = usedGlobalNotesByProductivity.get(productivityId) ?? 0;
                  const pickedIndex = Math.min(usedCount, globalNotes.length - 1);
                  usedGlobalNotesByProductivity.set(productivityId, usedCount + 1);
                  return globalNotes[pickedIndex] ?? "";
                }
                return "";
              };
              const newRows = (result.items ?? [])
                .map((item) => {
                  const suggestions = (item.suggestedIds ?? []).filter((id: string) =>
                    productivityOptionsById.has(id)
                  );
                  if (suggestions.length === 0) return null;
                  const [primaryId] = suggestions;
                  if (!primaryId) return null;
                  if (existingIds.has(primaryId)) {
                    const existingNote = takeCadNoteForProductivity(primaryId);
                    if (existingNote) {
                      next[itemId] = (next[itemId] ?? []).map((row) => {
                        if (row.productivityId !== primaryId) return row;
                        if ((row.note ?? "").trim()) return row;
                        return { ...row, note: existingNote };
                      });
                    }
                    return null;
                  }
                  const option = productivityOptionsById.get(primaryId);
                  if (!option) return null;
                  const thickValue = parseThickness(item.thick);
                  const baseQtyValue = parseStrictNumber(defaultQty);
                  const thicknessMm = thickValue !== null ? Math.round(thickValue * 1000) : null;
                  const computedQty =
                    thicknessMm !== null && baseQtyValue !== null
                      ? String(baseQtyValue * thicknessMm * 0.001)
                      : defaultQty;
                  return {
                    id: uuidv4(),
                    code: option.code,
                    description: option.description,
                    note: takeCadNoteForProductivity(option.id),
                    thickness: thicknessMm ?? undefined,
                    productivityId: option.id,
                    suggestedIds: suggestions,
                    qty: computedQty,
                    unit: option.unit,
                    unitMh: option.unitMh,
                    unitWagesRate: option.unitWagesRate,
                    unitEquipRate: option.equipmentRate,
                    materialsRate: "0.00",
                    subconRate: "0.00",
                    toolsRate: "0.00",
                  } as PricingSubItem;
                })
                .filter(Boolean) as PricingSubItem[];
              if (newRows.length > 0) {
                next[itemId] = [...existing, ...newRows];
                addedCount += newRows.length;
              }
            });
            return next;
          });

          if (addedCount > 0) {
            pushSuggestionLog(
              `AI response ${index + 1}/${chunks.length} received. Suggested ${suggestedCount} item(s), added ${addedCount} new sub-item(s).`
            );
            onDirtyChange?.(true);
            setIsDirty(true);
          } else {
            pushSuggestionLog(
              suggestedCount > 0
                ? `AI response ${index + 1}/${chunks.length} received. Suggested ${suggestedCount} item(s)`
                : `AI response ${index + 1}/${chunks.length} received. No suggested items returned.`
            );
          }

          setSuggestionCallsCompleted((prev) => prev + 1);
          return response;
        } catch (error) {
          setSuggestionCallsCompleted((prev) => prev + 1);
          throw error;
        }
      })
    );

    const failures = callResults.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    if (failures.length > 0) {
      const message =
        failures.map((failure) => (failure.reason as Error)?.message || String(failure.reason)).find(Boolean) ||
        "Failed to get productivity suggestions.";
      setSuggestionError(message);
      failures.forEach((failure) => {
        const reason = (failure.reason as Error)?.message || String(failure.reason);
        pushSuggestionLog(`AI call failed: ${reason}`, "error");
      });
      setSuggestionStatus("failed");
      return;
    }

    pushSuggestionLog("All AI calls completed.");
    setSuggestionStatus("success");
  }, [
    suggestionStatus,
    pricingBlocks,
    productivitySuggestionItems,
    productivityOptionsById,
    qtyOverrideByItemId,
    drawingItemsByCode,
    drawingDetailNotesByMainCode,
    drawingNotesByProductivityId,
    findScheduleMatches,
    onDirtyChange,
    pushSuggestionLog,
  ]);

  const percentValue = parseNumber(percentage) / 100;
  const poRateValue = parseNumber(poRate) / 100;
  const mpHourlyRateValue = parseNumber(mpHourlyRate);
  const projectDurationValue = parseNumber(projectDuration);
  const getSellRateInputValue = useCallback(
    (itemId: string, rateKey: PricingHeaderRateKey) => {
      const override = sellRateOverridesByItemId[itemId]?.[rateKey];
      if (override !== undefined && override.trim() !== "") return override;
      return sellRateFactor;
    },
    [sellRateOverridesByItemId, sellRateFactor]
  );

  const getSellRateValue = useCallback(
    (itemId: string, rateKey: PricingHeaderRateKey) =>
      parseNumber(getSellRateInputValue(itemId, rateKey)) / 100,
    [getSellRateInputValue]
  );

  const buildEstimationRows = useCallback((): EstimationRow[] => {
    return pricingBlocks.flatMap((entry) => {
      const item = entry.item;
      const category = (item.metadata?.category ?? "").trim() || "Uncategorized";
      const subcategory = (item.metadata?.subcategory ?? "").trim() || "";
      const noteRows: EstimationRow[] = entry.notes.map((note) => ({
        id: `note-${note.id}`,
        type: "description",
        itemCode: "",
        category,
        subcategory,
        description: note.description?.trim() ? note.description : "—",
      }));

      const baseQtyDisplay = getBoqFieldValue(item, "qty");
      const qtyDisplay = qtyOverrideByItemId[item.id] ?? baseQtyDisplay;
      const unitDisplay = getBoqFieldValue(item, "unit");
      const qtyValue = parseNumber(qtyDisplay);
      const subItems = subItemsByItemId[item.id] ?? [];

      const manualRows = subItems.map((row) => {
        const rowQtyValue = getSubRowEffectiveQty(row, qtyDisplay);
        const unitMh = parseNumber(row.unitMh);
        const totalMh = unitMh * rowQtyValue;
        const unitRateWages =
          row.unitWagesRate !== undefined
            ? parseNumber(row.unitWagesRate)
            : unitMh * mpHourlyRateValue;
        const totalRateWages = unitRateWages * rowQtyValue;
        const unitRateMaterials = parseNumber(row.materialsRate);
        const totalRateMaterials = (unitRateMaterials + unitRateMaterials * poRateValue) * rowQtyValue;
        const unitRateSubcon = parseNumber(row.subconRate);
        const totalRateSubcon = unitRateSubcon * rowQtyValue;
        const unitRateEquip = parseNumber(row.unitEquipRate);
        const totalRateEquip = unitRateEquip * rowQtyValue;
        const unitRateTools = parseNumber(row.toolsRate);
        const totalRateTools = unitRateTools * rowQtyValue;
        return {
          totalMh,
          totalRateWages,
          totalRateMaterials,
          totalRateSubcon,
          totalRateEquip,
          totalRateTools,
        };
      });

      const manualTotals = manualRows.reduce(
        (acc, row) => ({
          totalMh: acc.totalMh + row.totalMh,
          totalRateWages: acc.totalRateWages + row.totalRateWages,
          totalRateMaterials: acc.totalRateMaterials + row.totalRateMaterials,
          totalRateSubcon: acc.totalRateSubcon + row.totalRateSubcon,
          totalRateEquip: acc.totalRateEquip + row.totalRateEquip,
          totalRateTools: acc.totalRateTools + row.totalRateTools,
        }),
        {
          totalMh: 0,
          totalRateWages: 0,
          totalRateMaterials: 0,
          totalRateSubcon: 0,
          totalRateEquip: 0,
          totalRateTools: 0,
        }
      );

      const autoQty = parseNumber(autoRowQtyByItemId[item.id] ?? "1");
      const autoUnitMh = manualTotals.totalMh * percentValue;
      const autoTotalMh = autoUnitMh * autoQty;
      const autoUnitRateWages = autoUnitMh * mpHourlyRateValue;
      const autoTotalRateWages = autoUnitRateWages * autoQty;
      const autoUnitRateEquip = manualTotals.totalRateEquip * percentValue;
      const autoTotalRateEquip = autoUnitRateEquip * autoQty;

      const totalsWithAuto = {
        totalMh: manualTotals.totalMh + autoTotalMh,
        totalRateWages: manualTotals.totalRateWages + autoTotalRateWages,
        totalRateMaterials: manualTotals.totalRateMaterials,
        totalRateSubcon: manualTotals.totalRateSubcon,
        totalRateEquip: manualTotals.totalRateEquip + autoTotalRateEquip,
        totalRateTools: manualTotals.totalRateTools,
      };

      const pricedUnitMh = qtyValue ? totalsWithAuto.totalMh / qtyValue : 0;
      const pricedUnitRateWages = pricedUnitMh * mpHourlyRateValue;
      const pricedUnitRateMaterials = qtyValue ? totalsWithAuto.totalRateMaterials / qtyValue : 0;
      const pricedUnitRateSubcon = qtyValue ? totalsWithAuto.totalRateSubcon / qtyValue : 0;
      const pricedUnitRateEquip = qtyValue ? totalsWithAuto.totalRateEquip / qtyValue : 0;
      const pricedUnitRateTools = qtyValue ? totalsWithAuto.totalRateTools / qtyValue : 0;
      const sellRateWagesValue = getSellRateValue(item.id, "wages");
      const sellRateMaterialsValue = getSellRateValue(item.id, "materials");
      const sellRateSubconValue = getSellRateValue(item.id, "subcon");
      const sellRateEquipValue = getSellRateValue(item.id, "equip");
      const sellRateOtherValue = getSellRateValue(item.id, "other");
      const sellUnitRateWages = pricedUnitRateWages / (1 - sellRateWagesValue);
      const sellUnitRateMaterials = pricedUnitRateMaterials / (1 - sellRateMaterialsValue);
      const sellUnitRateSubcon = pricedUnitRateSubcon / (1 - sellRateSubconValue);
      const sellUnitRateEquip = pricedUnitRateEquip / (1 - sellRateEquipValue);
      const sellUnitRateOther = pricedUnitRateTools / (1 - sellRateOtherValue);
      const sellUnitPriceRaw =
        sellUnitRateWages +
        sellUnitRateMaterials +
        sellUnitRateSubcon +
        sellUnitRateEquip +
        sellUnitRateOther;
      const sellUnitPriceRounded = roundTo2(sellUnitPriceRaw);
      const sellTotalPriceRaw = sellUnitPriceRounded * qtyValue;

      const pricedRow: EstimationRow = {
        id: `priced-${item.id}`,
        type: "priced",
        itemCode: item.item_code?.trim() ? item.item_code : "—",
        category,
        subcategory,
        description: item.description?.trim() ? item.description : "—",
        qty: qtyDisplay?.trim() ? qtyDisplay : "—",
        unit: unitDisplay?.trim() ? unitDisplay : "—",
        rate: formatRounded(sellUnitPriceRounded),
        amount: formatRounded(sellTotalPriceRaw),
      };

      return [...noteRows, pricedRow];
    });
  }, [
    pricingBlocks,
    qtyOverrideByItemId,
    subItemsByItemId,
    autoRowQtyByItemId,
    percentValue,
    poRateValue,
    mpHourlyRateValue,
    getSellRateValue,
  ]);

  const handleGoToEstimation = useCallback(() => {
    if (!onGoToEstimation) return;
    onGoToEstimation(buildEstimationRows());
  }, [buildEstimationRows, onGoToEstimation]);

  const summaryTotals = useMemo(() => {
    return pricingBlocks.reduce(
      (acc, entry) => {
        const item = entry.item;
        if (isRateOnlyItem(item)) return acc;
        const baseQtyDisplay = getBoqFieldValue(item, "qty");
        const qtyDisplay = qtyOverrideByItemId[item.id] ?? baseQtyDisplay;
        const qtyValue = parseNumber(qtyDisplay);
        const subItems = subItemsByItemId[item.id] ?? [];

        const manualTotals = subItems.reduce(
          (manualAcc, row) => {
            const rowQtyValue = getSubRowEffectiveQty(row, qtyDisplay);
            const unitMh = parseNumber(row.unitMh);
            const totalMh = unitMh * rowQtyValue;
            const unitRateWages =
              row.unitWagesRate !== undefined
                ? parseNumber(row.unitWagesRate)
                : unitMh * mpHourlyRateValue;
            const totalRateWages = unitRateWages * rowQtyValue;
            const unitRateMaterials = parseNumber(row.materialsRate);
            const totalRateMaterials = (unitRateMaterials + unitRateMaterials * poRateValue) * rowQtyValue;
            const unitRateSubcon = parseNumber(row.subconRate);
            const totalRateSubcon = unitRateSubcon * rowQtyValue;
            const unitRateEquip = parseNumber(row.unitEquipRate);
            const totalRateEquip = unitRateEquip * rowQtyValue;
            const unitRateTools = parseNumber(row.toolsRate);
            const totalRateTools = unitRateTools * rowQtyValue;
            return {
              totalMh: manualAcc.totalMh + totalMh,
              totalRateWages: manualAcc.totalRateWages + totalRateWages,
              totalRateMaterials: manualAcc.totalRateMaterials + totalRateMaterials,
              totalRateSubcon: manualAcc.totalRateSubcon + totalRateSubcon,
              totalRateEquip: manualAcc.totalRateEquip + totalRateEquip,
              totalRateTools: manualAcc.totalRateTools + totalRateTools,
            };
          },
          {
            totalMh: 0,
            totalRateWages: 0,
            totalRateMaterials: 0,
            totalRateSubcon: 0,
            totalRateEquip: 0,
            totalRateTools: 0,
          }
        );

        const autoQty = parseNumber(autoRowQtyByItemId[item.id] ?? "1");
        const autoUnitMh = manualTotals.totalMh * percentValue;
        const autoTotalMh = autoUnitMh * autoQty;
        const autoUnitRateWages = autoUnitMh * mpHourlyRateValue;
        const autoTotalRateWages = autoUnitRateWages * autoQty;
        const autoUnitRateEquip = manualTotals.totalRateEquip * percentValue;
        const autoTotalRateEquip = autoUnitRateEquip * autoQty;

        const totalsWithAuto = {
          totalMh: manualTotals.totalMh + autoTotalMh,
          totalRateWages: manualTotals.totalRateWages + autoTotalRateWages,
          totalRateMaterials: manualTotals.totalRateMaterials,
          totalRateSubcon: manualTotals.totalRateSubcon,
          totalRateEquip: manualTotals.totalRateEquip + autoTotalRateEquip,
          totalRateTools: manualTotals.totalRateTools,
        };

        const pricedUnitMh = qtyValue ? totalsWithAuto.totalMh / qtyValue : 0;
        const pricedUnitRateWages = pricedUnitMh * mpHourlyRateValue;
        const pricedUnitRateMaterials = qtyValue ? totalsWithAuto.totalRateMaterials / qtyValue : 0;
        const pricedUnitRateSubcon = qtyValue ? totalsWithAuto.totalRateSubcon / qtyValue : 0;
        const pricedUnitRateEquip = qtyValue ? totalsWithAuto.totalRateEquip / qtyValue : 0;
        const pricedUnitRateTools = qtyValue ? totalsWithAuto.totalRateTools / qtyValue : 0;
        const pricedUnitPriceRaw =
          pricedUnitRateTools +
          pricedUnitRateEquip +
          pricedUnitRateSubcon +
          pricedUnitRateWages +
          pricedUnitRateMaterials;
        const pricedUnitPrice = roundTo2(pricedUnitPriceRaw);
        const pricedTotalPrice = roundTo2(pricedUnitPrice * qtyValue);

        const sellRateWagesValue = getSellRateValue(item.id, "wages");
        const sellRateMaterialsValue = getSellRateValue(item.id, "materials");
        const sellRateSubconValue = getSellRateValue(item.id, "subcon");
        const sellRateEquipValue = getSellRateValue(item.id, "equip");
        const sellRateOtherValue = getSellRateValue(item.id, "other");
        const sellUnitRateWages = pricedUnitRateWages / (1 - sellRateWagesValue);
        const sellTotalRateWages = sellUnitRateWages * qtyValue;
        const sellUnitRateMaterials = pricedUnitRateMaterials / (1 - sellRateMaterialsValue);
        const sellTotalRateMaterials = sellUnitRateMaterials * qtyValue;
        const sellUnitRateSubcon = pricedUnitRateSubcon / (1 - sellRateSubconValue);
        const sellTotalRateSubcon = sellUnitRateSubcon * qtyValue;
        const sellUnitRateEquip = pricedUnitRateEquip / (1 - sellRateEquipValue);
        const sellTotalRateEquip = sellUnitRateEquip * qtyValue;
        const sellUnitRateOther = pricedUnitRateTools / (1 - sellRateOtherValue);
        const sellTotalRateOther = sellUnitRateOther * qtyValue;
        const sellUnitPriceRaw =
          sellUnitRateWages +
          sellUnitRateMaterials +
          sellUnitRateSubcon +
          sellUnitRateEquip +
          sellUnitRateOther;
        const sellUnitPriceRounded = roundTo2(sellUnitPriceRaw);
        const sellTotalPriceRaw = sellUnitPriceRounded * qtyValue;

        acc.totalMh += pricedUnitMh * qtyValue;
        acc.totalRateWages += pricedUnitRateWages * qtyValue;
        acc.totalRateMaterials += pricedUnitRateMaterials * qtyValue;
        acc.totalRateSubcon += pricedUnitRateSubcon * qtyValue;
        acc.totalRateEquip += pricedUnitRateEquip * qtyValue;
        acc.totalRateTools += pricedUnitRateTools * qtyValue;
        acc.totalPrice += pricedTotalPrice;
        acc.sellTotalRateWages += sellTotalRateWages;
        acc.sellTotalRateMaterials += sellTotalRateMaterials;
        acc.sellTotalRateSubcon += sellTotalRateSubcon;
        acc.sellTotalRateEquip += sellTotalRateEquip;
        acc.sellTotalRateOther += sellTotalRateOther;
        acc.sellTotalPrice += sellTotalPriceRaw;
        return acc;
      },
      {
        totalMh: 0,
        totalRateWages: 0,
        totalRateMaterials: 0,
        totalRateSubcon: 0,
        totalRateEquip: 0,
        totalRateTools: 0,
        totalPrice: 0,
        sellTotalRateWages: 0,
        sellTotalRateMaterials: 0,
        sellTotalRateSubcon: 0,
        sellTotalRateEquip: 0,
        sellTotalRateOther: 0,
        sellTotalPrice: 0,
      }
    );
  }, [
    pricingBlocks,
    subItemsByItemId,
    autoRowQtyByItemId,
    qtyOverrideByItemId,
    percentValue,
    poRateValue,
    mpHourlyRateValue,
    isRateOnlyItem,
    getSellRateValue,
  ]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!projectId) {
      setSaveError("Save requires an active project.");
      return false;
    }
    setSaving(true);
    setSaveError("");
    setSaveMessage("");
    const payload = buildPricingPayload();
    try {
      await savePricing(projectId, payload);
      lastSavedSnapshotRef.current = JSON.stringify(payload);
      onDirtyChange?.(false);
      setIsDirty(false);
      setSaveMessage("Saved.");
      setTimeout(() => setSaveMessage(""), 3000);
      return true;
    } catch (error: unknown) {
      setSaveError((error as Error).message || "Failed to save pricing.");
      return false;
    } finally {
      setSaving(false);
    }
  }, [projectId, buildPricingPayload, onDirtyChange]);

  useEffect(() => {
    onRegisterSave?.(handleSave);
  }, [handleSave, onRegisterSave]);

  useEffect(() => {
    const currentSnapshot = JSON.stringify(buildPricingPayload());
    if (loadingPricing || initializingRef.current) return;
    if (autoUpdateRef.current) {
      lastSavedSnapshotRef.current = currentSnapshot;
      onDirtyChange?.(false);
      setIsDirty(false);
      autoUpdateRef.current = false;
      return;
    }
    const isDirty = currentSnapshot !== lastSavedSnapshotRef.current;
    onDirtyChange?.(isDirty);
    setIsDirty(isDirty);
  }, [buildPricingPayload, onDirtyChange, loadingPricing]);

  useEffect(() => {
    if (!activeRowId) return;
    const handleScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (activeMenuRef.current && target && activeMenuRef.current.contains(target)) {
        return;
      }
      setActiveRowId(null);
    };
    const handleResize = () => setMenuPositionTick((tick) => tick + 1);
    window.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("scroll", handleScroll, { capture: true } as AddEventListenerOptions);
      window.removeEventListener("resize", handleResize);
    };
  }, [activeRowId]);

  const getMenuStyle = (rowId: string) => {
    void menuPositionTick;
    const anchor = menuAnchorRefs.current[rowId];
    if (!anchor) {
      return { position: "fixed" as const, opacity: 0, pointerEvents: "none" as const };
    }
    const rect = anchor.getBoundingClientRect();
    return {
      position: "fixed" as const,
      top: rect.bottom,
      left: rect.left,
      width: rect.width,
      zIndex: 9999,
    };
  };

  const updateSellRateOverride = useCallback(
    (itemId: string, rateKey: PricingHeaderRateKey, value: string) => {
      setSellRateOverridesByItemId((current) => ({
        ...current,
        [itemId]: {
          ...(current[itemId] ?? {}),
          [rateKey]: value,
        },
      }));
    },
    []
  );

  const getHeaderClassName = (idx: number, header: PricingHeader) => {
    const classes = [];
    if (idx === 0) classes.push("pricing-col-action");
    if (idx === 1) classes.push("pricing-col-code");
    if (idx === 2) classes.push("pricing-col-description");
    if (idx === 3) classes.push("pricing-col-note");
    if (header.group === "sell") classes.push("pricing-col-sell");
    return classes.length ? classes.join(" ") : undefined;
  };


  if (loadingRates || loadingPricing) {
    return (
      <section className="panel">
        <div className="panel__header panel__header--review">
          <div className="stepper-container">
            {headerTop}
            <h2 className="section-title section-title--compact">Pricing</h2>
            <p className="eyebrow" style={{ opacity: 0.7, marginTop: "0.35rem" }}>
              {projectName ? `${projectName} • ` : ""}Loading pricing data...
            </p>
          </div>
        </div>
        <div className="panel__body">
          <p className="loading-text">Loading pricing data...</p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel__header panel__header--review">
        <div className="stepper-container">
          {headerTop}
          <h2 className="section-title section-title--compact">Pricing</h2>
          <p className="eyebrow" style={{ opacity: 0.7, marginTop: "0.35rem" }}>
            {projectName ? `${projectName} • ` : ""}Configure pricing inputs and build sub-items per BOQ line.
          </p>
        </div>
      </div>
      <div className="panel__body">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
          <label className="electrical-input" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className="electrical-input__label">Percentage</span>
            <input
              className="electrical-input__control"
              type="number"
              value={percentage}
              onChange={(event) => setPercentage(event.target.value)}
              min={0}
              step="0.01"
            />
          </label>
          <span style={{ opacity: 0.4 }}>|</span>
          <label className="electrical-input" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className="electrical-input__label">Text</span>
            <input
              className="electrical-input__control"
              type="text"
              value={idleText}
              onChange={(event) => setIdleText(event.target.value)}
            />
          </label>
          <span style={{ opacity: 0.4 }}>|</span>
          <label className="electrical-input" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className="electrical-input__label">PO Rate</span>
            <input
              className="electrical-input__control"
              type="number"
              value={poRate}
              onChange={(event) => setPoRate(event.target.value)}
              min={0}
              step="0.01"
            />
          </label>
          <span style={{ opacity: 0.4 }}>|</span>
          <label className="electrical-input" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className="electrical-input__label">MP Hourly Rate</span>
            <input
              className="electrical-input__control"
              type="number"
              value={mpHourlyRate}
              readOnly
            />
          </label>
          <span style={{ opacity: 0.4 }}>|</span>
          <label className="electrical-input" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className="electrical-input__label">Factor</span>
            <input
              className="electrical-input__control"
              type="number"
              value={sellRateFactor}
              onChange={(event) => setSellRateFactor(event.target.value)}
              min={0}
              step="0.01"
            />
          </label>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleGoToEstimation}
            disabled={pricingBlocks.length === 0}
          >
            Go to Estimation
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleSave}
            disabled={saving || !projectId || !isDirty}
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleAutoSuggest()}
            disabled={suggestionStatus === "running" || productivitySuggestionItems.length === 0 || pricingBlocks.length === 0}
          >
            {suggestionStatus === "running" ? "Suggesting..." : "Auto-suggest Productivity"}
          </button>
          {!showSuggestionLogs && suggestionStatus !== "idle" && (
            <button
              type="button"
              className="btn-secondary btn-compact btn-muted"
              onClick={() => setShowSuggestionLogs(true)}
            >
              Show Logs
            </button>
          )}
          {saveMessage && <span className="status">{saveMessage}</span>}
          {saveError && <span className="feedback" style={{ margin: 0 }}>{saveError}</span>}
        </div>
        {ratesError && <p className="feedback">{ratesError}</p>}
        {loadingRates && <p className="loading-text">Loading productivity rates...</p>}
        {showSuggestionLogs && (
          <div className="compare-log-card" style={{ marginBottom: "1.5rem" }}>
            <div className="compare-log-header">
              <div>
                <p className="eyebrow">Productivity Suggestions</p>
                <h3>Live Processing</h3>
                <p className="dashboard-muted" style={{ margin: 0 }}>
                  Calls: {suggestionCallsCompleted}/{suggestionCallsTotal || 0}
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span className={`compare-status compare-status--${suggestionStatus}`}>
                  {suggestionStatus === "running"
                    ? "Processing…"
                    : suggestionStatus === "success"
                      ? "Completed"
                      : suggestionStatus === "failed"
                        ? "Failed"
                        : "Ready"}
                </span>
                <button type="button" className="modal__close" onClick={() => setShowSuggestionLogs(false)}>
                  ×
                </button>
              </div>
            </div>
            <div className="compare-log-body">
              {suggestionStatus === "running" && (
                <div className="compare-waiting">
                  <span className="compare-waiting__dot" />
                  <span className="compare-waiting__dot" />
                  <span className="compare-waiting__dot" />
                  <span className="compare-waiting__label">Analyzing productivity items…</span>
                </div>
              )}
              <div className="log-panel compare-log-panel">
                {suggestionLogs.length === 0 ? (
                  <div className="log-empty">Logs will appear here once the process starts.</div>
                ) : (
                  <ul className="log-list">
                    {suggestionLogs.map((log, index) => (
                      <li
                        key={log.id}
                        className={`log-item log-item--${log.level} ${index === 0 ? "log-item--latest" : ""}`}
                      >
                        <span className="log-time">{formatTime(log.createdAt)}</span>
                        <span className="log-message">{log.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {suggestionStatus === "failed" && (
                <div className="compare-error">
                  <p>{suggestionError || "Suggestion process failed. Please retry."}</p>
                  <button type="button" className="btn-match" onClick={() => void handleAutoSuggest()}>
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {pricingEntries.length === 0 ? (
          <div className="pricing-placeholder">
            <h3>No BOQ items yet</h3>
            <p>Upload and extract a BOQ file to start pricing.</p>
          </div>
        ) : (
          <div className="pricing-accordion pricing-accordion--pricing">
            {pricingBlocks.map((entry) => {
              const item = entry.item;
              const noteItems = entry.notes;
              const categoryLabel = entry.category;
              const isCollapsed = collapsedByItemId[item.id] ?? false;
              const isCompleted = completedByItemId[item.id] ?? false;
              const panelId = `pricing-panel-${item.id}`;
              const baseQtyDisplay = getBoqFieldValue(item, "qty");
              const qtyDisplay = qtyOverrideByItemId[item.id] ?? baseQtyDisplay;
              const unitDisplay = getBoqFieldValue(item, "unit");
              const qtyValue = parseNumber(qtyDisplay);
              const subItems = subItemsByItemId[item.id] ?? [];

              const manualRows = subItems.map((row) => {
                const rowQtyValue = getSubRowEffectiveQty(row, qtyDisplay);
                const unitMh = parseNumber(row.unitMh);
                const totalMh = unitMh * rowQtyValue;
                const unitRateWages =
                  row.unitWagesRate !== undefined
                    ? parseNumber(row.unitWagesRate)
                    : unitMh * mpHourlyRateValue;
                const totalRateWages = unitRateWages * rowQtyValue;
                const unitRateMaterials = parseNumber(row.materialsRate);
                const totalRateMaterials = (unitRateMaterials + unitRateMaterials * poRateValue) * rowQtyValue;
                const unitRateSubcon = parseNumber(row.subconRate);
                const totalRateSubcon = unitRateSubcon * rowQtyValue;
                const unitRateEquip = parseNumber(row.unitEquipRate);
                const totalRateEquip = unitRateEquip * rowQtyValue;
                const unitRateTools = parseNumber(row.toolsRate);
                const totalRateTools = unitRateTools * rowQtyValue;
                const unitPrice =
                  unitRateTools +
                  unitRateEquip +
                  unitRateSubcon +
                  unitRateWages +
                  unitRateMaterials * (1 + poRateValue);
                const totalPrice = unitPrice * rowQtyValue;
                return {
                  ...row,
                  rowQtyValue,
                  unitMh,
                  totalMh,
                  unitRateWages,
                  totalRateWages,
                  unitRateMaterials,
                  totalRateMaterials,
                  unitRateSubcon,
                  totalRateSubcon,
                  unitRateEquip,
                  totalRateEquip,
                  unitRateTools,
                  totalRateTools,
                  unitPrice,
                  totalPrice,
                };
              });

              const manualTotals = manualRows.reduce(
                (acc, row) => ({
                  totalMh: acc.totalMh + row.totalMh,
                  totalRateWages: acc.totalRateWages + row.totalRateWages,
                  totalRateMaterials: acc.totalRateMaterials + row.totalRateMaterials,
                  totalRateSubcon: acc.totalRateSubcon + row.totalRateSubcon,
                  totalRateEquip: acc.totalRateEquip + row.totalRateEquip,
                  totalRateTools: acc.totalRateTools + row.totalRateTools,
                }),
                {
                  totalMh: 0,
                  totalRateWages: 0,
                  totalRateMaterials: 0,
                  totalRateSubcon: 0,
                  totalRateEquip: 0,
                  totalRateTools: 0,
                }
              );

              const autoQty = parseNumber(autoRowQtyByItemId[item.id] ?? "1");
              const percentageLabel = percentage.trim() || "0";
              const autoUnitMh = manualTotals.totalMh * percentValue;
              const autoTotalMh = autoUnitMh * autoQty;
              const autoUnitRateWages = autoUnitMh * mpHourlyRateValue;
              const autoTotalRateWages = autoUnitRateWages * autoQty;
              const autoUnitRateEquip = manualTotals.totalRateEquip * percentValue;
              const autoTotalRateEquip = autoUnitRateEquip * autoQty;
              const autoUnitPrice = autoUnitRateEquip + autoUnitRateWages;
              const autoTotalPrice = autoUnitPrice * autoQty;

              const totalsWithAuto = {
                totalMh: manualTotals.totalMh + autoTotalMh,
                totalRateWages: manualTotals.totalRateWages + autoTotalRateWages,
                totalRateMaterials: manualTotals.totalRateMaterials,
                totalRateSubcon: manualTotals.totalRateSubcon,
                totalRateEquip: manualTotals.totalRateEquip + autoTotalRateEquip,
                totalRateTools: manualTotals.totalRateTools,
              };

              const pricedUnitMh = qtyValue ? totalsWithAuto.totalMh / qtyValue : 0;
              const pricedUnitRateWages = pricedUnitMh * mpHourlyRateValue;
              const pricedUnitRateMaterials = qtyValue ? totalsWithAuto.totalRateMaterials / qtyValue : 0;
              const pricedUnitRateSubcon = qtyValue ? totalsWithAuto.totalRateSubcon / qtyValue : 0;
              const pricedUnitRateEquip = qtyValue ? totalsWithAuto.totalRateEquip / qtyValue : 0;
              const pricedUnitRateTools = qtyValue ? totalsWithAuto.totalRateTools / qtyValue : 0;
              const pricedUnitPriceRaw =
                pricedUnitRateTools +
                pricedUnitRateEquip +
                pricedUnitRateSubcon +
                pricedUnitRateWages +
                pricedUnitRateMaterials;
              const pricedUnitPrice = roundTo2(pricedUnitPriceRaw);
              const pricedTotalPrice = roundTo2(pricedUnitPrice * qtyValue);
              const sellRateWagesValue = getSellRateValue(item.id, "wages");
              const sellRateMaterialsValue = getSellRateValue(item.id, "materials");
              const sellRateSubconValue = getSellRateValue(item.id, "subcon");
              const sellRateEquipValue = getSellRateValue(item.id, "equip");
              const sellRateOtherValue = getSellRateValue(item.id, "other");
              const sellUnitRateWages = pricedUnitRateWages / (1 - sellRateWagesValue);
              const sellTotalRateWages = sellUnitRateWages * qtyValue;
              const sellUnitRateMaterials = pricedUnitRateMaterials / (1 - sellRateMaterialsValue);
              const sellTotalRateMaterials = sellUnitRateMaterials * qtyValue;
              const sellUnitRateSubcon = pricedUnitRateSubcon / (1 - sellRateSubconValue);
              const sellTotalRateSubcon = sellUnitRateSubcon * qtyValue;
              const sellUnitRateEquip = pricedUnitRateEquip / (1 - sellRateEquipValue);
              const sellTotalRateEquip = sellUnitRateEquip * qtyValue;
              const sellUnitRateOther = pricedUnitRateTools / (1 - sellRateOtherValue);
              const sellTotalRateOther = sellUnitRateOther * qtyValue;
              const sellUnitPriceRaw =
                sellUnitRateWages +
                sellUnitRateMaterials +
                sellUnitRateSubcon +
                sellUnitRateEquip +
                sellUnitRateOther;
              const sellUnitPriceRounded = roundTo2(sellUnitPriceRaw);
              const sellTotalPriceRaw = sellUnitPriceRounded * qtyValue;

              const isRateOnly = isRateOnlyItem(item);
              return (
                <div
                  key={item.id}
                  className={`pricing-accordion__card${isCollapsed ? "" : " is-open"}${isCompleted ? " is-complete" : ""}${isRateOnly ? " is-rate-only" : ""}`}
                >
                  <div
                    className="pricing-accordion__header"
                    role="button"
                    tabIndex={0}
                    aria-expanded={!isCollapsed}
                    aria-controls={panelId}
                    onClick={() => toggleCollapsed(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleCollapsed(item.id);
                      }
                    }}
                  >
                    <span>{categoryLabel}</span>
                    <div className="pricing-accordion__block-code" onClick={(e) => e.stopPropagation()}>
                      <label className="pricing-block-code-label">
                        Block code
                        {blockCodeLoadingByItemId[item.id] && (
                          <span className="pricing-code-loader pricing-code-loader--inline" aria-hidden>
                            <span className="pricing-code-loader__spinner" />
                          </span>
                        )}
                        <input
                          type="text"
                          className="pricing-block-code-input"
                          value={blockCodeByItemId[item.id] ?? ""}
                          disabled={!!blockCodeLoadingByItemId[item.id]}
                          onChange={(e) => setBlockCodeByItemId((curr) => ({ ...curr, [item.id]: e.target.value }))}
                          onBlur={(e) => handleBlockCodeChange(item.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.stopPropagation();
                              (e.target as HTMLInputElement).blur();
                            }
                            if (e.key === " ") e.stopPropagation();
                          }}
                          placeholder="Code"
                          aria-label="Block code"
                        />
                      </label>
                    </div>
                    <div className="pricing-accordion__actions">
                      <button
                        type="button"
                        className={`inline-check-button${isCompleted ? " is-active" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleCompleted(item.id);
                        }}
                        aria-pressed={isCompleted}
                        aria-label={isCompleted ? "Mark block as in progress" : "Mark block as completed"}
                        title={isCompleted ? "Mark block as in progress" : "Mark block as completed"}
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        className="inline-copy-block-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          openCopyFromProjectModal(item.id);
                        }}
                        aria-label="Copy from another project"
                        title="Copy from another project"
                      >
                        ⎘
                      </button>
                      <button
                        type="button"
                        className="inline-add-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          addSubItem(item.id, qtyDisplay);
                        }}
                        aria-label="Add sub item"
                        title="Add sub item"
                      >
                        +
                      </button>
                    </div>
                  </div>
                  {!isCollapsed && (
                    <div className="pricing-accordion__panel" id={panelId}>
                      <div className="pricing-table-wrapper">
                        <table className="matches-table pricing-table">
                          <colgroup>
                            <col style={{ width: "36px" }} />
                            <col style={{ width: "100px" }} />
                            <col style={{ width: "300px" }} />
                            <col style={{ width: "220px" }} />
                            {PRICING_HEADERS.slice(4).map((_, idx) => (
                              <col key={`col-${item.id}-${idx}`} style={{ width: "180px" }} />
                            ))}
                          </colgroup>
                          <thead>
                            <tr className="pricing-rate-row">
                              {PRICING_HEADERS.map((header, idx) => {
                                const rateKey = header.rateKey;
                                return (
                                  <th key={`rate-${item.id}-${header.key}`} className={getHeaderClassName(idx, header)}>
                                    {rateKey ? (
                                      <input
                                        className="pricing-rate-input"
                                        type="number"
                                        value={getSellRateInputValue(item.id, rateKey)}
                                        min={0}
                                        step="0.01"
                                        onChange={(event) =>
                                          updateSellRateOverride(item.id, rateKey, event.target.value)
                                        }
                                        aria-label={`Sell rate ${rateKey} (%)`}
                                      />
                                    ) : null}
                                  </th>
                                );
                              })}
                            </tr>
                            <tr>
                              {PRICING_HEADERS.map((header, idx) => (
                                <th
                                  key={`${item.id}-${header.key}`}
                                  className={getHeaderClassName(idx, header)}
                                >
                                  {header.label}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {noteItems.map((note) => (
                              <tr key={note.id}>
                                <td colSpan={PRICING_HEADERS.length}>
                                  <span className="cell-text">{note.description}</span>
                                </td>
                              </tr>
                            ))}
                            <tr>
                              <td className="pricing-col-action" />
                              <td className="pricing-col-code">{item.item_code || "—"}</td>
                              <td className="pricing-col-description">
                                <span className="cell-text">{item.description}</span>
                              </td>
                              <td className="pricing-col-note" />
                              <td />
                              <td>{qtyDisplay || "—"}</td>
                              <td>{unitDisplay || "—"}</td>
                              <td>{formatRounded(pricedUnitMh)}</td>
                              <td>{formatRounded(pricedUnitMh * qtyValue)}</td>
                              <td>{formatRounded(pricedUnitRateWages)}</td>
                              <td>{formatRounded(pricedUnitRateWages * qtyValue)}</td>
                              <td>{formatRounded(pricedUnitRateMaterials)}</td>
                              <td>{formatRounded(pricedUnitRateMaterials * qtyValue)}</td>
                              <td>{formatRounded(pricedUnitRateSubcon)}</td>
                              <td>{formatRounded(pricedUnitRateSubcon * qtyValue)}</td>
                              <td>{formatRounded(pricedUnitRateEquip)}</td>
                              <td>{formatRounded(pricedUnitRateEquip * qtyValue)}</td>
                              <td>{formatRounded(pricedUnitRateTools)}</td>
                              <td>{formatRounded(pricedUnitRateTools * qtyValue)}</td>
                              <td>{formatRounded(pricedUnitPrice)}</td>
                              <td>{formatRounded(pricedTotalPrice)}</td>
                              <td>{formatRounded(sellUnitRateWages)}</td>
                              <td>{formatRounded(sellTotalRateWages)}</td>
                              <td>{formatRounded(sellUnitRateMaterials)}</td>
                              <td>{formatRounded(sellTotalRateMaterials)}</td>
                              <td>{formatRounded(sellUnitRateSubcon)}</td>
                              <td>{formatRounded(sellTotalRateSubcon)}</td>
                              <td>{formatRounded(sellUnitRateEquip)}</td>
                              <td>{formatRounded(sellTotalRateEquip)}</td>
                              <td>{formatRounded(sellUnitRateOther)}</td>
                              <td>{formatRounded(sellTotalRateOther)}</td>
                              <td>{formatRounded(sellUnitPriceRounded)}</td>
                              <td>{formatRounded(sellTotalPriceRaw)}</td>
                            </tr>
                            {manualRows.map((row) => {
                              const query = row.description.trim().toLowerCase();
                              const hasSuggestedList = (row.suggestedIds?.length ?? 0) > 0;
                              const showSuggestedList = hasSuggestedList && query.length < 3;
                              const showSuggestions =
                                activeRowId === row.id && (showSuggestedList || query.length >= 3);
                              const matches = showSuggestions
                                ? showSuggestedList
                                  ? (row.suggestedIds ?? [])
                                    .map((id) => productivityOptionsById.get(id))
                                    .filter((option): option is ProductivityOption => Boolean(option))
                                  : productivityOptions
                                    .filter((option) => option.description.toLowerCase().includes(query))
                                    .slice(0, 8)
                                : [];
                              const displayCode = row.code ?? (row.productivityId ? productivityOptionsById.get(row.productivityId)?.code ?? "" : "");
                              const isCodeLoading = codeLoadingByRowId[row.id];
                              return (
                                <tr key={row.id}>
                                  <td className="pricing-col-action">
                                    <button
                                      type="button"
                                      className="inline-remove-button"
                                      onClick={() => removeSubItem(item.id, row.id)}
                                      aria-label="Remove sub item"
                                    >
                                      −
                                    </button>
                                  </td>
                                  <td className="pricing-col-code">
                                    <div className="pricing-sub-row-code-cell">
                                      <span className="pricing-sub-row-code-input-wrap">
                                        <input
                                          type="text"
                                          className="pricing-sub-item-code-input"
                                          value={displayCode}
                                          disabled={isCodeLoading}
                                        onChange={(e) => updateSubItem(item.id, row.id, (r) => ({ ...r, code: e.target.value }))}
                                        onBlur={(e) => handleSubItemCodeChange(item.id, row.id, e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") {
                                            (e.target as HTMLInputElement).blur();
                                          }
                                        }}
                                        placeholder="Code"
                                        aria-label="Sub item code (productivity rate)"
                                        title="Type a productivity rate code to auto-fill"
                                      />
                                        {isCodeLoading && (
                                          <span className="pricing-code-loader pricing-code-loader--inline" aria-hidden>
                                            <span className="pricing-code-loader__spinner" />
                                          </span>
                                        )}
                                      </span>
                                      {rowCodeErrorByRowId[row.id] && (
                                        <span className="pricing-row-code-error" role="alert">
                                          {rowCodeErrorByRowId[row.id]}
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="pricing-col-description" style={{ position: "relative", overflow: "visible" }}>
                                    <div className="productivity-cell-with-action" ref={(el) => {
                                      menuAnchorRefs.current[row.id] = el;
                                    }}>
                                      <input
                                        type="text"
                                        value={row.description}
                                        title={row.description}
                                        onFocus={() => {
                                          if (row.suggestedIds?.length) {
                                            setActiveRowId(row.id);
                                            return;
                                          }
                                          if (row.description.trim().length >= 3) {
                                            setActiveRowId(row.id);
                                          }
                                        }}
                                        onBlur={() => setTimeout(() => setActiveRowId(null), 150)}
                                        onChange={(event) =>
                                          updateSubItem(item.id, row.id, (current) => ({
                                            ...current,
                                            description: event.target.value,
                                          }))
                                        }
                                        onInput={(event) => {
                                          const value = (event.target as HTMLInputElement).value.trim();
                                          if (row.suggestedIds?.length) {
                                            setActiveRowId(row.id);
                                            return;
                                          }
                                          setActiveRowId(value.length >= 3 ? row.id : null);
                                        }}
                                        placeholder="Search productivity rates..."
                                      />
                                      {matches.length > 0 && (
                                        portalTarget
                                          ? createPortal(
                                            <div
                                              className="pricing-match-menu"
                                              style={getMenuStyle(row.id)}
                                              ref={(el) => {
                                                if (activeRowId === row.id) {
                                                  activeMenuRef.current = el;
                                                }
                                              }}
                                              onWheel={(event) => event.stopPropagation()}
                                              onScroll={(event) => event.stopPropagation()}
                                            >
                                              {matches.map((option) => (
                                                <button
                                                  key={option.id}
                                                  type="button"
                                                  className={`pricing-match-menu__item${option.id === row.productivityId ? " is-active" : ""}`}
                                                  title={option.description}
                                                  onMouseDown={(event) => {
                                                    event.preventDefault();
                                                    handleSelectProductivity(item.id, row.id, option.id);
                                                    setActiveRowId(null);
                                                  }}
                                                >
                                                  {option.description}
                                                </button>
                                              ))}
                                            </div>,
                                            portalTarget
                                          )
                                          : (
                                            <div
                                              className="pricing-match-menu"
                                              style={getMenuStyle(row.id)}
                                              ref={(el) => {
                                                if (activeRowId === row.id) {
                                                  activeMenuRef.current = el;
                                                }
                                              }}
                                              onWheel={(event) => event.stopPropagation()}
                                              onScroll={(event) => event.stopPropagation()}
                                            >
                                              {matches.map((option) => (
                                                <button
                                                  key={option.id}
                                                  type="button"
                                                  className={`pricing-match-menu__item${option.id === row.productivityId ? " is-active" : ""}`}
                                                  title={option.description}
                                                  onMouseDown={(event) => {
                                                    event.preventDefault();
                                                    handleSelectProductivity(item.id, row.id, option.id);
                                                    setActiveRowId(null);
                                                  }}
                                                >
                                                  {option.description}
                                                </button>
                                              ))}
                                            </div>
                                          )
                                      )}
                                    </div>
                                  </td>
                                  <td className="pricing-col-note">
                                    <input
                                      type="text"
                                      value={row.note ?? ""}
                                      onChange={(event) =>
                                        updateSubItem(item.id, row.id, (current) => ({
                                          ...current,
                                          note: event.target.value,
                                        }))
                                      }
                                      placeholder="Note"
                                      title={row.note ?? ""}
                                    />
                                  </td>
                                  <td>
                                    <input
                                      type="text"
                                      inputMode="decimal"
                                      placeholder="mm"
                                      value={row.thickness != null ? String(row.thickness) : ""}
                                      onChange={(event) => {
                                        const raw = event.target.value.trim();
                                        if (raw === "") {
                                          updateSubItem(item.id, row.id, (current) => ({
                                            ...current,
                                            thickness: null,
                                          }));
                                          return;
                                        }
                                        const num = parseStrictNumber(raw);
                                        if (num === null) return;
                                        const mainQty = parseNumber(qtyDisplay);
                                        updateSubItem(item.id, row.id, (current) => ({
                                          ...current,
                                          thickness: num,
                                          qty: String(mainQty * num * 0.001),
                                        }));
                                      }
                                    }
                                  aria-label="Thickness (mm)"
                                  title="Thickness in mm; qty = main qty × thickness × 0.001"
                                />
                                  </td>
                                  <td>
                                    <input
                                      type="text"
                                      inputMode="decimal"
                                      value={row.thickness != null ? String(getSubRowEffectiveQty(row, qtyDisplay)) : (row.qty ?? qtyDisplay)}
                                      onChange={(event) =>
                                        updateSubItem(item.id, row.id, (current) => ({
                                          ...current,
                                          qty: event.target.value,
                                          thickness: undefined,
                                        }))
                                      }
                                    />
                                  </td>
                                  <td>{row.unit ?? unitDisplay ?? "—"}</td>
                                  <td>{formatRounded(row.unitMh)}</td>
                                  <td>{formatRounded(row.totalMh)}</td>
                                  <td>{formatRounded(row.unitRateWages)}</td>
                                  <td>{formatRounded(row.totalRateWages)}</td>
                                  <td>
                                    <input
                                      type="number"
                                      value={row.materialsRate}
                                      onChange={(event) =>
                                        updateSubItem(item.id, row.id, (current) => ({
                                          ...current,
                                          materialsRate: event.target.value,
                                        }))
                                      }
                                    />
                                  </td>
                                  <td>{formatRounded(row.totalRateMaterials)}</td>
                                  <td>
                                    <input
                                      type="number"
                                      value={row.subconRate}
                                      onChange={(event) =>
                                        updateSubItem(item.id, row.id, (current) => ({
                                          ...current,
                                          subconRate: event.target.value,
                                        }))
                                      }
                                    />
                                  </td>
                                  <td>{formatRounded(row.totalRateSubcon)}</td>
                                  <td>{formatRounded(row.unitRateEquip)}</td>
                                  <td>{formatRounded(row.totalRateEquip)}</td>
                                  <td>
                                    <input
                                      type="number"
                                      value={row.toolsRate}
                                      onChange={(event) =>
                                        updateSubItem(item.id, row.id, (current) => ({
                                          ...current,
                                          toolsRate: event.target.value,
                                        }))
                                      }
                                    />
                                  </td>
                                  <td>{formatRounded(row.totalRateTools)}</td>
                                  <td>{formatRounded(row.unitPrice)}</td>
                                  <td>{formatRounded(row.totalPrice)}</td>
                                  <td />
                                  <td />
                                  <td />
                                  <td />
                                  <td />
                                  <td />
                                  <td />
                                  <td />
                                  <td />
                                  <td />
                                  <td />
                                  <td />
                                </tr>
                              );
                            })}
                            <tr>
                              <td className="pricing-col-action" />
                              <td className="pricing-col-code" />
                              <td className="pricing-col-description">
                                <span className="cell-text">{`${percentageLabel}% - ${idleText}`}</span>
                              </td>
                              <td className="pricing-col-note" />
                              <td />
                              <td>
                                <input
                                  type="number"
                                  value={autoRowQtyByItemId[item.id] ?? "1"}
                                  onChange={(event) => updateAutoQty(item.id, event.target.value)}
                                />
                              </td>
                              <td>ls</td>
                              <td>{formatRounded(autoUnitMh)}</td>
                              <td>{formatRounded(autoTotalMh)}</td>
                              <td>{formatRounded(autoUnitRateWages)}</td>
                              <td>{formatRounded(autoTotalRateWages)}</td>
                              <td />
                              <td />
                              <td />
                              <td />
                              <td>{formatRounded(autoUnitRateEquip)}</td>
                              <td>{formatRounded(autoTotalRateEquip)}</td>
                              <td />
                              <td />
                              <td>{formatRounded(autoUnitPrice)}</td>
                              <td>{formatRounded(autoTotalPrice)}</td>
                              <td />
                              <td />
                              <td />
                              <td />
                              <td />
                              <td />
                              <td />
                              <td />
                              <td />
                              <td />
                              <td />
                              <td />
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {pricingBlocks.length > 0 && (
              <div className="pricing-accordion__card pricing-accordion__card--summary">
                <div className="pricing-accordion__header pricing-accordion__header--summary">
                  <span>Totals</span>
                </div>
                <div className="pricing-accordion__panel pricing-accordion__panel--summary">
                  <div className="pricing-table-wrapper pricing-table-wrapper--summary">
                    <table className="matches-table pricing-table pricing-table--summary">
                      <colgroup>
                        {SUMMARY_HEADERS.map((header) => (
                          <col
                            key={`summary-col-${header.key}`}
                            style={{ width: header.key === "label" ? "260px" : "180px" }}
                          />
                        ))}
                      </colgroup>
                      <thead>
                        <tr>
                          {SUMMARY_HEADERS.map((header) => (
                            <th
                              key={`summary-${header.key}`}
                              className={header.group === "sell" ? "pricing-summary-sell" : undefined}
                            >
                              {header.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="pricing-summary-row">
                          <td>
                            <span className="cell-text">Result Total</span>
                          </td>
                          <td>{formatRounded(summaryTotals.totalMh)}</td>
                          <td>{formatRounded(summaryTotals.totalRateWages)}</td>
                          <td>{formatRounded(summaryTotals.totalRateMaterials)}</td>
                          <td>{formatRounded(summaryTotals.totalRateSubcon)}</td>
                          <td>{formatRounded(summaryTotals.totalRateEquip)}</td>
                          <td>{formatRounded(summaryTotals.totalRateTools)}</td>
                          <td>{formatRounded(summaryTotals.totalPrice)}</td>
                          <td className="pricing-summary-sell">
                            {formatRounded(summaryTotals.sellTotalRateWages)}
                          </td>
                          <td className="pricing-summary-sell">
                            {formatRounded(summaryTotals.sellTotalRateMaterials)}
                          </td>
                          <td className="pricing-summary-sell">
                            {formatRounded(summaryTotals.sellTotalRateSubcon)}
                          </td>
                          <td className="pricing-summary-sell">
                            {formatRounded(summaryTotals.sellTotalRateEquip)}
                          </td>
                          <td className="pricing-summary-sell">
                            {formatRounded(summaryTotals.sellTotalRateOther)}
                          </td>
                          <td className="pricing-summary-sell">
                            {formatRounded(summaryTotals.sellTotalPrice)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div className="pricing-summary-foot">
                    <div className="pricing-summary-foot__label">
                      <span className="cell-text">Total Working Days</span>
                    </div>
                    <div className="pricing-summary-foot__value">
                      <input
                        className="electrical-input__control"
                        type="number"
                        value={formatRounded(
                          projectDurationValue ? summaryTotals.totalMh / 160 / projectDurationValue : 0
                        )}
                        readOnly
                        disabled
                      />
                    </div>
                    <div className="pricing-summary-foot__label">
                      <span className="cell-text">Project Duration</span>
                    </div>
                    <div className="pricing-summary-foot__value">
                      <input
                        className="electrical-input__control"
                        type="number"
                        value={projectDuration}
                        onChange={(event) => setProjectDuration(event.target.value)}
                        min={0}
                        step="0.01"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className="pricing-fab btn-secondary"
        onClick={handleSave}
        disabled={saving || !projectId || !isDirty}
        title="Save pricing"
      >
        {saving ? "Saving..." : "Save"}
      </button>
      {copyFromProjectOpen && (
        <div
          className="pricing-copy-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="copy-from-project-title"
          onClick={(e) => e.target === e.currentTarget && setCopyFromProjectOpen(false)}
        >
          <div className="pricing-copy-modal">
            <h2 id="copy-from-project-title" className="pricing-copy-modal__title">
              Copy from another project
            </h2>
            <div className="pricing-copy-modal__filters">
              <label className="pricing-copy-modal__label">
                Search by block code
                <input
                  type="text"
                  className="pricing-copy-modal__input"
                  value={copyFromProjectBlockCode}
                  onChange={(e) => setCopyFromProjectBlockCode(e.target.value)}
                  placeholder="Block code"
                  onKeyDown={(e) => e.key === "Enter" && filterCopyFromProject()}
                />
              </label>
              <label className="pricing-copy-modal__label">
                Search by text
                <input
                  type="text"
                  className="pricing-copy-modal__input"
                  value={copyFromProjectText}
                  onChange={(e) => setCopyFromProjectText(e.target.value)}
                  placeholder="Description or text"
                  onKeyDown={(e) => e.key === "Enter" && filterCopyFromProject()}
                />
              </label>
              <button
                type="button"
                className="pricing-copy-modal__filter-btn btn-secondary"
                onClick={filterCopyFromProject}
                disabled={copyFromProjectLoading}
              >
                {copyFromProjectLoading ? "Searching…" : "Filter"}
              </button>
            </div>
            <div className="pricing-copy-modal__table-wrap">
              {copyFromProjectLoading ? (
                <div className="pricing-copy-modal__loader" aria-busy="true">
                  <span className="pricing-code-loader__spinner" />
                  <span className="pricing-copy-modal__loader-text">Searching…</span>
                </div>
              ) : copyFromProjectBlocks.length === 0 && copyFromProjectTotal === 0 ? (
                <p className="pricing-copy-modal__empty">
                  Enter block code or text and click Filter to find blocks from other projects.
                </p>
              ) : copyFromProjectBlocks.length === 0 ? (
                <p className="pricing-copy-modal__empty">No blocks found.</p>
              ) : (
                <>
                  <table className="pricing-copy-modal__table matches-table">
                    <thead>
                      <tr>
                        <th>Project</th>
                        <th>Description</th>
                        <th>Subitems</th>
                      </tr>
                    </thead>
                    <tbody>
                      {copyFromProjectBlocks.map((block) => (
                        <tr
                          key={`${block.projectId}-${block.itemId}`}
                          className={copyFromProjectSelected === block ? "pricing-copy-modal__row--selected" : ""}
                          onClick={() => setCopyFromProjectSelected(block)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setCopyFromProjectSelected(block);
                            }
                          }}
                        >
                          <td>{block.projectName}</td>
                          <td>{block.description}</td>
                          <td>
                            <ul className="pricing-copy-modal__subitems">
                              {block.subitems.map((sub, i) => (
                                <li key={i}>
                                  {sub.code} — {sub.description}
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {copyFromProjectTotal > COPY_FROM_PROJECT_PAGE_SIZE && (
                    <div className="pricing-copy-modal__pagination">
                      <span className="pricing-copy-modal__pagination-info">
                        Page {copyFromProjectPage} of{" "}
                        {Math.ceil(copyFromProjectTotal / COPY_FROM_PROJECT_PAGE_SIZE)} ({copyFromProjectTotal}{" "}
                        results)
                      </span>
                      <div className="pricing-copy-modal__pagination-btns">
                        <button
                          type="button"
                          className="btn-secondary pricing-copy-modal__page-btn"
                          disabled={copyFromProjectPage <= 1}
                          onClick={() => goToCopyFromProjectPage(copyFromProjectPage - 1)}
                        >
                          Previous
                        </button>
                        <button
                          type="button"
                          className="btn-secondary pricing-copy-modal__page-btn"
                          disabled={
                            copyFromProjectPage >= Math.ceil(copyFromProjectTotal / COPY_FROM_PROJECT_PAGE_SIZE)
                          }
                          onClick={() => goToCopyFromProjectPage(copyFromProjectPage + 1)}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="pricing-copy-modal__actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setCopyFromProjectOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={applyCopyFromProject}
                disabled={!copyFromProjectSelected || (copyFromProjectSelected?.subitems?.length ?? 0) === 0}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
