import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FC } from "react";
import LandingAiReview from "../LandingAiReview";
import { extractCadItems, getProductivityRates } from "../services/api";
import type { CadExtractionBox, CadExtractionItem, ProductivityRatesBlock } from "../types";

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
      thickness: item.thickness ?? null,
      productivityRateId: item.productivityRateId ?? null,
    }))
  );
};

type ProductivityOption = {
  id: string;
  description: string;
  unit: string;
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
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>("");
  const [initialSnapshot, setInitialSnapshot] = useState("");
  const [showUnsavedPrompt, setShowUnsavedPrompt] = useState(false);
  const [productivityBlocks, setProductivityBlocks] = useState<ProductivityRatesBlock[]>([]);
  const [activeDropdownId, setActiveDropdownId] = useState<string | null>(null);
  const [prodRateSearchQuery, setProdRateSearchQuery] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tableRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const selectionSourceRef = useRef<"pdf" | "table" | null>(null);
  const dropdownAnchorRefs = useRef<Record<string, HTMLDivElement | null>>({});

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

  // Load productivity rates when in review mode
  useEffect(() => {
    if (!isReviewMode) return;
    getProductivityRates()
      .then((payload) => {
        setProductivityBlocks(payload.blocks ?? []);
      })
      .catch(() => {
        // Silently fail - productivity rates are optional
      });
  }, [isReviewMode]);

  const productivityOptions = useMemo<ProductivityOption[]>(
    () =>
      productivityBlocks.map((block) => ({
        id: block.id,
        description: block.description,
        unit: block.unit,
      })),
    [productivityBlocks]
  );

  const productivityOptionsById = useMemo(() => {
    return new Map(productivityOptions.map((option) => [option.id, option]));
  }, [productivityOptions]);
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
    setError("");
  }, []);

  const handleExtract = useCallback(async () => {
    if (!selectedFile) return;
    setLoading(true);
    setError("");
    setItems([]);
    setSelectedItemId("");
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
    (id: string, field: "item_code" | "description" | "notes" | "thickness" | "productivityRateId", value: string | number | null) => {
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
      );
    },
    []
  );

  const handleThicknessChange = useCallback(
    (id: string, value: string) => {
      const trimmed = value.trim();
      if (trimmed === "") {
        handleItemFieldChange(id, "thickness", null);
      } else {
        const num = parseFloat(trimmed);
        handleItemFieldChange(id, "thickness", isNaN(num) ? null : num);
      }
    },
    [handleItemFieldChange]
  );

  const handleSelectProductivityRate = useCallback(
    (itemId: string, optionId: string) => {
      handleItemFieldChange(itemId, "productivityRateId", optionId);
      setActiveDropdownId(null);
      setProdRateSearchQuery((prev) => ({ ...prev, [itemId]: "" }));
    },
    [handleItemFieldChange]
  );

  const handleClearProductivityRate = useCallback(
    (itemId: string) => {
      handleItemFieldChange(itemId, "productivityRateId", null);
      setProdRateSearchQuery((prev) => ({ ...prev, [itemId]: "" }));
    },
    [handleItemFieldChange]
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

  const handleMoveItemToCode = useCallback((itemId: string, targetCode: string) => {
    const normalizedTarget = (targetCode || "ITEM").trim() || "ITEM";
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item;
        if (((item.item_code || "ITEM").trim() || "ITEM") === normalizedTarget) return item;
        return { ...item, item_code: normalizedTarget };
      })
    );
  }, []);

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
        style={{ flex: 1, minHeight: 0, overflowX: "auto", overflowY: "auto", fontSize: "0.88rem" }}
      >
        <table className="matches-table resizable-table" style={{ minWidth: "900px", tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th style={{ width: "100px" }}>Item</th>
              <th style={{ width: "280px" }}>Description</th>
              <th style={{ width: "90px" }}>Thickness</th>
              <th style={{ width: "220px" }}>Prod. Rate</th>
              <th style={{ width: "180px" }}>Note</th>
              {isReviewMode && <th style={{ width: "80px" }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="matches-table__row">
                <td colSpan={isReviewMode ? 6 : 5} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>
                  No items extracted yet.
                </td>
              </tr>
            ) : (
              groupedItems.flatMap(([code, group]) => {
                const handleGroupDragOver = (event: React.DragEvent<HTMLTableRowElement>) => {
                  if (!isReviewMode) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                };
                const handleGroupDrop = (event: React.DragEvent<HTMLTableRowElement>) => {
                  if (!isReviewMode) return;
                  event.preventDefault();
                  const itemId = event.dataTransfer.getData("text/plain");
                  if (!itemId) return;
                  handleMoveItemToCode(itemId, code);
                };
                const groupRows: React.ReactNode[] = [
                  (
                    <tr
                      key={`group-${code}`}
                      className="boq-group-row"
                      onDragOver={handleGroupDragOver}
                      onDrop={handleGroupDrop}
                    >
                      <td colSpan={isReviewMode ? 6 : 5}>{code}</td>
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
                  const handleRowDragStart = (event: React.DragEvent<HTMLTableRowElement>) => {
                    if (!isReviewMode) return;
                    event.dataTransfer.setData("text/plain", item.id);
                    event.dataTransfer.effectAllowed = "move";
                  };
                  const handleRowDragOver = (event: React.DragEvent<HTMLTableRowElement>) => {
                    if (!isReviewMode) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  };
                  const handleRowDrop = (event: React.DragEvent<HTMLTableRowElement>) => {
                    if (!isReviewMode) return;
                    event.preventDefault();
                    const itemId = event.dataTransfer.getData("text/plain");
                    if (!itemId) return;
                    handleMoveItemToCode(itemId, code);
                  };
                  const searchQuery = prodRateSearchQuery[item.id] ?? "";
                  const showDropdown = activeDropdownId === item.id && searchQuery.length >= 3;
                  const filteredOptions = showDropdown
                    ? productivityOptions
                      .filter((option) =>
                        option.description.toLowerCase().includes(searchQuery.toLowerCase())
                      )
                      .slice(0, 8)
                    : [];
                  const selectedOption = item.productivityRateId
                    ? productivityOptionsById.get(item.productivityRateId)
                    : null;
                  const itemCodeDisplay = (item.item_code ?? "").trim() === "ITEM" ? "" : item.item_code || `Item ${idx + 1}`;
                  const descDisplay = item.description || "—";
                  const thicknessDisplay = item.thickness != null ? `${item.thickness} mm` : "—";
                  const notesDisplay = (item.item_code ?? "").trim() === "ITEM" ? "" : (item.notes || "");
                  const prodRateDisplay = selectedOption?.description || "—";
                  groupRows.push(
                    <tr
                      key={item.id}
                      className={`matches-table__row ${isLinked ? "is-linked" : ""}`}
                      onClick={handleRowClick}
                      draggable={isReviewMode}
                      onDragStart={handleRowDragStart}
                      onDragOver={handleRowDragOver}
                      onDrop={handleRowDrop}
                      ref={(el) => {
                        tableRowRefs.current[item.id] = el;
                      }}
                    >
                      <td title={itemCodeDisplay} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {isReviewMode ? (
                          <input
                            type="text"
                            value={item.item_code}
                            onChange={(event) => handleItemFieldChange(item.id, "item_code", event.target.value)}
                            placeholder={`Item ${idx + 1}`}
                            title={item.item_code}
                          />
                        ) : (
                          itemCodeDisplay
                        )}
                      </td>
                      <td title={descDisplay} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {isReviewMode ? (
                          <input
                            type="text"
                            value={item.description}
                            onChange={(event) => handleItemFieldChange(item.id, "description", event.target.value)}
                            placeholder="Description"
                            title={item.description}
                          />
                        ) : (
                          descDisplay
                        )}
                      </td>
                      <td title={thicknessDisplay} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {isReviewMode ? (
                          <input
                            type="text"
                            inputMode="decimal"
                            value={item.thickness != null ? String(item.thickness) : ""}
                            onChange={(event) => handleThicknessChange(item.id, event.target.value)}
                            placeholder="mm"
                            title={item.thickness != null ? `${item.thickness} mm` : ""}
                          />
                        ) : (
                          thicknessDisplay
                        )}
                      </td>
                      <td title={prodRateDisplay} style={{ position: "relative", overflow: "visible" }}>
                        {isReviewMode ? (
                          <div
                            className="productivity-cell-with-action"
                            ref={(el) => {
                              dropdownAnchorRefs.current[item.id] = el;
                            }}
                            style={{ width: "100%" }}
                          >
                            {selectedOption ? (
                              <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", width: "100%" }}>
                                <span
                                  style={{
                                    flex: 1,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    fontSize: "0.85rem",
                                    minWidth: 0,
                                  }}
                                  title={selectedOption.description}
                                >
                                  {selectedOption.description}
                                </span>
                                <button
                                  type="button"
                                  className="inline-remove-button"
                                  onClick={() => handleClearProductivityRate(item.id)}
                                  aria-label="Clear productivity rate"
                                  style={{ flexShrink: 0, width: "20px", height: "20px", padding: 0, lineHeight: 1 }}
                                >
                                  ×
                                </button>
                              </div>
                            ) : (
                              <>
                                <input
                                  type="text"
                                  value={searchQuery}
                                  onFocus={() => {
                                    if (searchQuery.length >= 3) {
                                      setActiveDropdownId(item.id);
                                    }
                                  }}
                                  onBlur={() => setTimeout(() => setActiveDropdownId(null), 150)}
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    setProdRateSearchQuery((prev) => ({ ...prev, [item.id]: value }));
                                    if (value.length >= 3) {
                                      setActiveDropdownId(item.id);
                                    } else {
                                      setActiveDropdownId(null);
                                    }
                                  }}
                                  placeholder="Search prod. rates..."
                                  style={{ width: "100%" }}
                                />
                                {filteredOptions.length > 0 && (
                                  <div
                                    className="pricing-match-menu"
                                    style={{
                                      position: "absolute",
                                      top: "100%",
                                      left: 0,
                                      width: "280px",
                                      zIndex: 100,
                                      maxHeight: "200px",
                                      overflowY: "auto",
                                    }}
                                    onWheel={(event) => event.stopPropagation()}
                                    onScroll={(event) => event.stopPropagation()}
                                  >
                                    {filteredOptions.map((option) => (
                                      <button
                                        key={option.id}
                                        type="button"
                                        className="pricing-match-menu__item"
                                        onMouseDown={(event) => {
                                          event.preventDefault();
                                          handleSelectProductivityRate(item.id, option.id);
                                        }}
                                        title={option.description}
                                      >
                                        {option.description}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        ) : (
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                            {prodRateDisplay}
                          </span>
                        )}
                      </td>
                      <td title={notesDisplay} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {isReviewMode ? (
                          <input
                            type="text"
                            value={item.notes}
                            onChange={(event) => handleItemFieldChange(item.id, "notes", event.target.value)}
                            placeholder="Note"
                            title={item.notes}
                          />
                        ) : (
                          notesDisplay
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
                <p className="processing-indicator__message">Extracting items with AI…</p>
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
              <p className="processing-indicator__message">Extracting items with AI…</p>
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
        showAllOverlays={false}
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
