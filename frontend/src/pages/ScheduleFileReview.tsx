import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import LandingAiReview from "../LandingAiReview";
import type { ProjectItem } from "../types";

type ScheduleFileReviewProps = {
  fileUrl: string;
  fileName?: string;
  items: ProjectItem[];
  onBack?: () => void;
  onSave?: (items: ProjectItem[]) => Promise<void>;
};

const normalizeColumn = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const renderCell = (value: string | number | null | undefined) => {
  const text = value === null || value === undefined || String(value).trim() === "" ? "—" : String(value);
  return <span className="cell-text" title={text}>{text}</span>;
};

const getScheduleCellValue = (item: ProjectItem, column: string) => {
  const fields = item.metadata?.fields ?? {};
  const direct = fields[column];
  if (direct && String(direct).trim() !== "") return String(direct);
  const key = normalizeColumn(column);
  if (key === "item") return item.item_code;
  if (key === "description") return item.description;
  return "—";
};

export default function ScheduleFileReview({
  fileUrl,
  fileName,
  items,
  onBack,
  onSave,
}: ScheduleFileReviewProps) {
  const [localItems, setLocalItems] = useState<ProjectItem[]>(items);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    setLocalItems(items);
    setError("");
  }, [items]);

  const scheduleColumns = useMemo(() => {
    const columns: string[] = [];
    const seen = new Set<string>();
    localItems.forEach((item) => {
      const fields = item.metadata?.fields ?? {};
      Object.keys(fields).forEach((key) => {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      });
    });
    const base = columns.length > 0 ? columns : ["Item", "Description"];
    return base.filter((col) => normalizeColumn(col) !== "notes");
  }, [localItems]);

  const handleItemFieldChange = (id: string, field: "item_code" | "description", value: string) => {
    setLocalItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  };

  const handleFieldChange = (id: string, field: string, value: string) => {
    setLocalItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const fields = { ...(item.metadata?.fields ?? {}) };
        fields[field] = value;
        return { ...item, metadata: { ...(item.metadata ?? {}), fields } };
      })
    );
  };

  const handleDeleteItem = (id: string) => {
    setLocalItems((prev) => prev.filter((item) => item.id !== id));
  };

  const handleAddItem = () => {
    const id = `new-${Date.now()}`;
    const fields: Record<string, string> = {};
    scheduleColumns.forEach((col) => {
      const key = normalizeColumn(col);
      if (key !== "item" && key !== "item code" && key !== "description") {
        fields[col] = "";
      }
    });
    setLocalItems((prev) => [
      ...prev,
      {
        id,
        fileId: "",
        source: "schedule",
        item_code: "",
        description: "",
        notes: "",
        metadata: Object.keys(fields).length > 0 ? { fields } : undefined,
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
      setError((err as Error).message || "Failed to save schedule items.");
    } finally {
      setSaving(false);
    }
  };

  const headerLeft = (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <h2 className="review-title" style={{ marginBottom: 4 }}>Schedule Review</h2>
      <div style={{ color: "rgba(227,233,255,0.75)", fontSize: "0.9rem" }}>
        {fileName || "Schedule File"} • {localItems.length} item(s)
      </div>
    </div>
  );

  const rightPane: ReactNode = (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", minHeight: 0, height: "100%", overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
          <h3 style={{ margin: 0 }}>Extracted Schedule Items</h3>
          <span style={{ color: "rgba(227,233,255,0.75)", fontSize: "0.88rem" }}>
            {localItems.length} item(s)
          </span>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button type="button" className="btn-secondary btn-compact" onClick={handleAddItem}>
            Add Item
          </button>
          <span className="status">{saving ? "Saving…" : "Idle"}</span>
        </div>
      </div>
      <div
        className="table-wrapper"
        style={{ flex: 1, minHeight: 0, overflow: "auto", fontSize: "0.88rem", margin: 0 }}
      >
        <table className="matches-table boq-table" style={{ width: "max-content", minWidth: "100%" }}>
          <thead>
            <tr>
              {scheduleColumns.map((col) => (
                <th key={col}>{col}</th>
              ))}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {localItems.length === 0 ? (
              <tr className="matches-table__row">
                <td colSpan={scheduleColumns.length + 1} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>
                  No schedule items extracted yet.
                </td>
              </tr>
            ) : (
              localItems.map((item) => (
                <tr key={item.id} className="matches-table__row">
                  {scheduleColumns.map((col) => {
                    const key = normalizeColumn(col);
                    if (key === "item" || key === "item code") {
                      return (
                        <td key={`${item.id}-${col}`}>
                          <input
                            type="text"
                            value={item.item_code ?? ""}
                            onChange={(event) => handleItemFieldChange(item.id, "item_code", event.target.value)}
                          />
                        </td>
                      );
                    }
                    if (key === "description") {
                      return (
                        <td key={`${item.id}-${col}`}>
                          <input
                            type="text"
                            value={item.description ?? ""}
                            onChange={(event) => handleItemFieldChange(item.id, "description", event.target.value)}
                          />
                        </td>
                      );
                    }
                    const fieldValue = getScheduleCellValue(item, col);
                    return (
                      <td key={`${item.id}-${col}`}>
                        <input
                          type="text"
                          value={String(fieldValue ?? "")}
                          onChange={(event) => handleFieldChange(item.id, col, event.target.value)}
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
              ))
            )}
          </tbody>
        </table>
      </div>
      {error && <p className="feedback" style={{ margin: 0 }}>{error}</p>}
    </div>
  );

  return (
    <LandingAiReview
      pdfUrl={fileUrl}
      landingAiRaw={{ chunks: [] }}
      fileName={fileName}
      headerLeft={headerLeft}
      headerCompact
      rightPane={rightPane}
      headerActions={
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
      }
    />
  );
}
