import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type { ProductivityRatesBlock, ProductivityRatesPayload, ProductivityRatesRow } from "../types";
import { getProductivityRates, saveProductivityRates } from "../services/api";

type ProductivityRatesProps = {
  projectName?: string;
};

const createRow = (label = "", overrides: Partial<ProductivityRatesRow> = {}): ProductivityRatesRow => ({
  id: uuidv4(),
  label,
  quantity: "",
  hourlyRate: "",
  hoursPerDay: "",
  dailyProductivity: "",
  ...overrides,
});

const createBlock = (): ProductivityRatesBlock => ({
  id: uuidv4(),
  description: "",
  unit: "",
  hoursPerDay: "",
  dailyProductivity: "",
  manpowerRows: [createRow("FLAGMAN"), createRow("UNSKILLED")],
  equipmentRows: [createRow()],
  manpowerMh: "",
  manpowerRate: "",
});

const parseNumber = (value: string) => {
  if (!value || value.trim() === "") return 0;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const formatNumber = (value: number) => value.toFixed(2);

const getPrimaryEquipmentRowId = (block: ProductivityRatesBlock) => block.equipmentRows[0]?.id;

const getPrimaryEquipmentRowValues = (block: ProductivityRatesBlock) => {
  const primaryRow = block.equipmentRows[0] ?? { hoursPerDay: "", dailyProductivity: "" };
  return {
    hoursPerDay: primaryRow.hoursPerDay ?? "",
    dailyProductivity: primaryRow.dailyProductivity ?? "",
  };
};

const normalizeBlocks = (inputBlocks: ProductivityRatesBlock[]): ProductivityRatesBlock[] =>
  inputBlocks.map((block) => {
    const legacyHours = block.hoursPerDay ?? "";
    const legacyProductivity = block.dailyProductivity ?? "";
    const applyEquipmentDefaults = (row: ProductivityRatesRow): ProductivityRatesRow => ({
      ...row,
      hourlyRate: row.hourlyRate ?? "",
      hoursPerDay: row.hoursPerDay ?? legacyHours,
      dailyProductivity: row.dailyProductivity ?? legacyProductivity,
    });
    return {
      ...block,
      hoursPerDay: block.hoursPerDay ?? "",
      dailyProductivity: block.dailyProductivity ?? "",
      manpowerRows: block.manpowerRows.map((row) => ({
        ...row,
        hourlyRate: row.hourlyRate ?? "",
      })),
      equipmentRows: block.equipmentRows.map(applyEquipmentDefaults),
    };
  });

export default function ProductivityRates({ projectName }: ProductivityRatesProps) {
  const [factor, setFactor] = useState("1");
  const [blocks, setBlocks] = useState<ProductivityRatesBlock[]>([createBlock()]);
  const [saveMessage, setSaveMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [rowOverrides, setRowOverrides] = useState<Record<string, { hoursPerDay?: boolean; dailyProductivity?: boolean }>>(
    {}
  );
  const lastSavedRef = useRef<string>("");
  const [confirmDelete, setConfirmDelete] = useState<
    | { type: "block"; blockId: string }
    | { type: "row"; blockId: string; section: "manpowerRows" | "equipmentRows"; rowId: string }
    | null
  >(null);

  const defaultPayload = useMemo<ProductivityRatesPayload>(
    () => ({ factor: "1", blocks: [createBlock()], updatedAt: null }),
    []
  );

  useEffect(() => {
    setLoading(true);
    setErrorMessage("");
    getProductivityRates()
      .then((payload) => {
        const resolvedBlocks = payload.blocks?.length ? normalizeBlocks(payload.blocks) : defaultPayload.blocks;
        setBlocks(resolvedBlocks);
        setRowOverrides({});
        setFactor(payload.factor ?? "1");
        lastSavedRef.current = JSON.stringify({ factor: payload.factor ?? "1", blocks: resolvedBlocks });
        setIsDirty(false);
      })
      .catch((error: unknown) => {
        setBlocks(defaultPayload.blocks);
        setRowOverrides({});
        setFactor(defaultPayload.factor);
        setErrorMessage((error as Error).message || "Failed to load productivity rates.");
        lastSavedRef.current = JSON.stringify({ factor: defaultPayload.factor, blocks: defaultPayload.blocks });
        setIsDirty(false);
      })
      .finally(() => setLoading(false));
  }, [defaultPayload]);

  useEffect(() => {
    setSaveMessage("");
  }, []);

  const updateBlock = useCallback((blockId: string, updater: (block: ProductivityRatesBlock) => ProductivityRatesBlock) => {
    setBlocks((current) => current.map((block) => (block.id === blockId ? updater(block) : block)));
  }, []);

  const updateBlockSharedField = useCallback(
    (blockId: string, field: "hoursPerDay" | "dailyProductivity", value: string) => {
      updateBlock(blockId, (block) => ({
        ...block,
        [field]: value,
        equipmentRows: block.equipmentRows.map((row) => {
          if (rowOverrides[row.id]?.[field]) return row;
          return { ...row, [field]: value };
        }),
      }));
    },
    [updateBlock, rowOverrides]
  );

  const updateRow = useCallback(
    (
      blockId: string,
      section: "manpowerRows" | "equipmentRows",
      rowId: string,
      field: "label" | "quantity" | "hourlyRate" | "hoursPerDay" | "dailyProductivity",
      value: string
    ) => {
      let isPrimaryRow = false;
      updateBlock(blockId, (block) => {
        if (section !== "equipmentRows") {
          return {
            ...block,
            [section]: block[section].map((row) => (row.id === rowId ? { ...row, [field]: value } : row)),
          };
        }
        const primaryRowId = getPrimaryEquipmentRowId(block);
        const isBroadcastField = field === "hoursPerDay" || field === "dailyProductivity";
        isPrimaryRow = rowId === primaryRowId;
        if (isBroadcastField && isPrimaryRow) {
          const updateRowValue = (row: ProductivityRatesRow) => {
            if (row.id !== rowId && rowOverrides[row.id]?.[field]) {
              return row;
            }
            return { ...row, [field]: value };
          };
          return {
            ...block,
            equipmentRows: block.equipmentRows.map(updateRowValue),
          };
        }
        return {
          ...block,
          [section]: block[section].map((row) => (row.id === rowId ? { ...row, [field]: value } : row)),
        };
      });
      if (
        section === "equipmentRows" &&
        (field === "hoursPerDay" || field === "dailyProductivity") &&
        !isPrimaryRow
      ) {
        setRowOverrides((current) => ({
          ...current,
          [rowId]: { ...current[rowId], [field]: true },
        }));
      }
    },
    [updateBlock, rowOverrides]
  );

  const addRow = useCallback(
    (blockId: string, section: "manpowerRows" | "equipmentRows") => {
      updateBlock(blockId, (block) => ({
        ...block,
        [section]:
          section === "equipmentRows"
            ? [...block[section], createRow("", getPrimaryEquipmentRowValues(block))]
            : [...block[section], createRow()],
      }));
    },
    [updateBlock]
  );

  const removeRow = useCallback(
    (blockId: string, section: "manpowerRows" | "equipmentRows", rowId: string) => {
      updateBlock(blockId, (block) => {
        if (block[section].length <= 1) return block;
        return {
          ...block,
          [section]: block[section].filter((row) => row.id !== rowId),
        };
      });
    },
    [updateBlock]
  );

  const addBlock = useCallback(() => {
    setBlocks((current) => [...current, createBlock()]);
  }, []);

  const removeBlock = useCallback((blockId: string) => {
    setBlocks((current) => current.filter((block) => block.id !== blockId));
  }, []);

  const confirmDeleteAction = useCallback(() => {
    if (!confirmDelete) return;
    if (confirmDelete.type === "block") {
      removeBlock(confirmDelete.blockId);
    } else {
      removeRow(confirmDelete.blockId, confirmDelete.section, confirmDelete.rowId);
    }
    setConfirmDelete(null);
  }, [confirmDelete, removeBlock, removeRow]);

  const handleSave = useCallback(() => {
    setSaving(true);
    setErrorMessage("");
    const factorValue = parseNumber(factor);
    const enrichedBlocks = blocks.map((block) => {
      const hoursValue = parseNumber(block.hoursPerDay);
      const productivityValue = parseNumber(block.dailyProductivity);
      const manpowerSum = block.manpowerRows.reduce((sum, row) => sum + parseNumber(row.quantity), 0);
      const manpowerMh = productivityValue ? (manpowerSum * hoursValue) / productivityValue : 0;
      const manpowerRate = manpowerMh * factorValue;
      return {
        ...block,
        manpowerMh: formatNumber(manpowerMh),
        manpowerRate: formatNumber(manpowerRate),
        manpowerRows: block.manpowerRows.map((row) => ({
          id: row.id,
          label: row.label,
          quantity: row.quantity,
        })),
        equipmentRows: block.equipmentRows.map((row) => {
          const rowQty = parseNumber(row.quantity);
          const rowHours = parseNumber(row.hoursPerDay ?? "");
          const rowProductivity = parseNumber(row.dailyProductivity ?? "");
          const rowMh = rowProductivity ? (rowQty * rowHours) / rowProductivity : 0;
          const hourlyRateValue = parseNumber(row.hourlyRate ?? "");
          const rowRate = rowMh * hourlyRateValue;
          return {
            ...row,
            mh: formatNumber(rowMh),
            rate: formatNumber(rowRate),
          };
        }),
      };
    });
    saveProductivityRates({ factor, blocks: enrichedBlocks })
      .then(() => {
        setSaveMessage("Saved.");
        setBlocks(enrichedBlocks);
        lastSavedRef.current = JSON.stringify({ factor, blocks: enrichedBlocks });
        setIsDirty(false);
        setTimeout(() => setSaveMessage(""), 3000);
      })
      .catch((error: unknown) => {
        setErrorMessage((error as Error).message || "Failed to save productivity rates.");
      })
      .finally(() => setSaving(false));
  }, [factor, blocks]);

  const serialized = useMemo(() => JSON.stringify({ factor, blocks }), [factor, blocks]);

  useEffect(() => {
    if (loading) return;
    setIsDirty(serialized !== lastSavedRef.current);
  }, [serialized, loading]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!isDirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  useEffect(() => {
    (window as typeof window & { __productivityDirty?: boolean }).__productivityDirty = isDirty;
    return () => {
      (window as typeof window & { __productivityDirty?: boolean }).__productivityDirty = false;
    };
  }, [isDirty]);

  if (loading) {
    return (
      <section className="panel productivity-page">
        <div className="panel__header productivity-header">
          <div>
            <p className="eyebrow">Productivity</p>
            <h2>Productivity Rates</h2>
          </div>
        </div>
        <div className="panel__body">
          <p className="loading-text">Loading productivity rates...</p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel productivity-page">
      <div className="panel__header productivity-header">
        <div>
          <p className="eyebrow">Productivity</p>
          <h2>Productivity Rates</h2>
          <p className="dashboard-subtitle">
            Configure manpower and equipment rates {projectName ? `for ${projectName}` : ""}.
          </p>
        </div>
        <div className="productivity-header__actions">
          <label className="productivity-field productivity-field--inline">
            Manpower Hourly Rate
            <input
              type="number"
              step="0.01"
              value={factor}
              onChange={(event) => setFactor(event.target.value)}
            />
          </label>
          <button type="button" className="btn-secondary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
          {saveMessage && <span className="status">{saveMessage}</span>}
        </div>
      </div>
      <div className="panel__body">
        {errorMessage && <p className="feedback">{errorMessage}</p>}
        <div className="productivity-blocks">
          {blocks.map((block, index) => {
            const factorValue = parseNumber(factor);
            const totalRows = block.manpowerRows.length + block.equipmentRows.length;

            return (
              <div key={block.id} className="productivity-block">
                <div className="productivity-block__header">
                  <div className="productivity-block__meta-actions">
                    <button
                      type="button"
                      className="block-delete-button"
                      onClick={() => setConfirmDelete({ type: "block", blockId: block.id })}
                      aria-label={`Delete block ${index + 1}`}
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div className="productivity-table-wrapper">
                  <table className="productivity-table productivity-table--compact">
                    <thead>
                      <tr>
                        <th>Description</th>
                        <th className="productivity-col-unit">Unit</th>
                        <th>Manpower / Equipment Required</th>
                        <th>Qty</th>
                        <th>Hours per day</th>
                        <th>Daily productivity</th>
                        <th className="productivity-col-mh">MH/EH</th>
                        <th className="productivity-col-rate">Rate</th>
                        <th className="productivity-col-hourly">Hourly Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {block.manpowerRows.map((row, rowIndex) => {
                        const showShared = rowIndex === 0;
                        const hoursValue = parseNumber(block.hoursPerDay);
                        const productivityValue = parseNumber(block.dailyProductivity);
                        const manpowerSum = block.manpowerRows.reduce((sum, item) => sum + parseNumber(item.quantity), 0);
                        const manpowerMh = productivityValue ? (manpowerSum * hoursValue) / productivityValue : 0;
                        const manpowerRate = manpowerMh * factorValue;
                        return (
                          <tr key={row.id} className="productivity-row productivity-row--manpower">
                            {showShared && (
                              <td rowSpan={totalRows} className="productivity-cell--shared">
                                <textarea
                                  className="productivity-textarea"
                                  value={block.description}
                                  onChange={(event) =>
                                    updateBlock(block.id, (current) => ({ ...current, description: event.target.value }))
                                  }
                                  placeholder="e.g. Deep excavation (sandy soil)"
                                  rows={3}
                                />
                              </td>
                            )}
                            {showShared && (
                              <td rowSpan={totalRows} className="productivity-cell--shared productivity-col-unit">
                                <input
                                  type="text"
                                  value={block.unit}
                                  onChange={(event) => updateBlock(block.id, (current) => ({ ...current, unit: event.target.value }))}
                                  placeholder="e.g. M3"
                                />
                              </td>
                            )}
                            <td>
                              <div className="productivity-cell-with-action">
                                <input
                                  type="text"
                                  value={row.label}
                                  onChange={(event) =>
                                    updateRow(block.id, "manpowerRows", row.id, "label", event.target.value)
                                  }
                                  placeholder="e.g. Flagman"
                                />
                                <div className="row-action-buttons">
                                  {showShared && (
                                    <button
                                      type="button"
                                      className="inline-add-button"
                                      onClick={() => addRow(block.id, "manpowerRows")}
                                      aria-label="Add manpower row"
                                    >
                                      +
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="inline-remove-button"
                                    onClick={() =>
                                      setConfirmDelete({
                                        type: "row",
                                        blockId: block.id,
                                        section: "manpowerRows",
                                        rowId: row.id,
                                      })
                                    }
                                    aria-label="Remove manpower row"
                                    disabled={block.manpowerRows.length <= 1}
                                  >
                                    −
                                  </button>
                                </div>
                              </div>
                            </td>
                            <td>
                              <input
                                type="number"
                                step="0.01"
                                value={row.quantity}
                                onChange={(event) =>
                                  updateRow(block.id, "manpowerRows", row.id, "quantity", event.target.value)
                                }
                              />
                            </td>
                            <td>
                              {showShared ? (
                                <input
                                  type="number"
                                  step="0.01"
                                  value={block.hoursPerDay}
                                  onChange={(event) =>
                                    updateBlockSharedField(block.id, "hoursPerDay", event.target.value)
                                  }
                                />
                              ) : (
                                <span className="productivity-cell--empty" />
                              )}
                            </td>
                            <td>
                              {showShared ? (
                                <input
                                  type="number"
                                  step="0.01"
                                  value={block.dailyProductivity}
                                  onChange={(event) =>
                                    updateBlockSharedField(block.id, "dailyProductivity", event.target.value)
                                  }
                                />
                              ) : (
                                <span className="productivity-cell--empty" />
                              )}
                            </td>
                            {showShared ? (
                              <td rowSpan={block.manpowerRows.length} className="productivity-cell--calc productivity-col-mh">
                                {formatNumber(manpowerMh)}
                              </td>
                            ) : null}
                            {showShared ? (
                              <td
                                rowSpan={block.manpowerRows.length}
                                colSpan={2}
                                className="productivity-cell--calc productivity-col-rate"
                              >
                                {formatNumber(manpowerRate)}
                              </td>
                            ) : null}
                          </tr>
                        );
                      })}
                      {block.equipmentRows.map((row, rowIndex) => {
                        const showShared = rowIndex === 0;
                        const rowQty = parseNumber(row.quantity);
                        const rowHours = parseNumber(row.hoursPerDay ?? "");
                        const rowProductivity = parseNumber(row.dailyProductivity ?? "");
                        const equipmentMh = rowProductivity ? (rowQty * rowHours) / rowProductivity : 0;
                        const hourlyRateValue = parseNumber(row.hourlyRate ?? "");
                        const equipmentRate = equipmentMh * hourlyRateValue;
                        return (
                          <tr
                            key={row.id}
                            className={`productivity-row productivity-row--equipment${showShared ? " productivity-row--equipment-start" : ""}`}
                          >
                            <td>
                              <div className="productivity-cell-with-action">
                                <input
                                  type="text"
                                  value={row.label}
                                  onChange={(event) =>
                                    updateRow(block.id, "equipmentRows", row.id, "label", event.target.value)
                                  }
                                  placeholder="e.g. Water tanker"
                                />
                                <div className="row-action-buttons">
                                  {showShared && (
                                    <button
                                      type="button"
                                      className="inline-add-button inline-add-button--equipment"
                                      onClick={() => addRow(block.id, "equipmentRows")}
                                      aria-label="Add equipment row"
                                    >
                                      +
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="inline-remove-button inline-remove-button--equipment"
                                    onClick={() =>
                                      setConfirmDelete({
                                        type: "row",
                                        blockId: block.id,
                                        section: "equipmentRows",
                                        rowId: row.id,
                                      })
                                    }
                                    aria-label="Remove equipment row"
                                    disabled={block.equipmentRows.length <= 1}
                                  >
                                    −
                                  </button>
                                </div>
                              </div>
                            </td>
                            <td>
                              <input
                                type="number"
                                step="0.01"
                                value={row.quantity}
                                onChange={(event) =>
                                  updateRow(block.id, "equipmentRows", row.id, "quantity", event.target.value)
                                }
                              />
                            </td>
                            <td>
                              <input
                                type="number"
                                step="0.01"
                                value={row.hoursPerDay}
                                onChange={(event) =>
                                  updateRow(block.id, "equipmentRows", row.id, "hoursPerDay", event.target.value)
                                }
                              />
                            </td>
                            <td>
                              <input
                                type="number"
                                step="0.01"
                                value={row.dailyProductivity}
                                onChange={(event) =>
                                  updateRow(block.id, "equipmentRows", row.id, "dailyProductivity", event.target.value)
                                }
                              />
                            </td>
                            <td className="productivity-cell--calc productivity-col-mh">{formatNumber(equipmentMh)}</td>
                            <td className="productivity-cell--calc productivity-col-rate">{formatNumber(equipmentRate)}</td>
                            <td className="productivity-col-hourly">
                              <input
                                type="number"
                                step="0.01"
                                value={row.hourlyRate ?? ""}
                                onChange={(event) =>
                                  updateRow(block.id, "equipmentRows", row.id, "hourlyRate", event.target.value)
                                }
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
        <div className="productivity-actions productivity-actions--footer">
          <button type="button" className="btn-match" onClick={addBlock}>
            Add a New Block
          </button>
        </div>
      </div>
      {confirmDelete && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-rate-title">
            <div className="modal__header">
              <h3 className="modal__title" id="delete-rate-title">
                {confirmDelete.type === "block" ? "Delete Block" : "Delete Row"}
              </h3>
              <button type="button" className="modal__close" onClick={() => setConfirmDelete(null)}>
                ×
              </button>
            </div>
            <div className="modal__body">
              <p>
                {confirmDelete.type === "block"
                  ? "Are you sure you want to delete this block?"
                  : "Are you sure you want to delete this row?"}
              </p>
            </div>
            <div className="modal__footer">
              <button type="button" className="btn-secondary" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button type="button" className="btn-match" onClick={confirmDeleteAction}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
