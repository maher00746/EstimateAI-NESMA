import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { v4 as uuidv4 } from "uuid";
import type { PricingPayload, ProductivityRatesBlock, ProjectItem } from "../types";
import { getPricing, getProductivityRates, savePricing } from "../services/api";

type PricingProps = {
  boqItems: ProjectItem[];
  projectName?: string;
  projectId?: string;
  headerTop?: ReactNode;
  initialPricing?: PricingPayload | null;
  onPricingLoaded?: (payload: PricingPayload) => void;
  onDirtyChange?: (isDirty: boolean) => void;
  onRegisterSave?: (save: () => Promise<boolean>) => void;
};

type PricingSubItem = {
  id: string;
  description: string;
  productivityId?: string;
  unitMh: number;
  unitEquipRate: number;
  materialsRate: string;
  subconRate: string;
  toolsRate: string;
};

type PricingEntry = { type: "item"; item: ProjectItem };

type PricingRenderEntry =
  | { type: "priced"; item: ProjectItem; notes: ProjectItem[]; category: string };

const TABLE_HEADERS = [
  "",
  "Description",
  "Qty",
  "Unit",
  "Unit MH",
  "Total MH",
  "Unit Rate (Wages)",
  "Total Rate (Wages)",
  "Unit Rate (Materials)",
  "Total Rate (Materials)",
  "Unit Rate (Subcon)",
  "Total Rate (Subcon)",
  "Unit Rate (Equip)",
  "Total Rate (Equip)",
  "Unit Rate (Tools)",
  "Total Rate (Tools)",
  "UNIT PRICE",
  "TOTAL PRICE",
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

const formatRoundedText = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const numberValue = Number(trimmed);
  if (!Number.isFinite(numberValue)) return value;
  return numberValue.toFixed(2);
};

const buildPricingEntries = (items: ProjectItem[]): PricingEntry[] =>
  items.map((item) => ({ type: "item", item }));

const getBoqFieldValue = (item: ProjectItem, field: "qty" | "unit"): string => {
  const fields = item.metadata?.fields ?? {};
  const findField = (candidates: string[]) =>
    fields[Object.keys(fields).find((key) => candidates.includes(normalizeColumn(key))) ?? ""];
  if (field === "qty") {
    return findField(["qty", "quantity", "q'ty", "qnty"]) ?? "";
  }
  return findField(["unit", "uom", "unit of measure"]) ?? "";
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
  const [productivityBlocks, setProductivityBlocks] = useState<ProductivityRatesBlock[]>([]);
  const [loadingRates, setLoadingRates] = useState(false);
  const [ratesError, setRatesError] = useState("");
  const [loadingPricing, setLoadingPricing] = useState(false);
  const [subItemsByItemId, setSubItemsByItemId] = useState<Record<string, PricingSubItem[]>>({});
  const [autoRowQtyByItemId, setAutoRowQtyByItemId] = useState<Record<string, string>>({});
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const menuAnchorRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [menuPositionTick, setMenuPositionTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const lastSavedSnapshotRef = useRef<string>("");
  const pricingLoadedRef = useRef(false);
  const lastProjectIdRef = useRef<string | undefined>(undefined);
  const initializingRef = useRef(false);

  const buildPricingPayload = useCallback(
    (): PricingPayload => ({
      percentage,
      idleText,
      poRate,
      mpHourlyRate,
      subItemsByItemId,
      autoRowQtyByItemId,
    }),
    [percentage, idleText, poRate, mpHourlyRate, subItemsByItemId, autoRowQtyByItemId]
  );

  const applyPricingPayload = useCallback((payload: PricingPayload) => {
    setPercentage(payload.percentage ?? "10");
    setIdleText(payload.idleText ?? "idle time");
    setPoRate(payload.poRate ?? "8");
    if (payload.mpHourlyRate) {
      setMpHourlyRate(payload.mpHourlyRate);
    }
    setSubItemsByItemId((payload.subItemsByItemId as Record<string, PricingSubItem[]>) ?? {});
    setAutoRowQtyByItemId((payload.autoRowQtyByItemId as Record<string, string>) ?? {});
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

  const sortedBoqItems = useMemo(() => {
    return [...boqItems].sort((a, b) => {
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

  const productivityOptions = useMemo(
    () =>
      productivityBlocks.map((block) => ({
        id: block.id,
        description: block.description || "Untitled",
        unit: block.unit,
        unitMh: computeManpowerMh(block),
        equipmentRate: computeEquipmentRateSum(block),
      })),
    [productivityBlocks]
  );

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
          if (row.unitMh === match.unitMh && row.unitEquipRate === match.equipmentRate) {
            return row;
          }
          changed = true;
          return {
            ...row,
            unitMh: match.unitMh,
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

  const addSubItem = useCallback((itemId: string) => {
    setSubItemsByItemId((current) => ({
      ...current,
      [itemId]: [
        ...(current[itemId] ?? []),
        {
          id: uuidv4(),
          description: "",
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
      updateSubItem(itemId, rowId, (row) => ({
        ...row,
        productivityId: selected.id,
        description: selected.description,
        unitMh: selected.unitMh,
        unitEquipRate: selected.equipmentRate,
      }));
    },
    [productivityOptions, updateSubItem]
  );

  const updateAutoQty = useCallback((itemId: string, value: string) => {
    setAutoRowQtyByItemId((current) => ({ ...current, [itemId]: value }));
  }, []);

  const percentValue = parseNumber(percentage) / 100;
  const poRateValue = parseNumber(poRate) / 100;
  const mpHourlyRateValue = parseNumber(mpHourlyRate);

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
    const handleReposition = () => setMenuPositionTick((tick) => tick + 1);
    window.addEventListener("scroll", handleReposition, true);
    window.addEventListener("resize", handleReposition);
    return () => {
      window.removeEventListener("scroll", handleReposition, true);
      window.removeEventListener("resize", handleReposition);
    };
  }, [activeRowId]);

  const getMenuStyle = (rowId: string, itemCount: number) => {
    const anchor = menuAnchorRefs.current[rowId];
    if (!anchor) {
      return { position: "fixed" as const, opacity: 0, pointerEvents: "none" as const };
    }
    const rect = anchor.getBoundingClientRect();
    const itemHeight = 34;
    const menuPadding = 8;
    const height = Math.min(220, itemCount * itemHeight + menuPadding);
    return {
      position: "fixed" as const,
      top: rect.bottom + 6,
      left: rect.left,
      width: rect.width,
      height,
      zIndex: 9999,
    };
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
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
          <button type="button" className="btn-secondary" onClick={handleSave} disabled={saving || !projectId}>
            {saving ? "Saving..." : "Save"}
          </button>
          {saveMessage && <span className="status">{saveMessage}</span>}
          {saveError && <span className="feedback" style={{ margin: 0 }}>{saveError}</span>}
        </div>
        {ratesError && <p className="feedback">{ratesError}</p>}
        {loadingRates && <p className="loading-text">Loading productivity rates...</p>}
        {pricingEntries.length === 0 ? (
          <div className="pricing-placeholder">
            <h3>No BOQ items yet</h3>
            <p>Upload and extract a BOQ file to start pricing.</p>
          </div>
        ) : (
          <div className="pricing-accordion">
            {pricingBlocks.map((entry) => {
              const item = entry.item;
              const noteItems = entry.notes;
              const categoryLabel = entry.category;
              const qtyDisplay = getBoqFieldValue(item, "qty");
              const unitDisplay = getBoqFieldValue(item, "unit");
              const qtyValue = parseNumber(qtyDisplay);
              const qtyDisplayText = formatRoundedText(qtyDisplay) || "—";
              const subItems = subItemsByItemId[item.id] ?? [];

              const manualRows = subItems.map((row) => {
                const unitMh = row.unitMh;
                const totalMh = unitMh * qtyValue;
                const unitRateWages = unitMh * mpHourlyRateValue;
                const totalRateWages = unitRateWages * qtyValue;
                const unitRateMaterials = parseNumber(row.materialsRate);
                const totalRateMaterials = (unitRateMaterials + unitRateMaterials * poRateValue) * qtyValue;
                const unitRateSubcon = parseNumber(row.subconRate);
                const totalRateSubcon = unitRateSubcon * qtyValue;
                const unitRateEquip = row.unitEquipRate;
                const totalRateEquip = unitRateEquip * qtyValue;
                const unitRateTools = parseNumber(row.toolsRate);
                const totalRateTools = unitRateTools * qtyValue;
                const unitPrice =
                  unitRateTools +
                  unitRateEquip +
                  unitRateSubcon +
                  unitRateWages +
                  unitRateMaterials * (1 + poRateValue);
                const totalPrice = unitPrice * qtyValue;
                return {
                  ...row,
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

              return (
                <div key={item.id} className="pricing-accordion__card">
                  <div className="pricing-accordion__header">
                    <span>{categoryLabel}</span>
                    <button
                      type="button"
                      className="inline-add-button"
                      onClick={() => addSubItem(item.id)}
                      aria-label="Add sub item"
                    >
                      +
                    </button>
                  </div>
                  <div className="pricing-accordion__panel">
                    <div className="pricing-table-wrapper">
                      <table className="matches-table pricing-table">
                        <colgroup>
                          <col style={{ width: "30px" }} />
                          <col style={{ width: "300px" }} />
                          {TABLE_HEADERS.slice(2).map((_, idx) => (
                            <col key={`col-${item.id}-${idx}`} style={{ width: "180px" }} />
                          ))}
                        </colgroup>
                        <thead>
                          <tr>
                            {TABLE_HEADERS.map((header, idx) => (
                              <th
                                key={`${item.id}-${header}`}
                                className={
                                  idx === 0 ? "pricing-col-code" : idx === 1 ? "pricing-col-description" : undefined
                                }
                              >
                                {header}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {noteItems.map((note) => (
                            <tr key={note.id}>
                              <td colSpan={TABLE_HEADERS.length}>
                                <span className="cell-text">{note.description}</span>
                              </td>
                            </tr>
                          ))}
                          <tr>
                            <td className="pricing-col-code">{item.item_code || "—"}</td>
                            <td className="pricing-col-description">
                              <span className="cell-text">{item.description}</span>
                            </td>
                            <td>{qtyDisplayText}</td>
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
                          </tr>
                          {manualRows.map((row) => {
                            const query = row.description.trim().toLowerCase();
                            const showSuggestions = activeRowId === row.id && query.length >= 3;
                            const matches = showSuggestions
                              ? productivityOptions
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
                                        setActiveRowId(value.length >= 3 ? row.id : null);
                                      }}
                                      placeholder="Search productivity rates..."
                                    />
                                    {matches.length > 0 && (
                                      <>
                                        <div
                                          className="pricing-match-backdrop"
                                          style={getMenuStyle(row.id, matches.length)}
                                        />
                                        <div className="pricing-match-menu" style={getMenuStyle(row.id, matches.length)}>
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
                                      </>
                                    )}
                                  </div>
                                </td>
                                <td>{qtyDisplayText}</td>
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
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
