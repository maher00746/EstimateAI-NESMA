import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { v4 as uuidv4 } from "uuid";
import type { PricingPayload, ProductivityRatesBlock, ProjectItem } from "../types";
import { getPricing, getProductivityRates, savePricing, suggestProductivityItems } from "../services/api";
import type { ProductivitySuggestResponse } from "../services/api";

type PricingProps = {
  boqItems: ProjectItem[];
  scheduleItems: ProjectItem[];
  drawingItems: ProjectItem[];
  projectName?: string;
  projectId?: string;
  headerTop?: ReactNode;
  initialPricing?: PricingPayload | null;
  onPricingLoaded?: (payload: PricingPayload) => void;
  onDirtyChange?: (isDirty: boolean) => void;
  onRegisterSave?: (save: () => Promise<boolean>) => void;
};

type PricingPayloadWithTracking = PricingPayload & {
  collapsedByItemId?: Record<string, unknown>;
  completedByItemId?: Record<string, unknown>;
};

type PricingSubItem = {
  id: string;
  description: string;
  productivityId?: string;
  suggestedIds?: string[];
  qty?: string;
  unitMh: number;
  unitWagesRate?: number;
  unitEquipRate: number;
  materialsRate: string;
  subconRate: string;
  toolsRate: string;
};

type ProductivityOption = {
  id: string;
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
  { key: "code", label: "", group: "direct" },
  { key: "description", label: "Description", group: "direct" },
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
  initialPricing,
  onPricingLoaded,
  onDirtyChange,
  onRegisterSave,
}: PricingProps) {
  const [percentage, setPercentage] = useState("10");
  const [idleText, setIdleText] = useState("idle time");
  const [poRate, setPoRate] = useState("8");
  const [mpHourlyRate, setMpHourlyRate] = useState("0");
  const [totalPriceFactor, setTotalPriceFactor] = useState("0");
  const [sellRateWages, setSellRateWages] = useState("12.14");
  const [sellRateMaterials, setSellRateMaterials] = useState("12.14");
  const [sellRateSubcon, setSellRateSubcon] = useState("12.14");
  const [sellRateEquip, setSellRateEquip] = useState("12.14");
  const [sellRateOther, setSellRateOther] = useState("12.14");
  const [productivityBlocks, setProductivityBlocks] = useState<ProductivityRatesBlock[]>([]);
  const [loadingRates, setLoadingRates] = useState(false);
  const [ratesError, setRatesError] = useState("");
  const [loadingPricing, setLoadingPricing] = useState(false);
  const [subItemsByItemId, setSubItemsByItemId] = useState<Record<string, PricingSubItem[]>>({});
  const [autoRowQtyByItemId, setAutoRowQtyByItemId] = useState<Record<string, string>>({});
  const [qtyOverrideByItemId, setQtyOverrideByItemId] = useState<Record<string, string>>({});
  const [collapsedByItemId, setCollapsedByItemId] = useState<Record<string, boolean>>({});
  const [completedByItemId, setCompletedByItemId] = useState<Record<string, boolean>>({});
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
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
  const subItemsByItemIdRef = useRef<Record<string, PricingSubItem[]>>({});
  const lastSavedSnapshotRef = useRef<string>("");
  const pricingLoadedRef = useRef(false);
  const lastProjectIdRef = useRef<string | undefined>(undefined);
  const initializingRef = useRef(false);
  const portalTarget = typeof document !== "undefined" ? document.body : null;
  const activeMenuRef = useRef<HTMLDivElement | null>(null);

  const buildPricingPayload = useCallback(
    (): PricingPayloadWithTracking => ({
      percentage,
      idleText,
      poRate,
      mpHourlyRate,
      totalPriceFactor,
      subItemsByItemId,
      autoRowQtyByItemId,
      qtyOverrideByItemId,
      collapsedByItemId,
      completedByItemId,
    }),
    [
      percentage,
      idleText,
      poRate,
      mpHourlyRate,
      totalPriceFactor,
      subItemsByItemId,
      autoRowQtyByItemId,
      qtyOverrideByItemId,
      collapsedByItemId,
      completedByItemId,
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
    setSubItemsByItemId((payload.subItemsByItemId as Record<string, PricingSubItem[]>) ?? {});
    setAutoRowQtyByItemId((payload.autoRowQtyByItemId as Record<string, string>) ?? {});
    setQtyOverrideByItemId((payload.qtyOverrideByItemId as Record<string, string>) ?? {});
    setCollapsedByItemId((payload.collapsedByItemId as Record<string, boolean>) ?? {});
    setCompletedByItemId((payload.completedByItemId as Record<string, boolean>) ?? {});
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
    if (lastProjectIdRef.current !== projectId) {
      lastProjectIdRef.current = projectId;
      pricingLoadedRef.current = false;
      lastSavedSnapshotRef.current = "";
    }
    if (!projectId) return;
    if (initialPricing && !pricingLoadedRef.current) {
      initializingRef.current = true;
      applyPricingPayload(initialPricing);
      lastSavedSnapshotRef.current = JSON.stringify(initialPricing);
      pricingLoadedRef.current = true;
      onDirtyChange?.(false);
      return;
    }
    if (pricingLoadedRef.current) return;
    setLoadingPricing(true);
    getPricing(projectId)
      .then((payload) => {
        initializingRef.current = true;
        applyPricingPayload(payload);
        lastSavedSnapshotRef.current = JSON.stringify(payload);
        pricingLoadedRef.current = true;
        onPricingLoaded?.(payload);
        onDirtyChange?.(false);
      })
      .catch(() => {
        if (!lastSavedSnapshotRef.current) {
          lastSavedSnapshotRef.current = JSON.stringify(buildPricingPayload());
          onDirtyChange?.(false);
        }
        initializingRef.current = false;
        // ignore load errors; page can still be edited
      })
      .finally(() => setLoadingPricing(false));
  }, [projectId, initialPricing, applyPricingPayload, onDirtyChange, onPricingLoaded, buildPricingPayload]);

  useEffect(() => {
    subItemsByItemIdRef.current = subItemsByItemId;
  }, [subItemsByItemId]);

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
            unitMh: match.unitMh,
            unitWagesRate: match.unitWagesRate,
            unitEquipRate: match.equipmentRate,
          };
        });
        next[itemId] = updatedRows;
      });
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
      updateSubItem(itemId, rowId, (row) => ({
        ...row,
        productivityId: selected.id,
        description: selected.description,
        qty: row.qty && row.qty.trim() ? row.qty : defaultQty,
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

  const findScheduleCodes = useCallback(
    (description: string) => {
      const lower = description.toLowerCase();
      if (!lower.trim()) return [];
      return scheduleCodeEntries
        .filter((entry) => lower.includes(entry.lower))
        .map((entry) => entry.original);
    },
    [scheduleCodeEntries]
  );

  const handleAutoSuggest = useCallback(async () => {
    if (suggestionStatus === "running") return;
    setShowSuggestionLogs(true);
    setSuggestionStatus("running");
    setSuggestionError(null);
    setSuggestionLogs([]);
    setSuggestionCallsCompleted(0);
    setSuggestionCallsTotal(0);

    if (productivitySuggestionItems.length === 0) {
      pushSuggestionLog("No productivity items available to suggest from.", "warning");
      setSuggestionStatus("failed");
      return;
    }
    if (pricingBlocks.length === 0) {
      pushSuggestionLog("No priced items available for suggestions.", "warning");
      setSuggestionStatus("failed");
      return;
    }

    const suggestionBlocks = pricingBlocks.map((entry) => {
      const description = entry.item.description ?? "";
      const lastNote = entry.notes.length > 0 ? entry.notes[entry.notes.length - 1] : null;
      const notes = lastNote?.description ? [lastNote.description].filter((value) => value && value.trim()) : [];
      const baseQty = getBoqFieldValue(entry.item, "qty");
      const qty = String(qtyOverrideByItemId[entry.item.id] ?? baseQty ?? "").trim();
      const scheduleCodes = findScheduleCodes(description);
      const drawingDetails: string[] = [];
      if (scheduleCodes.length > 0) {
        scheduleCodes.forEach((code) => {
          const matches = drawingItemsByCode.get(code.toLowerCase()) ?? [];
          matches.forEach((item) => {
            if (item.description) drawingDetails.push(item.description);
            if (item.notes) drawingDetails.push(item.notes);
          });
        });
      }
      return {
        blockId: entry.item.id,
        itemCode: String(entry.item.item_code ?? "").trim(),
        description,
        qty,
        notes,
        drawingDetails,
        scheduleCodes,
      };
    });
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
              const newRows = (result.items ?? [])
                .map((item) => {
                  const suggestions = (item.suggestedIds ?? []).filter((id: string) =>
                    productivityOptionsById.has(id)
                  );
                  if (suggestions.length === 0) return null;
                  const [primaryId] = suggestions;
                  if (!primaryId || existingIds.has(primaryId)) return null;
                  const option = productivityOptionsById.get(primaryId);
                  if (!option) return null;
                  return {
                    id: uuidv4(),
                    description: option.description,
                    productivityId: option.id,
                    suggestedIds: suggestions,
                    qty: defaultQty,
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
    drawingItemsByCode,
    findScheduleCodes,
    pushSuggestionLog,
  ]);

  const percentValue = parseNumber(percentage) / 100;
  const poRateValue = parseNumber(poRate) / 100;
  const mpHourlyRateValue = parseNumber(mpHourlyRate);
  const totalPriceFactorValue = parseNumber(totalPriceFactor);
  const sellRateWagesValue = parseNumber(sellRateWages) / 100;
  const sellRateMaterialsValue = parseNumber(sellRateMaterials) / 100;
  const sellRateSubconValue = parseNumber(sellRateSubcon) / 100;
  const sellRateEquipValue = parseNumber(sellRateEquip) / 100;
  const sellRateOtherValue = parseNumber(sellRateOther) / 100;

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
            const rowQtyValue = parseNumber(row.qty ?? qtyDisplay);
            const unitMh = row.unitMh;
            const totalMh = unitMh * rowQtyValue;
            const unitRateWages = row.unitWagesRate ?? unitMh * mpHourlyRateValue;
            const totalRateWages = unitRateWages * rowQtyValue;
            const unitRateMaterials = parseNumber(row.materialsRate);
            const totalRateMaterials = (unitRateMaterials + unitRateMaterials * poRateValue) * rowQtyValue;
            const unitRateSubcon = parseNumber(row.subconRate);
            const totalRateSubcon = unitRateSubcon * rowQtyValue;
            const unitRateEquip = row.unitEquipRate;
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
    sellRateWagesValue,
    sellRateMaterialsValue,
    sellRateSubconValue,
    sellRateEquipValue,
    sellRateOtherValue,
    isRateOnlyItem,
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
      onPricingLoaded?.(payload);
      onDirtyChange?.(false);
      setSaveMessage("Saved.");
      setTimeout(() => setSaveMessage(""), 3000);
      return true;
    } catch (error: unknown) {
      setSaveError((error as Error).message || "Failed to save pricing.");
      return false;
    } finally {
      setSaving(false);
    }
  }, [projectId, buildPricingPayload, onPricingLoaded, onDirtyChange]);

  useEffect(() => {
    onRegisterSave?.(handleSave);
  }, [handleSave, onRegisterSave]);

  useEffect(() => {
    const currentSnapshot = JSON.stringify(buildPricingPayload());
    const isDirty = currentSnapshot !== lastSavedSnapshotRef.current;
    onDirtyChange?.(isDirty);
  }, [buildPricingPayload, onDirtyChange]);

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

  const rateInputsByKey: Record<PricingHeaderRateKey, { value: string; setValue: (value: string) => void }> = {
    wages: { value: sellRateWages, setValue: setSellRateWages },
    materials: { value: sellRateMaterials, setValue: setSellRateMaterials },
    subcon: { value: sellRateSubcon, setValue: setSellRateSubcon },
    equip: { value: sellRateEquip, setValue: setSellRateEquip },
    other: { value: sellRateOther, setValue: setSellRateOther },
  };

  const getHeaderClassName = (idx: number, header: PricingHeader) => {
    const classes = [];
    if (idx === 0) classes.push("pricing-col-code");
    if (idx === 1) classes.push("pricing-col-description");
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
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem", justifyContent: "flex-end" }}>
          <button type="button" className="btn-match" onClick={handleSave} disabled={saving || !projectId}>
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            className="btn-match"
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
                const rowQtyValue = parseNumber(row.qty ?? qtyDisplay);
                const unitMh = row.unitMh;
                const totalMh = unitMh * rowQtyValue;
                const unitRateWages = row.unitWagesRate ?? unitMh * mpHourlyRateValue;
                const totalRateWages = unitRateWages * rowQtyValue;
                const unitRateMaterials = parseNumber(row.materialsRate);
                const totalRateMaterials = (unitRateMaterials + unitRateMaterials * poRateValue) * rowQtyValue;
                const unitRateSubcon = parseNumber(row.subconRate);
                const totalRateSubcon = unitRateSubcon * rowQtyValue;
                const unitRateEquip = row.unitEquipRate;
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

              return (
                <div
                  key={item.id}
                  className={`pricing-accordion__card${isCollapsed ? "" : " is-open"}${isCompleted ? " is-complete" : ""}`}
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
                          <col style={{ width: "30px" }} />
                          <col style={{ width: "300px" }} />
                          {PRICING_HEADERS.slice(2).map((_, idx) => (
                            <col key={`col-${item.id}-${idx}`} style={{ width: "180px" }} />
                          ))}
                        </colgroup>
                        <thead>
                          <tr className="pricing-rate-row">
                            {PRICING_HEADERS.map((header, idx) => {
                              const rateInput = header.rateKey ? rateInputsByKey[header.rateKey] : null;
                              return (
                                <th key={`rate-${item.id}-${header.key}`} className={getHeaderClassName(idx, header)}>
                                  {rateInput ? (
                                    <input
                                      className="pricing-rate-input"
                                      type="number"
                                      value={rateInput.value}
                                      min={0}
                                      step="0.01"
                                      onChange={(event) => rateInput.setValue(event.target.value)}
                                      aria-label={`Sell rate ${header.rateKey} (%)`}
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
                            <td className="pricing-col-code">{item.item_code || "—"}</td>
                            <td className="pricing-col-description">
                              <span className="cell-text">{item.description}</span>
                            </td>
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
                            return (
                              <tr key={row.id}>
                                <td className="pricing-col-code">
                                  <button
                                    type="button"
                                    className="inline-remove-button"
                                    onClick={() => removeSubItem(item.id, row.id)}
                                    aria-label="Remove sub item"
                                  >
                                    −
                                  </button>
                                </td>
                                <td className="pricing-col-description" style={{ position: "relative", overflow: "visible" }}>
                                  <div className="productivity-cell-with-action" ref={(el) => {
                                    menuAnchorRefs.current[row.id] = el;
                                  }}>
                                    <input
                                      type="text"
                                      value={row.description}
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
                                <td>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    value={row.qty ?? qtyDisplay}
                                    onChange={(event) =>
                                      updateSubItem(item.id, row.id, (current) => ({
                                        ...current,
                                        qty: event.target.value,
                                      }))
                                    }
                                  />
                                </td>
                                <td>{unitDisplay || "—"}</td>
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
                            <td className="pricing-col-code" />
                            <td className="pricing-col-description">
                              <span className="cell-text">{`${percentageLabel}% - ${idleText}`}</span>
                            </td>
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
                  <div
                    style={{
                      display: "flex",
                      gap: "1rem",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      marginTop: "1rem",
                    }}
                  >
                    <label className="electrical-input" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span className="electrical-input__label">Total Price Factor</span>
                      <input
                        className="electrical-input__control"
                        type="number"
                        value={totalPriceFactor}
                        onChange={(event) => setTotalPriceFactor(event.target.value)}
                        step="0.01"
                      />
                    </label>
                    <label className="electrical-input" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span className="electrical-input__label">Selling Price</span>
                      <input
                        className="electrical-input__control"
                        type="number"
                        value={formatRounded(summaryTotals.sellTotalPrice)}
                        readOnly
                        disabled
                      />
                    </label>
                    <label className="electrical-input" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span className="electrical-input__label">New Selling Price</span>
                      <input
                        className="electrical-input__control"
                        type="number"
                        value={formatRounded(summaryTotals.sellTotalPrice * (1 + totalPriceFactorValue))}
                        readOnly
                        disabled
                      />
                    </label>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
