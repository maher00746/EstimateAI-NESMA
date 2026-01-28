import { useEffect, useMemo, useState } from "react";
import type { ProjectItem } from "../types";

type BoqFileReviewProps = {
  fileName?: string;
  items: ProjectItem[];
  onBack?: () => void;
  onSave?: (items: ProjectItem[]) => Promise<void>;
};

const renderEmptyCell = () => <span className="cell-text" />;

const isItemPlaceholder = (value: string | number | null | undefined) =>
  value !== null && value !== undefined && String(value).trim() === "ITEM";

const normalizeColumn = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const boqColumns = ["Item", "Description", "QTY", "Unit", "Rate", "Amount"];

const getBoqCellValue = (item: ProjectItem, column: string) => {
  const key = normalizeColumn(column);
  const fields = item.metadata?.fields ?? {};
  const findField = (candidates: string[]) =>
    fields[Object.keys(fields).find((k) => candidates.includes(normalizeColumn(k))) ?? ""];
  if (key === "item") return item.item_code;
  if (key === "description") return item.description;
  if (key === "qty") return findField(["qty", "quantity", "q'ty", "qnty"]) ?? "—";
  if (key === "unit") return findField(["unit", "uom", "unit of measure"]) ?? "—";
  if (key === "rate") return findField(["rate", "unit rate", "unit price", "price"]) ?? "—";
  if (key === "amount") return findField(["amount", "total", "total price"]) ?? "—";
  return "—";
};

export default function BoqFileReview({ fileName, items, onBack, onSave }: BoqFileReviewProps) {
  const [localItems, setLocalItems] = useState<ProjectItem[]>(items);
  const [activeBoqTab, setActiveBoqTab] = useState<string>("all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    setLocalItems(items);
    setError("");
  }, [items]);

  const boqTabs = useMemo(() => {
    const sheetNames = Array.from(
      new Set(localItems.map((item) => item.metadata?.sheetName).filter(Boolean))
    ) as string[];
    return [
      { id: "all", label: "All BOQ" },
      ...sheetNames.map((sheet) => ({ id: `sheet:${sheet}`, label: sheet })),
    ];
  }, [localItems]);

  const activeBoqTabId = boqTabs.some((tab) => tab.id === activeBoqTab) ? activeBoqTab : "all";

  const filteredBoqItems = useMemo(() => {
    const itemsForTab =
      activeBoqTabId === "all"
        ? localItems
        : localItems.filter((item) => item.metadata?.sheetName === activeBoqTabId.replace(/^sheet:/, ""));
    const isAll = activeBoqTabId === "all";
    return [...itemsForTab].sort((a, b) => {
      if (isAll) {
        const aSheet = a.metadata?.sheetIndex ?? 0;
        const bSheet = b.metadata?.sheetIndex ?? 0;
        if (aSheet !== bSheet) return aSheet - bSheet;
      }
      const aChunk = a.metadata?.chunkIndex ?? 0;
      const bChunk = b.metadata?.chunkIndex ?? 0;
      if (aChunk !== bChunk) return aChunk - bChunk;
      const aIndex = a.metadata?.rowIndex ?? 0;
      const bIndex = b.metadata?.rowIndex ?? 0;
      return aIndex - bIndex;
    });
  }, [activeBoqTabId, localItems]);

  const filteredBoqItemCount = useMemo(
    () =>
      filteredBoqItems.filter((item) => {
        const code = String(item.item_code ?? "").trim();
        return code !== "" && !isItemPlaceholder(code);
      }).length,
    [filteredBoqItems]
  );

  const handleItemFieldChange = (id: string, field: "item_code" | "description", value: string) => {
    setLocalItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  };

  const handleDeleteItem = (id: string) => {
    setLocalItems((prev) => prev.filter((item) => item.id !== id));
  };

  const handleAddItem = () => {
    const id = `new-${Date.now()}`;
    const sheetName =
      activeBoqTabId !== "all" ? activeBoqTabId.replace(/^sheet:/, "") : undefined;
    setLocalItems((prev) => [
      ...prev,
      {
        id,
        fileId: "",
        source: "boq",
        item_code: "",
        description: "",
        notes: "",
        metadata: sheetName ? { sheetName } : undefined,
        createdAt: "",
        updatedAt: "",
      },
    ]);
  };

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    setError("");
    try {
      await onSave(localItems);
    } catch (err) {
      setError((err as Error).message || "Failed to save BOQ items.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel__header panel__header--review">
        <div>
          <h2 style={{ marginTop: 0 }}>BOQ File Review</h2>
          <p className="eyebrow" style={{ opacity: 0.8, marginTop: "0.35rem" }}>
            {fileName || "BOQ File"} • {filteredBoqItemCount} item(s)
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {onBack && (
            <button type="button" className="btn-secondary" onClick={onBack}>
              Back
            </button>
          )}
          {onSave && (
            <button type="button" className="btn-match" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>
      <div className="panel__body">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem", flexWrap: "wrap" }}>
          <div className="tabs">
            {boqTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`tab ${activeBoqTabId === tab.id ? "is-active" : ""}`}
                onClick={() => setActiveBoqTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn-secondary btn-compact" onClick={handleAddItem}>
            Add Item
          </button>
        </div>

        <div
          className="table-wrapper items-table-scroll"
          style={{ margin: 0, maxHeight: "calc(100vh - 300px)" }}
        >
          <table className="matches-table boq-table">
            <thead>
              <tr>
                {boqColumns.map((col) => {
                  const normalizedCol = normalizeColumn(col);
                  const isItemCol = normalizedCol === "item";
                  const isDescriptionCol = normalizedCol === "description";
                  return (
                    <th
                      key={col}
                      style={
                        isItemCol
                          ? { width: "90px", minWidth: "90px" }
                          : isDescriptionCol
                            ? { minWidth: "320px" }
                            : undefined
                      }
                    >
                      {col}
                    </th>
                  );
                })}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredBoqItems.length === 0 ? (
                <tr className="matches-table__row">
                  <td colSpan={boqColumns.length + 1} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>
                    No items for this sheet.
                  </td>
                </tr>
              ) : (() => {
                const rows: React.ReactNode[] = [];
                let lastCategory = "";
                let lastSubcategory = "";
                filteredBoqItems.forEach((item) => {
                  const category = item.metadata?.category || "Uncategorized";
                  const subcategory = item.metadata?.subcategory || "";
                  if (category !== lastCategory) {
                    rows.push(
                      <tr key={`cat-${category}-${item.id}`} className="boq-group-row">
                        <td colSpan={boqColumns.length + 1}>{category}</td>
                      </tr>
                    );
                    lastCategory = category;
                    lastSubcategory = "";
                  }
                  if (subcategory && subcategory !== lastSubcategory) {
                    rows.push(
                      <tr key={`sub-${category}-${subcategory}-${item.id}`} className="boq-subgroup-row">
                        <td colSpan={boqColumns.length + 1}>{subcategory}</td>
                      </tr>
                    );
                    lastSubcategory = subcategory;
                  }
                  const itemCode = (item.item_code ?? "").trim();
                  const highlightItemCode = /^[A-Z]$/.test(itemCode);
                  const hideItemCode = isItemPlaceholder(item.item_code);
                  rows.push(
                    <tr
                      key={item.id}
                      className="matches-table__row"
                      style={highlightItemCode ? { color: "#72fcd1" } : undefined}
                    >
                      {boqColumns.map((col) => {
                        const normalizedCol = normalizeColumn(col);
                        if (normalizedCol === "item") {
                          return (
                            <td
                              key={`${item.id}-${col}`}
                              style={{ width: "90px", minWidth: "90px" }}
                            >
                              {hideItemCode ? (
                                renderEmptyCell()
                              ) : (
                                <input
                                  type="text"
                                  value={item.item_code ?? ""}
                                  onChange={(event) => handleItemFieldChange(item.id, "item_code", event.target.value)}
                                />
                              )}
                            </td>
                          );
                        }
                        if (normalizedCol === "description") {
                          return (
                            <td key={`${item.id}-${col}`} style={{ minWidth: "320px" }}>
                              <textarea
                                value={item.description ?? ""}
                                onChange={(event) => handleItemFieldChange(item.id, "description", event.target.value)}
                                style={{
                                  width: "100%",
                                  minHeight: "80px",
                                  background: "rgba(10, 15, 34, 0.7)",
                                  border: "1px solid rgba(114, 252, 209, 0.2)",
                                  color: "#e3e9ff",
                                  padding: "0.35rem 0.5rem",
                                  borderRadius: "0.4rem",
                                  fontSize: "0.85rem",
                                  resize: "vertical",
                                }}
                              />
                            </td>
                          );
                        }
                        if (hideItemCode) {
                          return <td key={`${item.id}-${col}`}>{renderEmptyCell()}</td>;
                        }
                        const fieldValue = getBoqCellValue(item, col);
                        return (
                          <td key={`${item.id}-${col}`}>
                            <input
                              type="text"
                              value={String(fieldValue ?? "")}
                              onChange={(event) => {
                                const value = event.target.value;
                                setLocalItems((prev) =>
                                  prev.map((entry) => {
                                    if (entry.id !== item.id) return entry;
                                    const fields = { ...(entry.metadata?.fields ?? {}) };
                                    fields[col] = value;
                                    return { ...entry, metadata: { ...(entry.metadata ?? {}), fields } };
                                  })
                                );
                              }}
                            />
                          </td>
                        );
                      })}
                      <td>
                        <button type="button" className="btn-secondary" onClick={() => handleDeleteItem(item.id)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                });
                return rows;
              })()}
            </tbody>
          </table>
        </div>
        {error && <p className="feedback" style={{ marginTop: "0.75rem" }}>{error}</p>}
      </div>
    </section>
  );
}
