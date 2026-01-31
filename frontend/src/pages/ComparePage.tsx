import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompareItemResult, ProjectCompareResponse } from "../types";
import { compareProjectItems } from "../services/api";

type LogLevel = "info" | "warning" | "error";

type CompareLog = {
  id: string;
  level: LogLevel;
  message: string;
  createdAt: string;
};

type CompareStatus = "idle" | "running" | "success" | "failed";

interface ComparePageProps {
  projectId: string;
  onNext: () => void;
  headerTop?: ReactNode;
  forceRefresh?: boolean;
  onConsumeForce?: () => void;
}

const formatTime = (value: string) => new Date(value).toLocaleTimeString();

const renderText = (value: string) => {
  const text = value.trim() ? value : "—";
  return <span className="cell-text" title={text}>{text}</span>;
};

const renderInlineMarkdown = (value: string) => {
  const parts = value.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    const match = part.match(/^\*\*([^*]+)\*\*$/);
    if (match) {
      return <strong key={`b-${index}`}>{match[1]}</strong>;
    }
    return <span key={`t-${index}`}>{part}</span>;
  });
};

const renderMarkdownReason = (value: string) => {
  const text = value.trim();
  if (!text) return renderText("");
  const lines = text.split(/\r?\n/);
  const blocks: Array<{ type: "heading" | "list" | "paragraph"; content: string[] | string }> = [];
  let listBuffer: string[] = [];

  const flushList = () => {
    if (listBuffer.length > 0) {
      blocks.push({ type: "list", content: listBuffer });
      listBuffer = [];
    }
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      return;
    }
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      flushList();
      blocks.push({ type: "heading", content: headingMatch[2] });
      return;
    }
    const listMatch = trimmed.match(/^[-*•]\s+(.*)$/);
    if (listMatch) {
      listBuffer.push(listMatch[1]);
      return;
    }
    flushList();
    blocks.push({ type: "paragraph", content: trimmed });
  });
  flushList();

  return (
    <div className="compare-reason">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return (
            <div key={`h-${index}`} className="compare-reason__heading">
              {renderInlineMarkdown(block.content as string)}
            </div>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={`l-${index}`} className="compare-reason__list">
              {(block.content as string[]).map((item, itemIndex) => (
                <li key={`${item}-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={`p-${index}`} className="compare-reason__paragraph">
            {renderInlineMarkdown(block.content as string)}
          </p>
        );
      })}
    </div>
  );
};

export default function ComparePage({
  projectId,
  onNext,
  headerTop,
  forceRefresh,
  onConsumeForce,
}: ComparePageProps) {
  const [status, setStatus] = useState<CompareStatus>("idle");
  const [logs, setLogs] = useState<CompareLog[]>([]);
  const [results, setResults] = useState<CompareItemResult[]>([]);
  const [stats, setStats] = useState<ProjectCompareResponse["stats"] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const didRunRef = useRef(false);

  const pushLog = useCallback((message: string, level: LogLevel = "info") => {
    const createdAt = new Date().toISOString();
    setLogs((prev) => [
      { id: `${createdAt}-${Math.random()}`, level, message, createdAt },
      ...prev,
    ]);
  }, []);

  const runCompare = useCallback(async () => {
    onConsumeForce?.();
    setStatus("running");
    setErrorMessage(null);
    setResults([]);
    setStats(null);
    setLogs([]);
    pushLog("Preparing BOQ items from schedule codes.");
    pushLog("Preparing drawing detail list from extracted drawings.");
    try {
      pushLog("Calling OpenAI to compare BOQ vs drawing details.");
      const response = await compareProjectItems(projectId, { force: Boolean(forceRefresh) });
      setResults(response.results ?? []);
      setStats(response.stats ?? null);
      if (response.cached) {
        pushLog("Loaded comparison results from database.");
      }
      pushLog(`Comparison complete. ${response.results?.length ?? 0} item(s) checked.`);
      if ((response.stats?.chunks ?? 0) > 1) {
        pushLog(`Large BOQ detected. Split into ${response.stats?.chunks} AI calls for accuracy.`);
      }
      setStatus("success");
    } catch (error) {
      const message = (error as Error).message || "Comparison failed.";
      setErrorMessage(message);
      pushLog(`Comparison failed: ${message}`, "error");
      setStatus("failed");
    }
  }, [forceRefresh, onConsumeForce, projectId, pushLog]);

  useEffect(() => {
    if (didRunRef.current) return;
    didRunRef.current = true;
    void runCompare();
  }, [runCompare]);

  const matchCount = useMemo(
    () => results.filter((item) => item.result === "matched").length,
    [results]
  );

  return (
    <section className="panel">
      <div className="panel__header panel__header--review">
        <div className="stepper-container">
          {headerTop}
          <h2 style={{ marginTop: "0.5rem" }}>Compare BOQ vs Drawings</h2>
        </div>
      </div>
      <div className="panel__body">
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
          <button
            type="button"
            className="btn-secondary btn-compact btn-muted"
            onClick={onNext}
          >
            Go to Pricing
          </button>
        </div>

        <div className="compare-grid">
          <div className="compare-log-card">
            <div className="compare-log-header">
              <div>
                <p className="eyebrow">Comparison Log</p>
                <h3>Live Processing</h3>
              </div>
              <span className={`compare-status compare-status--${status}`}>
                {status === "running" ? "Processing…" : status === "success" ? "Completed" : status === "failed" ? "Failed" : "Ready"}
              </span>
            </div>
            <div className="compare-log-body">
              {status === "running" && (
                <div className="compare-waiting">
                  <span className="compare-waiting__dot" />
                  <span className="compare-waiting__dot" />
                  <span className="compare-waiting__dot" />
                  <span className="compare-waiting__label">Comparing items…</span>
                </div>
              )}
              {stats && (
                <div className="compare-stats">
                  <div>
                    <span className="compare-stat__label">Comparable Items</span>
                    <span className="compare-stat__value">{stats.comparableItems}</span>
                  </div>
                  <div>
                    <span className="compare-stat__label">Schedule Codes</span>
                    <span className="compare-stat__value">{stats.scheduleCodes}</span>
                  </div>
                  <div>
                    <span className="compare-stat__label">Drawing Details</span>
                    <span className="compare-stat__value">{stats.drawingItems}</span>
                  </div>
                </div>
              )}
              <div className="log-panel compare-log-panel">
                {logs.length === 0 ? (
                  <div className="log-empty">Logs will appear here once comparison starts.</div>
                ) : (
                  <ul className="log-list">
                    {logs.map((log, index) => (
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
              {status === "failed" && (
                <div className="compare-error">
                  <p>{errorMessage || "Comparison failed. Please retry."}</p>
                  <button type="button" className="btn-match" onClick={() => void runCompare()}>
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="compare-results-card">
            <div className="compare-results-header">
              <div>
                <p className="eyebrow">Results</p>
                <h3>BOQ vs Drawing Validation</h3>
                <p className="dashboard-muted">
                  {status === "running"
                    ? "Comparing BOQ items against drawing details…"
                    : status === "success"
                      ? `${matchCount} matched · ${results.length - matchCount} mismatched`
                      : "Run comparison to see results."}
                </p>
              </div>
              {status === "success" && (
                <span className="compare-summary-chip">
                  {matchCount}/{results.length} matched
                </span>
              )}
            </div>

            <div className="table-wrapper compare-table-wrapper">
              <table className="kb-table compare-results-table">
                <thead>
                  <tr>
                    <th>Item Code</th>
                    <th>Status</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {results.length === 0 ? (
                    <tr className="kb-table__row">
                      <td colSpan={3} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>
                        {status === "running" ? "Comparing items..." : "No comparison results yet."}
                      </td>
                    </tr>
                  ) : (
                    results.map((row) => (
                      <tr
                        key={row.item_code}
                        className={`kb-table__row compare-row compare-row--${row.result}`}
                      >
                        <td className="kb-table__filename">{renderText(row.item_code)}</td>
                        <td>
                          <span className={`compare-pill compare-pill--${row.result}`}>
                            {row.result === "matched" ? "Matched" : "Mismatch"}
                          </span>
                        </td>
                        <td>{renderMarkdownReason(row.reason || "")}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
