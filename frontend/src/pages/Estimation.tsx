import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";
import * as XLSX from "xlsx";
import type { EstimationRow } from "../types";

type EstimationProps = {
  rows: EstimationRow[];
  projectName?: string;
  headerTop?: ReactNode;
  onGenerate?: () => void;
};

const columns = ["Item", "Description", "QTY", "Unit", "Rate", "Amount"];

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
  if (!Number.isFinite(value)) return "0.00";
  return value.toFixed(2);
};

const formatCell = (value?: string) => (value && value.trim() ? value : "—");

export default function Estimation({ rows, projectName, headerTop, onGenerate }: EstimationProps) {
  const totalAmount = useMemo(() => {
    return rows.reduce((sum, row) => {
      if (row.type !== "priced") return sum;
      return sum + parseNumber(row.amount);
    }, 0);
  }, [rows]);

  const groupedRows = useMemo(() => {
    const output: React.ReactNode[] = [];
    let lastCategory = "";
    let lastSubcategory = "";
    rows.forEach((row) => {
      const category = (row.category ?? "").trim() || "Uncategorized";
      const subcategory = (row.subcategory ?? "").trim();
      if (category !== lastCategory) {
        output.push(
          <tr key={`cat-${category}-${row.id}`} className="boq-group-row">
            <td colSpan={columns.length}>{category}</td>
          </tr>
        );
        lastCategory = category;
        lastSubcategory = "";
      }
      if (subcategory && subcategory !== lastSubcategory) {
        output.push(
          <tr key={`sub-${category}-${subcategory}-${row.id}`} className="boq-subgroup-row">
            <td colSpan={columns.length}>{subcategory}</td>
          </tr>
        );
        lastSubcategory = subcategory;
      }
      output.push(
        <tr key={row.id} className="kb-table__row">
          <td className="kb-table__filename">
            <span className="cell-text">{row.type === "priced" ? formatCell(row.itemCode) : "—"}</span>
          </td>
          <td className="kb-table__filename">
            <span className="cell-text">{formatCell(row.description)}</span>
          </td>
          <td>
            <span className="cell-text">{row.type === "priced" ? formatCell(row.qty) : "—"}</span>
          </td>
          <td>
            <span className="cell-text">{row.type === "priced" ? formatCell(row.unit) : "—"}</span>
          </td>
          <td>
            <span className="cell-text">{row.type === "priced" ? formatCell(row.rate) : "—"}</span>
          </td>
          <td>
            <span className="cell-text">{row.type === "priced" ? formatCell(row.amount) : "—"}</span>
          </td>
        </tr>
      );
    });
    return output;
  }, [rows]);

  const handleGenerate = useCallback(() => {
    if (onGenerate) {
      onGenerate();
    }
    const outputRows: Array<{
      Item: string;
      Description: string;
      QTY: string;
      Unit: string;
      Rate: string;
      Amount: string;
    }> = [];
    let lastCategory = "";
    let lastSubcategory = "";
    rows.forEach((row) => {
      const category = (row.category ?? "").trim() || "Uncategorized";
      const subcategory = (row.subcategory ?? "").trim();
      if (category !== lastCategory) {
        outputRows.push({
          Item: "",
          Description: category,
          QTY: "",
          Unit: "",
          Rate: "",
          Amount: "",
        });
        lastCategory = category;
        lastSubcategory = "";
      }
      if (subcategory && subcategory !== lastSubcategory) {
        outputRows.push({
          Item: "",
          Description: subcategory,
          QTY: "",
          Unit: "",
          Rate: "",
          Amount: "",
        });
        lastSubcategory = subcategory;
      }
      outputRows.push({
        Item: row.type === "priced" ? formatCell(row.itemCode) : "",
        Description: formatCell(row.description),
        QTY: row.type === "priced" ? formatCell(row.qty) : "",
        Unit: row.type === "priced" ? formatCell(row.unit) : "",
        Rate: row.type === "priced" ? formatCell(row.rate) : "",
        Amount: row.type === "priced" ? formatCell(row.amount) : "",
      });
    });
    outputRows.push({
      Item: "",
      Description: "Total",
      QTY: "",
      Unit: "",
      Rate: "",
      Amount: formatRounded(totalAmount),
    });
    const worksheet = XLSX.utils.json_to_sheet(outputRows, {
      header: ["Item", "Description", "QTY", "Unit", "Rate", "Amount"],
    });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Estimation");
    const fileBase = (projectName ?? "estimation").trim() || "estimation";
    XLSX.writeFile(workbook, `${fileBase}-estimation.xlsx`);
  }, [onGenerate, projectName, rows, totalAmount]);

  return (
    <section className="panel">
      <div className="panel__header panel__header--review">
        <div className="stepper-container">
          {headerTop}
          <h2 className="section-title section-title--compact">Estimation Generation</h2>
          <p className="eyebrow" style={{ opacity: 0.7, marginTop: "0.35rem" }}>
            {projectName ? `${projectName} • ` : ""}Selling rate summary.
          </p>
        </div>
      </div>
      <div className="panel__body">
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.75rem" }}>
          <button type="button" className="btn-secondary" onClick={handleGenerate}>
            Generate
          </button>
        </div>
        {rows.length === 0 ? (
          <div className="pricing-placeholder">
            <h3>No priced items yet</h3>
            <p>Complete pricing to generate the estimation table.</p>
          </div>
        ) : (
          <div className="table-wrapper items-table-scroll" style={{ margin: 0, maxHeight: "calc(100vh - 355px)" }}>
            <table className="matches-table boq-table">
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groupedRows}
                <tr className="kb-table__row">
                  <td />
                  <td className="kb-table__filename">
                    <span className="cell-text">Total</span>
                  </td>
                  <td />
                  <td />
                  <td />
                  <td>
                    <span className="cell-text">{formatRounded(totalAmount)}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
