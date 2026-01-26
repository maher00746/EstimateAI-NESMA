import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FC } from "react";
import LandingAiReview from "../LandingAiReview";
import { extractCadItems } from "../services/api";
import type { CadExtractionBox, CadExtractionItem } from "../types";

type CadItemWithId = CadExtractionItem & { id: string };

type CadExtractionMode = "upload" | "review";

export type CadExtractionProps = {
  mode?: CadExtractionMode;
  fileUrl?: string;
  fileName?: string;
  items?: CadItemWithId[];
  onSave?: (items: CadItemWithId[]) => Promise<void>;
  onBack?: () => void;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const normalizeBox = (box: CadExtractionBox | null | undefined): CadExtractionBox | null => {
  if (!box) return null;
  const left = clamp01(Number(box.left));
  const top = clamp01(Number(box.top));
  const right = clamp01(Number(box.right));
  const bottom = clamp01(Number(box.bottom));
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
    return null;
  }
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
};

const serializeCadItems = (items: CadItemWithId[]): string => {
  return JSON.stringify(
    items.map((item) => ({
      id: item.id,
      item_code: item.item_code ?? "",
      description: item.description ?? "",
      notes: item.notes ?? "",
      box: normalizeBox(item.box) ?? null,
    }))
  );
};

const CadExtraction: FC<CadExtractionProps> = ({
  mode = "upload",
  fileUrl: externalFileUrl,
  fileName: externalFileName,
  items: externalItems,
  onSave,
  onBack,
}) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string>("");
  const [items, setItems] = useState<CadItemWithId[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const [hasExtracted, setHasExtracted] = useState(false);
  const [selectAll, setSelectAll] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>("");
  const [initialSnapshot, setInitialSnapshot] = useState("");
  const [showUnsavedPrompt, setShowUnsavedPrompt] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tableRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const selectionSourceRef = useRef<"pdf" | "table" | null>(null);

  const isReviewMode = mode === "review";

  useEffect(() => {
    if (isReviewMode) {
      const nextItems = externalItems || [];
      setFileUrl(externalFileUrl || "");
      setItems(nextItems);
      setHasExtracted(true);
      setInitialSnapshot(serializeCadItems(nextItems));
      return;
    }
    if (!selectedFile) {
      setFileUrl("");
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setFileUrl(url);
    return () => {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    };
  }, [selectedFile, externalFileUrl, externalItems, isReviewMode]);
  const hasUnsavedChanges = useMemo(() => {
    if (!isReviewMode) return false;
    return initialSnapshot !== serializeCadItems(items);
  }, [initialSnapshot, isReviewMode, items]);
  const groupedItems = useMemo(() => {
    const groups = new Map<string, CadItemWithId[]>();
    items.forEach((item) => {
      const key = (item.item_code || "ITEM").trim() || "ITEM";
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    });
    return Array.from(groups.entries());
  }, [items]);


  useEffect(() => {
    if (!selectedItemId) return;
    if (selectionSourceRef.current !== "pdf") return;
    const root = tableScrollRef.current;
    if (!root) return;
    const row = tableRowRefs.current[selectedItemId];
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    selectionSourceRef.current = null;
  }, [selectedItemId]);

  const landingAiRaw = useMemo(() => {
    return {
      chunks: items
        .map((item) => {
          const box = normalizeBox(item.box);
          if (!box) return null;
          return {
            id: item.id,
            type: "item",
            grounding: { box, page: 0 },
          };
        })
        .filter(Boolean),
    };
  }, [items]);

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;
    setSelectedFile(file);
    setItems([]);
    setSelectedItemId("");
    setHasExtracted(false);
    setSelectAll(false);
    setError("");
  }, []);

  const handleExtract = useCallback(async () => {
    if (!selectedFile) return;
    setLoading(true);
    setError("");
    setItems([]);
    setSelectedItemId("");
    setSelectAll(false);
    try {
      const result = await extractCadItems(selectedFile);
      const enriched = (result.items || []).map((item, idx) => ({
        ...item,
        id: `cad-${idx + 1}`,
      }));
      setItems(enriched);
      setHasExtracted(true);
    } catch (err) {
      setError((err as Error).message || "Failed to extract items.");
      setHasExtracted(true);
    } finally {
      setLoading(false);
    }
  }, [selectedFile]);

  const handleItemFieldChange = useCallback(
    (id: string, field: "item_code" | "description" | "notes", value: string) => {
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
      );
    },
    []
  );

  const handleDeleteItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const handleAddItem = useCallback(() => {
    const id = `new-${Date.now()}`;
    setItems((prev) => [
      ...prev,
      {
        id,
        item_code: "",
        description: "",
        notes: "",
        box: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    ]);
    setSelectedItemId(id);
  }, []);

  const handleSave = useCallback(async () => {
    if (!onSave) return false;
    setSaving(true);
    setError("");
    try {
      await onSave(items);
      setInitialSnapshot(serializeCadItems(items));
      return true;
    } catch (err) {
      setError((err as Error).message || "Failed to save items.");
      return false;
    } finally {
      setSaving(false);
    }
  }, [items, onSave]);

  const handleBackClick = useCallback(() => {
    if (!onBack) return;
    if (hasUnsavedChanges) {
      setShowUnsavedPrompt(true);
      return;
    }
    onBack();
  }, [hasUnsavedChanges, onBack]);

  const handleDiscardChanges = useCallback(() => {
    if (!onBack) return;
    setShowUnsavedPrompt(false);
    onBack();
  }, [onBack]);


  const handleSaveAndBack = useCallback(async () => {
    const saved = await handleSave();
    if (!saved) return;
    setShowUnsavedPrompt(false);
    onBack?.();
  }, [handleSave, onBack]);

  const headerLeft = (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <h2 className="review-title" style={{ marginBottom: 4 }}>CAD Extraction</h2>
      <div style={{ color: "rgba(227,233,255,0.75)", fontSize: "0.9rem" }}>
        {externalFileName || selectedFile?.name || "CAD Drawing"} • {items.length} item(s)
      </div>
    </div>
  );

  const rightPane = (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", minHeight: 0, height: "100%", overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
          <h3 style={{ margin: 0 }}>Extracted Items</h3>
          <span style={{ color: "rgba(227,233,255,0.75)", fontSize: "0.88rem" }}>
            {items.length} item(s)
          </span>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.88rem" }}>
            <input
              type="checkbox"
              checked={selectAll}
              onChange={(event) => setSelectAll(event.target.checked)}
            />
            Select All (show all boxes)
          </label>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {isReviewMode && (
            <button type="button" className="btn-secondary" onClick={handleAddItem}>
              Add Item
            </button>
          )}
          <span className="status">{loading ? "Processing…" : saving ? "Saving…" : "Idle"}</span>
        </div>
      </div>
      <div
        className="table-wrapper"
        ref={tableScrollRef}
        style={{ flex: 1, minHeight: 0, overflow: "auto", fontSize: "0.88rem" }}
      >
        <table className="matches-table resizable-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Description</th>
              <th>Notes</th>
              {isReviewMode && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="matches-table__row">
                <td colSpan={isReviewMode ? 4 : 3} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>
                  No items extracted yet.
                </td>
              </tr>
            ) : (
              groupedItems.flatMap(([code, group]) => {
                const groupRows: React.ReactNode[] = [
                  (
                    <tr key={`group-${code}`} className="boq-group-row">
                      <td colSpan={isReviewMode ? 4 : 3}>{code}</td>
                    </tr>
                  ),
                ];
                group.forEach((item, idx) => {
                  const isLinked = selectedItemId === item.id;
                  const handleRowClick = (event: React.MouseEvent<HTMLTableRowElement>) => {
                    const target = event.target as HTMLElement;
                    if (target.closest("input, textarea, button, select")) return;
                    selectionSourceRef.current = "table";
                    setSelectedItemId(item.id);
                  };
                  groupRows.push(
                    <tr
                      key={item.id}
                      className={`matches-table__row ${isLinked ? "is-linked" : ""}`}
                      onClick={handleRowClick}
                      ref={(el) => {
                        tableRowRefs.current[item.id] = el;
                      }}
                    >
                      <td>
                        {isReviewMode ? (
                          <input
                            type="text"
                            value={item.item_code}
                            onChange={(event) => handleItemFieldChange(item.id, "item_code", event.target.value)}
                            placeholder={`Item ${idx + 1}`}
                          />
                        ) : (
                          (item.item_code ?? "").trim() === "ITEM" ? "" : item.item_code || `Item ${idx + 1}`
                        )}
                      </td>
                      <td>
                        {isReviewMode ? (
                          <input
                            type="text"
                            value={item.description}
                            onChange={(event) => handleItemFieldChange(item.id, "description", event.target.value)}
                            placeholder="Description"
                          />
                        ) : (
                          item.description || "—"
                        )}
                      </td>
                      <td>
                        {isReviewMode ? (
                          <input
                            type="text"
                            value={item.notes}
                            onChange={(event) => handleItemFieldChange(item.id, "notes", event.target.value)}
                            placeholder="Notes"
                          />
                        ) : (
                          (item.item_code ?? "").trim() === "ITEM" ? "" : item.notes || "—"
                        )}
                      </td>
                      {isReviewMode && (
                        <td>
                          <button type="button" className="btn-secondary" onClick={() => handleDeleteItem(item.id)}>
                            Delete
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                });
                return groupRows;
              })
            )}
          </tbody>
        </table>
      </div>
      {error && <p className="feedback" style={{ margin: 0 }}>{error}</p>}
    </div>
  );

  if (!isReviewMode && (!selectedFile || !hasExtracted)) {
    return (
      <section className="panel">
        <div className="panel__header">
          <div>
            <h2 className="section-title section-title--compact">CAD Extraction</h2>
            <p className="eyebrow" style={{ opacity: 0.7, marginTop: "0.35rem" }}>
              Upload a CAD drawing PDF to extract BOQ items with bounding boxes.
            </p>
          </div>
          <span className="status">{loading ? "Processing…" : "Idle"}</span>
        </div>
        <div className="panel__body">
          <div className="uploaders-grid">
            <label className="dropzone dropzone--estimate uploader-card">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                onChange={handleFileChange}
              />
              <div className="dropzone__content">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="dropzone__icon">
                  <path d="M24 16v16M16 24h16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  <rect x="8" y="8" width="32" height="32" rx="4" stroke="currentColor" strokeWidth="2" />
                </svg>
                <p className="dropzone__text">
                  {selectedFile ? `Selected: ${selectedFile.name}` : "Drag & drop or browse CAD drawing (PDF)"}
                </p>
                <p className="dropzone__hint">Upload one PDF drawing to proceed.</p>
              </div>
            </label>
          </div>
          <div className="upload-actions">
            <button
              type="button"
              className="btn-match"
              onClick={() => void handleExtract()}
              disabled={loading || !selectedFile}
            >
              {loading ? "Extracting…" : "Extract BOQ Items"}
            </button>
          </div>
          {error && <p className="feedback">{error}</p>}
        </div>
          {loading && (
          <div className="processing-overlay">
            <div className="processing-indicator">
              <div className="processing-indicator__spinner">
                <svg width="40" height="40" viewBox="0 0 40 40" className="spinner">
                  <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="80" strokeDashoffset="20" strokeLinecap="round" />
                </svg>
              </div>
              <div className="processing-indicator__text">
                <p className="processing-indicator__message">Extracting items with Gemini…</p>
              </div>
            </div>
          </div>
        )}
      </section>
    );
  }

  return (
    <>
      {loading && (
        <div className="processing-overlay">
          <div className="processing-indicator">
            <div className="processing-indicator__spinner">
              <svg width="40" height="40" viewBox="0 0 40 40" className="spinner">
                <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="80" strokeDashoffset="20" strokeLinecap="round" />
              </svg>
            </div>
            <div className="processing-indicator__text">
              <p className="processing-indicator__message">Extracting items with Gemini…</p>
            </div>
          </div>
        </div>
      )}
      <LandingAiReview
        pdfUrl={fileUrl}
        landingAiRaw={landingAiRaw}
        fileName={externalFileName || selectedFile?.name}
        headerLeft={headerLeft}
        headerCompact
        enableOverlayOnSelectionChange
        showAllOverlays={selectAll}
        headerActions={
          <div style={{ display: "flex", gap: "0.5rem" }}>
            {onBack && (
              <button type="button" className="btn-secondary" onClick={handleBackClick}>
                Back
              </button>
            )}
            {!isReviewMode && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    fileInputRef.current?.click();
                  }}
                >
                  Upload another
                </button>
                <button
                  type="button"
                  className="btn-match"
                  onClick={() => void handleExtract()}
                  disabled={loading || !selectedFile}
                >
                  Re-run extraction
                </button>
              </>
            )}
            {isReviewMode && onSave && (
              <button type="button" className="btn-match" onClick={() => void handleSave()} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        }
        rightPane={rightPane}
        selectedChunkId={selectedItemId}
        onSelectedChunkIdChange={(id) => {
          selectionSourceRef.current = "pdf";
          setSelectedItemId(id);
        }}
      />
      {showUnsavedPrompt && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="unsaved-changes-title">
            <div className="modal__header">
              <h3 className="modal__title" id="unsaved-changes-title">Unsaved changes</h3>
              <button type="button" className="modal__close" onClick={() => setShowUnsavedPrompt(false)}>
                ×
              </button>
            </div>
            <div className="modal__body">
              <p>You have unsaved edits. Save before leaving?</p>
            </div>
            <div className="modal__footer">
              <button type="button" className="btn-secondary" onClick={() => setShowUnsavedPrompt(false)} disabled={saving}>
                Stay
              </button>
              <button type="button" className="btn-secondary" onClick={handleDiscardChanges} disabled={saving}>
                Discard
              </button>
              <button type="button" className="btn-match" onClick={() => void handleSaveAndBack()} disabled={saving}>
                {saving ? "Saving…" : "Save & Leave"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default CadExtraction;
