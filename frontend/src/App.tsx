import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import CadExtraction from "./pages/CadExtraction";
import BoqFileReview from "./pages/BoqFileReview";
import ScheduleFileReview from "./pages/ScheduleFileReview";
import Pricing from "./pages/Pricing";
import ProductivityRates from "./pages/ProductivityRates";
import ComparePage from "./pages/ComparePage";
import type { CadExtractionItem, PricingPayload, ProjectFile, ProjectItem, ProjectLog, ProjectSummary } from "./types";
import {
  addProjectFileItem,
  createProject,
  getPricing,
  listProjectFileItems,
  listProjectFiles,
  listProjectItems,
  listProjects,
  removeProjectItem,
  removeProject,
  removeProjectFile,
  retryProjectFile,
  startProjectExtraction,
  updateProjectName,
  updateProjectItem,
  uploadProjectFiles,
} from "./services/api";

type AppPage =
  | "home"
  | "projects"
  | "upload"
  | "extract"
  | "file-review"
  | "schedule-review"
  | "boq-review"
  | "compare"
  | "finalize"
  | "productivity-rates"
  | "pricing";

type CadItemWithId = CadExtractionItem & { id: string };
type EditableProjectItem = Pick<ProjectItem, "id" | "item_code" | "description" | "notes" | "box" | "metadata">;

const PROJECT_STATUS_LABELS: Record<ProjectSummary["status"], string> = {
  in_progress: "In Progess",
  analyzing: "Analysing Files",
  finalized: "Extraction Ready",
};

const FILE_STATUS_LABELS: Record<ProjectFile["status"], string> = {
  pending: "Pending",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
};

const renderCell = (value: string | number | null | undefined) => {
  const text = value === null || value === undefined || String(value).trim() === "" ? "—" : String(value);
  return <span className="cell-text" title={text}>{text}</span>;
};

const renderEmptyCell = () => <span className="cell-text" />;

const renderItemCodeCell = (value: string | number | null | undefined) => {
  const text = value === null || value === undefined ? "" : String(value).trim();
  if (text === "ITEM") {
    return renderEmptyCell();
  }
  return renderCell(value);
};

const isItemPlaceholder = (value: string | number | null | undefined) =>
  value !== null && value !== undefined && String(value).trim() === "ITEM";

const normalizeColumn = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

export default function App() {
  const [activePage, setActivePage] = useState<AppPage>("home");
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [openingProject, setOpeningProject] = useState(false);
  const [pageLoadingMessage, setPageLoadingMessage] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<ProjectSummary | null>(null);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [projectItems, setProjectItems] = useState<ProjectItem[]>([]);
  const [activeFile, setActiveFile] = useState<ProjectFile | null>(null);
  const [fileItems, setFileItems] = useState<ProjectItem[]>([]);
  const [fileItemsSnapshot, setFileItemsSnapshot] = useState<ProjectItem[]>([]);
  const [projectLogs, setProjectLogs] = useState<ProjectLog[]>([]);
  const [drawings, setDrawings] = useState<File[]>([]);
  const [scheduleFiles, setScheduleFiles] = useState<File[]>([]);
  const [boqFile, setBoqFile] = useState<File | null>(null);
  const [projectNameInput, setProjectNameInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [deleteFileTarget, setDeleteFileTarget] = useState<ProjectFile | null>(null);
  const [deletingFile, setDeletingFile] = useState(false);
  const [addFilesOpen, setAddFilesOpen] = useState(false);
  const [addDrawings, setAddDrawings] = useState<File[]>([]);
  const [addSchedules, setAddSchedules] = useState<File[]>([]);
  const [addBoq, setAddBoq] = useState<File | null>(null);
  const [retryingFileId, setRetryingFileId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string>("");
  const [notifications, setNotifications] = useState<Array<{ id: string; message: string }>>([]);
  const lastFileStatusRef = useRef<Map<string, ProjectFile["status"]>>(new Map());
  const didRestoreStepRef = useRef(false);
  const [streamStatus, setStreamStatus] = useState<"connecting" | "connected" | "error">("connecting");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemDrafts, setItemDrafts] = useState<Record<string, { item_code: string; description: string; notes: string }>>({});
  const [savingItemId, setSavingItemId] = useState<string | null>(null);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);
  const [deleteItemTarget, setDeleteItemTarget] = useState<ProjectItem | null>(null);
  const [activeBoqTab, setActiveBoqTab] = useState<string>("all");
  const [activeDrawingTab, setActiveDrawingTab] = useState<string>("all");
  const [activeScheduleTab, setActiveScheduleTab] = useState<string>("all");
  const [pricingCacheByProject, setPricingCacheByProject] = useState<Record<string, PricingPayload | null>>({});
  const [pricingDirty, setPricingDirty] = useState(false);
  const pricingSaveRef = useRef<null | (() => Promise<boolean>)>(null);
  const [unsavedDialogContext, setUnsavedDialogContext] = useState<"productivity" | "pricing" | null>(null);
  const activePricingCache = activeProject ? pricingCacheByProject[activeProject.id] : null;
  const [compareForceNextRun, setCompareForceNextRun] = useState(false);
  type ReviewAccordionKey = "projectFiles" | "boq" | "schedule" | "drawings";
  const [openAccordions, setOpenAccordions] = useState<Record<ReviewAccordionKey, boolean>>({
    projectFiles: true,
    boq: false,
    schedule: false,
    drawings: false,
  });

  const [pendingPageChange, setPendingPageChange] = useState<AppPage | null>(null);
  const [unsavedDialogOpen, setUnsavedDialogOpen] = useState(false);

  const requestPageChange = useCallback(
    (nextPage: AppPage) => {
      const isLeavingProductivity = activePage === "productivity-rates" && nextPage !== "productivity-rates";
      const isDirty = (window as typeof window & { __productivityDirty?: boolean }).__productivityDirty;
      const isLeavingPricing = activePage === "pricing" && nextPage !== "pricing";
      const hasPricingDirty = pricingDirty;
      if (isLeavingPricing && hasPricingDirty) {
        setPendingPageChange(nextPage);
        setUnsavedDialogContext("pricing");
        setUnsavedDialogOpen(true);
        return;
      }
      if (isLeavingProductivity && isDirty) {
        setPendingPageChange(nextPage);
        setUnsavedDialogContext("productivity");
        setUnsavedDialogOpen(true);
        return;
      }
      setActivePage(nextPage);
    },
    [activePage, pricingDirty]
  );

  const handleUnsavedStay = useCallback(() => {
    setUnsavedDialogOpen(false);
    setPendingPageChange(null);
    setUnsavedDialogContext(null);
  }, []);

  const handleUnsavedLeave = useCallback(() => {
    if (pendingPageChange) {
      setActivePage(pendingPageChange);
    }
    setPendingPageChange(null);
    setUnsavedDialogOpen(false);
    setUnsavedDialogContext(null);
  }, [pendingPageChange]);

  const handleUnsavedDiscard = useCallback(() => {
    setPricingDirty(false);
    handleUnsavedLeave();
  }, [handleUnsavedLeave]);

  const handleUnsavedSaveAndLeave = useCallback(async () => {
    if (pricingSaveRef.current) {
      const ok = await pricingSaveRef.current();
      if (!ok) return;
    }
    setPricingDirty(false);
    handleUnsavedLeave();
  }, [handleUnsavedLeave]);

  const pushNotification = useCallback((message: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setNotifications((current) => [{ id, message }, ...current]);
    setTimeout(() => {
      setNotifications((current) => current.filter((note) => note.id !== id));
    }, 5000);
  }, []);

  const refreshProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const rows = await listProjects();
      setProjects(rows);
    } catch (error) {
      setFeedback((error as Error).message || "Failed to load projects.");
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const refreshProjectData = useCallback(async (projectId: string) => {
    const [files, items] = await Promise.all([
      listProjectFiles(projectId),
      listProjectItems(projectId),
    ]);
    setProjectFiles(files);
    setProjectItems(items);
    lastFileStatusRef.current = new Map(files.map((file) => [file.id, file.status]));
    if (files.length > 0) {
      setMaxStepReached((prev) => Math.max(prev, 1));
    }
    if (!pricingCacheByProject[projectId]) {
      try {
        const pricing = await getPricing(projectId);
        setPricingCacheByProject((prev) => ({ ...prev, [projectId]: pricing }));
      } catch {
        // ignore missing pricing data
      }
    }
  }, [pricingCacheByProject]);

  useEffect(() => {
    if (activeProject) {
      setProjectNameInput(activeProject.name);
    }
    if (!activeProject) {
      didRestoreStepRef.current = false;
      setPricingDirty(false);
    }
  }, [activeProject]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects, requestPageChange]);

  useEffect(() => {
    if (activePage === "projects" || activePage === "home") {
      void refreshProjects();
    }
  }, [activePage, refreshProjects]);

  useEffect(() => {
    const handler = () => requestPageChange("pricing");
    window.addEventListener("pricing:go", handler);
    return () => window.removeEventListener("pricing:go", handler);
  }, [requestPageChange]);

  useEffect(() => {
    if (activePage !== "extract" || !activeProject) return;
    const token = localStorage.getItem("auth_token");
    const streamUrl = token
      ? `/api/projects/${encodeURIComponent(activeProject.id)}/stream?token=${encodeURIComponent(token)}`
      : `/api/projects/${encodeURIComponent(activeProject.id)}/stream`;
    const source = new EventSource(streamUrl);
    setStreamStatus("connecting");

    source.addEventListener("project-update", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          files: ProjectFile[];
          items: ProjectItem[];
          logs?: ProjectLog[];
        };
        setProjectFiles(payload.files);
        setProjectItems(payload.items);
        if (payload.logs) {
          setProjectLogs(payload.logs);
        }
        setStreamStatus("connected");

        const prev = lastFileStatusRef.current;
        const next = new Map<string, ProjectFile["status"]>();
        payload.files.forEach((file) => {
          next.set(file.id, file.status);
          const prevStatus = prev.get(file.id);
          if (prevStatus && prevStatus !== file.status && file.status === "ready") {
            pushNotification(`${file.fileName} is ready.`);
          }
        });
        lastFileStatusRef.current = next;
      } catch {
        // ignore malformed updates
      }
    });

    source.addEventListener("error", () => {
      source.close();
      setStreamStatus("error");
    });

    return () => {
      source.close();
    };
  }, [activePage, activeProject, pushNotification]);

  const handleNewProject = useCallback(async () => {
    try {
      const project = await createProject();
      setActiveProject(project);
      setDrawings([]);
      setScheduleFiles([]);
      setBoqFile(null);
      requestPageChange("upload");
      setMaxStepReached(0);
      void refreshProjects();
    } catch (error) {
      setFeedback((error as Error).message || "Failed to create project.");
    }
  }, [refreshProjects]);

  const handleOpenProject = useCallback(async (project: ProjectSummary) => {
    setOpeningProject(true);
    setActiveProject(project);
    requestPageChange("extract");
    setMaxStepReached(1);
    try {
      await refreshProjectData(project.id);
    } catch (error) {
      setFeedback((error as Error).message || "Failed to load project data.");
    } finally {
      setOpeningProject(false);
    }
  }, [refreshProjectData, requestPageChange]);

  const handleDeleteProject = useCallback(async () => {
    if (!deleteTarget) return;
    setDeletingProject(true);
    try {
      await removeProject(deleteTarget.id);
      if (activeProject?.id === deleteTarget.id) {
        setActiveProject(null);
        requestPageChange("home");
      }
      setDeleteTarget(null);
      await refreshProjects();
    } catch (error) {
      setFeedback((error as Error).message || "Failed to delete project.");
    } finally {
      setDeletingProject(false);
    }
  }, [activeProject, deleteTarget, refreshProjects, requestPageChange]);

  const handleDeleteFile = useCallback(async () => {
    if (!activeProject || !deleteFileTarget) return;
    setDeletingFile(true);
    try {
      await removeProjectFile(activeProject.id, deleteFileTarget.id);
      if (activeFile?.id === deleteFileTarget.id) {
        setActiveFile(null);
        requestPageChange("extract");
      }
      setDeleteFileTarget(null);
      await refreshProjectData(activeProject.id);
      setFeedback("File deleted.");
      setTimeout(() => setFeedback(""), 3000);
    } catch (error) {
      setFeedback((error as Error).message || "Failed to delete file.");
    } finally {
      setDeletingFile(false);
    }
  }, [activeFile, activeProject, deleteFileTarget, refreshProjectData, requestPageChange]);

  const hasScheduleItems = useMemo(
    () => projectItems.some((item) => item.source === "schedule"),
    [projectItems]
  );

  const handleRetryFile = useCallback(
    async (file: ProjectFile) => {
      if (!activeProject) return;
      if (file.fileType === "drawing" && !hasScheduleItems) {
        setFeedback("Upload and process schedule files before retrying drawings.");
        return;
      }
      setRetryingFileId(file.id);
      try {
        await retryProjectFile(activeProject.id, file.id, uuidv4());
      } catch (error) {
        setFeedback((error as Error).message || "Failed to retry extraction.");
      } finally {
        setRetryingFileId(null);
      }
    },
    [activeProject, hasScheduleItems]
  );

  const handleStartExtraction = useCallback(async () => {
    if (!activeProject) return;
    if (drawings.length === 0 && scheduleFiles.length === 0 && !boqFile) {
      setFeedback("Please upload drawings, schedule files, or a BOQ file.");
      return;
    }
    setPageLoadingMessage("Preparing extraction…");
    try {
      const trimmedName = projectNameInput.trim();
      if (trimmedName && trimmedName !== activeProject.name) {
        const updated = await updateProjectName(activeProject.id, trimmedName);
        setActiveProject(updated);
      }
      const uploaded = await uploadProjectFiles(activeProject.id, drawings, scheduleFiles, boqFile);
      const uploadedIds = uploaded.files.map((file) => file.id);
      await startProjectExtraction(activeProject.id, uuidv4(), uploadedIds);
      requestPageChange("extract");
      setMaxStepReached(1);
      await refreshProjectData(activeProject.id);
    } catch (error) {
      setFeedback((error as Error).message || "Failed to start extraction.");
    } finally {
      setPageLoadingMessage(null);
    }
  }, [activeProject, boqFile, drawings, scheduleFiles, projectNameInput, refreshProjectData, requestPageChange]);

  const toggleAccordion = useCallback((key: ReviewAccordionKey) => {
    setOpenAccordions((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleOpenFile = useCallback(async (file: ProjectFile) => {
    if (!activeProject) return;
    setPageLoadingMessage("Opening file…");
    setActiveFile(file);
    requestPageChange(
      file.fileType === "drawing"
        ? "file-review"
        : file.fileType === "schedule"
          ? "schedule-review"
          : "boq-review"
    );
    try {
      const items = await listProjectFileItems(activeProject.id, file.id);
      setFileItems(items);
      setFileItemsSnapshot(items);
    } catch (error) {
      setFeedback((error as Error).message || "Failed to load file items.");
    } finally {
      setPageLoadingMessage(null);
    }
  }, [activeProject, requestPageChange]);

  const handleEditItem = useCallback((item: ProjectItem) => {
    setEditingItemId(item.id);
    setItemDrafts((prev) => ({
      ...prev,
      [item.id]: {
        item_code: item.item_code ?? "",
        description: item.description ?? "",
        notes: item.notes ?? "",
      },
    }));
  }, []);

  const handleItemDraftChange = useCallback(
    (itemId: string, field: "item_code" | "description" | "notes", value: string) => {
      setItemDrafts((prev) => ({
        ...prev,
        [itemId]: {
          ...prev[itemId],
          [field]: value,
        },
      }));
    },
    []
  );

  const handleCancelEditItem = useCallback((itemId: string) => {
    setItemDrafts((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
    setEditingItemId(null);
  }, []);

  const handleSaveItem = useCallback(
    async (itemId: string) => {
      if (!activeProject) return;
      const draft = itemDrafts[itemId];
      if (!draft) return;
      setSavingItemId(itemId);
      try {
        const updated = await updateProjectItem(activeProject.id, itemId, draft);
        setProjectItems((prev) =>
          prev.map((item) =>
            item.id === itemId
              ? { ...item, item_code: updated.item_code, description: updated.description, notes: updated.notes, box: updated.box ?? item.box }
              : item
          )
        );
        handleCancelEditItem(itemId);
      } catch (error) {
        setFeedback((error as Error).message || "Failed to update item.");
      } finally {
        setSavingItemId(null);
      }
    },
    [activeProject, handleCancelEditItem, itemDrafts]
  );

  const handleDeleteItem = useCallback(async () => {
    if (!activeProject || !deleteItemTarget) return;
    setDeletingItemId(deleteItemTarget.id);
    try {
      await removeProjectItem(activeProject.id, deleteItemTarget.id);
      setProjectItems((prev) => prev.filter((item) => item.id !== deleteItemTarget.id));
      setDeleteItemTarget(null);
    } catch (error) {
      setFeedback((error as Error).message || "Failed to delete item.");
    } finally {
      setDeletingItemId(null);
    }
  }, [activeProject, deleteItemTarget]);

  const handleSaveFileItems = useCallback(
    async (items: EditableProjectItem[]) => {
      if (!activeProject || !activeFile) return;

      const snapshotById = new Map(fileItemsSnapshot.map((item) => [item.id, item]));
      const currentIds = new Set(items.map((item) => item.id));

      const updates = items.filter((item) => snapshotById.has(item.id));
      const creates = items.filter((item) => !snapshotById.has(item.id) || item.id.startsWith("new-"));
      const deletes = fileItemsSnapshot.filter((item) => !currentIds.has(item.id));

      await Promise.all(
        deletes.map((item) => removeProjectItem(activeProject.id, item.id))
      );

      await Promise.all(
        updates.map((item) => {
          const existing = snapshotById.get(item.id);
          if (!existing) return Promise.resolve();
          const boxChanged =
            JSON.stringify(existing.box ?? null) !== JSON.stringify(item.box ?? null);
          const metadataChanged =
            JSON.stringify(existing.metadata ?? null) !== JSON.stringify(item.metadata ?? null);
          const changed =
            existing.item_code !== item.item_code ||
            existing.description !== item.description ||
            existing.notes !== item.notes ||
            boxChanged ||
            metadataChanged;
          if (!changed) return Promise.resolve();
          return updateProjectItem(activeProject.id, item.id, {
            item_code: item.item_code,
            description: item.description,
            notes: item.notes,
            box: item.box ?? null,
            metadata: item.metadata ?? null,
          });
        })
      );

      await Promise.all(
        creates.map((item) =>
          addProjectFileItem(activeProject.id, activeFile.id, {
            item_code: item.item_code || "NOTE",
            description: item.description || "N/A",
            notes: item.notes || "N/A",
            box: item.box ?? null,
            metadata: item.metadata ?? null,
          })
        )
      );

      const [itemsForFile, itemsForProject] = await Promise.all([
        listProjectFileItems(activeProject.id, activeFile.id),
        listProjectItems(activeProject.id),
      ]);
      setFileItems(itemsForFile);
      setFileItemsSnapshot(itemsForFile);
      setProjectItems(itemsForProject);
      setFeedback("File items saved.");
      setTimeout(() => setFeedback(""), 3000);
    },
    [activeFile, activeProject, fileItemsSnapshot]
  );

  const workflowSteps = useMemo(
    () => [
      { id: "upload", label: "Upload", description: "Drawings & BOQ" },
      { id: "review", label: "Review", description: "Check items" },
      { id: "compare", label: "Compare", description: "BOQ vs drawings" },
      { id: "finalize", label: "Finalize", description: "Manual edits" },
      { id: "pricing", label: "Pricing", description: "Review prices" },
      { id: "estimation", label: "Estimation", description: "Generate estimate" },
    ],
    []
  );
  const [maxStepReached, setMaxStepReached] = useState(0);

  const currentStepId = useMemo(() => {
    if (activePage === "upload") return "upload";
    if (activePage === "extract") return "review";
    if (activePage === "file-review") return "review";
    if (activePage === "schedule-review") return "review";
    if (activePage === "boq-review") return "review";
    if (activePage === "compare") return "compare";
    if (activePage === "finalize") return "finalize";
    if (activePage === "pricing") return "pricing";
    return null;
  }, [activePage]);

  const activeStepIndex = useMemo(() => {
    if (!currentStepId) return -1;
    const index = workflowSteps.findIndex((step) => step.id === currentStepId);
    return index >= 0 ? index : -1;
  }, [currentStepId, workflowSteps]);

  useEffect(() => {
    if (activeStepIndex >= 0) {
      setMaxStepReached((prev) => Math.max(prev, activeStepIndex));
    }
  }, [activeStepIndex]);

  const stepPageMap: Partial<Record<string, AppPage>> = {
    upload: "upload",
    review: "extract",
    compare: "compare",
    finalize: "finalize",
    pricing: "pricing",
  };

  useEffect(() => {
    if (!activeProject || didRestoreStepRef.current) return;
    const storedStep = localStorage.getItem(`project:${activeProject.id}:lastStep`);
    const targetPage = storedStep ? stepPageMap[storedStep] : null;
    if (targetPage) {
      setActivePage(targetPage);
    }
    didRestoreStepRef.current = true;
  }, [activeProject, stepPageMap]);

  useEffect(() => {
    if (!activeProject || !currentStepId) return;
    localStorage.setItem(`project:${activeProject.id}:lastStep`, currentStepId);
  }, [activeProject, currentStepId]);

  const renderStepper = () => (
    <div className={`stepper ${isSidebarOpen ? "stepper--compact" : "stepper--wide"}`}>
      {workflowSteps.map((step, index) => {
        const isCurrent = step.id === currentStepId;
        const isComplete = maxStepReached > index;
        const targetPage = stepPageMap[step.id];
        const isDisabled = !targetPage || index > maxStepReached;
        const isClickable = !isDisabled && index !== activeStepIndex;
        return (
          <div key={step.id} className="stepper__segment">
            <button
              type="button"
              className={`stepper__item ${isCurrent ? "stepper__item--current" : ""} ${isComplete ? "stepper__item--complete" : ""
                } ${isClickable ? "is-clickable" : ""} ${isDisabled ? "is-disabled" : ""}`}
              onClick={() => {
                if (isClickable && targetPage) {
                  requestPageChange(targetPage);
                }
              }}
              disabled={isDisabled}
            >
              <div className="stepper__meta">
                <span className="stepper__label">{step.label}</span>
                <span className="stepper__desc">{step.description}</span>
              </div>
            </button>
            {index < workflowSteps.length - 1 && (
              <span className={`stepper__connector ${isComplete ? "is-complete" : ""}`} />
            )}
          </div>
        );
      })}
    </div>
  );

  const projectStats = useMemo(() => {
    const total = projects.length;
    const inProgress = projects.filter((p) => p.status === "in_progress").length;
    const analyzing = projects.filter((p) => p.status === "analyzing").length;
    const finalized = projects.filter((p) => p.status === "finalized").length;
    return { total, inProgress, analyzing, finalized };
  }, [projects]);
  const recentProject = useMemo(() => projects[0] ?? null, [projects]);

  const renderProjectStatus = (status: ProjectSummary["status"]) => (
    <span className="status-inline">
      {status === "analyzing" && <span className="status-spinner" aria-hidden="true" />}
      {PROJECT_STATUS_LABELS[status]}
    </span>
  );

  const renderFileStatus = (status: ProjectFile["status"]) => (
    <span className="status-inline">
      {status === "processing" && <span className="status-spinner" aria-hidden="true" />}
      {FILE_STATUS_LABELS[status]}
    </span>
  );


  const cadReviewItems: CadItemWithId[] = fileItems.map((item) => ({
    id: item.id,
    item_code: item.item_code,
    description: item.description,
    notes: item.notes,
    box: item.box ?? { left: 0, top: 0, right: 0, bottom: 0 },
  }));

  const drawingItems = useMemo(
    () => projectItems.filter((item) => item.source === "cad"),
    [projectItems]
  );
  const scheduleItems = useMemo(
    () => projectItems.filter((item) => item.source === "schedule"),
    [projectItems]
  );
  const boqItems = useMemo(
    () => projectItems.filter((item) => item.source === "boq"),
    [projectItems]
  );
  useEffect(() => {
    if (!activeProject) return;
    let reached = 0;
    if (projectFiles.length > 0) reached = Math.max(reached, 1);
    const hasBoq = boqItems.length > 0;
    const hasDrawing = drawingItems.length > 0;
    const hasSchedule = scheduleItems.length > 0;
    if (hasBoq && (hasDrawing || hasSchedule)) reached = Math.max(reached, 2);
    if (projectItems.length > 0) reached = Math.max(reached, 3);
    if (activePricingCache) reached = Math.max(reached, 4);
    setMaxStepReached((prev) => Math.max(prev, reached));
  }, [activeProject, projectFiles.length, boqItems.length, drawingItems.length, scheduleItems.length, projectItems.length, activePricingCache]);
  const drawingTabs = useMemo(() => {
    const drawingFiles = projectFiles.filter((file) => file.fileType === "drawing");
    return [
      { id: "all", label: "All Drawings" },
      ...drawingFiles.map((file) => ({ id: file.id, label: file.fileName })),
    ];
  }, [projectFiles]);
  const scheduleTabs = useMemo(() => {
    const scheduleFiles = projectFiles.filter((file) => file.fileType === "schedule");
    return [
      { id: "all", label: "All Schedule" },
      ...scheduleFiles.map((file) => ({ id: file.id, label: file.fileName })),
    ];
  }, [projectFiles]);
  const activeDrawingTabId = drawingTabs.some((tab) => tab.id === activeDrawingTab) ? activeDrawingTab : "all";
  const activeScheduleTabId = scheduleTabs.some((tab) => tab.id === activeScheduleTab) ? activeScheduleTab : "all";
  const filteredDrawingItems = useMemo(
    () => (activeDrawingTabId === "all" ? drawingItems : drawingItems.filter((item) => item.fileId === activeDrawingTabId)),
    [activeDrawingTabId, drawingItems]
  );
  const groupedDrawingItems = useMemo(() => {
    const groups = new Map<string, ProjectItem[]>();
    filteredDrawingItems.forEach((item) => {
      const key = (item.item_code || "ITEM").trim() || "ITEM";
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    });
    return Array.from(groups.entries());
  }, [filteredDrawingItems]);
  const filteredScheduleItems = useMemo(
    () => (activeScheduleTabId === "all" ? scheduleItems : scheduleItems.filter((item) => item.fileId === activeScheduleTabId)),
    [activeScheduleTabId, scheduleItems]
  );
  const boqTabs = useMemo(() => {
    const sheetNames = Array.from(
      new Set(boqItems.map((item) => item.metadata?.sheetName).filter(Boolean))
    ) as string[];
    return [
      { id: "all", label: "All BOQ" },
      ...sheetNames.map((sheet) => ({ id: `sheet:${sheet}`, label: sheet })),
    ];
  }, [boqItems]);
  const activeBoqTabId = boqTabs.some((tab) => tab.id === activeBoqTab) ? activeBoqTab : "all";
  const filteredBoqItems = useMemo(() => {
    const items =
      activeBoqTabId === "all"
        ? boqItems
        : boqItems.filter((item) => item.metadata?.sheetName === activeBoqTabId.replace(/^sheet:/, ""));
    const isAll = activeBoqTabId === "all";
    return [...items].sort((a, b) => {
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
  }, [activeBoqTabId, boqItems]);
  const filteredBoqItemCount = useMemo(
    () =>
      filteredBoqItems.filter((item) => {
        const code = String(item.item_code ?? "").trim();
        return code !== "" && !isItemPlaceholder(code);
      }).length,
    [filteredBoqItems]
  );
  const boqColumns = useMemo(() => ["Item", "Description", "QTY", "Unit", "Rate"], []);
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
    return "—";
  };
  const scheduleColumns = useMemo(() => {
    const columns: string[] = [];
    const seen = new Set<string>();
    filteredScheduleItems.forEach((item) => {
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
  }, [filteredScheduleItems]);
  const getScheduleCellValue = (item: ProjectItem, column: string) => {
    const fields = item.metadata?.fields ?? {};
    const direct = fields[column];
    if (direct && String(direct).trim() !== "") return String(direct);
    const key = normalizeColumn(column);
    if (key === "item") return item.item_code;
    if (key === "description") return item.description;
    if (key === "notes") return item.notes;
    return "—";
  };

  return (
    <div className={`app-shell ${isSidebarOpen ? "sidebar-open" : "sidebar-collapsed"}`}>
      <aside className="sidebar">
        <button
          type="button"
          className="brand"
          onClick={() => requestPageChange("home")}
          aria-label="Go to home"
        >
          <div className="brand__icon">
            <img
              src="/logo2.png"
              alt="Logo"
              style={{ width: "34px", height: "34px", objectFit: "contain" }}
            />
          </div>
          <div>
            <p className="brand__title">AI Powered Estimation System</p>
          </div>
        </button>

        <nav className="sidebar__nav">
          <button
            type="button"
            className="nav-link is-active"
            onClick={() => requestPageChange("home")}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M3 9.5l7-6 7 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 8.5v7h10v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>Home</span>
          </button>
          <button
            type="button"
            className={`nav-link ${activePage === "projects" ? "is-active" : ""}`}
            onClick={() => requestPageChange("projects")}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M4 5h12M4 10h12M4 15h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>Projects</span>
          </button>
          <button
            type="button"
            className={`nav-link ${activePage === "productivity-rates" ? "is-active" : ""}`}
            onClick={() => requestPageChange("productivity-rates")}
            title="Manage productivity rates"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M4 14h12M6 10h8M8 6h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>Productivity Rates</span>
          </button>
        </nav>

        <div className="sidebar__bottom">
          <div className="sidebar__footer">
            <p className="eyebrow" style={{ marginBottom: "0.25rem" }}>Active Project</p>
            <p className="status" style={{ margin: 0 }}>
              {activeProject ? activeProject.name : "None"}
            </p>
          </div>

          <div
            role="button"
            tabIndex={0}
            className="sidebar-toggle sidebar-toggle--icon"
            onClick={() => setIsSidebarOpen(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                setIsSidebarOpen(false);
              }
            }}
            aria-label="Collapse sidebar"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path d="M12 5l-5 5 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </aside>

      {!isSidebarOpen && (
        <div
          role="button"
          tabIndex={0}
          className="sidebar-toggle sidebar-toggle--floating sidebar-toggle--icon"
          onClick={() => setIsSidebarOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              setIsSidebarOpen(true);
            }
          }}
          aria-label="Expand sidebar"
        >
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
            <path d="M8 5l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}

      <main
        className="content"
        style={
          activePage === "file-review" || activePage === "schedule-review"
            ? { padding: 0, maxWidth: "none", height: "100vh", overflow: "hidden" }
            : undefined
        }
      >
        {(openingProject || pageLoadingMessage) && (
          <div className="processing-overlay">
            <div className="processing-indicator">
              <div className="processing-indicator__spinner">
                <svg width="40" height="40" viewBox="0 0 40 40" className="spinner">
                  <circle
                    cx="20"
                    cy="20"
                    r="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeDasharray="80"
                    strokeDashoffset="20"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <div className="processing-indicator__text">
                <p className="processing-indicator__message">
                  {openingProject ? "Opening project…" : pageLoadingMessage}
                </p>
              </div>
            </div>
          </div>
        )}
        {feedback && <p className="feedback">{feedback}</p>}

        {(activePage === "projects" || activePage === "home") && (
          <section className="panel">
            <div className="panel__header dashboard-header">
              <div>
                <p className="eyebrow">Welcome back</p>
                <h2>Projects Dashboard</h2>
                <p className="dashboard-subtitle">
                  Track active estimation projects and jump back in where you left off.
                </p>
              </div>
              <div className="dashboard-actions">
                <button type="button" className="btn-secondary" onClick={() => void refreshProjects()}>
                  Refresh
                </button>
              </div>
            </div>
            <div className="panel__body">
              <div className="dashboard-grid">
                <div className="stat-card dashboard-card">
                  <div className="stat-card__content">
                    <p className="stat-card__label">Total Projects</p>
                    <span className="stat-card__value">{projectStats.total}</span>
                  </div>
                </div>
                <div className="stat-card dashboard-card">
                  <div className="stat-card__content">
                    <p className="stat-card__label">In Progess</p>
                    <span className="stat-card__value">{projectStats.inProgress}</span>
                  </div>
                </div>
                <div className="stat-card dashboard-card">
                  <div className="stat-card__content">
                    <p className="stat-card__label">Analysing Files</p>
                    <span className="stat-card__value">{projectStats.analyzing}</span>
                  </div>
                </div>
                <div className="stat-card dashboard-card">
                  <div className="stat-card__content">
                    <p className="stat-card__label">Extraction Ready</p>
                    <span className="stat-card__value">{projectStats.finalized}</span>
                  </div>
                </div>
              </div>

              <div className="dashboard-split">
                <div className="dashboard-panel dashboard-panel--equal">
                  <h3>Quick Actions</h3>
                  <p className="dashboard-muted">Start new projects or revisit existing work.</p>
                  <div className="dashboard-action-list">
                    <button type="button" className="btn-match" onClick={() => void handleNewProject()}>
                      Start New Project
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => requestPageChange("extract")} disabled={!activeProject}>
                      Resume Active Project
                    </button>
                  </div>
                </div>

                <div className="dashboard-panel dashboard-panel--equal">
                  <h3>Recent Project</h3>
                  <p className="dashboard-muted">Most recently updated project.</p>
                  {!recentProject ? (
                    <p className="empty-state">No projects yet. Create one to get started.</p>
                  ) : (
                    <button
                      type="button"
                      className="dashboard-list__item dashboard-list__item--single"
                      onClick={() => void handleOpenProject(recentProject)}
                    >
                      <div>
                        <p className="dashboard-list__title">{recentProject.name}</p>
                        <p className="dashboard-list__meta">
                          Updated {new Date(recentProject.updatedAt).toLocaleDateString()}
                        </p>
                      </div>
                      <span className={`status-chip status-chip--${recentProject.status}`}>
                        {renderProjectStatus(recentProject.status)}
                      </span>
                    </button>
                  )}
                </div>
              </div>

              {projectsLoading ? (
                <p className="loading-text">Loading projects...</p>
              ) : projects.length === 0 ? (
                <p className="empty-state">No projects yet. Create one to get started.</p>
              ) : (
                <div className="table-wrapper dashboard-table">
                  <div className="dashboard-table__header">
                    <h3>All Projects</h3>
                    <p className="dashboard-muted">Manage and open any project from the list below.</p>
                  </div>
                  <table className="kb-table">
                    <thead>
                      <tr>
                        <th>No</th>
                        <th>Project Name</th>
                        <th>Created Date</th>
                        <th>Status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {projects.map((project, index) => (
                        <tr key={project.id} className="kb-table__row">
                          <td>{renderCell(index + 1)}</td>
                          <td className="kb-table__filename">{renderCell(project.name)}</td>
                          <td className="kb-table__date">{renderCell(new Date(project.createdAt).toLocaleString())}</td>
                          <td>{renderProjectStatus(project.status)}</td>
                          <td>
                            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                              <button type="button" className="btn-secondary" onClick={() => void handleOpenProject(project)}>
                                Open Project
                              </button>
                              <button type="button" className="btn-secondary" onClick={() => setDeleteTarget(project)}>
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        )}

        {activePage === "productivity-rates" && (
          <ProductivityRates projectName={activeProject?.name} />
        )}

        {activePage === "pricing" && (
          <Pricing
            boqItems={boqItems}
            scheduleItems={scheduleItems}
            drawingItems={drawingItems}
            projectName={activeProject?.name}
            projectId={activeProject?.id}
            headerTop={renderStepper()}
            initialPricing={activePricingCache}
            onPricingLoaded={(payload) => {
              if (!activeProject) return;
              setPricingCacheByProject((prev) => ({ ...prev, [activeProject.id]: payload }));
            }}
            onDirtyChange={(dirty) => setPricingDirty(dirty)}
            onRegisterSave={(save) => {
              pricingSaveRef.current = save;
            }}
          />
        )}

        {activePage === "upload" && activeProject && (
          <section className="panel">
            <div className="panel__header">
              <div className="stepper-container">
                {renderStepper()}
                <h2 style={{ marginTop: "0.5rem" }}>Upload Drawings, Schedule & BOQ</h2>
              </div>
            </div>
            <div className="panel__body">
              <div className="panel__form" style={{ marginBottom: "1rem" }}>
                <label>
                  Project Name
                  <input
                    type="text"
                    value={projectNameInput}
                    placeholder="Enter project name"
                    className="project-name-input"
                    onChange={(event) => setProjectNameInput(event.target.value)}
                    onBlur={async () => {
                      if (!activeProject) return;
                      const trimmedName = projectNameInput.trim();
                      if (trimmedName && trimmedName !== activeProject.name) {
                        try {
                          const updated = await updateProjectName(activeProject.id, trimmedName);
                          setActiveProject(updated);
                        } catch (error) {
                          setFeedback((error as Error).message || "Failed to update project name.");
                        }
                      }
                    }}
                  />
                </label>
              </div>
              <div className="uploaders-grid">
                <label className="dropzone dropzone--estimate uploader-card">
                  <input
                    type="file"
                    multiple
                    accept=".pdf,.png,.jpg,.jpeg,.webp"
                    onChange={(event) => setDrawings(Array.from(event.target.files ?? []))}
                  />
                  <div className="dropzone__content">
                    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="dropzone__icon">
                      <path d="M24 16v16M16 24h16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      <rect x="8" y="8" width="32" height="32" rx="4" stroke="currentColor" strokeWidth="2" />
                    </svg>
                    <p className="dropzone__text">
                      {drawings.length > 0 ? `${drawings.length} drawing(s) selected` : "Upload drawings (multiple)"}
                    </p>
                    <p className="dropzone__hint">PDF or image files.</p>
                  </div>
                </label>
                <label className="dropzone dropzone--estimate uploader-card">
                  <input
                    type="file"
                    multiple
                    accept=".pdf,.xlsx,.xls,.csv,.docx,.txt"
                    onChange={(event) => setScheduleFiles(Array.from(event.target.files ?? []))}
                  />
                  <div className="dropzone__content">
                    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="dropzone__icon">
                      <path d="M24 16v16M16 24h16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      <rect x="8" y="8" width="32" height="32" rx="4" stroke="currentColor" strokeWidth="2" />
                    </svg>
                    <p className="dropzone__text">
                      {scheduleFiles.length > 0 ? `${scheduleFiles.length} schedule file(s) selected` : "Upload schedule files (multiple)"}
                    </p>
                    <p className="dropzone__hint">PDF, Excel, Word, or text.</p>
                  </div>
                </label>
                <label className="dropzone dropzone--estimate uploader-card">
                  <input
                    type="file"
                    accept=".pdf,.xlsx,.xls,.csv"
                    onChange={(event) => setBoqFile(event.target.files?.[0] ?? null)}
                  />
                  <div className="dropzone__content">
                    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="dropzone__icon">
                      <path d="M24 16v16M16 24h16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      <rect x="8" y="8" width="32" height="32" rx="4" stroke="currentColor" strokeWidth="2" />
                    </svg>
                    <p className="dropzone__text">
                      {boqFile ? `Selected: ${boqFile.name}` : "Upload BOQ (single file)"}
                    </p>
                    <p className="dropzone__hint">PDF, Excel, or CSV.</p>
                  </div>
                </label>
              </div>
              <div className="upload-actions">
                <button type="button" className="btn-match" onClick={() => void handleStartExtraction()}>
                  Start
                </button>
              </div>
            </div>
          </section>
        )}

        {activePage === "extract" && activeProject && (
          <section className="panel">
            <div className="panel__header panel__header--review">
              <div className="stepper-container">
                {renderStepper()}
                <h2 style={{ marginTop: "0.5rem" }}>Review Files and Extractions</h2>
              </div>
            </div>
            <div className="panel__body">
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                <button
                  type="button"
                  className="btn-secondary btn-compact btn-muted"
                  onClick={() => {
                    setCompareForceNextRun(true);
                    requestPageChange("compare");
                  }}
                >
                  Go to Compare
                </button>
              </div>
              {notifications.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "1rem" }}>
                  {notifications.map((note) => (
                    <div key={note.id} className="status" style={{ padding: "0.5rem 0.75rem", background: "rgba(114,252,209,0.08)" }}>
                      {note.message}
                    </div>
                  ))}
                </div>
              )}
              <div className="pricing-accordion pricing-accordion--review">
                <div className={`pricing-accordion__card ${openAccordions.projectFiles ? "is-open" : ""}`}>
                  <button
                    type="button"
                    className="pricing-accordion__header"
                    onClick={() => toggleAccordion("projectFiles")}
                    aria-expanded={openAccordions.projectFiles}
                    aria-controls="review-project-files-panel"
                  >
                    <div>
                      <h3 style={{ margin: 0 }}>Project Files</h3>
                      <span className="eyebrow">{projectFiles.length} file(s)</span>
                    </div>
                    <svg
                      className={`pricing-accordion__chevron ${openAccordions.projectFiles ? "is-open" : ""}`}
                      width="20"
                      height="20"
                      viewBox="0 0 20 20"
                      aria-hidden="true"
                    >
                      <path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                  {openAccordions.projectFiles && (
                    <div className="pricing-accordion__panel" id="review-project-files-panel">
                      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.75rem" }}>
                        <button
                          type="button"
                          className="btn-secondary btn-compact btn-muted"
                          onClick={() => setAddFilesOpen(true)}
                        >
                          Add More Files
                        </button>
                      </div>
                      <div className="table-wrapper" style={{ margin: 0, maxWidth: "100%", maxHeight: "320px" }}>
                        <table className="kb-table">
                          <thead>
                            <tr>
                              <th>No</th>
                              <th>File Name</th>
                              <th>Type</th>
                              <th>Status</th>
                              <th>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {projectFiles.length === 0 ? (
                              <tr className="kb-table__row">
                                <td colSpan={5} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>
                                  No files uploaded yet.
                                </td>
                              </tr>
                            ) : (
                              projectFiles.map((file) => (
                                <tr key={file.id} className="kb-table__row">
                                  <td>{renderCell(file.fileNo)}</td>
                                  <td className="kb-table__filename">{renderCell(file.fileName)}</td>
                                  <td>{renderCell(file.fileType)}</td>
                                  <td>{renderFileStatus(file.status)}</td>
                                  <td>
                                    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                                      <button type="button" className="btn-secondary" onClick={() => void handleOpenFile(file)}>
                                        Go to File
                                      </button>
                                      {file.status === "failed" && (
                                        <button
                                          type="button"
                                          className="btn-secondary"
                                          onClick={() => void handleRetryFile(file)}
                                          disabled={retryingFileId === file.id}
                                        >
                                          {retryingFileId === file.id ? "Retrying…" : "Retry"}
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        className="btn-secondary"
                                        onClick={() => setDeleteFileTarget(file)}
                                        disabled={deletingFile && deleteFileTarget?.id === file.id}
                                      >
                                        {deletingFile && deleteFileTarget?.id === file.id ? "Deleting…" : "Delete"}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>

                <div className={`pricing-accordion__card ${openAccordions.boq ? "is-open" : ""}`}>
                  <button
                    type="button"
                    className="pricing-accordion__header"
                    onClick={() => toggleAccordion("boq")}
                    aria-expanded={openAccordions.boq}
                    aria-controls="review-boq-panel"
                  >
                    <div>
                      <h3 style={{ margin: 0 }}>BOQ Items</h3>
                      <span className="eyebrow">{filteredBoqItemCount} item(s)</span>
                    </div>
                    <svg
                      className={`pricing-accordion__chevron ${openAccordions.boq ? "is-open" : ""}`}
                      width="20"
                      height="20"
                      viewBox="0 0 20 20"
                      aria-hidden="true"
                    >
                      <path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                  {openAccordions.boq && (
                    <div className="pricing-accordion__panel" id="review-boq-panel">
                      {boqItems.length === 0 ? (
                        <div className="status" style={{ padding: "0.75rem", background: "rgba(255,255,255,0.04)" }}>
                          No BOQ items extracted yet.
                        </div>
                      ) : (
                        <div>
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
                          <div className="table-wrapper items-table-scroll" style={{ margin: 0 }}>
                            <table className="matches-table boq-table">
                              <thead>
                                <tr>
                                  {boqColumns.map((col) => (
                                    <th key={col}>{col}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {filteredBoqItems.length === 0 ? (
                                  <tr className="matches-table__row">
                                    <td colSpan={boqColumns.length} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>
                                      No items for this sheet.
                                    </td>
                                  </tr>
                                ) : (() => {
                                  const rows: ReactNode[] = [];
                                  let lastCategory = "";
                                  let lastSubcategory = "";
                                  filteredBoqItems.forEach((item) => {
                                    const category = item.metadata?.category || "Uncategorized";
                                    const subcategory = item.metadata?.subcategory || "";
                                    if (category !== lastCategory) {
                                      rows.push(
                                        <tr key={`cat-${category}-${item.id}`} className="boq-group-row">
                                          <td colSpan={boqColumns.length}>{category}</td>
                                        </tr>
                                      );
                                      lastCategory = category;
                                      lastSubcategory = "";
                                    }
                                    if (subcategory && subcategory !== lastSubcategory) {
                                      rows.push(
                                        <tr key={`sub-${category}-${subcategory}-${item.id}`} className="boq-subgroup-row">
                                          <td colSpan={boqColumns.length}>{subcategory}</td>
                                        </tr>
                                      );
                                      lastSubcategory = subcategory;
                                    }
                                    const itemCode = (item.item_code ?? "").trim();
                                    const highlightItemCode = /^[A-Z]$/.test(itemCode);
                                    const hideNonDescription = isItemPlaceholder(item.item_code);
                                    const rateValue = String(getBoqCellValue(item, "Rate") ?? "").trim();
                                    const isRateOnly = rateValue.toLowerCase() === "rate only";
                                    rows.push(
                                      <tr
                                        key={item.id}
                                        className={`matches-table__row${isRateOnly ? " matches-table__row--rate-only" : ""}`}
                                        style={highlightItemCode ? { color: "#72fcd1" } : undefined}
                                      >
                                        {boqColumns.map((col) => (
                                          <td key={`${item.id}-${col}`}>
                                            {(() => {
                                              const normalizedCol = normalizeColumn(col);
                                              if (normalizedCol === "description") {
                                                return renderCell(getBoqCellValue(item, col));
                                              }
                                              if (hideNonDescription) {
                                                return renderEmptyCell();
                                              }
                                              if (normalizedCol === "item") {
                                                return renderItemCodeCell(item.item_code);
                                              }
                                              return renderCell(getBoqCellValue(item, col));
                                            })()}
                                          </td>
                                        ))}
                                      </tr>
                                    );
                                  });
                                  return rows;
                                })()}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className={`pricing-accordion__card ${openAccordions.schedule ? "is-open" : ""}`}>
                  <button
                    type="button"
                    className="pricing-accordion__header"
                    onClick={() => toggleAccordion("schedule")}
                    aria-expanded={openAccordions.schedule}
                    aria-controls="review-schedule-panel"
                  >
                    <div>
                      <h3 style={{ margin: 0 }}>Schedule Items</h3>
                      <span className="eyebrow">{scheduleItems.length} item(s)</span>
                    </div>
                    <svg
                      className={`pricing-accordion__chevron ${openAccordions.schedule ? "is-open" : ""}`}
                      width="20"
                      height="20"
                      viewBox="0 0 20 20"
                      aria-hidden="true"
                    >
                      <path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                  {openAccordions.schedule && (
                    <div className="pricing-accordion__panel" id="review-schedule-panel">
                      {scheduleItems.length === 0 ? (
                        <div className="status" style={{ padding: "0.75rem", background: "rgba(255,255,255,0.04)" }}>
                          No schedule items extracted yet.
                        </div>
                      ) : (
                        <div>
                          <div className="tabs">
                            {scheduleTabs.map((tab) => (
                              <button
                                key={tab.id}
                                type="button"
                                className={`tab ${activeScheduleTabId === tab.id ? "is-active" : ""}`}
                                onClick={() => setActiveScheduleTab(tab.id)}
                              >
                                {tab.label}
                              </button>
                            ))}
                          </div>
                          <div className="table-wrapper items-table-scroll" style={{ margin: 0 }}>
                            <table className="matches-table boq-table">
                              <thead>
                                <tr>
                                  {scheduleColumns.map((col) => {
                                    const normalizedCol = normalizeColumn(col);
                                    const isCodeCol =
                                      normalizedCol === "code" || normalizedCol === "item code" || normalizedCol === "item";
                                    return (
                                      <th
                                        key={col}
                                        style={isCodeCol ? { minWidth: "140px" } : undefined}
                                      >
                                        {col}
                                      </th>
                                    );
                                  })}
                                </tr>
                              </thead>
                              <tbody>
                                {filteredScheduleItems.length === 0 ? (
                                  <tr className="matches-table__row">
                                    <td colSpan={scheduleColumns.length} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>
                                      No schedule items for this file.
                                    </td>
                                  </tr>
                                ) : (
                                  filteredScheduleItems.map((item) => (
                                    <tr key={item.id} className="matches-table__row">
                                      {scheduleColumns.map((col) => {
                                        const normalizedCol = normalizeColumn(col);
                                        const isCodeCol =
                                          normalizedCol === "code" || normalizedCol === "item code" || normalizedCol === "item";
                                        return (
                                          <td
                                            key={`${item.id}-${col}`}
                                            style={isCodeCol ? { minWidth: "140px" } : undefined}
                                          >
                                            {renderCell(getScheduleCellValue(item, col))}
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  ))
                                )}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className={`pricing-accordion__card ${openAccordions.drawings ? "is-open" : ""}`}>
                  <button
                    type="button"
                    className="pricing-accordion__header"
                    onClick={() => toggleAccordion("drawings")}
                    aria-expanded={openAccordions.drawings}
                    aria-controls="review-drawings-panel"
                  >
                    <div>
                      <h3 style={{ margin: 0 }}>Drawing Details</h3>
                      <span className="eyebrow">{drawingItems.length} item(s)</span>
                    </div>
                    <svg
                      className={`pricing-accordion__chevron ${openAccordions.drawings ? "is-open" : ""}`}
                      width="20"
                      height="20"
                      viewBox="0 0 20 20"
                      aria-hidden="true"
                    >
                      <path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                  {openAccordions.drawings && (
                    <div className="pricing-accordion__panel" id="review-drawings-panel">
                      <div className="tabs">
                        {drawingTabs.map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            className={`tab ${activeDrawingTabId === tab.id ? "is-active" : ""}`}
                            onClick={() => setActiveDrawingTab(tab.id)}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                      <div className="table-wrapper items-table-scroll" style={{ margin: 0 }}>
                        <table className="matches-table">
                          <thead>
                            <tr>
                              <th>File No</th>
                              <th>Item Code</th>
                              <th style={{ minWidth: "260px" }}>Description</th>
                              <th>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredDrawingItems.length === 0 ? (
                              <tr className="matches-table__row">
                                <td colSpan={4} style={{ textAlign: "center", color: "rgba(227,233,255,0.7)" }}>
                                  No drawing details extracted yet.
                                </td>
                              </tr>
                            ) : (
                              groupedDrawingItems.flatMap(([code, group]) => {
                                const groupRows: ReactNode[] = [
                                  (
                                    <tr key={`drawing-group-${code}`} className="boq-group-row">
                                      <td colSpan={4}>{code}</td>
                                    </tr>
                                  ),
                                ];
                                group.forEach((item) => {
                                  const isEditing = editingItemId === item.id;
                                  const draft = itemDrafts[item.id];
                                  const hideNonDescription = isItemPlaceholder(item.item_code);
                                  groupRows.push(
                                    <tr key={item.id} className="matches-table__row">
                                      <td>{hideNonDescription ? renderEmptyCell() : renderCell(item.fileNo)}</td>
                                      <td>
                                        {isEditing ? (
                                          <input
                                            type="text"
                                            value={draft?.item_code ?? ""}
                                            onChange={(event) => handleItemDraftChange(item.id, "item_code", event.target.value)}
                                          />
                                        ) : (
                                          hideNonDescription ? renderEmptyCell() : renderItemCodeCell(item.item_code)
                                        )}
                                      </td>
                                      <td>
                                        {isEditing ? (
                                          <input
                                            type="text"
                                            value={draft?.description ?? ""}
                                            onChange={(event) => handleItemDraftChange(item.id, "description", event.target.value)}
                                          />
                                        ) : (
                                          renderCell(item.description)
                                        )}
                                      </td>
                                      <td>
                                        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "nowrap", alignItems: "center" }}>
                                          {isEditing ? (
                                            <>
                                              <button
                                                type="button"
                                                className="btn-secondary btn-icon"
                                                onClick={() => void handleSaveItem(item.id)}
                                                disabled={savingItemId === item.id}
                                                aria-label="Save item"
                                                title="Save"
                                              >
                                                {savingItemId === item.id ? (
                                                  <svg viewBox="0 0 20 20" aria-hidden="true">
                                                    <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="40" strokeDashoffset="16" />
                                                  </svg>
                                                ) : (
                                                  <svg viewBox="0 0 20 20" aria-hidden="true">
                                                    <path d="M4 10l4 4 8-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                                  </svg>
                                                )}
                                              </button>
                                              <button
                                                type="button"
                                                className="btn-secondary btn-icon"
                                                onClick={() => handleCancelEditItem(item.id)}
                                                aria-label="Cancel edit"
                                                title="Cancel"
                                              >
                                                <svg viewBox="0 0 20 20" aria-hidden="true">
                                                  <path d="M5 5l10 10M15 5l-10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                                </svg>
                                              </button>
                                            </>
                                          ) : (
                                            <button
                                              type="button"
                                              className="btn-secondary btn-icon"
                                              onClick={() => handleEditItem(item)}
                                              aria-label="Edit item"
                                              title="Edit"
                                            >
                                              <svg viewBox="0 0 20 20" aria-hidden="true">
                                                <path d="M4 13.5V16h2.5L15 7.5 12.5 5 4 13.5z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                                                <path d="M11.5 6l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                              </svg>
                                            </button>
                                          )}
                                          <button
                                            type="button"
                                            className="btn-secondary btn-icon"
                                            onClick={() => setDeleteItemTarget(item)}
                                            disabled={deletingItemId === item.id}
                                            aria-label="Delete item"
                                            title="Delete"
                                          >
                                            {deletingItemId === item.id ? (
                                              <svg viewBox="0 0 20 20" aria-hidden="true">
                                                <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="40" strokeDashoffset="16" />
                                              </svg>
                                            ) : (
                                              <svg viewBox="0 0 20 20" aria-hidden="true">
                                                <path d="M6 6h8l-1 10H7L6 6z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                                                <path d="M4 6h12M8 6V4h4v2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                              </svg>
                                            )}
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                });
                                return groupRows;
                              })
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div style={{ marginTop: "1.5rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={{ marginTop: 0 }}>Processing Log</h3>
                  <span className={`log-status log-status--${streamStatus}`}>
                    {streamStatus === "connected"
                      ? "Live updates connected"
                      : streamStatus === "connecting"
                        ? "Connecting…"
                        : "Live updates unavailable"}
                  </span>
                </div>
                <div className="log-panel">
                  {projectLogs.length === 0 ? (
                    <div className="log-empty">No logs yet. Upload files to start extraction.</div>
                  ) : (
                    <ul className="log-list">
                      {projectLogs.map((log, index) => (
                        <li
                          key={log.id}
                          className={`log-item log-item--${log.level} ${index === 0 ? "log-item--latest" : ""}`}
                        >
                          <span className="log-time">
                            {new Date(log.createdAt).toLocaleTimeString()}
                          </span>
                          <span className="log-message">
                            {log.fileNo ? `[File ${log.fileNo}] ` : ""}
                            {log.message}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {activePage === "compare" && activeProject && (
          <ComparePage
            projectId={activeProject.id}
            onNext={() => requestPageChange("finalize")}
            headerTop={renderStepper()}
            forceRefresh={compareForceNextRun}
            onConsumeForce={() => setCompareForceNextRun(false)}
          />
        )}

        {activePage === "finalize" && activeProject && (
          <section className="panel">
            <div className="panel__header panel__header--review">
              <div className="stepper-container">
                {renderStepper()}
                <h2 style={{ marginTop: "0.5rem" }}>Finalize</h2>
              </div>
            </div>
            <div className="panel__body">
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                <button
                  type="button"
                  className="btn-secondary btn-compact btn-muted"
                  onClick={() => requestPageChange("pricing")}
                >
                  Go to Pricing
                </button>
              </div>
              <div className="status" style={{ padding: "0.75rem", background: "rgba(255,255,255,0.04)" }}>
                Finalize view will appear here once the draft is ready for manual edits.
              </div>
            </div>
          </section>
        )}

        {activePage === "file-review" && activeProject && activeFile && (
          <CadExtraction
            mode="review"
            fileUrl={activeFile.fileUrl}
            fileName={activeFile.fileName}
            items={cadReviewItems}
            onBack={() => requestPageChange("extract")}
            onSave={handleSaveFileItems}
          />
        )}

        {activePage === "schedule-review" && activeProject && activeFile && (
          <ScheduleFileReview
            fileUrl={activeFile.fileUrl}
            fileName={activeFile.fileName}
            items={fileItems}
            onBack={() => requestPageChange("extract")}
            onSave={handleSaveFileItems}
          />
        )}

        {activePage === "boq-review" && activeProject && activeFile && (
          <BoqFileReview
            fileName={activeFile.fileName}
            items={fileItems}
            onBack={() => requestPageChange("extract")}
            onSave={handleSaveFileItems}
          />
        )}

        {addFilesOpen && (
          <div className="modal-backdrop" role="presentation">
            <div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-files-title">
              <div className="modal__header">
                <h3 className="modal__title" id="add-files-title">Add Files</h3>
                <button type="button" className="modal__close" onClick={() => setAddFilesOpen(false)}>
                  ×
                </button>
              </div>
              <div className="modal__body">
                <div className="uploaders-grid uploaders-grid--horizontal">
                  <label className="dropzone dropzone--estimate uploader-card">
                    <input
                      type="file"
                      multiple
                      accept=".pdf,.png,.jpg,.jpeg,.webp"
                      onChange={(event) => setAddDrawings(Array.from(event.target.files ?? []))}
                    />
                    <div className="dropzone__content">
                      <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="dropzone__icon">
                        <path d="M24 16v16M16 24h16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                        <rect x="8" y="8" width="32" height="32" rx="4" stroke="currentColor" strokeWidth="2" />
                      </svg>
                      <p className="dropzone__text">
                        {addDrawings.length > 0 ? `${addDrawings.length} drawing(s) selected` : "Upload drawings (multiple)"}
                      </p>
                      <p className="dropzone__hint">PDF or image files.</p>
                    </div>
                  </label>
                  <label className="dropzone dropzone--estimate uploader-card">
                    <input
                      type="file"
                      multiple
                      accept=".pdf,.xlsx,.xls,.csv,.docx,.txt"
                      onChange={(event) => setAddSchedules(Array.from(event.target.files ?? []))}
                    />
                    <div className="dropzone__content">
                      <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="dropzone__icon">
                        <path d="M24 16v16M16 24h16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                        <rect x="8" y="8" width="32" height="32" rx="4" stroke="currentColor" strokeWidth="2" />
                      </svg>
                      <p className="dropzone__text">
                        {addSchedules.length > 0 ? `${addSchedules.length} schedule file(s) selected` : "Upload schedule files (multiple)"}
                      </p>
                      <p className="dropzone__hint">PDF, Excel, Word, or text.</p>
                    </div>
                  </label>
                  <label className="dropzone dropzone--estimate uploader-card">
                    <input
                      type="file"
                      accept=".pdf,.xlsx,.xls,.csv"
                      onChange={(event) => setAddBoq(event.target.files?.[0] ?? null)}
                    />
                    <div className="dropzone__content">
                      <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="dropzone__icon">
                        <path d="M24 16v16M16 24h16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                        <rect x="8" y="8" width="32" height="32" rx="4" stroke="currentColor" strokeWidth="2" />
                      </svg>
                      <p className="dropzone__text">
                        {addBoq ? `Selected: ${addBoq.name}` : "Upload BOQ (single file)"}
                      </p>
                      <p className="dropzone__hint">PDF, Excel, or CSV.</p>
                    </div>
                  </label>
                </div>
              </div>
              <div className="modal__footer">
                <button type="button" className="btn-secondary" onClick={() => setAddFilesOpen(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-match"
                  onClick={async () => {
                    if (!activeProject) return;
                    if (addDrawings.length === 0 && addSchedules.length === 0 && !addBoq) {
                      setFeedback("Please select files to add.");
                      return;
                    }
                    setPageLoadingMessage("Uploading files…");
                    try {
                      const uploaded = await uploadProjectFiles(activeProject.id, addDrawings, addSchedules, addBoq);
                      const uploadedIds = uploaded.files.map((file) => file.id);
                      await startProjectExtraction(activeProject.id, uuidv4(), uploadedIds);
                      setAddDrawings([]);
                      setAddSchedules([]);
                      setAddBoq(null);
                      setAddFilesOpen(false);
                      await refreshProjectData(activeProject.id);
                    } catch (error) {
                      setFeedback((error as Error).message || "Failed to upload additional files.");
                    } finally {
                      setPageLoadingMessage(null);
                    }
                  }}
                >
                  Upload & Extract
                </button>
              </div>
            </div>
          </div>
        )}

        {deleteFileTarget && (
          <div className="modal-backdrop" role="presentation">
            <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-file-title">
              <div className="modal__header">
                <h3 className="modal__title" id="delete-file-title">Delete File</h3>
                <button type="button" className="modal__close" onClick={() => setDeleteFileTarget(null)}>
                  ×
                </button>
              </div>
              <div className="modal__body">
                <p>Are you sure you want to delete “{deleteFileTarget.fileName}”?</p>
                <p className="dashboard-muted">This will remove the file and its extracted items.</p>
              </div>
              <div className="modal__footer">
                <button type="button" className="btn-secondary" onClick={() => setDeleteFileTarget(null)} disabled={deletingFile}>
                  Cancel
                </button>
                <button type="button" className="btn-match" onClick={() => void handleDeleteFile()} disabled={deletingFile}>
                  {deletingFile ? "Deleting…" : "Delete File"}
                </button>
              </div>
            </div>
          </div>
        )}

        {deleteItemTarget && (
          <div className="modal-backdrop" role="presentation">
            <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-item-title">
              <div className="modal__header">
                <h3 className="modal__title" id="delete-item-title">Delete Item</h3>
                <button type="button" className="modal__close" onClick={() => setDeleteItemTarget(null)}>
                  ×
                </button>
              </div>
              <div className="modal__body">
                <p>Are you sure you want to delete this item?</p>
                <p className="dashboard-muted">
                  {deleteItemTarget.item_code || "Item"} • {deleteItemTarget.description || "No description"}
                </p>
              </div>
              <div className="modal__footer">
                <button type="button" className="btn-secondary" onClick={() => setDeleteItemTarget(null)} disabled={deletingItemId === deleteItemTarget.id}>
                  Cancel
                </button>
                <button type="button" className="btn-match" onClick={() => void handleDeleteItem()} disabled={deletingItemId === deleteItemTarget.id}>
                  {deletingItemId === deleteItemTarget.id ? "Deleting…" : "Delete Item"}
                </button>
              </div>
            </div>
          </div>
        )}

        {deleteTarget && (
          <div className="modal-backdrop" role="presentation">
            <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-project-title">
              <div className="modal__header">
                <h3 className="modal__title" id="delete-project-title">Delete Project</h3>
                <button type="button" className="modal__close" onClick={() => setDeleteTarget(null)}>
                  ×
                </button>
              </div>
              <div className="modal__body">
                <p>Are you sure you want to delete “{deleteTarget.name}”?</p>
                <p className="dashboard-muted">This will remove all files, items, logs, and extraction jobs.</p>
              </div>
              <div className="modal__footer">
                <button type="button" className="btn-secondary" onClick={() => setDeleteTarget(null)} disabled={deletingProject}>
                  Cancel
                </button>
                <button type="button" className="btn-match" onClick={() => void handleDeleteProject()} disabled={deletingProject}>
                  {deletingProject ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}

        {unsavedDialogOpen && (
          <div className="modal-backdrop" role="presentation">
            <div className="modal" role="dialog" aria-modal="true" aria-labelledby="unsaved-changes-title">
              <div className="modal__header">
                <h3 className="modal__title" id="unsaved-changes-title">Unsaved Changes</h3>
                <button type="button" className="modal__close" onClick={handleUnsavedStay}>
                  ×
                </button>
              </div>
              <div className="modal__body">
                {unsavedDialogContext === "pricing" ? (
                  <p>You have unsaved pricing edits. Save before leaving?</p>
                ) : (
                  <p>You have unsaved changes. Do you want to leave without saving?</p>
                )}
              </div>
              <div className="modal__footer">
                <button type="button" className="btn-secondary" onClick={handleUnsavedStay}>
                  Stay
                </button>
                {unsavedDialogContext === "pricing" ? (
                  <>
                    <button type="button" className="btn-secondary" onClick={handleUnsavedDiscard}>
                      Discard
                    </button>
                    <button type="button" className="btn-match" onClick={() => void handleUnsavedSaveAndLeave()}>
                      Save & Leave
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn-match" onClick={handleUnsavedLeave}>
                    Leave
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
