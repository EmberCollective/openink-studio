import { useProjectFiles } from "./useProjectFiles";
import { WindowControls, dragWindow } from "./WindowControls";
import { useJogKeys } from "./useJogKeys";
import { ClipboardImport, type ClipboardFile } from "./ClipboardImport";
import { emptyPage, projectPages, type Project } from "./projectModel";
import { PageNavigation, type PageAddition } from "./PageNavigation";
import { PaperBackgroundWizard, type GuideEditorState } from "./PaperBackgroundWizard";
import { blankBackground, guideLineNumber, validTextSettings, type BackgroundPage, type GuideLine, type TextSettings } from "./paperModel";
import Toggle from "./Toggle";
import RegistrationHandles from "./RegistrationHandles";
import { RegistrationPanel, type RegistrationProfile, type RegistrationSetup } from "./RegistrationPanel";
import { identityRegistration, canvasToMachine, registrationMatrix, registrationScales, scaledRegistration, type Registration } from "./coordinateGeometry";
import { ensureStrokeIds, unwrittenDocument, completedStrokeIds, resetWrittenSelection, markCompletedStroke, replacePendingStrokes } from "./writtenTracking";
import { DraftNumberInput } from "./DraftNumberInput";
import { useRoutePlan, type RouteSnapshot } from "./useRoutePlan";
import { RouteOverlay, inspectRouteStroke, type RouteInspection } from "./RouteOverlay";
import { RouteComparison, canApplyRouteVariant, type RouteComparisonResult, type RouteVariant } from "./RouteComparison";
import { calibratedRouteComparison } from "./routeMetrics";
import { JobTiming } from "./JobTiming";
import { beginJobTiming, cancelJobTiming, emptyJobTiming, updateJobTiming } from "./jobTimingModel";
import { DocumentEditLock, documentEditPolicy } from "./documentEditPolicy";
import { writableArea, boundsWithinArea, AXIS_LIMITS_MM } from "./writableArea";
import { applyLayoutToPages, applyScaleToPages, normalizeLayouts, resizePositioning, type Layout } from "./layoutGeometry";
import { LayoutPagesDialog } from "./LayoutPagesDialog";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useCanvasEditing } from "./CanvasEditing";
import { useCanvasPan } from "./CanvasPan";
import { CanvasCoordinates } from "./CanvasCoordinates";
import { CanvasPointerOverlay } from "./CanvasPointerOverlay";
import { mapMachineCoordinates, outsideDirection } from "./coordinateGeometry";
import {
  boundsOf,
  movePaths,
  resizePaths,
  rotatePaths,
} from "./editorGeometry";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Crosshair,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  HelpCircle,
  Hand,
  Layers3,
  LoaderCircle,
  Maximize2,
  Minus,
  MousePointer2,
  Pause,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Save,
  Settings2,
  Square,
  Terminal,
  Type,
  Unplug,
  Upload,
  Usb,
  X,
  ZoomIn,
} from "lucide-react";

type Point = { x: number; y: number };
type Document = {
  text_settings?: TextSettings;
  route_optimized?: boolean;
  materials?: { id: string; name: string; kind: string }[];
  strokeOwners?: string[];
  strokeIds?: string[];
  name: string;
  width_mm: number;
  height_mm: number;
  strokes: Point[][];
};
type Template = {
  id: string;
  name: string;
  description: string;
  width_mm: number;
  height_mm: number;
  margin_mm: number;
  font_size_mm: number;
  letter_spacing_mm: number;
  lines: number;
};
type Port = { name: string; description: string; preferred: boolean };
type GlyphFont = { name: string; path: string; characters: string[] };
type ComparisonVariant = {
  label: string;
  source: string;
  page: number;
  options: ImportOptions;
  document: Document;
};
type LegacyFont = {
  display: string;
  version: number;
  size: number;
  count: number;
  author: string;
  description: string;
  path: string;
  preview_strokes: Point[][];
};
type FontSelection = { path: string; weight: number };
type LegacyComposition = {
  document: Document;
  missing: string[];
  choices: string[];
};
type DeviceStatus = {
  state: string;
  position?: number[] | null;
  wco?: number[] | null;
};
type ImportOptions = {
  page: number;
  dpi: number;
  threshold: number;
  conservative: boolean;
  python_path: string;
  autotrace_path: string;
  tolerance_mm: number;
  filter_iterations: number;
  error_threshold: number;
  line_threshold: number;
  despeckle_level: number;
};
type Event = {
  total_seconds?: number;
  cumulative_seconds?: number[];
  type: string;
  ports?: Port[];
  port?: string;
  status?: DeviceStatus;
  message?: string;
  sent?: number;
  index?: number;
  total?: number;
  paused?: boolean;
  reason?: string;
  running?: boolean;
  active?: boolean;
  automatic?: boolean;
  anchor?: number[];
  origin?: number[] | null;
  scale?: number;
  rotation_deg?: number;
  matrix?: [number, number, number, number];
};
const desktop = !!(window as unknown as Record<string, unknown>)
  .__TAURI_INTERNALS__;
const initialTemplate: Template = {
  id: "custom",
  name: "基础书写模板",
  description: "自由排版，从一张白纸开始",
  width_mm: 160,
  height_mm: 240,
  margin_mm: 10,
  font_size_mm: 10,
  letter_spacing_mm: 1,
  lines: 12,
};
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  );
}
function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 1000,
  unit = "mm",
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  unit?: string;
  step?: number;
}) {
  return (
    <Field label={label}>
      <div className="number-input">
        <DraftNumberInput
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
          }}
        />
        <span>{unit}</span>
      </div>
    </Field>
  );
}
function CanvasNumber({
  label,
  value,
  onChange,
  ariaLabel,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  ariaLabel: string;
}) {
  return (
    <Field label={label}>
      <div className="number-input">
        <DraftNumberInput
          aria-label={ariaLabel}
          type="number"
          step=".5"
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
        />
        <span>mm</span>
      </div>
    </Field>
  );
}
function Section({
  icon,
  title,
  aside,
  children,
}: {
  icon: ReactNode;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-heading">
        <span>
          {icon}
          {title}
        </span>
        {aside}
      </div>
      {children}
    </section>
  );
}
function TrajectoryPreview({
  document,
  height = 250,
}: {
  document: Document;
  height?: number;
}) {
  const [zoom, setZoom] = useState(1);
  const paths = useMemo(
    () =>
      document.strokes.map((s, i) => (
        <polyline
          key={i}
          points={s.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke="#5950ac"
          strokeWidth={0.22}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )),
    [document],
  );
  const width = 320,
    drawHeight = (width * document.height_mm) / document.width_mm;
  return (
    <>
      <div className="trajectory-viewport" style={{ height }}>
        <svg
          viewBox={`0 0 ${document.width_mm} ${document.height_mm}`}
          width={width * zoom}
          height={drawHeight * zoom}
          role="img"
          aria-label="当前文档实际走线路径"
        >
          {paths}
        </svg>
      </div>
      <div className="trajectory-tools">
        <span>{document.strokes.length.toLocaleString()} 条路径</span>
        <button
          className="icon-button"
          title="缩小轨迹"
          onClick={() => setZoom((z) => Math.max(0.5, z / 1.5))}
        >
          <Minus size={13} />
        </button>
        <button className="trajectory-zoom" onClick={() => setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button
          className="icon-button"
          title="放大轨迹"
          onClick={() => setZoom((z) => Math.min(12, z * 1.5))}
        >
          <Plus size={13} />
        </button>
      </div>
    </>
  );
}

export default function App() {
  const [storedTemplate, setTemplate] = useState<Template>(initialTemplate),
    [templates, setTemplates] = useState<Template[]>([]);
  const [layouts, setLayouts] = useState<Layout[]>([{ ...initialTemplate, source: "template" }]);
  const [selectedTemplateId, setSelectedTemplateId] = useState(initialTemplate.id);
  const [pageLayoutIds, setPageLayoutIds] = useState<string[]>([initialTemplate.id]);
  const [layoutDialog, setLayoutDialog] = useState(false);
  const [paperDraftSize, setPaperDraftSize] = useState<{ width_mm: number; height_mm: number } | null>(null);
  const template = paperDraftSize ? { ...storedTemplate, ...paperDraftSize } : storedTemplate;
  const layoutChanging = useRef(false);
  const [fonts, setFonts] = useState<{ name: string; path: string }[]>([]);
  const [fontMode, setFontMode] = useState<"regular" | "glyph" | "legacy">(
    "regular",
  );
  const [legacyFonts, setLegacyFonts] = useState<LegacyFont[]>([]);
  const [privateGfont, setPrivateGfont] = useState(false);
  const [legacySelection, setLegacySelection] = useState<FontSelection[]>([]);
  const [draftLegacySelection, setDraftLegacySelection] = useState<
    FontSelection[]
  >([]);
  const [legacySearch, setLegacySearch] = useState("");
  const [legacyFocus, setLegacyFocus] = useState("");
  const [legacyPercent, setLegacyPercent] = useState(100),
    [legacyBaseline, setLegacyBaseline] = useState(1),
    [legacySeed, setLegacySeed] = useState(1);
  const [legacyMissing, setLegacyMissing] = useState<string[]>([]),
    [legacyChoices, setLegacyChoices] = useState<string[]>([]);
  const [glyphFonts, setGlyphFonts] = useState<GlyphFont[]>([]);
  const [glyphFont, setGlyphFont] = useState("");
  const [libraryName, setLibraryName] = useState("我的手写字库");
  const [glyphCharacter, setGlyphCharacter] = useState("");
  const [cropWindow, setCropWindow] = useState<
    [number, number, number, number]
  >([0, 0, 20, 20]);
  const [showExtraction, setShowExtraction] = useState(false);
  const [customFit, setCustomFit] = useState(false);
  const [comparisonVariants, setComparisonVariants] = useState<
      ComparisonVariant[]
    >([]),
    [comparing, setComparing] = useState(false),
    [comparisonError, setComparisonError] = useState("");
  const comparisonRequest = useRef(0),
    comparisonCurrentKey = useRef("");
  const [text, setText] = useState("山川与远方\n落笔皆有回响"),
    [font, setFont] = useState(""),
    [centerline, setCenterline] = useState(false);
  const [document, setSourceDocument] = useState<Document | null>({ name: "组合画布", width_mm: 160, height_mm: 240, strokes: [], materials: [], strokeOwners: [] }),
    [source, setSource] = useState(""),
    [pageCount, setPageCount] = useState<number | null>(null);
  const [editedDocument, setEditedDocument] = useState<Document | null>(null);
  const [backgroundPages, setBackgroundPages] = useState<BackgroundPage[]>([]);
  const [canvasPage, setCanvasPage] = useState(0);
  const currentLayout = layouts.find(layout => layout.id === pageLayoutIds[canvasPage]) || layouts[0];
  const currentLayoutRef = useRef(currentLayout);
  currentLayoutRef.current = currentLayout;
  const sharedPages = pageLayoutIds.flatMap((id, i) => id === currentLayout.id ? [i] : []);
  const [backgroundVisible, setBackgroundVisible] = useState(true);
  const pageDocuments = useRef(new Map<number, Document>());
  const [paperWizard, setPaperWizard] = useState<{ kind: "pdf" | "image"; newPage: boolean } | null>(null);
  const [paperPreview, setPaperPreview] = useState<BackgroundPage | null>(null);
  const [paperStage, setPaperStage] = useState(0);
  const [paperCornerHost, setPaperCornerHost] = useState<HTMLDivElement | null>(null);
  const [paperGuideEditor, setPaperGuideEditor] = useState<GuideEditorState | null>(null);
  const [paperCalibrated, setPaperCalibrated] = useState(false);
  const paperPreviousSetup = useRef<RegistrationSetup | null>(null);
  const [paperCalibrationStarted, setPaperCalibrationStarted] = useState(false);
  const paperWizardRef = useRef(paperWizard); paperWizardRef.current = paperWizard;
  const [textPlacement, setTextPlacement] = useState<"free" | "lines">("free");
  const [lineStart, setLineStart] = useState(0), [lineOffset, setLineOffset] = useState(0.5);
  const background = paperPreview || backgroundPages[canvasPage];
  const canvasPageCount = Math.max(1, canvasPage + 1, backgroundPages.length, ...[...pageDocuments.current.keys()].map(i => i + 1));
  function captureTextSettings(): TextSettings {
    return { text, font_mode: fontMode, font_path: font, glyph_path: glyphFont, legacy_selection: legacySelection,
      legacy_percent: legacyPercent, legacy_baseline: legacyBaseline, legacy_seed: legacySeed, centerline,
      placement: textPlacement, start_line: lineStart, offset: lineOffset, font_size_mm: template.font_size_mm, letter_spacing_mm: template.letter_spacing_mm };
  }
  function restoreTextSettings(doc: Document) {
    const value = doc.text_settings;
    if (!validTextSettings(value)) { setTextPlacement("free"); setLineStart(0); return; }
    setText(value.text); setFontMode(value.font_mode); setFont(value.font_path); setGlyphFont(value.glyph_path);
    setLegacySelection(value.legacy_selection); setLegacyPercent(value.legacy_percent); setLegacyBaseline(value.legacy_baseline); setLegacySeed(value.legacy_seed); setCenterline(value.centerline);
    setTextPlacement(value.placement); setLineStart(value.start_line); setLineOffset(value.offset);

  }
  const [extractionDocument, setExtractionDocument] = useState<Document | null>(null);
  const [activeJobDocument, setActiveJobDocument] = useState<Document | null>(
    null,
  );
  function setDocument(next: Document | null, kind = "file", absolute = false) {
    if (!next || editingBlocked()) return;
    const id = crypto.randomUUID();
    const box = boundsOf(next);
    if (!box) return;
    const current = preparedDoc || document!;
    const existing = boundsOf(current);
    let x = template.margin_mm, y = template.margin_mm;
    if (existing) {
      if (existing.x + existing.width + 5 + box.width <= template.width_mm - template.margin_mm) x = existing.x + existing.width + 5;
      else if (existing.y + existing.height + 5 + box.height <= template.height_mm - template.margin_mm) y = existing.y + existing.height + 5;
      else { x += 5; y += 5; }
    }
    next = ensureStrokeIds(next);
    const placed = absolute ? next : movePaths(next, next.strokes.map((_, i) => i), x - box.x, y - box.y);
    const merged = {
      ...current, name: "组合画布",
      materials: [...(current.materials || []), { id, name: next.name, kind }],
      strokeOwners: [...(current.strokeOwners || current.strokes.map(() => "")), ...placed.strokes.map(() => id)],
      strokeIds: [...ensureStrokeIds(current).strokeIds!, ...placed.strokeIds!],
      strokes: [...current.strokes, ...placed.strokes],
    };
    editor.commitAll(merged, placed.strokes.map((_, i) => current.strokes.length + i));
    setSourceDocument(merged);
    setEditedDocument(merged);
  }
  const [options, setOptions] = useState<ImportOptions>({
    page: 1,
    dpi: 300,
    threshold: 180,
    conservative: false,
    python_path: "python",
    autotrace_path: "",
    tolerance_mm: 0.02,
    filter_iterations: 4,
    error_threshold: 2,
    line_threshold: 1,
    despeckle_level: 0,
  });
  const [busy, setBusy] = useState(""),
    [message, setMessage] = useState("准备就绪，导入图形或选择字体开始创作"),
    [error, setError] = useState(false);
  const [ports, setPorts] = useState<Port[]>([]),
    [port, setPort] = useState(""),
    [connected, setConnected] = useState(""),
    [status, setStatus] = useState<DeviceStatus>({ state: "未连接" });
  const [autoConnect, setAutoConnect] = useState(false),
    [running, setRunning] = useState(false),
    [paused, setPaused] = useState(false),
    [progress, setProgress] = useState({ sent: 0, total: 0 });
  const [feed, setFeed] = useState(1500),
    [travelFeed, setTravelFeed] = useState(2500),
    [zFeed, setZFeed] = useState(3000),
    [zDown, setZDown] = useState(4),
    [jogStep, setJogStep] = useState(1);
  const [recovering, setRecovering] = useState(false),
    [connectionError, setConnectionError] = useState(false),
    [confirmedOrigin, setConfirmedOrigin] = useState<number[] | null>(null);
  const [registration, setRegistration] = useState<Registration>(identityRegistration);
  const [registrationProfiles, setRegistrationProfiles] = useState<RegistrationProfile[]>([]);
  const [registrationSetup, setRegistrationSetup] = useState<RegistrationSetup | null>(null);
  const [restoreSetup, setRestoreSetup] = useState<{ version: number; value: RegistrationSetup } | null>(null);
  const [projectCalibration, setProjectCalibration] = useState<Project["calibration"] | null>(null);
  const projectCalibrationRef = useRef<Project["calibration"] | null>(null);
  projectCalibrationRef.current = projectCalibration;
  const preservedRegistrationRef = useRef<Registration | null>(null);
  const [projectNeedsAlignment, setProjectNeedsAlignment] = useState(false);
  const [machineOriginReady, setMachineOriginReady] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const [projectRevision, setProjectRevision] = useState(0);
  const projectLoaded = useRef(false);
  const [registrationLocked, setRegistrationLocked] = useState(false);
  const [calibrationVersion, setCalibrationVersion] = useState(0);
  const [secondPointVersion, setSecondPointVersion] = useState(0);
  const [sessionVersion, setSessionVersion] = useState(0);
  useEffect(() => { setPaperCalibrated(false); }, [sessionVersion, connected]);
  const [registrationPoints, setRegistrationPoints] = useState<number[][] | null>(null);
  const [registrationPointEdit, setRegistrationPointEdit] = useState<{ index: number; point: number[] } | null>(null);
  const [registrationErrorVersion, setRegistrationErrorVersion] = useState(0);
  const [positioning, setPositioning] = useState(false);
  const resetOriginLayout = useRef<string | null>(null);
  const [automaticOrigin, setAutomaticOrigin] = useState(true);
  const [allowReverse, setAllowReverse] = useState(true);
  const [optimizeTrajectory, setOptimizeTrajectory] = useState(true);
  const [routeInspection, setRouteInspection] = useState<RouteInspection | null>(null);
  const [routeComparison, setRouteComparison] = useState<{ key: string; result: RouteComparisonResult } | null>(null);
  const [routeComparisonPending, setRouteComparisonPending] = useState(false);
  const [routeComparisonError, setRouteComparisonError] = useState("");
  const [allowWritingGap, setAllowWritingGap] = useState(false);
  const [maxWritingGap, setMaxWritingGap] = useState(0.3);
  const [deduplicateWriting, setDeduplicateWriting] = useState(false);
  const routeComparisonEpoch = useRef(0);
  const [activeRoute, setActiveRoute] = useState<RouteSnapshot | null>(null);
  const [targetCanvasX, setTargetCanvasX] = useState(0),
    [targetCanvasY, setTargetCanvasY] = useState(0);
  const [writtenIds, setWrittenIds] = useState<Set<string>>(() => new Set());
  const submittedStrokes = useRef<Document | null>(null);
  const submittedOrderedIds = useRef<string[]>([]);
  const [jobLocked, setJobLocked] = useState(false);
  const jobLockRef = useRef(false);
  const submissionEpoch = useRef(0);
  const [jobTiming, setJobTiming] = useState(emptyJobTiming);
  function lockJob(locked: boolean) {
    jobLockRef.current = locked;
    setJobLocked(locked);
    if (!locked) { submissionEpoch.current++; submittedStrokes.current = null; submittedOrderedIds.current = []; }
  }
  const editPolicy = documentEditPolicy({ jobLocked: jobLocked || running, positioning: positioning || registrationLocked, recovering, converting: !!busy });
  const mutationPolicy = documentEditPolicy({ jobLocked: jobLocked || running, positioning: positioning || registrationLocked, recovering, converting: false });
  const editPolicyRef = useRef(mutationPolicy);
  editPolicyRef.current = mutationPolicy;
  function editingBlocked() {
    return jobLockRef.current || !!paperWizard || !editPolicyRef.current.canEditDocument;
  }
  const machineBusy = jobLocked || running || positioning || recovering;
  const connectionAttempt = useRef(false);
  const [zoom, setZoom] = useState(1),
    [rotation, setRotation] = useState(0),
    [scale, setScale] = useState(1),
    [showMargins, setShowMargins] = useState(true);
  const [modal, setModal] = useState<
      | "code"
      | "logs"
      | "settings"
      | "templates"
      | "help"
      | "comparison"
      | "route-comparison"
      | "legacy"
      | null
    >(null),
    [code, setCode] = useState(""),
    [logs, setLogs] = useState<string[]>([]);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [leftTab, setLeftTab] = useState<"materials" | "board">("materials");
  const [rightTab, setRightTab] = useState<"properties" | "planning" | "machine" | "writing">("properties");
  const [tab, setTab] = useState<"text" | "file">("text");
  const rightScroll = useRef<HTMLDivElement>(null);
  const [canvasTool, setCanvasTool] = useState<"select" | "pan">("select");
  const [placingOrigin, setPlacingOrigin] = useState(false);
  const [originDraft, setOriginDraft] = useState<number[] | null>(null);
  const [penDraft, setPenDraft] = useState<number[] | null>(null);
  const pan = useCanvasPan(canvasTool === "pan");
  useEffect(() => {
    if (machineBusy || busy || registrationLocked || paperWizard || showExtraction) setPlacingOrigin(false);
  }, [machineBusy, busy, registrationLocked, paperWizard, showExtraction]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setPlacingOrigin(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  const paperHost = useRef<HTMLDivElement>(null),
    [paperFit, setPaperFit] = useState(2);
  const mounted = useRef(true);
  const updateTemplate = (key: keyof Template, value: string | number) => {
    if (editingBlocked()) return;
    const next = { ...currentLayout, ...template, id: currentLayout.id, [key]: value };
    if (key === "width_mm" || key === "height_mm") { next.source = "manual"; next.name = "自定义版面"; delete next.derivation; }
    void changeLayout(next, sharedPages);
  };
  const preset = customFit
    ? "custom"
    : options.threshold === 180 && options.conservative
      ? "180-conservative"
      : !options.conservative &&
          options.filter_iterations === 4 &&
          options.error_threshold === 2 &&
          options.line_threshold === 1 &&
          options.despeckle_level === 0 &&
          [128, 180].includes(options.threshold)
        ? `${options.threshold}-default`
        : "custom";
  function applyPreset(value: string) {
    setCustomFit(value === "custom");
    if (value === "custom") {
      setOptions((o) => ({ ...o, conservative: false }));
      return;
    }
    const conservative = value === "180-conservative";
    setOptions((o) => ({
      ...o,
      threshold: value.startsWith("128") ? 128 : 180,
      conservative,
      filter_iterations: conservative ? 0 : 4,
      error_threshold: conservative ? 0.5 : 2,
      line_threshold: conservative ? 0.5 : 1,
      despeckle_level: 0,
    }));
  }
  const notify = (value: string, isError = false) => {
    setMessage(value);
    setError(isError);
    setLogs((l) => [
      ...l.slice(-299),
      `${new Date().toLocaleTimeString()}  ${value}`,
    ]);
  };
  async function call<T>(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    if (!desktop)
      throw new Error(
        "当前为浏览器界面预览。请启动桌面应用以访问文件、转换与设备。",
      );
    return invoke<T>(name, args);
  }
  async function work(label: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError(false);
    try {
      await fn();
    } catch (e) {
      notify(String(e), true);
    } finally {
      setBusy("");
    }
  }
  async function command(command: Record<string, unknown>) {
    if (recovering) return false;
    const connecting = ["connect", "auto_connect", "recover"].includes(
      String(command.type),
    );
    if (connecting) {
      connectionAttempt.current = true;
      setConnectionError(false);
      setConfirmedOrigin(null);
    }
    try {
      await call("device_command", { command });
      return true;
    } catch (e) {
      if (connecting) setConnectionError(true);
      notify(String(e), true);
      return false;
    }
  }
  function stopJob() {
    submissionEpoch.current++;
    setJobTiming((state) => cancelJobTiming(state, Date.now()));
    void command({ type: "stop" });
  }
  async function recoverConnection() {
    if (!port || recovering || positioning || (running && connected)) return;
    setRecovering(true);
    connectionAttempt.current = true;
    setConnectionError(false);
    setConfirmedOrigin(null);
    notify("正在清除旧任务、恢复连接并抬笔");
    try {
      await call("device_command", { command: { type: "recover", port } });
    } catch (e) {
      setRecovering(false);
      setConnectionError(true);
      notify(String(e), true);
    }
  }
  async function issuePositioning(request: Record<string, unknown>) {
    if (machineBusy || busy || !connected || status.state !== "Idle") return false;
    setPositioning(true);
    if (!(await command(request))) { setPositioning(false); return false; }
    return true;
  }
  function setWorkOrigin(point: { x: number; y: number }) {
    if (!confirmedOrigin && (currentLayout.scale_x !== undefined)) return;
    const target = [Number(point.x.toFixed(3)), Number(point.y.toFixed(3))];
    const pen = coordinateMapping?.pen || { x: target[0], y: target[1] };
    const previousOrigin = originDraft, previousPen = penDraft;
    setPlacingOrigin(false); setCanvasTool("select");
    setOriginDraft(target); setPenDraft([pen.x, pen.y]);
    notify("正在自动抬笔并将所选点设为工作原点");
    void issuePositioning({
      type: "calibrate",
      canvas_x: pen.x,
      canvas_y: pen.y,
      origin_x: target[0],
      origin_y: target[1],
      raised_confirmed: true,
    }).then(ok => { if (!ok) { setOriginDraft(previousOrigin); setPenDraft(previousPen); } });
  }
  const positionKnown =
    status.position?.length === 3 && status.position.every(Number.isFinite);
  const wcoKnown =
    status.wco?.length === 3 && status.wco.every((v) => Number.isFinite(v));
  const canJog = !!connected && !machineBusy && status.state === "Idle";
  useJogKeys(rightOpen && rightTab === "machine" && canJog && !busy, jogStep, travelFeed, command);
  const canPen =
    canJog &&
    positionKnown &&
    wcoKnown &&
    status.position![2] >= -0.05 &&
    status.position![2] <= 4.05;
  const originalPreparedDoc = useMemo(() => {
    if (!document) return null;
    if (!document.strokes.length) return document;
    const a = (rotation * Math.PI) / 180;
    let minx = Infinity,
      miny = Infinity;
    const strokes = document.strokes.map((s) =>
      s.map((p) => {
        const x = (p.x * Math.cos(a) - p.y * Math.sin(a)) * scale,
          y = (p.x * Math.sin(a) + p.y * Math.cos(a)) * scale;
        minx = Math.min(minx, x);
        miny = Math.min(miny, y);
        return { x, y };
      }),
    );
    for (const s of strokes)
      for (const p of s) {
        p.x += template.margin_mm - minx;
        p.y += template.margin_mm - miny;
      }
    return {
      ...ensureStrokeIds(document),
      width_mm: template.width_mm,
      height_mm: template.height_mm,
      strokes,
    };
  }, [
    document,
    rotation,
    scale,
    template.margin_mm,
    template.width_mm,
    template.height_mm,
  ]);
  const preparedDoc = useMemo(
    () =>
      jobLocked && activeJobDocument
        ? activeJobDocument
        : document
          ? editedDocument
            ? {
                ...editedDocument,
                width_mm: template.width_mm,
                height_mm: template.height_mm,
              }
            : originalPreparedDoc
          : null,
    [
      jobLocked,
      activeJobDocument,
      document,
      editedDocument,
      originalPreparedDoc,
      template.width_mm,
      template.height_mm,
    ],
  );
  const pendingDoc = useMemo(() => jobLocked && submittedStrokes.current ? submittedStrokes.current : preparedDoc ? unwrittenDocument(preparedDoc, writtenIds) : null, [preparedDoc, writtenIds, jobLocked]);
  const extractionPrepared = useMemo(() => {
    if (!extractionDocument) return null;
    const box = boundsOf(extractionDocument);
    return box ? movePaths(extractionDocument, extractionDocument.strokes.map((_, i) => i), template.margin_mm - box.x, template.margin_mm - box.y) : extractionDocument;
  }, [extractionDocument, template.margin_mm]);
  const displayDoc = showExtraction ? extractionPrepared : preparedDoc;
  function commitCanvas(next: Document) {
    if (editingBlocked()) return;
    next = ensureStrokeIds(next);
    setSourceDocument(next);
    setEditedDocument(next);
    setRotation(0);
    setScale(1);
  }
  const editor = useCanvasEditing({
    document: displayDoc,
    sourceKey: `composition-${projectRevision}-${canvasPage}`,
    locked: !editPolicy.canEditDocument || !!paperWizard,
    extracting: showExtraction,
    writtenIds,
    onResetWritten: (selection) => { if (preparedDoc && !editingBlocked()) setWrittenIds((current) => resetWrittenSelection(current, preparedDoc, selection)); },
    onChange: commitCanvas,
    onMessage: notify,
  });
  const guideDocument = useMemo(() => paperGuideEditor ? {
    name: "定位横线", width_mm: template.width_mm, height_mm: template.height_mm,
    strokeIds: paperGuideEditor.lines.map(line => line.id),
    strokes: paperGuideEditor.lines.map(line => [{ x: line.start[0], y: line.start[1] }, { x: line.end[0], y: line.end[1] }]),
  } : null, [paperGuideEditor, template.width_mm, template.height_mm]);
  const guideEditor = useCanvasEditing({
    document: guideDocument, sourceKey: paperStage === 2 ? paperWizard : null,
    locked: !paperGuideEditor || paperGuideEditor.locked || !editPolicy.canEditDocument || !!busy,
    extracting: false, onMessage: notify,
    onChange(next) {
      if (!paperGuideEditor || paperGuideEditor.locked || machineBusy || busy) return;
      if (next.strokes.length > 500 || next.strokes.some(stroke => stroke.length !== 2 || stroke.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > template.width_mm || p.y < 0 || p.y > template.height_mm))) { notify("横线须保持在页面内，最多 500 条", true); return; }
      let serial = paperGuideEditor.maxNumber;
      const lines = next.strokes.map((stroke, i) => ({ id: /^line-\d+$/.test(next.strokeIds?.[i] || "") ? next.strokeIds![i] : `line-${++serial}`, start: [stroke[0].x, stroke[0].y] as [number, number], end: [stroke[1].x, stroke[1].y] as [number, number] }));
      paperGuideEditor.onChange(lines);
    },
  });
  const activeEditor = paperGuideEditor ? guideEditor : editor;
  const visibleGuideLines: GuideLine[] | undefined = paperGuideEditor && guideEditor.displayDocument ? guideEditor.displayDocument.strokes.map((stroke, i) => ({ id: guideEditor.displayDocument!.strokeIds?.[i] || `line-${i + 1}`, start: [stroke[0].x, stroke[0].y], end: [stroke[stroke.length - 1].x, stroke[stroke.length - 1].y] })) : background?.guide_lines;
  useEffect(() => {
    if (activeEditor.selection.length) { setRightOpen(true); setRightTab("properties"); }
  }, [activeEditor.selection]);
  const coordinateFirst =
    editor.displayDocument?.strokes.find((s) => s.length > 1)?.[0] || null;
  const coordinateOrigin = connected && !recovering ? confirmedOrigin : null;
  const coordinatePosition =
    connected && !recovering && positionKnown ? status.position! : null;
  const coordinateMapping = coordinateOrigin
    ? mapMachineCoordinates(coordinateOrigin, coordinatePosition, registration)
    : null;
  const defaultLayoutOrigin = registrationSetup?.points[0] || [template.width_mm, 0];
  const defaultLayoutPen = registrationSetup?.point3 || registrationSetup?.points[1] || [15, template.height_mm - 15];
  const displayedOrigin = confirmedOrigin || (projectNeedsAlignment ? projectCalibration?.origin : null) || originDraft || defaultLayoutOrigin;
  const displayedPen = coordinateMapping?.pen ? [coordinateMapping.pen.x, coordinateMapping.pen.y] : penDraft || defaultLayoutPen;
  const routeRequest = useMemo(() => pendingDoc ? ({
    document: pendingDoc,
    start: automaticOrigin ? null : coordinateMapping?.pen || null,
    allow_reverse: allowReverse,
    optimize: optimizeTrajectory,
    travel_feed_mm_min: travelFeed / (automaticOrigin || registration.matrix ? 1 : registration.scale),
    ...(!automaticOrigin && registration.matrix ? { metric_matrix: registration.matrix } : {}),
  }) : null, [pendingDoc, automaticOrigin, automaticOrigin ? null : coordinateMapping?.pen?.x, automaticOrigin ? null : coordinateMapping?.pen?.y, allowReverse, travelFeed, optimizeTrajectory, registration.scale, registration.matrix]);
  const route = useRoutePlan(routeRequest, ({ optimize: _optimize, metric_matrix: _metric, ...request }) => call("optimize_document", request), jobLocked || running);
  const visibleRoute = jobLocked || running ? activeRoute : route.snapshot;
  const routeComparisonKey = JSON.stringify({ document: pendingDoc, feed, travelFeed, zFeed, zDown, registration: automaticOrigin ? identityRegistration : registration, start: routeRequest?.start, allowReverse, optimizeTrajectory, allowWritingGap, maxWritingGap, deduplicateWriting });
  const routeComparisonLatestKey = useRef(routeComparisonKey);
  routeComparisonLatestKey.current = routeComparisonKey;
  async function compareRouteOptions() {
    if (editingBlocked() || !pendingDoc?.strokes.length) return;
    setModal("route-comparison");
    const key = routeComparisonKey, epoch = ++routeComparisonEpoch.current;
    setRouteComparisonPending(true);
    setRouteComparisonError("");
    try {
      let result = await call<RouteComparisonResult>("compare_routes", {
        job: { ...job({ document: pendingDoc }), feed: feed / (automaticOrigin || registration.matrix ? 1 : registration.scale), travel_feed: travelFeed / (automaticOrigin || registration.matrix ? 1 : registration.scale) }, start: routeRequest?.start || null,
        allow_reverse: allowReverse,
        official_baseline: !pendingDoc.route_optimized && !!pendingDoc.materials?.length && pendingDoc.materials.every((material) => material.kind === "legacy"),
        stroke_owners: pendingDoc.strokeOwners || [],
        max_gap_mm: allowWritingGap ? maxWritingGap : 0,
        deduplicate: deduplicateWriting,
        trajectory_enabled: optimizeTrajectory,
      });
      if (!automaticOrigin && registration.matrix) result = calibratedRouteComparison(result, registration.matrix, routeRequest?.start || null, feed, travelFeed, optimizeTrajectory);
      if (epoch === routeComparisonEpoch.current) setRouteComparison({ key, result });
    } catch (error) {
      if (epoch === routeComparisonEpoch.current) setRouteComparisonError(String(error));
    } finally {
      if (epoch === routeComparisonEpoch.current) setRouteComparisonPending(false);
    }
  }
  function applyRouteVariant(variant: RouteVariant) {
    if (editingBlocked() || !preparedDoc || routeComparisonPending || routeComparison?.key !== routeComparisonLatestKey.current || !canApplyRouteVariant(variant)) return;
    const next: Document = { ...replacePendingStrokes(preparedDoc, { ...variant.document, strokeOwners: variant.stroke_owners }, writtenIds), route_optimized: true };
    editor.commitAll(next);
    setModal(null);
    notify(`已应用${variant.label}，可撤销`);
  }
  const routeStrokeCount = visibleRoute?.document.strokes.filter((stroke) => stroke.length > 1).length || 0;
  function selectRouteStroke(index: number) {
    if (!visibleRoute || !routeStrokeCount) return;
    const inspection = inspectRouteStroke(visibleRoute, Math.min(routeStrokeCount, Math.max(1, Math.round(index))));
    setRouteInspection(inspection);
  }
  useEffect(() => setRouteInspection(null), [visibleRoute?.key]);
  async function currentRoute() {
    if (jobLocked || running) {
      if (!activeRoute) throw new Error("任务走线规划中，请稍后预览或导出");
      return activeRoute;
    }
    if (!routeRequest) throw new Error("请先生成或导入路径");
    return route.ensure(routeRequest);
  }
  const originOutside = coordinateMapping
    ? outsideDirection(
        coordinateMapping.origin,
        template.width_mm,
        template.height_mm,
      )
    : "";
  const bounds = useMemo(() => {
    let minx = Infinity,
      miny = Infinity,
      maxx = -Infinity,
      maxy = -Infinity;
    for (const s of pendingDoc?.strokes || [])
      for (const p of s) {
        minx = Math.min(minx, p.x);
        miny = Math.min(miny, p.y);
        maxx = Math.max(maxx, p.x);
        maxy = Math.max(maxy, p.y);
      }
    return {
      x: Number.isFinite(minx) ? minx : 0,
      y: Number.isFinite(miny) ? miny : 0,
      width: Number.isFinite(maxx) ? maxx - minx : 0,
      height: Number.isFinite(maxy) ? maxy - miny : 0,
    };
  }, [pendingDoc]);
  const machinePoints = !automaticOrigin && confirmedOrigin ? (pendingDoc?.strokes || []).flat().map(p => canvasToMachine(p, confirmedOrigin, registration)) : [];
  const machineBounds = machinePoints.reduce((b, p) => ({ minx: Math.min(b.minx, p.x), maxx: Math.max(b.maxx, p.x), miny: Math.min(b.miny, p.y), maxy: Math.max(b.maxy, p.y) }), { minx: Infinity, maxx: -Infinity, miny: Infinity, maxy: -Infinity });
  const physicalExceeds = machinePoints.length ? machineBounds.maxx - machineBounds.minx > AXIS_LIMITS_MM[0] || machineBounds.maxy - machineBounds.miny > AXIS_LIMITS_MM[1] : bounds.width > AXIS_LIMITS_MM[0] || bounds.height > AXIS_LIMITS_MM[1];
  const pageExceeds =
    !!preparedDoc?.strokes.length &&
    (bounds.x < -0.001 ||
      bounds.y < -0.001 ||
      bounds.x + bounds.width > template.width_mm + 0.001 ||
      bounds.y + bounds.height > template.height_mm + 0.001);
  const fitArea = writableArea(
    template.width_mm, template.height_mm, 0,
    !automaticOrigin && confirmedOrigin ? confirmedOrigin : [0, 0], !automaticOrigin ? coordinatePosition : null,
    automaticOrigin ? identityRegistration : registration,
  );
  const placementExceeds = machinePoints.length ? machinePoints.some(p => Math.abs(p.x) > AXIS_LIMITS_MM[0] + .001 || Math.abs(p.y) > AXIS_LIMITS_MM[1] + .001 || !!coordinatePosition && (Math.abs(p.x - coordinatePosition[0]) > AXIS_LIMITS_MM[0] + .001 || Math.abs(p.y - coordinatePosition[1]) > AXIS_LIMITS_MM[1] + .001)) : !!preparedDoc?.strokes.length && !boundsWithinArea(bounds, fitArea);
  const exceeds = physicalExceeds || pageExceeds || placementExceeds;
  const runReason = machineBusy
    ? "设备正在作业或走位，编辑已锁定"
    : !connected
      ? "请先连接设备"
      : !automaticOrigin && !machineOriginReady
        ? projectNeedsAlignment
          ? projectCalibration ? "工程已打开：请用两点校准当前旋转；横纵比例沿用保存值" : "请用两点校准当前旋转"
          : "正在恢复工程工作原点"
      : status.state !== "Idle"
        ? `等待设备空闲：${status.state}`
        : !positionKnown
          ? "等待控制器反馈当前笔尖位置"
          : showExtraction
                  ? "请先关闭字形提取，返回编辑作品"
                  : !pendingDoc?.strokes.some((s) => s.length > 1)
                    ? preparedDoc?.strokes.some((s) => s.length > 1) ? "本页内容均已书写；框选后可重置书写标记" : "请先导入或生成书写路径"
                    : physicalExceeds
                        ? "墨迹跨度超过当前 A4 工作范围（X 210 / Y 297 mm）"
                        : pageExceeds
                          ? "墨迹超出画布，请移动、改尺寸或一键适配"
                          : placementExceeds
                            ? `超出当前软件范围（X 210 / Y 297 mm）。画布允许区域：${fitArea ? `X ${fitArea.x.toFixed(1)}–${(fitArea.x + fitArea.width).toFixed(1)}，Y ${fitArea.y.toFixed(1)}–${(fitArea.y + fitArea.height).toFixed(1)} mm` : "与纸面无交集"}；请检查原点与笔尖定位`
                            : "";
  const canRun = !runReason && !busy && !machineBusy && !registrationLocked && !paperWizard;
  const cropPolygon = useMemo(() => {
    const document = extractionDocument;
    if (!document || !showExtraction || !source) return "";
    const a = 0, scale = 1;
    const transform = (x: number, y: number) => ({
      x: (x * Math.cos(a) - y * Math.sin(a)) * scale,
      y: (x * Math.sin(a) + y * Math.cos(a)) * scale,
    });
    let minx = Infinity,
      miny = Infinity;
    for (const s of document.strokes)
      for (const p of s) {
        const q = transform(p.x, p.y);
        minx = Math.min(minx, q.x);
        miny = Math.min(miny, q.y);
      }
    const [x0, y0, x1, y1] = cropWindow;
    return [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ]
      .map(([x, y]) => {
        const q = transform(x, y);
        return `${q.x - minx + template.margin_mm},${q.y - miny + template.margin_mm}`;
      })
      .join(" ");
  }, [
    extractionDocument,
    showExtraction,
    source,
    rotation,
    scale,
    cropWindow,
    template.margin_mm,
  ]);
  function fitToPage() {
    if (
      !document ||
      !preparedDoc?.strokes.some((s) => s.length > 1) ||
      machineBusy ||
      busy ||
      showExtraction
    )
      return;
    if (!fitArea) {
      notify("画布与当前可达范围没有交集，请重新校准工作原点及笔尖", true);
      return;
    }
    const factor =
      Math.min(AXIS_LIMITS_MM[0], fitArea.width) /
      (bounds.width || 1);
    const factorY =
      Math.min(AXIS_LIMITS_MM[1], fitArea.height) /
      (bounds.height || 1);
    const ratio = Math.min(factor, factorY) * 0.99;
    const ids = preparedDoc.strokes.map((_, i) => i);
    let fitted = resizePaths(
      preparedDoc,
      ids,
      bounds.width * ratio,
      bounds.height * ratio,
    );
    const bbox = boundsOf(fitted)!;
    fitted = movePaths(
      fitted,
      ids,
      fitArea.x - bbox.x,
      fitArea.y - bbox.y,
    );
    editor.commitAll(fitted);
    notify("已按墨迹范围适配画布域，保留 1% 余量");
  }
  async function optimizeRoute() {
    if (editingBlocked()) return;
    route.recompute();
  }
  function changeRotation(value: number) {
    if (machineBusy || busy || showExtraction) return;
    if (editedDocument) {
      editor.commitAll(
        rotatePaths(
          editedDocument,
          editedDocument.strokes.map((_, i) => i),
          value - rotation,
        ),
      );
      setRotation(value);
    } else setRotation(value);
  }
  function changeScale(value: number) {
    if (machineBusy || busy || showExtraction) return;
    if (editedDocument) {
      const b = boundsOf(editedDocument);
      if (!b) return;
      editor.commitAll(
        resizePaths(
          editedDocument,
          editedDocument.strokes.map((_, i) => i),
          (b.width * value) / scale,
          (b.height * value) / scale,
        ),
      );
      setScale(value);
    } else setScale(value);
  }
  function job(snapshot: Pick<RouteSnapshot, "document">) {
    return {
      document: snapshot.document,
      feed,
      travel_feed: travelFeed,
      z_feed: zFeed,
      z_down: zDown,
    };
  }

  const comparisonKey = JSON.stringify({ source, options });
  const focusedLegacy = legacyFonts.find((f) => f.path === legacyFocus);
  const legacyPreview = useMemo(() => {
    if (!focusedLegacy?.preview_strokes.length) return null;
    let minx = Infinity,
      miny = Infinity,
      maxx = -Infinity,
      maxy = -Infinity;
    for (const s of focusedLegacy.preview_strokes)
      for (const p of s) {
        minx = Math.min(minx, p.x);
        miny = Math.min(miny, p.y);
        maxx = Math.max(maxx, p.x);
        maxy = Math.max(maxy, p.y);
      }
    return {
      name: focusedLegacy.display,
      width_mm: Math.max(1, maxx - minx) + 6,
      height_mm: Math.max(1, maxy - miny) + 6,
      strokes: focusedLegacy.preview_strokes.map((s) =>
        s.map((p) => ({ x: p.x - minx + 3, y: p.y - miny + 3 })),
      ),
    };
  }, [focusedLegacy]);
  comparisonCurrentKey.current = comparisonKey;
  useEffect(() => {
    comparisonRequest.current++;
    setComparisonVariants([]);
    setComparisonError("");
    setComparing(false);
  }, [comparisonKey]);
  useEffect(() => {
    mounted.current = true;
    if (!desktop) return;
    let polling = false;
    call<{ name: string; path: string }[]>("list_fonts")
      .then((v) => {
        setFonts(v);
        const preferred = v.find((f) => /msyh/i.test(f.name));
        if (preferred) setFont(preferred.path);
      })
      .catch(() => {});
    call<Template[]>("list_templates")
      .then(setTemplates)
      .catch((e) => notify(String(e), true));
    call<GlyphFont[]>("list_glyph_fonts")
      .then((v) => {
        setGlyphFonts(v);
        if (v[0]) setGlyphFont(v[0].path);
      })
      .catch((e) => notify(String(e), true));
    call<boolean>("private_gfont_available")
      .then(async (available) => {
        setPrivateGfont(available);
        if (available) setLegacyFonts(await call<LegacyFont[]>("list_legacy_fonts"));
      })
      .catch((e) => notify(String(e), true));
    call<Partial<ImportOptions>>("default_import_options")
      .then((v) => setOptions((o) => projectLoaded.current ? { ...v, ...o, python_path: v.python_path || o.python_path, autotrace_path: v.autotrace_path || o.autotrace_path } : { ...o, ...v }))
      .catch(() => {});
    call<RegistrationProfile[]>("list_registration_profiles").then(v => setRegistrationProfiles(current => [...v, ...current.filter(p => !v.some(q => q.id === p.id))])).catch(e => notify(String(e), true));
    call<string | null>("startup_project_path").then(path => { if (path) void openProjectFile(path); }).catch(e => notify(String(e), true));
    command({ type: "scan" });
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const events = await call<Event[]>("poll_device");
        if (!mounted.current) return;
        for (const e of events) {
          const eventEpoch = submissionEpoch.current, receivedAt = Date.now();
          setJobTiming((state) => updateJobTiming(state, e, receivedAt, eventEpoch));
          switch (e.type) {
            case "origin_mode":
              setAutomaticOrigin(e.automatic !== false);
              break;
            case "ports":
              setPorts(e.ports || []);
              setPort((p) => p || e.ports?.[0]?.name || "");
              break;
            case "connected":
              resetOriginLayout.current = null;
              setRegistration(preservedRegistrationRef.current || identityRegistration); setRegistrationLocked(false); setSessionVersion(v => v + 1);
              setMachineOriginReady(false);
              setConfirmedOrigin(null);
              if (projectCalibrationRef.current || currentLayoutRef.current.scale_x !== undefined) { setAutomaticOrigin(false); setProjectNeedsAlignment(true); }
              else setAutomaticOrigin(true);
              connectionAttempt.current = false;
              setConnectionError(false);
              setConnected(e.port || "");
              notify(`已连接 ${e.port}`);
              break;
            case "disconnected":
              resetOriginLayout.current = null;
              setRegistration(preservedRegistrationRef.current || identityRegistration); setRegistrationLocked(false); setSessionVersion(v => v + 1);
              submittedStrokes.current = null;
              submittedOrderedIds.current = [];
              setConnected("");
              setRunning(false);
              setPositioning(false);
              setMachineOriginReady(false);
              setConfirmedOrigin(null); setRegistration(preservedRegistrationRef.current || identityRegistration);
              if (projectCalibrationRef.current || currentLayoutRef.current.scale_x !== undefined) { setAutomaticOrigin(false); setProjectNeedsAlignment(true); }
              setStatus({ state: "未连接" });
              break;
            case "status":
              if (e.status) setStatus(e.status);
              break;
            case "progress":
              setProgress({ sent: e.sent || 0, total: e.total || 0 });
              break;
            case "completed":
              if (submittedStrokes.current) {
                const ids = completedStrokeIds(submittedStrokes.current);
                setWrittenIds((current) => new Set([...current, ...ids]));
                submittedStrokes.current = null;
              }
              lockJob(false);
              setRunning(false);
              notify("控制器已完成作业，请检查纸面书写效果");
              break;
            case "stroke_completed": {
              const ids = submittedOrderedIds.current;
              const index = e.index;
              if (typeof index === "number") setWrittenIds((current) => markCompletedStroke(current, ids, index));
              break;
            }
            case "paused":
              setPaused(!!e.paused);
              break;
            case "stopped":
              setRegistrationLocked(false);
              setSessionVersion(v => v + 1);
              lockJob(false);
              setRunning(false);
              setPositioning(false);
              setPaused(false);
              notify("旧任务已清除，笔已抬起；已保留确认完成笔画。停止时当前笔画未确认，重新开始可能重描");
              break;
            case "recovering":
              setRecovering(!!e.active);
              if (e.active) {
                setMachineOriginReady(false); setConfirmedOrigin(null); setRegistration(identityRegistration);
                if (projectCalibrationRef.current) { setAutomaticOrigin(false); setProjectNeedsAlignment(true); }
                setRegistrationLocked(false); setSessionVersion(v => v + 1);
              }
              break;
            case "job_started":
              lockJob(true);
              setRunning(true);
              break;
            case "positioning":
              setPositioning(!!e.active);
              break;
            case "registration_changed":
              {
                const next = { scale: e.scale || 1, rotation_deg: e.rotation_deg || 0, ...(e.matrix ? { matrix: e.matrix } : {}) };
                setRegistration(next);
                setProjectCalibration(current => current ? { ...current, registration: next } : current);
              }
              setCalibrationVersion(v => v + 1);
              break;
            case "registration_point_captured":
              if (e.index === 2) setSecondPointVersion(v => v + 1);
              break;
            case "calibration_changed":
              setRegistration(identityRegistration);
              setCalibrationVersion(v => v + 1);
              if (!e.origin) setRegistration(identityRegistration);
              if (e.origin?.length === 2 && e.origin.every(Number.isFinite)) {
                if (resetOriginLayout.current) {
                  const id = resetOriginLayout.current;
                  setLayouts(current => current.map(l => l.id === id ? { ...l, scale_x: 1, scale_y: 1 } : l));
                  resetOriginLayout.current = null;
                }
                const origin = [...e.origin];
                setProjectNeedsAlignment(false);
                setConfirmedOrigin(origin);
                preservedRegistrationRef.current = null;
                setProjectCalibration(current => current ? { ...current, origin } : current);
                setMachineOriginReady(true);
                setOriginDraft(null);
                setPenDraft(null);
                notify(
                  `纸面校准完成：程序已抬笔，工作原点为画布 (${e.origin[0].toFixed(2)}, ${e.origin[1].toFixed(2)}) mm`,
                );
              } else {
                setConfirmedOrigin(null);
                setMachineOriginReady(false);
                setRegistrationLocked(false);
                setSessionVersion(v => v + 1);
              }
              break;
            case "error":
              resetOriginLayout.current = null;
              setRegistrationErrorVersion(v => v + 1);
              if (connectionAttempt.current) setConnectionError(true);
              notify(e.message || "设备错误", true);
              break;
            case "job_rejected":
              lockJob(!!e.running);
              setRunning(!!e.running);
              notify(
                e.reason || "作业未被接受，请检查笔高、坐标与路径范围",
                true,
              );
              break;
            case "log":
              setLogs((l) =>
                e.message?.includes("<Idle|") && l[l.length - 1] === e.message
                  ? l
                  : [...l.slice(-299), e.message || ""],
              );
              break;
          }
        }
      } catch (e) {
        setError(true);
        setMessage(String(e));
      } finally {
        polling = false;
      }
    }, 180);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);
  const initialPaperFit = useRef(false);
  function fitPaper() {
    const el = paperHost.current;
    if (!el || el.clientWidth <= 104 || el.clientHeight <= 62) return;
    setPaperFit(Math.min((el.clientWidth - 104) / template.width_mm, (el.clientHeight - 62) / template.height_mm));
    setZoom(1);
    const scroll = el.querySelector<HTMLElement>(".paper-scroll");
    if (scroll) { scroll.scrollLeft = 0; scroll.scrollTop = 0; }
  }
  useEffect(() => {
    const el = paperHost.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (!initialPaperFit.current && el.clientWidth > 104 && el.clientHeight > 62) {
        initialPaperFit.current = true; fitPaper();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  async function chooseFont() {
    if (editingBlocked()) return;
    await work("选择字体", async () => {
      const path = await open({
        multiple: false,
        filters: [{ name: "常规字体", extensions: ["ttf", "otf", "ttc"] }],
      });
      if (typeof path === "string" && !editingBlocked()) {
        setFont(path);
        notify(`已选择 ${fileName(path)}，生成预览后可书写`);
      }
    });
  }
  async function generateText() {
    if (editingBlocked()) return;
    await work("生成文字路径", async () => {
      if (fontMode === "legacy" && !privateGfont)
        throw new Error("此版本不支持原版 gfont 字体，请选择普通字体或本地中心线字库；已有画布笔迹仍可使用");
      if (fontMode === "regular" && !font)
        throw new Error("请先选择 TTF / OTF 字体");
      if (fontMode === "glyph" && !glyphFont)
        throw new Error("请先从 PDF / 图片提取字形，或选择已有本地字库");
      if (!text.trim()) throw new Error("请输入文字内容");
      if (textPlacement === "lines") {
        if (!background?.processed || !background.guide_lines?.length) throw new Error("请先完成纸张背景设置并确认横线");
        if (fontMode === "legacy" && !legacySelection.length) throw new Error("请先选择原版 gfont 字体");
        const d = await call<Document>("lined_text_document", {
          font_mode: fontMode, path: fontMode === "glyph" ? glyphFont : font, selections: legacySelection, text,
          size_mm: template.font_size_mm, spacing_mm: template.letter_spacing_mm,
          guide_lines: background.guide_lines, start_line: lineStart, baseline_offset_mm: lineOffset,
          legacy_baseline: legacyBaseline, legacy_percent: legacyPercent, legacy_seed: legacySeed,
          centerline, options, width_mm: template.width_mm, height_mm: template.height_mm,
        });
        setDocument(d, fontMode, true); setShowExtraction(false); setScale(1); setRotation(0);
        notify(`已沿背景横线生成文字 · ${d.strokes.length} 条路径`);
        return;
      }
      if (fontMode === "legacy") {
        setDocument(null);
        setLegacyMissing([]);
        setLegacyChoices([]);
        if (!legacySelection.length) throw new Error("请先选择原版 gfont 字体");
        const result = await call<LegacyComposition>("legacy_font_document", {
          selections: legacySelection,
          text,
          options: {
            size_mm: template.font_size_mm,
            spacing_ratio: template.letter_spacing_mm / template.font_size_mm,
            line_spacing_ratio:
              (template.height_mm - 2 * template.margin_mm) /
              template.lines /
              template.font_size_mm,
            baseline: legacyBaseline,
            font_size_percent: legacyPercent,
            page_width_mm: template.width_mm - 2 * template.margin_mm,
            seed: legacySeed,
          },
        });
        setLegacyMissing(result.missing);
        setLegacyChoices(result.choices);
        if (result.missing.length)
          throw new Error(
            `原版字库缺字：${result.missing.join(" ")}；未把缺字作业作为完整预览使用`,
          );
        setDocument(result.document, "legacy");
        setAllowReverse(false);
        setShowExtraction(false);
        setScale(1);
        setRotation(0);
        notify(
          `已按原版笔顺生成 · ${result.document.strokes.length} 条路径 · 选字方案已冻结`,
        );
        return;
      }
      const d = await call<Document>(
        fontMode === "glyph" ? "glyph_font_document" : "font_document",
        {
          path: fontMode === "glyph" ? glyphFont : font,
          text,
          size_mm: template.font_size_mm,
          spacing_mm: template.letter_spacing_mm,
          rows: template.lines,
          width_mm: template.width_mm - 2 * template.margin_mm,
          height_mm: template.height_mm - 2 * template.margin_mm,
          centerline,
          options,
        },
      );
      setDocument(d, fontMode);
      setShowExtraction(false);
      setScale(1);
      setRotation(0);
      notify(`已生成文字路径 · ${d.strokes.length} 条路径`);
    });
  }
  async function compareCurrentPdf() {
    if (!source || !/\.pdf$/i.test(source)) {
      setComparisonError("请先在导入区选择 PDF，再生成当前页面的拟合走线对照");
      return;
    }
    const ticket = ++comparisonRequest.current,
      key = comparisonKey;
    setComparing(true);
    setComparisonError("");
    setComparisonVariants([]);
    try {
      const variants = await call<ComparisonVariant[]>("import_comparison", {
        path: source,
        options,
      });
      if (
        ticket === comparisonRequest.current &&
        key === comparisonCurrentKey.current
      )
        setComparisonVariants(variants);
    } catch (e) {
      if (
        ticket === comparisonRequest.current &&
        key === comparisonCurrentKey.current
      )
        setComparisonError(String(e));
    } finally {
      if (
        ticket === comparisonRequest.current &&
        key === comparisonCurrentKey.current
      )
        setComparing(false);
    }
  }
  function openLegacyFonts() {
    setDraftLegacySelection(legacySelection.map((s) => ({ ...s })));
    setLegacyFocus(legacySelection[0]?.path || legacyFonts[0]?.path || "");
    setModal("legacy");
  }
  async function importLegacyFonts() {
    if (editingBlocked()) return;
    await work("导入原版字体", async () => {
      const paths = await open({
        multiple: true,
        filters: [{ name: "原版字体", extensions: ["gfont"] }],
      });
      if (!paths) return;
      const imported = await call<LegacyFont[]>("import_legacy_fonts", {
        paths: Array.isArray(paths) ? paths : [paths],
      });
      setLegacyFonts(await call<LegacyFont[]>("list_legacy_fonts"));
      if (imported[0]) setLegacyFocus(imported[0].path);
      setDraftLegacySelection((v) => [
        ...v,
        ...imported
          .filter((f) => !v.some((s) => s.path === f.path))
          .map((f) => ({ path: f.path, weight: 1 })),
      ]);
      notify(`已导入 ${imported.length} 个原版 gfont 字体`);
    });
  }
  async function convert(path = source, page = options.page) {
    if (editingBlocked()) return;
    await work("转换文档路径", async () => {
      if (!path) throw new Error("请先选择文件");
      setDocument(null);
      setShowExtraction(false);
      const d = await call<Document>("import_document", {
        path,
        options: { ...options, page },
      });
      setExtractionDocument(d);
      setDocument(
        /\.pdf$/i.test(path)
          ? {
              ...d,
              name: `${d.name} · 第 ${page} 页 · 阈值 ${options.threshold}${options.conservative ? " · 保守拟合" : ""}`,
            }
          : d,
      );
      setAllowReverse(!preparedDoc?.materials?.some((m) => m.kind === "legacy"));
      setCropWindow([0, 0, d.width_mm, d.height_mm]);
      setScale(1);
      setRotation(0);
      notify(`已转换 ${fileName(path)} · ${d.strokes.length} 条路径`);
    });
  }
  async function saveGlyph() {
    if (editingBlocked()) return;
    await work("保存字形到本地字库", async () => {
      if (!extractionDocument) throw new Error("请先转换 PDF 或图片");
      if (Array.from(glyphCharacter.trim()).length !== 1)
        throw new Error("请绑定一个字符，不自动识别文字");
      if (!libraryName.trim()) throw new Error("请填写字库名");
      if (cropWindow[2] <= cropWindow[0] || cropWindow[3] <= cropWindow[1])
        throw new Error("选区右下角必须大于左上角");
      const result = await call<GlyphFont>("save_glyph", {
        library_name: libraryName.trim(),
        character: glyphCharacter.trim(),
        document: extractionDocument,
        window: cropWindow,
      });
      setGlyphFonts(await call<GlyphFont[]>("list_glyph_fonts"));
      setGlyphFont(result.path);
      notify(
        `已将“${glyphCharacter.trim()}”保存到 ${result.name} · 共 ${result.characters.length} 个字符`,
      );
    });
  }
  const [clipboardFiles, setClipboardFiles] = useState<ClipboardFile[]>([]);
  const choosingFile = useRef(false);
  const [readingClipboard, setReadingClipboard] = useState(false);
  async function useImportFile(path: string) {
    if (editingBlocked() || busy) return;
    if (/\.(inkproj|kjoy)$/i.test(path)) { await openProjectFile(path); return; }
    setSource(path);
    setTab("file");
    setOptions((o) => ({ ...o, page: 1 }));
    setPageCount(null);
    if (/\.pdf$/i.test(path)) {
      call<number>("pdf_page_count", { path, python_path: options.python_path })
        .then(setPageCount).catch((e) => notify(String(e), true));
    }
    await convert(path, 1);
  }
  async function chooseFile() {
    if (editingBlocked() || busy || choosingFile.current) return;
    choosingFile.current = true;
    setLeftOpen(true); setLeftTab("materials"); setTab("file");
    setClipboardFiles([]);
    try { await browseFile(); }
    finally { choosingFile.current = false; }
  }
  async function readClipboard() {
    if (editingBlocked() || busy || choosingFile.current) return;
    setLeftOpen(true); setLeftTab("materials"); setTab("file");
    choosingFile.current = true;
    setReadingClipboard(true);
    setClipboardFiles([]);
    try {
      let files: ClipboardFile[] = [];
      try { files = await call<ClipboardFile[]>("clipboard_files") || []; }
      catch (e) { notify(String(e), true); return; }
      if (editingBlocked()) return;
      if (files.length) setClipboardFiles(files);
      else notify("剪贴板中没有可导入的图片或文件");
    } finally { choosingFile.current = false; setReadingClipboard(false); }
  }
  async function browseFile() {
    if (editingBlocked()) return;
    if (busy) return;
    try {
      const path = await open({
        multiple: false,
        filters: [
          {
            name: "图形与文档",
            extensions: ["inkproj", "kjoy", "svg", "pdf", "png", "jpg", "jpeg", "json"],
          },
        ],
      });
      if (typeof path !== "string" || editingBlocked()) return;
      await useImportFile(path);
    } catch (e) {
      notify(
        desktop ? String(e) : "浏览器仅展示界面；请使用桌面应用打开本地文件",
        true,
      );
    }
  }
  function importBackground(kind: "pdf" | "image" = "pdf", newPage = false) {
    if (editingBlocked() || busy) return;
    if (kind === "pdf") { void importPdfBackground(newPage); return; }
    paperPreviousSetup.current = registrationSetup ? structuredClone(registrationSetup) : null;
    setPaperDraftSize({ width_mm: template.width_mm, height_mm: template.height_mm });
    setPaperWizard({ kind, newPage }); setPaperPreview(null); setPaperCalibrated(false); setPaperCalibrationStarted(false);
    setLeftOpen(true); setLeftTab("board"); setShowExtraction(false);
  }
  async function importPdfBackground(newPage: boolean) {
    if (choosingFile.current || editingBlocked() || busy) return;
    choosingFile.current = true;
    try {
      const path = await open({ multiple: false, filters: [{ name: "PDF 背景", extensions: ["pdf"] }] });
      if (typeof path !== "string" || editingBlocked()) return;
      await work("导入 PDF 全部页面", async () => {
        const first = await call<BackgroundPage>("pdf_background_page", { path, page: 1 });
        if (editingBlocked()) return;
        const count = first.page_count;
        if (!Number.isInteger(count) || count < 1 || canvasPageCount + count - (newPage ? 0 : 1) > 200) throw new Error("PDF 导入后页面总数不能超过 200 页");
        const imported = [first];
        for (let page = 2; page <= count; page++) imported.push(await call<BackgroundPage>("pdf_background_page", { path, page }));
        if (editingBlocked()) return;
        const pages = snapshotLayoutPages();
        const nextLayouts = [...layouts];
        const groups = new Map<string, Layout>();
        let firstIndex = newPage ? pages.length : canvasPage;
        imported.forEach((bg, index) => {
          const width = bg.width_mm!, height = bg.height_mm!;
          if (![width, height].every(v => Number.isFinite(v) && v > 0 && v <= 1000)) throw new Error("PDF 未返回有效页面尺寸");
          const key = `${width}:${height}`;
          let layout = groups.get(key);
          if (!layout) {
            layout = { ...template, id: crypto.randomUUID(), name: "自定义版面", source: "pdf", width_mm: width, height_mm: height, margin_mm: Math.min(template.margin_mm, width / 4, height / 4) };
            groups.set(key, layout); nextLayouts.push(layout);
          }
          const at = index === 0 ? firstIndex : pages.length;
          const existing = index === 0 && !newPage ? pages[at].document : emptyPage(width, height);
          const updated = applyLayoutToPages([{ document: existing, background: null }], layout, [0])[0];
          pages[at] = { ...updated, background: { ...bg, data_url: index === 0 ? bg.data_url : "", path, page: index + 1, page_count: count, kind: "pdf", width_mm: width, height_mm: height } };
        });
        await invalidatePageCalibration(true);
        installLayoutPages(pages, nextLayouts, firstIndex);
        setBackgroundVisible(true); setLeftOpen(true); setLeftTab("board");
        notify(`已铺好 ${count} 页 PDF 背景 · 使用实际页面尺寸 · 请完成纸面定位`);
      });
    } catch (error) { notify(String(error), true); }
    finally { choosingFile.current = false; }
  }
  function layoutTemplate(layout: Layout): Template {
    const { source: _source, derivation: _derivation, scale_x: _sx, scale_y: _sy, ...value } = layout;
    return value;
  }
  function snapshotLayoutPages(): Project["pages"] {
    const current = { ...(preparedDoc || emptyPage(currentLayout.width_mm, currentLayout.height_mm)), width_mm: currentLayout.width_mm, height_mm: currentLayout.height_mm, text_settings: { ...captureTextSettings(), font_size_mm: currentLayout.font_size_mm, letter_spacing_mm: currentLayout.letter_spacing_mm } };
    return projectPages(current, canvasPage, pageDocuments.current, backgroundPages, currentLayout.width_mm, currentLayout.height_mm).map((page, i) => ({ ...page, layout_id: pageLayoutIds[i] || currentLayout.id }));
  }
  function installLayoutPages(pages: Project["pages"], definitions: Layout[], index = canvasPage) {
    const used = definitions.filter(l => pages.some(p => p.layout_id === l.id));
    pageDocuments.current = new Map(pages.map((p, i) => [i, p.document]));
    setBackgroundPages(pages.map(p => p.background || blankBackground()));
    setPageLayoutIds(pages.map(p => p.layout_id!)); setLayouts(used);
    const layout = used.find(l => l.id === pages[index].layout_id)!;
    activatePage(pages[index].document, index, layout);
  }
  async function changeLayout(next: Layout, selected: number[]) {
    if (editingBlocked() || paperWizard || busy || layoutChanging.current || !selected.length) return false;
    next = { ...next, scale_x: next.scale_x ?? currentLayout.scale_x, scale_y: next.scale_y ?? currentLayout.scale_y };
    layoutChanging.current = true;
    setBusy("更新版面");
    try {
      const pages = snapshotLayoutPages();
      const updated = applyLayoutToPages(pages, next, selected);
      const activeChanged = updated[canvasPage].layout_id !== pages[canvasPage].layout_id || next.id === currentLayout.id && (next.width_mm !== currentLayout.width_mm || next.height_mm !== currentLayout.height_mm);
      const resized = activeChanged ? resizePositioning(registrationSetup || { points: [[currentLayout.width_mm, 0], [15, currentLayout.height_mm - 15]], show_points: true, selected_profile: "" }, currentLayout, next) : null;
      if (activeChanged) await invalidatePageCalibration(true);
      if (editingBlocked()) return false;
      installLayoutPages(updated, [...layouts.filter(l => l.id !== next.id), next]);
      if (resized) {
        setRestoreSetup(previous => ({ version: (previous?.version || 0) + 1, value: resized.setup }));
        setRegistrationSetup(resized.setup); setRegistrationPointEdit(null);
        setOriginDraft(resized.origin); setPenDraft(resized.pen);
      }
      return true;
    } catch (error) { notify(String(error), true); return false; }
    finally { layoutChanging.current = false; setBusy(""); }
  }
  async function syncPageScale(layout: Layout) {
    const sx = layout.scale_x ?? 1, sy = layout.scale_y ?? 1;
    const next = scaledRegistration(sx, sy, confirmedOrigin ? registration.rotation_deg : 0);
    if (confirmedOrigin) {
      if (!await command({ type: "set_registration_scale", scales: [sx, sy] })) throw new Error("未能应用页面比例，已保留当前页面与设置");
    }
    setRegistration(next);
    if (!confirmedOrigin && layout.scale_x !== undefined) { setAutomaticOrigin(false); setProjectNeedsAlignment(true); }
  }
  async function applyPageScale(scales: [number, number], selected: number[]) {
    if (machineBusy || busy || registrationLocked || paperWizard || !selected.length) return false;
    setBusy("应用书写比例");
    try {
      const updated = applyScaleToPages(snapshotLayoutPages(), layouts, scales, selected);
      if (selected.includes(canvasPage)) await syncPageScale({ ...currentLayout, scale_x: scales[0], scale_y: scales[1] });
      setLayouts(updated.layouts); setPageLayoutIds(updated.pages.map(p => p.layout_id!));
      return true;
    } catch (error) { notify(String(error), true); return false; }
    finally { setBusy(""); }
  }
  async function completeCalibration() {
    const scales = registrationScales(registration);
    const updated = applyScaleToPages(snapshotLayoutPages(), layouts, scales, [canvasPage]);
    setBusy("保存校准比例");
    try {
      await syncPageScale({ ...currentLayout, scale_x: scales[0], scale_y: scales[1] });
      if (!paperWizard) { setLayouts(updated.layouts); setPageLayoutIds(updated.pages.map(p => p.layout_id!)); }
      if (registrationSetup) setProjectCalibration({ ...registrationSetup, origin: confirmedOrigin, registration: scaledRegistration(...scales), profiles: [] });
      if (paperWizard) setPaperCalibrated(true);
      const [a, b, c, d] = registrationMatrix(registration);
      notify(Math.abs(a * b + c * d) > scales[0] * scales[1] * 1e-6 ? "已保存横纵比例与本次旋转；三点结果含斜切，请核对纸面贴合效果" : "已保存当前页比例；本次旋转仅在当前连接中有效");
      requestAnimationFrame(fitPaper);
    } catch (error) { notify(String(error), true); }
    finally { setBusy(""); }
  }
  async function invalidatePageCalibration(needsAlignment: boolean) {
    if (!await command({ type: "forget_calibration" })) throw new Error("设备状态变更，未切换页面，请停稳后重试");
    preservedRegistrationRef.current = null;
    setConfirmedOrigin(null); setRegistration(identityRegistration);
    setMachineOriginReady(false); setProjectCalibration(null);
    setRegistrationLocked(false); setSessionVersion(v => v + 1); setProjectNeedsAlignment(needsAlignment);
    setAutomaticOrigin(!needsAlignment);
    const defaultOrigin = registrationSetup?.points[0] || [template.width_mm, 0];
    setOriginDraft(needsAlignment ? [...defaultOrigin] : null);
    setPenDraft(null);
  }
  function activatePage(next: Document, index: number, layout = layouts.find(l => l.id === pageLayoutIds[index]) || currentLayout) {
    setCanvasPage(index); setSourceDocument(next); setEditedDocument(next);
    setTemplate(layoutTemplate(layout)); setSelectedTemplateId("");
    setRotation(0); setScale(1); setShowExtraction(false); setRouteInspection(null); restoreTextSettings(next);
  }
  async function switchCanvasPage(index: number) {
    if (editingBlocked() || busy || index === canvasPage || index < 0 || index >= canvasPageCount) return;
    await work("切换画板页面", async () => {
      let target = backgroundPages[index] || blankBackground();
      const next = pageDocuments.current.get(index) || emptyPage(template.width_mm, template.height_mm);
      if (!target.data_url && target.path) {
        const rendered = target.kind === "image" ? await call<BackgroundPage>("paper_background", { path: target.path, page: 1, width_mm: next.width_mm, height_mm: next.height_mm, process: false, remove_shadow: false, corners: null, python_path: options.python_path }) : await call<BackgroundPage>("pdf_background_page", { path: target.path, page: target.page });
        target = { ...target, data_url: rendered.data_url };
      }
      if (editingBlocked()) return;
      await syncPageScale(layouts.find(l => l.id === pageLayoutIds[index]) || currentLayout);
      if (preparedDoc) pageDocuments.current.set(canvasPage, { ...preparedDoc, text_settings: captureTextSettings() });
      setBackgroundPages(pages => Array.from({ length: canvasPageCount }, (_, i) => i === index ? target : pages[i] || blankBackground()));
      activatePage(next, index);
    });
  }
  async function addPage(addition: PageAddition) {
    if (editingBlocked() || busy || canvasPageCount >= 200) return;
    if (addition.kind === "pdf" || addition.kind === "image") { importBackground(addition.kind, true); return; }
    await work("添加页面", async () => {
      const current = { ...(preparedDoc || emptyPage(template.width_mm, template.height_mm)), text_settings: captureTextSettings() };
      const copied = addition.kind === "copy" ? (addition.index === canvasPage ? current : pageDocuments.current.get(addition.index)) : null;
      if (addition.kind === "copy" && !copied) throw new Error("源页面不存在");
      const next = copied ? structuredClone(copied) : emptyPage(addition.kind === "blank" ? addition.width : template.width_mm, addition.kind === "blank" ? addition.height : template.height_mm);
      if (copied) next.strokeIds = next.strokes.map(() => crypto.randomUUID());
      const bg = addition.kind === "copy" ? structuredClone(backgroundPages[addition.index] || blankBackground()) : blankBackground();
      const sourceLayout = addition.kind === "copy" ? layouts.find(l => l.id === pageLayoutIds[addition.index])! : currentLayout;
      const layout: Layout = next.width_mm === sourceLayout.width_mm && next.height_mm === sourceLayout.height_mm ? sourceLayout : { ...sourceLayout, id: crypto.randomUUID(), name: "自定义版面", source: "manual", width_mm: next.width_mm, height_mm: next.height_mm, margin_mm: Math.min(sourceLayout.margin_mm, next.width_mm / 4, next.height_mm / 4), derivation: undefined };
      await syncPageScale(layout);
      setLayouts(existing => existing.some(l => l.id === layout.id) ? existing : [...existing, layout]);
      setPageLayoutIds(ids => [...ids, layout.id]);
      pageDocuments.current.set(canvasPage, current);
      pageDocuments.current.set(canvasPageCount, next);
      setBackgroundPages(pages => [...Array.from({ length: canvasPageCount }, (_, i) => pages[i] || blankBackground()), bg]);
      activatePage(next, canvasPageCount, layout);
      notify(addition.kind === "copy" ? "已复制页面及背景横线，无需重复处理；换纸后请重新对准" : "已添加空白页面");
    });
  }
  async function beginPaperCalibration() {
    if (machineBusy || busy || !paperPreview) return false;
    const pending = paperWizardRef.current;
    if (!await command({ type: "forget_calibration" })) return false;
    setPaperCalibrationStarted(true);
    setPaperCalibrated(false); setConfirmedOrigin(null); setRegistration(identityRegistration); setAutomaticOrigin(false);
    setSessionVersion(v => v + 1); setLeftOpen(true); setLeftTab("board");
    return !!pending && paperWizardRef.current === pending;
  }
  function applyPaperBackground(value: BackgroundPage) {
    if (!paperWizard || !paperCalibrated || !connected || !confirmedOrigin || status.state !== "Idle" || registrationLocked || machineBusy || busy) return;
    try {
      const size = paperDraftSize || template;
      const [scale_x, scale_y] = registrationScales(registration);
      const layout: Layout = { ...template, ...size, scale_x, scale_y, id: crypto.randomUUID(), name: "自定义版面", source: "image", margin_mm: Math.min(template.margin_mm, size.width_mm / 4, size.height_mm / 4) };
      const pages = snapshotLayoutPages();
      const index = paperWizard.newPage ? pages.length : canvasPage;
      if (paperWizard.newPage) pages.push({ document: emptyPage(layout.width_mm, layout.height_mm), background: null });
      const updated = applyLayoutToPages(pages, layout, [index]);
      updated[index].background = { ...value, width_mm: layout.width_mm, height_mm: layout.height_mm };
      installLayoutPages(updated, [...layouts, layout], index);
      setPaperWizard(null); setPaperDraftSize(null); setPaperPreview(null); setBackgroundVisible(true); setProjectNeedsAlignment(false);
      notify("纸张背景、横线及纸面定位已应用；工作原点已同步");
    } catch (error) { notify(String(error), true); }
  }
  async function cancelPaperBackground() {
    if (machineBusy || busy) return;
    if (registrationLocked && !await command({ type: "cancel_registration" })) return;
    if (paperCalibrationStarted) await invalidatePageCalibration(!!backgroundPages[canvasPage]?.path);
    if (paperPreviousSetup.current) setRestoreSetup({ version: Date.now(), value: paperPreviousSetup.current });
    setPaperWizard(null); setPaperDraftSize(null); setTemplate(layoutTemplate(currentLayout)); setPaperPreview(null); setPaperCalibrated(false); setRegistrationLocked(false);
  }
  async function sourceCode() {
    await work("生成作业源码", async () => {
      if (!document) throw new Error("请先生成或导入路径");
      if (!automaticOrigin && (!confirmedOrigin || registrationLocked)) throw new Error("请先完成纸面定位，再生成固定原点的作业代码");
      const value = await call<string>("generate_gcode", {
        job: job(await currentRoute()),
        relative: false,
        origin: automaticOrigin ? null : confirmedOrigin,
        registration: automaticOrigin ? null : registration,
      });
      setCode(value);
      setModal("code");
      notify("已生成 G-code，可审阅与导出");
    });
  }
  async function start() {
    if (jobLockRef.current || !canRun || !document) {
      notify(runReason || "转换进行中，请稍后再开始", true);
      return;
    }
    const request = routeRequest!;
    const frozenJob = { feed, travel_feed: travelFeed, z_feed: zFeed, z_down: zDown };
    submittedStrokes.current = pendingDoc;
    setActiveJobDocument(preparedDoc);
    setActiveRoute(null);
    const epoch = ++submissionEpoch.current;
    setJobTiming(beginJobTiming(epoch));
    lockJob(true);
    setPaused(false);
    setProgress({ sent: 0, total: 0 });
    try {
      const snapshot = await route.ensure(request);
      if (submissionEpoch.current !== epoch || !jobLockRef.current) return;
      setActiveRoute(snapshot);
      submittedOrderedIds.current = snapshot.stroke_order.map((index) => pendingDoc?.strokeIds?.[index] || "");
      const submitted = await command({ type: "run", job: { ...frozenJob, document: snapshot.document } });
      if (!submitted && submissionEpoch.current === epoch) {
        lockJob(false);
        setJobTiming((state) => cancelJobTiming(state, Date.now()));
      }
    } catch (error) {
      if (submissionEpoch.current === epoch) {
        lockJob(false);
        setJobTiming((state) => cancelJobTiming(state, Date.now()));
        setActiveRoute(null);
        notify(`走线规划失败，未启动任务：${String(error)}`, true);
      }
    }
  }

  async function exportFile(format: "svg" | "json" | "gcode") {
    await work("导出文件", async () => {
      if (!document) throw new Error("请先生成路径");
      if (format === "gcode" && !automaticOrigin && (!confirmedOrigin || registrationLocked)) throw new Error("请先完成纸面定位，再导出固定原点的作业代码");
      const path = await save({
        defaultPath: `书写任务.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!path) return;
      if (format === "gcode")
        await call("export_gcode", {
          path,
          job: job(await currentRoute()),
          origin: automaticOrigin ? null : confirmedOrigin,
        registration: automaticOrigin ? null : registration,
        });
      else
        await call("export_document", { path, format, document: (await currentRoute()).document });
      notify(`已导出 ${fileName(path)}`);
    });
  }
  function buildProjectSnapshot(): Project {
    const setup = registrationSetup || { points: [[template.width_mm, 0], [15, template.height_mm - 15]], show_points: true, selected_profile: "" };
    return {
      pages: snapshotLayoutPages(), layouts,
      current_page: canvasPage, template: layoutTemplate(currentLayout),
      writing: { feed, travel_feed: travelFeed, z_feed: zFeed, z_down: zDown, jog_step: jogStep },
      routing: { optimize: optimizeTrajectory, allow_reverse: allowReverse, allow_gap: allowWritingGap, max_gap: maxWritingGap, deduplicate: deduplicateWriting },
      calibration: { ...setup, ...(projectNeedsAlignment && !setup.point3 && projectCalibration?.point3 ? { point3: projectCalibration.point3 } : {}), origin: projectNeedsAlignment ? originDraft || projectCalibration?.origin || null : confirmedOrigin, registration: scaledRegistration(currentLayout.scale_x ?? 1, currentLayout.scale_y ?? 1), profiles: [] },
      conversion: { dpi: options.dpi, threshold: options.threshold, conservative: options.conservative, tolerance_mm: options.tolerance_mm, filter_iterations: options.filter_iterations, error_threshold: options.error_threshold, line_threshold: options.line_threshold, despeckle_level: options.despeckle_level },
      background_visible: backgroundVisible, show_margins: showMargins,
    } satisfies Project;
  }
  const projectSnapshot = useMemo(buildProjectSnapshot, [preparedDoc, canvasPage, backgroundPages, template, layouts, pageLayoutIds, feed, travelFeed, zFeed, zDown, jogStep, optimizeTrajectory, allowReverse, allowWritingGap, maxWritingGap, deduplicateWriting, registrationSetup, projectNeedsAlignment, projectCalibration, confirmedOrigin, originDraft, registration, registrationProfiles, options, backgroundVisible, showMargins, text, fontMode, font, glyphFont, legacySelection, legacyPercent, legacyBaseline, legacySeed, centerline, textPlacement, lineStart, lineOffset]);
  const projectSnapshotRef = useRef(projectSnapshot);
  projectSnapshotRef.current = projectSnapshot;
  const files = useProjectFiles({ snapshot: projectSnapshot, path: projectPath, onPath: setProjectPath,
    blocked: editingBlocked() || !!busy, desktop,
    onSave: async (path, project) => { await call("save_project", { path, project }); },
    onOpen: restoreProject, onNew: resetProject, onMessage: notify });
  async function saveProject() { await files.saveProject(); }
  async function openProjectFile(path?: string) { await files.openProject(path); }
  async function resetProject() {
    const previous = JSON.stringify(projectSnapshotRef.current);
    if (!await command({ type: "forget_calibration" })) throw new Error("设备状态变更，请停稳后新建工程");
    if (previous !== JSON.stringify(projectSnapshotRef.current)) throw new Error("工程内容在等待期间发生变化，未新建工程，请重试");
    const empty = emptyPage(initialTemplate.width_mm, initialTemplate.height_mm);
    pageDocuments.current = new Map(); setBackgroundPages([]); setCanvasPage(0);
    setOriginDraft(null); setPenDraft(null); setSourceDocument(empty); setEditedDocument(empty); setTemplate(initialTemplate); setSelectedTemplateId(initialTemplate.id);
    setLayouts([{ ...initialTemplate, source: "template" }]); setPageLayoutIds([initialTemplate.id]);
    preservedRegistrationRef.current = null; setProjectCalibration(null); setProjectNeedsAlignment(false); setConfirmedOrigin(null);
    setMachineOriginReady(false);
    setRegistration(identityRegistration); setAutomaticOrigin(true); setRegistrationSetup(null);
    setRestoreSetup({ version: Date.now(), value: { points: [[210, 0], [15, 282]], show_points: true, selected_profile: "" } });
    setRegistrationLocked(false); setRegistrationPointEdit(null);
    setProjectRevision(v => v + 1); setRotation(0); setScale(1); setSource(""); setPageCount(null);
    setExtractionDocument(null); setShowExtraction(false); setClipboardFiles([]);
    setPaperWizard(null); setPaperPreview(null); setPaperCalibrated(false); setPaperCalibrationStarted(false);
    setText(""); setTextPlacement("free"); setLineStart(0); setLineOffset(0.5);
    setWrittenIds(new Set()); setProgress({ sent: 0, total: 0 }); setJobTiming(emptyJobTiming);
    setActiveRoute(null); setRouteInspection(null); setRouteComparison(null); setRouteComparisonError("");
    notify("已新建空白工程");
  }
  async function restoreProject(selected: string) {
    const previous = JSON.stringify(projectSnapshotRef.current);
    setBusy("打开完整工程");
    try {
      const value = await call<Project>("open_project", { path: selected });
      const normalized = normalizeLayouts(value.pages, value.template, value.layouts, value.calibration.registration);
      value.pages = normalized.pages; value.layouts = normalized.layouts;
      value.template = layoutTemplate(normalized.layouts.find(l => l.id === value.pages[value.current_page]?.layout_id)!);
      const background = value.pages[value.current_page].background;
      if (background?.path && !background.data_url) {
        const rendered = background.kind === "image" ? await call<BackgroundPage>("paper_background", { path: background.path, page: 1, width_mm: value.template.width_mm, height_mm: value.template.height_mm, process: false, remove_shadow: false, corners: null, python_path: options.python_path }) : await call<BackgroundPage>("pdf_background_page", { path: background.path, page: background.page });
        background.data_url = rendered.data_url;
      }
      if (editingBlocked()) throw new Error("设备状态变更，未替换当前工程");
      if (previous !== JSON.stringify(projectSnapshotRef.current)) throw new Error("工程内容在打开期间发生变化，未替换当前工程，请重试");
      if (!await command({ type: "forget_calibration" })) throw new Error("设备状态变更，请停稳后打开工程");
      projectLoaded.current = true;
      setLayouts(normalized.layouts); setPageLayoutIds(normalized.pages.map(p => p.layout_id!)); setSelectedTemplateId("");
      pageDocuments.current = new Map(value.pages.map((p, i) => [i, p.document]));
      setTemplate(layoutTemplate(normalized.layouts.find(l => l.id === value.pages[value.current_page].layout_id)!));
      const next = value.pages[value.current_page].document;
      restoreTextSettings(next);
      setPaperWizard(null); setPaperPreview(null); setPaperCalibrated(false); setPaperCalibrationStarted(false);
      setSourceDocument(next); setEditedDocument(next); setCanvasPage(value.current_page);
      setBackgroundPages(value.pages.map(p => p.background || { path: "", page: 1, page_count: 1, data_url: "" }));
      setBackgroundVisible(value.background_visible); setShowMargins(value.show_margins);
      setFeed(value.writing.feed); setTravelFeed(value.writing.travel_feed); setZFeed(value.writing.z_feed); setZDown(value.writing.z_down); setJogStep(value.writing.jog_step);
      setOptimizeTrajectory(value.routing.optimize); setAllowReverse(value.routing.allow_reverse); setAllowWritingGap(value.routing.allow_gap); setMaxWritingGap(value.routing.max_gap); setDeduplicateWriting(value.routing.deduplicate);
      setOptions(o => ({ ...o, ...value.conversion, page: 1 })); setCustomFit(false);
      const calibration = value.calibration;
      const savedOrigin = calibration.origin?.length === 2 && calibration.origin.every(Number.isFinite) ? calibration.origin : calibration.points[0];
      const activeLayout = normalized.layouts.find(l => l.id === normalized.pages[value.current_page].layout_id)!;
      const preservedRegistration = scaledRegistration(activeLayout.scale_x ?? 1, activeLayout.scale_y ?? 1);
      const candidate = calibration.origin && Math.hypot(calibration.points[1][0] - calibration.points[0][0], calibration.points[1][1] - calibration.points[0][1]) >= 100 && calibration.points.every(point => point.every((p, i) => p >= 0 && p <= (i ? value.template.height_mm : value.template.width_mm)))
        ? { id: "project-current", name: "工程中的校准方案", width_mm: value.template.width_mm, height_mm: value.template.height_mm, point1: calibration.points[0], point2: calibration.points[1], ...(calibration.point3 ? { point3: calibration.point3 } : {}), ...calibration.registration } : null;
      setRegistrationProfiles(current => [...current.filter(p => !calibration.profiles.some(q => q.id === p.id) && p.id !== "project-current"), ...calibration.profiles.filter(p => !candidate || p.id !== candidate.id), ...(candidate ? [candidate] : [])]);
      setOriginDraft(null); setPenDraft(null); setProjectCalibration({ ...calibration, origin: savedOrigin }); setProjectNeedsAlignment(true); setConfirmedOrigin(null); setRegistration(preservedRegistration); setAutomaticOrigin(false);
      preservedRegistrationRef.current = preservedRegistration;
      setMachineOriginReady(false);
      setRegistrationLocked(false); setRegistrationPointEdit(null);
      setRestoreSetup({ version: Date.now(), value: { points: calibration.points, show_points: calibration.show_points, selected_profile: candidate ? candidate.id : calibration.selected_profile } });
      setProjectRevision(v => v + 1); setProjectPath(selected);
      setRotation(0); setScale(1); setSource(""); setPageCount(null); setExtractionDocument(null); setShowExtraction(false); setClipboardFiles([]);
      setWrittenIds(new Set()); setProgress({ sent: 0, total: 0 }); setJobTiming(emptyJobTiming); setActiveRoute(null); setRouteInspection(null); setRouteComparison(null); setRouteComparisonError("");
      setLeftOpen(true); setLeftTab("board");
      notify(`已打开工程 ${fileName(selected)}；请用两点校准当前旋转，缩放比例沿用保存值`);
    } finally { setBusy(""); }
  }
  async function saveTemplate() {
    if (editingBlocked()) return;
    await work("保存模板", async () => {
      const value = { ...template, id: `custom-${Date.now()}` };
      await call("save_template", { template: value });
      setTemplates(await call<Template[]>("list_templates"));
      setSelectedTemplateId(value.id);
      notify("模板已保存到本机模板库");
    });
  }
  async function importTemplate() {
    if (editingBlocked()) return;
    await work("导入模板", async () => {
      const path = await open({
        multiple: false,
        filters: [{ name: "版面模板 JSON", extensions: ["json"] }],
      });
      if (typeof path === "string" && !editingBlocked()) {
        const value = await call<Template>("import_template", { path });
        if (await changeLayout({ ...value, id: currentLayout.id, source: "template" }, sharedPages)) setSelectedTemplateId(value.id);
        setTemplates(await call<Template[]>("list_templates"));
        notify("模板已导入");
      }
    });
  }
  async function exportTemplate() {
    await work("导出版面模板", async () => {
      const path = await save({
        defaultPath: `${template.name}.json`,
        filters: [{ name: "版面模板 JSON", extensions: ["json"] }],
      });
      if (path) {
        await call("export_template", { path, template });
        notify("版面模板 JSON 已导出");
      }
    });
  }
  async function deleteTemplate() {
    if (editingBlocked()) return;
    await work("删除模板", async () => {
      await call("delete_template", { id: selectedTemplateId });
      setTemplates(await call<Template[]>("list_templates"));
      setSelectedTemplateId("");
      notify("自定义模板已删除");
    });
  }

  const pathCount = document?.strokes.length || 0;
  const paperWidth = template.width_mm * Math.max(0.2, paperFit) * zoom,
    paperHeight = template.height_mm * Math.max(0.2, paperFit) * zoom;
  return (
    <DocumentEditLock.Provider value={!editPolicy.canEditDocument}>
    <div className="studio">
          <header className="topbar native-titlebar">
            <span className="titlebar-brand" aria-label="OpenInk Studio"><PenLine size={18} /></span>
            <nav className="application-menus" aria-label="应用菜单" onClick={event => {
              const button = (event.target as Element).closest("button");
              if (button && !button.disabled) event.currentTarget.querySelectorAll("details").forEach(menu => menu.open = false);
            }}>
              <details className="workspace-menu application-menu"><summary>文件</summary><div>
                <button disabled={!editPolicy.canEditDocument || files.pending} onClick={() => void files.newProject()}>新建工程<kbd>Ctrl+N</kbd></button>
                <button title="打开工程" disabled={!editPolicy.canEditDocument || files.pending} onClick={() => void openProjectFile()}>打开工程<kbd>Ctrl+O</kbd></button>
                {!!files.recent.length && <details className="recent-projects"><summary>最近打开</summary>{files.recent.map(path => <button key={path} title={path} disabled={!editPolicy.canEditDocument || files.pending} onClick={() => void openProjectFile(path)}>{fileName(path)}</button>)}</details>}
                <hr />
                <button title="保存工程" disabled={!editPolicy.canEditDocument || files.pending} onClick={saveProject}>保存<kbd>Ctrl+S</kbd></button>
                <button disabled={!editPolicy.canEditDocument || files.pending} onClick={() => void files.saveProject(true)}>另存为…<kbd>Ctrl+Shift+S</kbd></button>
                <button disabled={!editPolicy.canEditDocument || files.pending} onClick={() => void files.newProject()}>关闭工程</button>
                <hr />
                <button disabled={!editPolicy.canEditDocument} onClick={chooseFile}>导入素材…</button>
                <button disabled={!document || !!busy} onClick={() => exportFile("svg")}>导出 SVG</button>
                <button disabled={!document || !!busy} onClick={() => exportFile("json")}>导出 JSON</button>
                <button disabled={!document || !!busy} onClick={() => exportFile("gcode")}>导出 G-code</button>
              </div></details>
              <details className="workspace-menu application-menu"><summary>编辑</summary><div>
                <button disabled={!activeEditor.canUndo} onClick={activeEditor.undo}>撤销<kbd>Ctrl+Z</kbd></button>
                <button disabled={!activeEditor.canRedo} onClick={activeEditor.redo}>重做<kbd>Ctrl+Y</kbd></button>
                <hr />
                <button disabled={!activeEditor.canCopy} onClick={activeEditor.cut}>剪切<kbd>Ctrl+X</kbd></button>
                <button disabled={!activeEditor.canCopy} onClick={activeEditor.copy}>复制<kbd>Ctrl+C</kbd></button>
                <button disabled={!activeEditor.canPaste} onClick={activeEditor.paste}>粘贴<kbd>Ctrl+V</kbd></button>
                <button disabled={!activeEditor.canSelectAll} onClick={activeEditor.selectAll}>全选<kbd>Ctrl+A</kbd></button>
                <button disabled={!activeEditor.canCopy} onClick={activeEditor.remove}>删除<kbd>Delete</kbd></button>
              </div></details>
            </nav>
            <div className="titlebar-drag" onMouseDown={event => dragWindow(event, desktop, message => notify(message, true))} title={projectPath || "未命名工程"}>
              <span className="titlebar-project">{projectPath ? fileName(projectPath) : "未命名工程"}{files.dirty && <span className="titlebar-dirty" aria-label="未保存更改"> ●</span>}</span>
            </div>
            <div className="topbar-actions">
              {!desktop && (
                <span className="preview-badge">浏览器预览 · 未接入设备</span>
              )}
              <button className={`button connection-badge ${connected ? "online" : ""}`} onClick={() => { setRightOpen(true); setRightTab("machine"); }} title="打开机器连接与控制">
                <i />
                {connected ? `${connected} 已连接` : "设备未连接"}
              </button>
              {!rightOpen && <button className="button danger" disabled={!connected} onClick={stopJob}><Square size={13} />停止</button>}
              <details className="workspace-menu"><summary aria-label="工作台菜单"><ChevronDown size={16} /></summary><div>
                <button onClick={() => setModal("templates")}><BookOpen size={15} />模板库</button>
                <button onClick={() => setModal("logs")}><Terminal size={15} />通信日志</button>
                <button onClick={() => setModal("settings")}><Settings2 size={15} />设置</button>
                <button onClick={() => setModal("help")}><HelpCircle size={15} />使用说明</button>
              </div></details>
              <button className="button panel-toggle" aria-label="规划与机器侧栏" aria-pressed={rightOpen} title={rightOpen ? "收起规划与机器侧栏" : "展开规划与机器侧栏"} onClick={() => setRightOpen(!rightOpen)}>{rightOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
            </div>
            <WindowControls desktop={desktop} onError={message => notify(message, true)} />
          </header>
      <fieldset className="recovery-lock" disabled={recovering}>
        <nav className="activity-rail" aria-label="左侧面板">
          <button title="素材" aria-label="素材" aria-pressed={leftOpen && leftTab === "materials"} onClick={() => { setLeftOpen(!(leftOpen && leftTab === "materials")); setLeftTab("materials"); }}><Type size={21} /><span>素材</span></button>
          <button title="画板" aria-label="画板" aria-pressed={leftOpen && leftTab === "board"} onClick={() => { setLeftOpen(!(leftOpen && leftTab === "board")); setLeftTab("board"); }}><Layers3 size={21} /><span>画板</span></button>
          <button className="activity-settings" title="设置" aria-label="设置" onClick={() => setModal("settings")}><Settings2 size={21} /></button>
        </nav>
        <div className="workspace">

          <main className={`editor-grid ${!leftOpen ? "left-collapsed" : ""} ${!rightOpen ? "right-collapsed" : ""}`}>
            <aside className="left-panel panel" hidden={!leftOpen}>
              <div className="sidebar-heading">{leftTab === "materials" ? "素材" : "画板"}</div>
              <fieldset className="panel-fieldset" disabled={machineBusy}>
                <div className="panel-scroll">
                  <div className="workspace-tab-content" hidden={leftTab !== "board"}>
                  {paperWizard ? <PaperBackgroundWizard key={`${paperWizard.kind}-${paperWizard.newPage}`} kind={paperWizard.kind} width={paperDraftSize?.width_mm || template.width_mm} height={paperDraftSize?.height_mm || template.height_mm} python={options.python_path} locked={machineBusy || !!busy} calibrated={paperCalibrated} canvasHost={paperCornerHost} onStageChange={setPaperStage} onGuideEditor={setPaperGuideEditor} onPreview={setPaperPreview} onCalibration={beginPaperCalibration} onApply={applyPaperBackground} onCancel={() => void cancelPaperBackground()} onSizeChange={(width_mm, height_mm) => setPaperDraftSize({ width_mm, height_mm })} /> : <Section icon={<Layers3 size={17} />} title="纸张背景">
                    <button className="button" disabled={!editPolicy.canEditDocument} onClick={() => importBackground("pdf")}>导入 PDF 作为背景</button>
                    <button className="button" disabled={!editPolicy.canEditDocument} onClick={() => importBackground("image")}>导入照片作为背景</button>
                    <p className="field-note">PDF 直接铺好全部页面；照片经四角拉平、确认横线后进行纸面定位。</p>
                    {background?.path && <><p className="field-note">{fileName(background.source_path || background.path)} · 第 {background.page} 页</p>
                      <Toggle checked={backgroundVisible} onChange={setBackgroundVisible} label="显示背景" />
                      {!!background.guide_lines?.length && <Toggle checked={background.guides_visible !== false} onChange={visible => setBackgroundPages(pages => pages.map((p, i) => i === canvasPage ? { ...p, guides_visible: visible } : p))} label="显示全部定位横线" />}
                    </>}
                  </Section>}
                  <fieldset className="panel-fieldset" disabled={!!paperWizard}><Section
                    icon={<Layers3 size={17} />}
                    title="版面设置"
                    aside={
                      <button
                        className="text-button"
                        onClick={() => setModal("templates")}
                      >
                        模板库 <ChevronRight size={12} />
                      </button>
                    }
                  >
                    <button
                      className="template-card"
                      onClick={() => setModal("templates")}
                    >
                      <div className="mini-page">
                        <span />
                        <span />
                        <span />
                        <span />
                      </div>
                      <div>
                        <strong>{currentLayout.source === "template" ? template.name : "自定义版面"}</strong>
                        <small>
                          {template.width_mm} × {template.height_mm} mm ·{" "}
                          {template.lines} 行 · {sharedPages.length} 页共用
                        </small>
                      </div>
                      <ChevronDown size={16} />
                    </button>
                    <div className="field-grid">
                      <NumberField
                        label="页面宽度"
                        value={template.width_mm}
                        onChange={(v) => updateTemplate("width_mm", v)}
                        min={20}
                        max={500}
                      />
                      <NumberField
                        label="页面高度"
                        value={template.height_mm}
                        onChange={(v) => updateTemplate("height_mm", v)}
                        min={20}
                        max={500}
                      />
                      <NumberField
                        label="页边距"
                        value={template.margin_mm}
                        onChange={(v) => updateTemplate("margin_mm", v)}
                        min={0}
                        max={
                          Math.min(template.width_mm, template.height_mm) / 2 -
                          1
                        }
                      />
                      <NumberField
                        label="行数"
                        value={template.lines}
                        onChange={(v) => updateTemplate("lines", Math.round(v))}
                        min={1}
                        max={100}
                        unit="行"
                      />
                      <NumberField
                        label="字号"
                        value={template.font_size_mm}
                        onChange={(v) => updateTemplate("font_size_mm", v)}
                        min={1}
                        max={80}
                      />
                      <NumberField
                        label="字间距"
                        value={template.letter_spacing_mm}
                        onChange={(v) => updateTemplate("letter_spacing_mm", v)}
                        min={0}
                        max={20}
                        step={0.5}
                      />
                    </div>
                    <p className="field-note">{sharedPages.length > 1 ? `共享版面 · 已用于 ${sharedPages.length} 页` : "独立版面 · 当前页"}；修改设置会同步到同组页面。</p>
                    <fieldset className="panel-fieldset" disabled={machineBusy || !!busy || registrationLocked}>
                      <div className="field-grid">
                        <NumberField label="横向比例" unit="%" value={Number(((currentLayout.scale_x ?? 1) * 100).toFixed(4))} min={10} max={1000} step={0.01} onChange={v => void applyPageScale([v / 100, currentLayout.scale_y ?? 1], sharedPages)} />
                        <NumberField label="纵向比例" unit="%" value={Number(((currentLayout.scale_y ?? 1) * 100).toFixed(4))} min={10} max={1000} step={0.01} onChange={v => void applyPageScale([currentLayout.scale_x ?? 1, v / 100], sharedPages)} />
                      </div>
                      <p className="field-note">比例随工程保存，原版尺寸保持不变。</p>
                      <p className="field-note" role="status" aria-label="本次旋转">本次旋转：<strong>{connected && confirmedOrigin && !registrationLocked && !projectNeedsAlignment ? `${registration.rotation_deg > 0 ? "+" : ""}${registration.rotation_deg.toFixed(3)}° · 临时` : "待校准"}</strong><br />仅本次连接有效，不随工程保存。</p>
                    </fieldset>
                    <div className="calibration-controls">
                      <button className="button primary full" disabled={!editPolicy.canEditDocument || !!busy} onClick={() => setLayoutDialog(true)}>应用到页面…</button>
                    </div>
                    <button className="save-template" onClick={saveTemplate}>
                      <Save size={14} />
                      保存为新模板
                    </button>
                  </Section></fieldset>
                <Section icon={<MousePointer2 size={17} />} title="纸面定位">
                  <RegistrationPanel secondPointVersion={secondPointVersion} onPositioningStarted={() => { setRightOpen(true); setRightTab("machine"); }} onComplete={() => void completeCalibration()} restoreSetup={restoreSetup} onSetupChange={setRegistrationSetup} travelFeed={travelFeed} pointEdit={registrationPointEdit} editLocked={machineBusy || !!busy || showExtraction} onPointsChange={setRegistrationPoints} errorVersion={registrationErrorVersion} width={template.width_mm} height={template.height_mm} origin={confirmedOrigin} registration={paperWizard || confirmedOrigin ? registration : scaledRegistration(currentLayout.scale_x ?? 1, currentLayout.scale_y ?? 1)} ready={canJog && !busy} positioning={positioning} calibrationVersion={calibrationVersion} sessionVersion={sessionVersion} preserveScale={!paperWizard && currentLayout.scale_x !== undefined} onLock={setRegistrationLocked} onCommand={async request => { if (!canJog || busy) return false; if (request.type !== "cancel_registration") setPositioning(true); const ok = await command(request); if (!ok) setPositioning(false); return ok; }} />
                  <button className="button full" onClick={() => { setRightOpen(true); setRightTab("machine"); }}>点动微调笔尖 <ChevronRight size={14} /></button>
                  <div className="field-note" aria-label="当前页坐标系">当前页坐标系：{currentLayout.name} · {sharedPages.length} 页共用 · {currentLayout.width_mm.toFixed(1)} × {currentLayout.height_mm.toFixed(1)} mm</div>
                  <p className="field-note">换纸后，将笔尖对准本页相同的工作原点，点击“将当前位置设为工作原点”即可继续。重连后须重新校准。</p>
                </Section>
                  </div>
                  <div className="workspace-tab-content" hidden={leftTab !== "materials"}>
                  <Section icon={<Type size={17} />} title="插入素材">
                    <div className="segmented">
                      <button
                        className={tab === "text" ? "active" : ""}
                        onClick={() => setTab("text")}
                      >
                        输入文字
                      </button>
                      <button
                        className={tab === "file" ? "active" : ""}
                        onClick={() => setTab("file")}
                      >
                        导入文件
                      </button>
                    </div>
                    {!!preparedDoc?.materials?.length && <div className="material-list" aria-label="画布素材">
                      {preparedDoc.materials.map((material) => <div key={material.id} className="material-item">
                        <span>{material.name}<small>{preparedDoc.strokeOwners?.filter((id) => id === material.id).length || 0} 条路径</small></span>
                        <button className="icon-button" title={`删除素材 ${material.name}`} onClick={() => {
                          const current = preparedDoc!;
                          const remove = new Set(current.strokeOwners?.flatMap((owner, i) => owner === material.id ? [i] : []) || []);
                          editor.commitAll({ ...current, materials: current.materials?.filter((m) => m.id !== material.id), strokes: current.strokes.filter((_, i) => !remove.has(i)), strokeIds: current.strokeIds?.filter((_, i) => !remove.has(i)), strokeOwners: current.strokeOwners?.filter((_, i) => !remove.has(i)) });
                        }}><X size={14}/></button>
                      </div>)}
                      <p className="field-note">继续插入可叠加素材；在画布框选、移动和调整尺寸。</p>

                    </div>}
                    {tab === "text" ? (
                      <>
                        <Field label="字体来源">
                          <select
                            className="full-select"
                            value={fontMode}
                            onChange={(e) => {
                              setDocument(null);
                              setLegacyMissing([]);
                              setLegacyChoices([]);
                              setFontMode(
                                e.target.value as
                                  "regular" | "glyph" | "legacy",
                              );
                            }}
                          >
                            <option value="regular">
                              普通字体 · TTF / OTF
                            </option>
                            <option value="glyph">本地中心线字库</option>
                            {privateGfont && <option value="legacy">原版 gfont 字体</option>}
                            {!privateGfont && fontMode === "legacy" && <option value="legacy" disabled>原版字体（此版本不支持）</option>}
                          </select>
                        </Field>
                        {fontMode === "regular" ? (
                          <>
                            <Field label="书写字体">
                              <div className="font-select-row">
                                <select
                                  aria-label="书写字体"
                                  value={font}
                                  onChange={(e) => setFont(e.target.value)}
                                >
                                  <option value="">选择常规字体</option>
                                  {font &&
                                    !fonts.some((f) => f.path === font) && (
                                      <option value={font}>
                                        {fileName(font)}
                                      </option>
                                    )}
                                  {fonts.map((f) => (
                                    <option key={f.path} value={f.path}>
                                      {f.name}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  className="icon-button bordered"
                                  title="浏览字体文件"
                                  onClick={chooseFont}
                                >
                                  <FolderOpen size={16} />
                                </button>
                              </div>
                            </Field>
                          </>
                        ) : fontMode === "glyph" ? (
                          <>
                            <Field label="本地字库">
                              <div className="font-select-row">
                                <select
                                  value={glyphFont}
                                  onChange={(e) => setGlyphFont(e.target.value)}
                                >
                                  <option value="">选择已提取的字库</option>
                                  {glyphFonts.map((f) => (
                                    <option key={f.path} value={f.path}>
                                      {f.name} · {f.characters.length} 字
                                    </option>
                                  ))}
                                </select>
                                <button
                                  className="icon-button bordered"
                                  title="刷新本地字库"
                                  onClick={() =>
                                    work("刷新字库", async () =>
                                      setGlyphFonts(
                                        await call<GlyphFont[]>(
                                          "list_glyph_fonts",
                                        ),
                                      ),
                                    )
                                  }
                                >
                                  <RefreshCw size={15} />
                                </button>
                              </div>
                            </Field>
                            <p className="glyph-characters">
                              已收录：
                              {glyphFonts
                                .find((f) => f.path === glyphFont)
                                ?.characters.join(" ") ||
                                "尚无字形，请从 PDF / 图片手动绑定字符"}
                            </p>
                          </>
                        ) : null}
                        {privateGfont && fontMode === "legacy" && (
                          <>
                            <button
                              className="legacy-picker"
                              onClick={openLegacyFonts}
                            >
                              <BookOpen size={18} />
                              <div>
                                <strong>
                                  {legacySelection.length
                                    ? `已选择 ${legacySelection.length} 个原版字体`
                                    : "选择原版 gfont 字体"}
                                </strong>
                                <small>
                                  {legacySelection
                                    .map(
                                      (s) =>
                                        legacyFonts.find(
                                          (f) => f.path === s.path,
                                        )?.display || fileName(s.path),
                                    )
                                    .join("、") ||
                                    "支持多选与权重分配，保持原始笔顺"}
                                </small>
                              </div>
                              <ChevronRight size={15} />
                            </button>
                            <div className="field-grid">
                              <NumberField
                                label="字体大小比例"
                                value={legacyPercent}
                                onChange={setLegacyPercent}
                                min={1}
                                max={200}
                                unit="%"
                              />
                              <NumberField
                                label="基线比例"
                                value={legacyBaseline}
                                onChange={setLegacyBaseline}
                                min={0}
                                max={2}
                                step={0.05}
                                unit="×"
                              />
                              <NumberField
                                label="选字种子"
                                value={legacySeed}
                                onChange={(v) => setLegacySeed(Math.round(v))}
                                min={0}
                                max={2147483647}
                                unit=""
                              />
                            </div>
                            <p className="field-note">
                              直接解析 gfont 原始路径，不转字体轮廓或
                              AutoTrace。多字体按权重选字，同一种子可复现。
                            </p>
                            {legacyMissing.length > 0 && (
                              <div className="inline-error">
                                缺少字符：{legacyMissing.join(" ")}
                              </div>
                            )}
                            {legacyChoices.length > 0 && (
                              <p className="field-note">
                                当前预览已冻结 {legacyChoices.length}{" "}
                                次选字，不会在发送时重新抽选。
                              </p>
                            )}
                          </>
                        )}
                        <Field label="编辑内容" hint={`${text.length} 字`}>
                          <textarea
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            rows={5}
                            placeholder="写下你想表达的文字…"
                          />
                        </Field>
                        <div className="field-grid"><NumberField label="字号" value={template.font_size_mm} onChange={v => updateTemplate("font_size_mm", v)} min={1} max={80} /><NumberField label="字间距" value={template.letter_spacing_mm} onChange={v => updateTemplate("letter_spacing_mm", v)} min={0} max={20} step={0.5} /></div>
                        <div className="text-layout-options"><label className="paper-field">文字排版<select className="text-input" value={textPlacement} onChange={e => setTextPlacement(e.target.value as "free" | "lines")}><option value="free">自由排版</option><option value="lines">沿背景横线排版</option></select></label>
                          {textPlacement === "lines" && (background?.processed && background.guide_lines?.length ? <div className="paper-fields"><label>起始横线<select className="text-input" value={lineStart} onChange={e => setLineStart(Number(e.target.value))}>{background.guide_lines.map((line, i) => <option key={line.id} value={i}>第 {guideLineNumber(line, i)} 行</option>)}</select></label><label>离横线 / mm<DraftNumberInput className="text-input" type="number" value={lineOffset} min={0} max={10} step={0.1} onChange={e => setLineOffset(Number(e.target.value))} /></label></div> : <><p className="field-note">当前页没有已确认的横线，请先设置纸张背景。</p><button className="button" onClick={() => importBackground("image")}>设置纸张背景</button></>)}
                        </div>
                        {fontMode === "regular" && (
                          <>
                            <Toggle
                              checked={centerline}
                              onChange={setCenterline}
                              label="提取字体中心线"
                            />
                            <p className="field-note">
                              {centerline
                                ? "通过 AutoTrace 提取中心线，转换在后台完成。"
                                : "使用标准字体轮廓，不依赖私有字体格式。"}
                            </p>
                          </>
                        )}
                        <button
                          className="button primary full inline-submit"
                          disabled={!!busy}
                          onClick={generateText}
                        >
                          {busy === "生成文字路径" ? (
                            <LoaderCircle className="spin" size={16} />
                          ) : (
                            <PenLine size={16} />
                          )}
                          插入文字到画布
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="upload-zone" hidden={clipboardFiles.length > 0} disabled={readingClipboard} onClick={chooseFile}>
                          <span>
                            <Upload size={22} />
                          </span>
                          <strong>
                            {source ? fileName(source) : "选择要书写的文件"}
                          </strong>
                          <small>SVG · PDF · PNG · JPEG · 轨迹 JSON</small>
                        </button>
                        <button className="button full" hidden={clipboardFiles.length > 0} disabled={readingClipboard || !!busy} onClick={() => void readClipboard()}>
                          {readingClipboard ? "正在读取剪贴板…" : "从剪贴板读取图片或文件"}
                        </button>
                        {clipboardFiles.length > 0 && <ClipboardImport key={clipboardFiles.map(f => f.path).join("|")}
                          files={clipboardFiles} disabled={machineBusy || !!busy}
                          onUse={path => { setClipboardFiles([]); void useImportFile(path); }}
                          onBrowse={() => void chooseFile()}
                          onCancel={() => setClipboardFiles([])}
                        />}
                        {source && /\.pdf$/i.test(source) && (
                          <div className="pdf-pages">
                            <span>PDF 页面</span>
                            <button
                              className="icon-button"
                              disabled={options.page <= 1 || !!busy}
                              onClick={() =>
                                setOptions((o) => ({ ...o, page: o.page - 1 }))
                              }
                            >
                              <ArrowLeft size={14} />
                            </button>
                            <DraftNumberInput
                              type="number"
                              value={options.page}
                              min={1}
                              max={pageCount || 10000}
                              onChange={(e) =>
                                setOptions((o) => ({
                                  ...o,
                                  page: Math.max(
                                    1,
                                    Math.min(
                                      pageCount || 10000,
                                      Number(e.target.value) || 1,
                                    ),
                                  ),
                                }))
                              }
                            />
                            <span>/ {pageCount || "—"}</span>
                            <button
                              className="icon-button"
                              disabled={
                                options.page >= (pageCount || 10000) || !!busy
                              }
                              onClick={() =>
                                setOptions((o) => ({ ...o, page: o.page + 1 }))
                              }
                            >
                              <ArrowRight size={14} />
                            </button>
                          </div>
                        )}
                        <Field label="转换预设">
                          <select
                            className="full-select"
                            value={preset}
                            onChange={(e) => applyPreset(e.target.value)}
                          >
                            <option value="180-default">
                              阈值 180 · 默认拟合
                            </option>
                            <option value="128-default">
                              阈值 128 · 默认拟合
                            </option>
                            <option value="180-conservative">
                              阈值 180 · 保守拟合
                            </option>
                            <option value="custom">自定义参数</option>
                          </select>
                        </Field>
                        <div className="threshold-row">
                          <span>
                            二值化阈值 <strong>{options.threshold}</strong>
                          </span>
                          <input
                            type="range"
                            min={1}
                            max={254}
                            value={options.threshold}
                            onChange={(e) =>
                              setOptions((o) => ({
                                ...o,
                                threshold: Number(e.target.value),
                              }))
                            }
                          />
                          <small>默认 180，适用于 PDF 与图片</small>
                        </div>
                        <Toggle
                          checked={options.conservative}
                          onChange={(v) =>
                            applyPreset(v ? "180-conservative" : "180-default")
                          }
                          label="保守拟合模式"
                        />
                        <details className="advanced-trace">
                          <summary>
                            <Settings2 size={14} />
                            高级转换参数
                            <ChevronDown size={13} />
                          </summary>
                          <p className="field-note">
                            当前生效：预平滑{" "}
                            {options.conservative
                              ? 0
                              : options.filter_iterations}{" "}
                            次；曲线误差{" "}
                            {options.conservative
                              ? 0.5
                              : options.error_threshold}{" "}
                            px；直线误差{" "}
                            {options.conservative
                              ? 0.5
                              : options.line_threshold}{" "}
                            px。
                          </p>
                          <div className="field-grid">
                            {(
                              [
                                {
                                  key: "filter_iterations",
                                  label: "预平滑次数",
                                  max: 20,
                                  step: 1,
                                  unit: "次",
                                },
                                {
                                  key: "error_threshold",
                                  label: "曲线拟合误差",
                                  max: 20,
                                  step: 0.1,
                                  unit: "px",
                                },
                                {
                                  key: "line_threshold",
                                  label: "直线判定误差",
                                  max: 20,
                                  step: 0.1,
                                  unit: "px",
                                },
                                {
                                  key: "despeckle_level",
                                  label: "去斑等级",
                                  max: 20,
                                  step: 1,
                                  unit: "级",
                                },
                              ] as const
                            ).map((item) => (
                              <NumberField
                                key={item.key}
                                label={item.label}
                                value={options[item.key]}
                                onChange={(v) => {
                                  setCustomFit(true);
                                  setOptions((o) => ({
                                    ...o,
                                    conservative: false,
                                    [item.key]:
                                      item.step === 1 ? Math.round(v) : v,
                                  }));
                                }}
                                min={item.step === 1 ? 0 : 0.01}
                                max={item.max}
                                step={item.step}
                                unit={item.unit}
                              />
                            ))}
                            <NumberField
                              label="栅格分辨率"
                              value={options.dpi}
                              onChange={(v) =>
                                setOptions((o) => ({ ...o, dpi: v }))
                              }
                              min={36}
                              max={1200}
                              unit="dpi"
                            />
                            <NumberField
                              label="路径展平误差"
                              value={options.tolerance_mm}
                              onChange={(v) =>
                                setOptions((o) => ({ ...o, tolerance_mm: v }))
                              }
                              min={0.005}
                              max={1}
                              step={0.005}
                            />
                          </div>
                          <p className="field-note">
                            拟合误差以像素计，路径展平误差以毫米计。调整拟合字段后使用自定义参数。
                          </p>
                        </details>
                        <button
                          className="comparison-link"
                          onClick={() => setModal("comparison")}
                        >
                          <Layers3 size={14} />
                          查看参数对照
                          <ChevronRight size={13} />
                        </button>
                        <p className="field-note">
                          阈值增大可保留浅墨，也可能引入噪声；线条更顺不代表没有漏笔。
                        </p>
                        {extractionDocument && /\.(pdf|png|jpe?g)$/i.test(source) && (
                          <details
                            className="glyph-extraction"
                            open={showExtraction}
                            onToggle={(e) =>
                              setShowExtraction(e.currentTarget.open)
                            }
                          >
                            <summary>
                              <BookOpen size={15} />
                              提取到本地字库
                              <ChevronDown size={13} />
                            </summary>
                            <p className="field-note">
                              仅提取最近导入的文件（不含其他画布素材）。手动指定原文档单字区域并绑定字符；不执行 OCR。
                            </p>
                            <Field label="字库名">
                              <input
                                className="text-input"
                                value={libraryName}
                                onChange={(e) => setLibraryName(e.target.value)}
                              />
                            </Field>
                            <Field label="绑定字符" hint="单个字符">
                              <input
                                className="text-input"
                                placeholder="例如：永"
                                value={glyphCharacter}
                                onChange={(e) =>
                                  setGlyphCharacter(e.target.value)
                                }
                              />
                            </Field>
                            <div className="field-grid">
                              {(
                                [
                                  "左上 X",
                                  "左上 Y",
                                  "右下 X",
                                  "右下 Y",
                                ] as const
                              ).map((label, i) => (
                                <NumberField
                                  key={label}
                                  label={label}
                                  value={cropWindow[i]}
                                  onChange={(v) =>
                                    setCropWindow(
                                      (w) =>
                                        w.map((n, k) => (k === i ? v : n)) as [
                                          number,
                                          number,
                                          number,
                                          number,
                                        ],
                                    )
                                  }
                                  min={0}
                                  max={
                                    i % 2 === 0
                                      ? extractionDocument.width_mm
                                      : extractionDocument.height_mm
                                  }
                                  step={0.5}
                                />
                              ))}
                            </div>
                            <p className="field-note">
                              原文档坐标，单位 mm；页面{" "}
                              {extractionDocument.width_mm.toFixed(1)} ×{" "}
                              {extractionDocument.height_mm.toFixed(1)}
                              。蓝色边框显示选区。
                            </p>
                            <button
                              className="button full glyph-save"
                              disabled={!!busy || !glyphCharacter.trim()}
                              onClick={saveGlyph}
                            >
                              <Save size={15} />
                              保存这个字形
                            </button>
                          </details>
                        )}
                        <button
                          className="button primary full inline-submit"
                          disabled={!source || !!busy}
                          onClick={() => convert()}
                        >
                          {busy === "转换文档路径" ? (
                            <LoaderCircle className="spin" size={16} />
                          ) : (
                            <RefreshCw size={16} />
                          )}
                          插入文件到画布
                          {source && /\.pdf$/i.test(source)
                            ? `第 ${options.page} 页`
                            : ""}
                        </button>
                      </>
                    )}
                  </Section>
                  <div className="tip-card">
                    <span className="tip-dot" />
                    <p>
                      素材可反复插入，已有内容保留。框选路径后移动、缩放或旋转；图片与 PDF 支持中心线提取。
                    </p>
                  </div>
                </div>
                </div>
                <div className="left-action" hidden={leftTab !== "materials"}>
                  <button
                    className="button primary full"
                    disabled={!!busy || (tab === "file" && !source)}
                    onClick={() =>
                      tab === "text" ? generateText() : convert()
                    }
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : tab === "text" ? (
                      <PenLine size={16} />
                    ) : (
                      <RefreshCw size={16} />
                    )}{" "}
                    {busy
                      ? busy
                      : tab === "text"
                        ? "插入文字到画布"
                        : "插入文件到画布"}
                  </button>
                  </div>
              </fieldset>
            </aside>
            <section className="canvas-panel">
              <div className="canvas-toolbar">
                <div className="canvas-edit-tools" role="group" aria-label="画布编辑工具">
                  <button className={`icon-button canvas-tool ${canvasTool === "select" && !placingOrigin ? "selected" : ""}`} aria-label="选择" aria-pressed={canvasTool === "select" && !placingOrigin} title="选择：选择或移动笔画" onClick={() => { setPlacingOrigin(false); setCanvasTool("select"); }}><MousePointer2 size={17} /></button>
                  <button className={`icon-button canvas-tool ${canvasTool === "pan" ? "selected" : ""}`} aria-label="拖动" aria-pressed={canvasTool === "pan"} title="拖动：拖动画布（也可按住空格）" onClick={() => { setPlacingOrigin(false); setCanvasTool("pan"); }}><Hand size={17} /></button>
                  <button className={`icon-button canvas-tool ${placingOrigin ? "selected" : ""}`} aria-label="设置工作原点" aria-pressed={placingOrigin} disabled={!canJog || !!busy || registrationLocked || showExtraction || !!paperWizard || (!confirmedOrigin && (currentLayout.scale_x !== undefined))} title="设置工作原点：已定位时点目标位置；未定位时点笔尖当前位置。自动抬笔并立即设置，无需确认" onClick={() => { setCanvasTool("select"); setPlacingOrigin(value => !value); }}><Crosshair size={17} /></button>
                  <span className="tool-divider" />
                  {activeEditor.toolbar}
                </div>
                <div className="transform-tools">
                  <RotateCw size={15} />
                  <DraftNumberInput
                    aria-label="旋转角度"
                    type="number"
                    value={rotation}
                    disabled={machineBusy || !!busy || showExtraction}
                    onChange={(e) =>
                      changeRotation(Number(e.target.value) || 0)
                    }
                  />
                  <span>°</span>
                  <span className="tool-divider" />
                  <ZoomIn size={15} />
                  <DraftNumberInput
                    aria-label="路径缩放"
                    type="number"
                    value={scale}
                    disabled={machineBusy || !!busy || showExtraction}
                    min={0.01}
                    max={10}
                    step={0.05}
                    onChange={(e) =>
                      changeScale(
                        Math.min(
                          10,
                          Math.max(0.01, Number(e.target.value) || 0.01),
                        ),
                      )
                    }
                  />
                  <span>×</span>
                </div>
                <div className="canvas-tools">
                  <button
                    className="fit-button"
                    disabled={
                      !document || machineBusy || !!busy || showExtraction
                    }
                    onClick={fitToPage}
                    title="按墨迹范围适配页面内区与 A4 工作范围（X210 / Y297 mm）"
                  >
                    适配画布
                  </button>
                  <button
                    className={
                      showMargins ? "icon-button selected" : "icon-button"
                    }
                    title="显示辅助线"
                    onClick={() => setShowMargins(!showMargins)}
                  >
                    <Layers3 size={16} />
                  </button>

                  <button
                    className="icon-button"
                    title="逆时针旋转"
                    disabled={machineBusy || !!busy || showExtraction}
                    onClick={() => changeRotation(rotation - 90)}
                  >
                    <RotateCcw size={16} />
                  </button>
                </div>
              </div>
              <div className="paper-host" ref={paperHost}>
                <div className="paper-corner-host" ref={setPaperCornerHost} hidden={!paperWizard || paperStage !== 1} />
                <div hidden={!!paperWizard && paperStage === 1} className={`paper-scroll ${pan.panActive ? "pan-ready" : ""} ${pan.panning ? "panning" : ""}`} tabIndex={0} aria-label="画布视图区" {...pan.bind}>
                  <CanvasPointerOverlay width={template.width_mm} height={template.height_mm} paperWidth={paperWidth} paperHeight={paperHeight} origin={coordinateOrigin} registration={registration} host={paperHost.current} onPlaceOrigin={placingOrigin ? setWorkOrigin : undefined}>
                  <div
                    className="paper"
                    style={{ width: paperWidth, height: paperHeight }}
                  >
                    <svg
                      viewBox={`0 0 ${template.width_mm} ${template.height_mm}`}
                      width="100%"
                      height="100%"
                    >
                      <defs>
                        <clipPath id="paper-clip">
                          <rect
                            width={template.width_mm}
                            height={template.height_mm}
                          />
                        </clipPath>
                      </defs>
                      <g id="registration-preview-content" clipPath="url(#paper-clip)">
                        {!showExtraction && backgroundVisible && background?.data_url && <image aria-label="PDF 背景（不可选中）" href={background.data_url} width={template.width_mm} height={template.height_mm} x={0} y={0} preserveAspectRatio="none" pointerEvents="none" />}
                        {showMargins && (
                          <g className="paper-guides">
                            <rect
                              x={template.margin_mm}
                              y={template.margin_mm}
                              width={Math.max(
                                0,
                                template.width_mm - template.margin_mm * 2,
                              )}
                              height={Math.max(
                                0,
                                template.height_mm - template.margin_mm * 2,
                              )}
                            />
                            {Array.from(
                              { length: template.lines - 1 },
                              (_, i) => (
                                <line
                                  key={i}
                                  x1={template.margin_mm}
                                  x2={template.width_mm - template.margin_mm}
                                  y1={
                                    template.margin_mm +
                                    ((template.height_mm -
                                      template.margin_mm * 2) *
                                      (i + 1)) /
                                      template.lines
                                  }
                                  y2={
                                    template.margin_mm +
                                    ((template.height_mm -
                                      template.margin_mm * 2) *
                                      (i + 1)) /
                                      template.lines
                                  }
                                />
                              ),
                            )}
                          </g>
                        )}
                        {!paperWizard && editor.layer}
                        {paperGuideEditor && <g className="guide-edit-layer">{guideEditor.layer}</g>}
                        {!showExtraction && background?.guides_visible !== false && visibleGuideLines?.map((line, index) => <g key={line.id} className="paper-guide" aria-label={`第 ${guideLineNumber(line, index)} 条横线`}>
                          <line className="paper-guideline" x1={line.start[0]} y1={line.start[1]} x2={line.end[0]} y2={line.end[1]} />
                          <text className="paper-guideline-label" x={line.start[0] + 1} y={line.start[1] - 1}>{guideLineNumber(line, index)}</text>
                        </g>)}
                        {!showExtraction && visibleRoute && <RouteOverlay snapshot={visibleRoute} selectedIndex={routeInspection?.index} />}
                        <CanvasCoordinates
                          draftPen={penDraft}
                          first={visibleRoute?.document.strokes.find((s) => s.length > 1)?.[0] || coordinateFirst}
                          origin={coordinateOrigin}
                          registration={registration}
                          position={coordinatePosition}
                          width={template.width_mm}
                          height={template.height_mm}
                          pixelsPerMm={paperWidth / template.width_mm}
                          startLabel="路径起点（计划）"
                        />
                        {cropPolygon && (
                          <polygon
                            points={cropPolygon}
                            fill="#625bd712"
                            stroke="#625bd7"
                            strokeWidth={0.4}
                            strokeDasharray="1 .7"
                          />
                        )}
                      </g>
                      {activeEditor.handles}
                      {!showExtraction && paperStage !== 2 && leftOpen && leftTab === "board" && registrationPoints && <RegistrationHandles previewHost={paperHost.current} points={registrationPoints} width={template.width_mm} height={template.height_mm} pixelsPerMm={paperWidth / template.width_mm} disabled={!editPolicy.canEditDocument} onCommit={(index, point) => setRegistrationPointEdit({ index, point })} onMessage={notify} />}
                    </svg>
                    {!document && (
                      <div className="paper-empty">
                        <div className="empty-pen">
                          <PenLine size={30} strokeWidth={1.2} />
                        </div>
                        <strong>每一份作品，从这里开始</strong>
                        <span>
                          输入文字或导入文件
                          <br />
                          生成可书写的真实路径
                        </span>
                      </div>
                    )}
                    <div className="paper-corner" />
                  </div>
                  </CanvasPointerOverlay>
                </div>
                <div
                  className={`paper-caption ${exceeds ? "overflow-warning" : ""}`}
                >
                  {!!preparedDoc?.strokeIds?.some((id) => writtenIds.has(id)) && <span className="written-summary">已书写 {preparedDoc.strokeIds.filter((id) => writtenIds.has(id)).length} 笔 · 后续跳过</span>}
                  <span>
                    {document
                      ? `墨迹 ${bounds.width.toFixed(1)} × ${bounds.height.toFixed(1)} mm`
                      : "空白画布"}
                  </span>
                  <i />
                  {exceeds
                    ? "超出区域，请调整大小或适配画布"
                    : `${template.width_mm} × ${template.height_mm} mm`}
                </div>
                {(document || confirmedOrigin) && (
                  <div className="coordinate-caption">
                    {coordinateMapping ? (
                      <>
                        <span>
                          <i className="coordinate-dot start" />
                          路径起点（计划）
                        </span>
                        <span>
                          <i className="coordinate-dot pen" />
                          当前笔尖
                        </span>
                        {originOutside ? (
                          <span className="origin-outside-note">
                            工作原点在纸面{originOutside} · 画布(
                            {coordinateMapping.origin.x.toFixed(2)},{" "}
                            {coordinateMapping.origin.y.toFixed(2)}) mm
                          </span>
                        ) : (
                          <span>
                            <i className="coordinate-dot origin" />
                            工作原点 (0,0)
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="coordinate-unknown">
                        {automaticOrigin ? "开始后显示任务原点与笔尖" : "等待原点与笔尖位置反馈"}
                      </span>
                    )}
                  </div>
                )}
                {!!busy && (
                  <div className="conversion-indicator">
                    <LoaderCircle className="spin" size={17} />
                    {busy}…
                  </div>
                )}
              </div>
              <div className="canvas-bottom">
                {activeEditor.historyToolbar}
                <div className="page-view-controls" role="group" aria-label="页面与视图">
              <PageNavigation page={canvasPage} count={canvasPageCount} width={template.width_mm} height={template.height_mm} disabled={!editPolicy.canEditDocument || !!paperWizard} onPage={switchCanvasPage} onAdd={addPage} />
                <div className="zoom-control">
                  <button
                    className="icon-button"
                    title="适应画布"
                    onClick={fitPaper}
                  >
                    <Maximize2 size={16} />
                  </button>
                  <button
                    className="icon-button"
                    title="缩小"
                    onClick={() => setZoom((z) => Math.max(0.3, z - 0.1))}
                  >
                    <Minus size={15} />
                  </button>
                  <button className="zoom-value" onClick={fitPaper}>
                    {Math.round(zoom * 100)}%<ChevronDown size={12} />
                  </button>
                  <button
                    className="icon-button"
                    title="放大"
                    onClick={() => setZoom((z) => Math.min(8, z + 0.1))}
                  >
                    <Plus size={15} />
                  </button>
                </div>

              </div>
              </div>
            </section>
            <aside className="right-panel panel" hidden={!rightOpen}>
              <nav className="workspace-tabs" aria-label="右侧面板">
                <button aria-pressed={rightTab === "properties"} onClick={() => setRightTab("properties")}>属性</button>
                <button aria-pressed={rightTab === "planning"} onClick={() => setRightTab("planning")}>线路</button>
                <button aria-pressed={rightTab === "machine"} onClick={() => setRightTab("machine")}>设备控制</button>
                <button aria-pressed={rightTab === "writing"} onClick={() => setRightTab("writing")}>书写</button>
              </nav>
              <div className="panel-scroll" ref={rightScroll}>
                <div className="workspace-tab-content section selection-properties" hidden={rightTab !== "properties"}>
                  {activeEditor.inspector || <div className="selection-empty"><strong>选区变换</strong><p className="field-note">在画布中选择路径后，可在这里编辑位置、尺寸和旋转。</p></div>}
                </div>
                <div className="workspace-tab-content" hidden={rightTab !== "planning"}>
                {visibleRoute && routeInspection && <p className="field-note" role="status">第 {routeInspection.index} 笔 · {routeInspection.kind} · ({routeInspection.from.x.toFixed(2)}, {routeInspection.from.y.toFixed(2)}) → ({routeInspection.to.x.toFixed(2)}, {routeInspection.to.y.toFixed(2)}) · {routeInspection.distance.toFixed(2)} mm</p>}
                <Section icon={<PenLine size={17} />} title="线路规划">
                      <button className="button" disabled={!!busy || !preparedDoc?.strokes.length} onClick={optimizeRoute}>重新计算走线</button>
                      <button className="button" disabled={machineBusy || !preparedDoc?.strokes.length} onClick={compareRouteOptions}>优化书写对照</button>
                      <fieldset className="panel-fieldset" disabled={machineBusy}>
                        <Toggle checked={optimizeTrajectory} onChange={setOptimizeTrajectory} label="优化轨迹" />
                        <Toggle checked={allowReverse} onChange={setAllowReverse} label="允许调整单条路径方向" />
                      </fieldset>
                      <p className="field-note">{optimizeTrajectory ? "仅优化笔序和方向，不合并笔画。" : "保留画布原笔顺；需要时再开启轨迹优化。"}合并连写请单独比较并选择书写方案。</p>
                      {!!routeStrokeCount && <div className="route-inspector">
                        <label className="field-label" htmlFor="route-stroke-index">定位笔序 · 共 {routeStrokeCount} 笔</label>
                        <div className="route-step-controls">
                          <button className="button" disabled={(routeInspection?.index || 1) <= 1} onClick={() => selectRouteStroke((routeInspection?.index || 1) - 1)}>上一笔</button>
                          <DocumentEditLock.Provider value={false}>
                            <DraftNumberInput id="route-stroke-index" aria-label="定位笔序" type="number" min={1} max={routeStrokeCount} value={routeInspection?.index || 1} onChange={(e) => selectRouteStroke(Number(e.target.value))} />
                          </DocumentEditLock.Provider>
                          <button className="button" onClick={() => selectRouteStroke(routeInspection?.index || 1)}>定位</button>
                          <button className="button" disabled={(routeInspection?.index || 1) >= routeStrokeCount} onClick={() => selectRouteStroke((routeInspection?.index || 1) + 1)}>下一笔</button>
                        </div>
                        {routeInspection && <p className="field-note" role="status">第 {routeInspection.index} 笔已高亮 · {routeInspection.kind} · 画布长度 {routeInspection.distance.toFixed(2)} mm；箭头指向实际书写方向</p>}
                      </div>}
                      <p className="field-note" role="status">{route.status === "planning" ? "正在准备走线…" : route.status === "error" ? `走线规划失败：${route.error}，请重新计算` : visibleRoute ? `${optimizeTrajectory ? "轨迹优化" : "原笔顺"}：空移 ${visibleRoute.before_distance_mm.toFixed(1)} → ${visibleRoute.after_distance_mm.toFixed(1)} mm；按笔序定位查看单笔方向` : "插入素材后准备走线"}</p>
                      {!automaticOrigin && registration.matrix && <p className="field-note">按画布坐标排序，空移长度按三点校准后的实际路径计算。</p>}
                </Section>
                </div>
                <div className="workspace-tab-content" hidden={rightTab !== "machine"}>
                <Section
                  icon={<Usb size={17} />}
                  title="设备连接"
                  aside={
                    <span
                      className={`small-status ${connected ? "online" : ""}`}
                    >
                      <i />
                      {connected ? "已连接" : "离线"}
                    </span>
                  }
                >
                  <fieldset disabled={machineBusy} className="panel-fieldset">
                    <Toggle
                      checked={autoConnect}
                      onChange={(v) => {
                        setAutoConnect(v);
                        if (v && !connected) command({ type: "auto_connect" });
                      }}
                      label="自动识别连接"
                    />
                  </fieldset>
                  <div className="port-row">
                    <select
                      aria-label="串口"
                      disabled={machineBusy}
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                    >
                      <option value="">选择设备串口</option>
                      {ports.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                          {p.preferred ? " · CH340" : ""} {p.description}
                        </option>
                      ))}
                    </select>
                    <button
                      className="icon-button bordered"
                      title="刷新串口"
                      disabled={machineBusy}
                      onClick={() => command({ type: "scan" })}
                    >
                      <RefreshCw size={15} />
                    </button>
                  </div>
                  <button
                    className={`button full ${connected ? "" : "dark"}`}
                    disabled={machineBusy || (!port && !connected)}
                    onClick={() =>
                      command(
                        connected
                          ? { type: "disconnect" }
                          : { type: "connect", port },
                      )
                    }
                  >
                    {connected ? <Unplug size={15} /> : <Power size={15} />}{" "}
                    {connected ? "断开连接" : "连接设备"}
                  </button>
                  {(recovering || connectionError || (!connected && jobLocked)) && (
                    <div className="recover-card">
                      <button
                        className="button full"
                        disabled={!port || recovering || positioning || !!connected && running}
                        onClick={recoverConnection}
                      >
                        {recovering ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <RefreshCw size={15} />
                        )}
                        清除旧任务并恢复连接
                      </button>
                      <p>
                        清除旧任务、恢复连接并自动抬笔后，可重新开始。
                      </p>
                    </div>
                  )}
                  <div className="protocol-note">
                    <span /> GRBL 1.1 <span className="middle-dot" /> 115200
                    baud
                  </div>
                </Section>
                <Section icon={<MousePointer2 size={17} />} title="手动控制">
                  <div className="speed-row">
                    <span>
                      <i className="speed-dot travel" />
                      移动速度
                    </span>
                    <div className="inline-number">
                      <DraftNumberInput
                        aria-label="移动速度"
                        type="number"
                        positive
                        value={travelFeed}
                        disabled={machineBusy}
                        onChange={(e) => setTravelFeed(Number(e.target.value))}
                      />
                      <small>mm/min</small>
                    </div>
                  </div>

                  <div className="jog-layout">
                    <div className="jog-pad">
                      <button
                        className="jog up"
                        disabled={!canJog}
                        onClick={() =>
                          command({
                            type: "jog",
                            x: 0,
                            y: jogStep,
                            feed: travelFeed,
                          })
                        }
                      >
                        <ArrowUp size={17} />
                      </button>
                      <button
                        className="jog left"
                        disabled={!canJog}
                        onClick={() =>
                          command({
                            type: "jog",
                            x: -jogStep,
                            y: 0,
                            feed: travelFeed,
                          })
                        }
                      >
                        <ArrowLeft size={17} />
                      </button>
                      <div className="jog-center">XY</div>
                      <button
                        className="jog right"
                        disabled={!canJog}
                        onClick={() =>
                          command({
                            type: "jog",
                            x: jogStep,
                            y: 0,
                            feed: travelFeed,
                          })
                        }
                      >
                        <ArrowRight size={17} />
                      </button>
                      <button
                        className="jog down"
                        disabled={!canJog}
                        onClick={() =>
                          command({
                            type: "jog",
                            x: 0,
                            y: -jogStep,
                            feed: travelFeed,
                          })
                        }
                      >
                        <ArrowDown size={17} />
                      </button>
                    </div>
                    <div className="jog-step">
                      <span>移动步长</span>
                      <select
                        aria-label="移动步长"
                        disabled={machineBusy}
                        value={jogStep}
                        onChange={(e) => setJogStep(Number(e.target.value))}
                      >
                        {[0.1, 0.5, 1, 5, 10].map((n) => (
                          <option key={n} value={n}>
                            {n} mm
                          </option>
                        ))}
                      </select>
                      <small>方向键点动 · Shift ×2</small>
                    </div>
                  </div>
                  <div className="pen-buttons">
                    <button
                      className="button"
                      disabled={!canPen}
                      onClick={() => command({ type: "pen_up" })}
                    >
                      <ArrowUp size={14} />
                      抬笔 <small>Z0</small>
                    </button>
                    <button
                      className="button"
                      disabled={!canPen}
                      onClick={() => command({ type: "pen_down", depth: zDown })}
                    >
                      <ArrowDown size={14} />
                      落笔 <small>Z{zDown}</small>
                    </button>
                  </div>
                </Section>
                <Section icon={<Settings2 size={17} />} title="工作原点">
                  <div className="manual-origin">
                    <button className="button full" disabled={!canJog || !!busy || registrationLocked || !confirmedOrigin} title="自动抬笔，将当前笔尖所在位置设为工作原点，不移动 XY" onClick={() => void issuePositioning({ type: "confirm_manual_origin", raised_confirmed: true })}>将当前位置设为工作原点</button>
                    <button className="button full" disabled={!canJog || !!busy || registrationLocked || (!confirmedOrigin && (currentLayout.scale_x !== undefined))} title="自动抬笔，将画布左上角设为工作原点，原缩放与旋转失效" onClick={() => { resetOriginLayout.current = currentLayout.id; void issuePositioning({ type: "reset_origin" }).then(ok => { if (!ok) resetOriginLayout.current = null; }); }}>重置到画布左上角</button>
                  </div>
                  <p className="field-note" role="status">工作原点{confirmedOrigin ? "" : projectCalibration && projectNeedsAlignment ? "（工程保存，待两点校准）" : "（默认定位点1）"}：画布 X {displayedOrigin[0].toFixed(2)} / Y {displayedOrigin[1].toFixed(2)} mm</p>
                  <p className="field-note">当前笔尖：{projectNeedsAlignment && projectCalibration ? "待两点校准" : `画布 X ${displayedPen[0].toFixed(2)} / Y ${displayedPen[1].toFixed(2)} mm${coordinateMapping?.pen ? "" : "（默认末点）"}`}</p>
                  <p className="field-note">两个按钮都会先抬笔，点击后立即执行，不再弹出二次确认。</p>
                </Section>
                <Section icon={<MousePointer2 size={17} />} title="机器移动">
                  <details className="position-details">
                    <summary>指定位置与电动返回</summary>
                  <fieldset
                    className="calibration-controls"
                    disabled={machineBusy || !!busy || registrationLocked || !confirmedOrigin}
                  >
                    <div className="calibration-grid">
                      <CanvasNumber
                        label="目标画布 X"
                        ariaLabel="目标画布X"
                        value={targetCanvasX}
                        onChange={setTargetCanvasX}
                      />
                      <CanvasNumber
                        label="目标画布 Y"
                        ariaLabel="目标画布Y"
                        value={targetCanvasY}
                        onChange={setTargetCanvasY}
                      />
                    </div>
                    <button
                      className="button"
                      disabled={!canJog || !confirmedOrigin}
                      onClick={() =>
                        issuePositioning({
                          type: "move_to",
                          canvas_x: targetCanvasX,
                          canvas_y: targetCanvasY,
                          feed: travelFeed,
                        })
                      }
                    >
                      移动到指定点
                    </button>
                    <button
                      className="button"
                      disabled={!canJog || !confirmedOrigin}
                      onClick={() =>
                        issuePositioning({ type: "return_origin" })
                      }
                    >
                      电动返回工作原点 XY0
                    </button>
                    <p className="field-note">
                      先抬笔，再移动到指定点或已校准 XY0；不执行 $H。
                    </p>
                  </fieldset>
                  </details>
                </Section>
                </div>
                <div className="workspace-tab-content" hidden={rightTab !== "writing"}>
                <Section icon={<Settings2 size={17} />} title="书写参数">
                  <div className="speed-row">
                    <span>
                      <i className="speed-dot ink" />
                      描线速率
                    </span>
                    <div className="inline-number">
                      <DraftNumberInput
                        aria-label="描线速率"
                        type="number"
                        positive
                        value={feed}
                        disabled={machineBusy}
                        onChange={(e) => setFeed(Number(e.target.value))}
                      />
                      <small>mm/min</small>
                    </div>
                  </div>
                  <div className="speed-row">
                    <span>
                      <i className="speed-dot z" />Z 速率
                    </span>
                    <div className="inline-number">
                      <DraftNumberInput
                        aria-label="Z速率"
                        type="number"
                        positive
                        value={zFeed}
                        disabled={machineBusy}
                        onChange={(e) => setZFeed(Number(e.target.value))}
                      />
                      <small>mm/min</small>
                    </div>
                  </div>
                  <div className="speed-row">
                    <span>落笔下探</span>
                    <div className="inline-number">
                      <DraftNumberInput aria-label="落笔下探" type="number" min={2} max={10} step={0.5} value={zDown} disabled={machineBusy} onChange={(e) => setZDown(Number(e.target.value))} />
                      <small>mm</small>
                    </div>
                  </div>
                  <p className="field-note">落笔下探可调 2–10 mm，默认 4 mm。仅调整作业参数，不修改固件设置。</p>
                </Section>
                </div>
              </div>
              <div className="task-fixed">
                <Section
                  icon={<Play size={17} />}
                  title="任务控制"
                  aside={
                    <button
                      className="text-button"
                      onClick={() => {
                        setRightOpen(true);
                        setRightTab("writing");
                        requestAnimationFrame(() => rightScroll.current?.scrollTo({
                          top: rightScroll.current.scrollHeight,
                          behavior: "smooth",
                        }));
                      }}
                    >
                      速率设置 <ChevronRight size={12} />
                    </button>
                  }
                >
                  <button
                    className="button full code-button"
                    disabled={!document || !!busy}
                    onClick={sourceCode}
                  >
                    <Code2 size={16} />
                    预览 CNC / G-code <ChevronRight size={14} />
                  </button>
                  <button
                    className="button primary full start-button"
                    disabled={!canRun}
                    onClick={start}
                  >
                    <Play size={17} fill="currentColor" />
                    开始书写
                  </button>
                  {runReason && !running && (
                    <div className="run-readiness">
                      <span>{runReason}</span>
                      {!connected && <button onClick={() => { setRightOpen(true); setRightTab("machine"); }}>连接设备</button>}
                      {canPen &&
                        positionKnown &&
                        Math.abs(status.position![2]) > 0.05 && (
                          <button onClick={() => command({ type: "pen_up" })}>
                            抬笔 Z0
                          </button>
                        )}
                      {exceeds && document && (
                        <button
                          disabled={!!busy || showExtraction}
                          onClick={fitToPage}
                        >
                          适配画布
                        </button>
                      )}
                    </div>
                  )}
                  <div className="task-buttons">
                    <button
                      className="button"
                      disabled={!running}
                      onClick={() =>
                        command({ type: paused ? "resume" : "pause" })
                      }
                    >
                      {paused ? <Play size={14} /> : <Pause size={14} />}{" "}
                      {paused ? "继续" : "暂停"}
                    </button>
                    <button
                      className="button danger"
                      disabled={!connected}
                      onClick={stopJob}
                    >
                      <Square size={13} fill="currentColor" />
                      停止
                    </button>
                  </div>
                  {progress.total > 0 && (
                    <div className="job-progress">
                      <div>
                        <span>指令确认进度</span>
                        <strong>
                          {Math.round((progress.sent / progress.total) * 100)}%
                        </strong>
                      </div>
                      <progress value={progress.sent} max={progress.total} />
                      <small>
                        {progress.sent} / {progress.total} 条命令已确认
                      </small>
                    </div>
                  )}
                  <JobTiming state={jobTiming} />
                  <div className="anchor-note">
                    <MousePointer2 size={13} />
                    <span>{automaticOrigin ? "开始先抬笔，从当前笔尖起写" : "按固定画布原点定位；点动只移动笔尖"}</span>
                  </div>
                </Section>
              </div>
              <div className="position-card">
                <div>
                  <span
                    className={`status-light ${connected ? "online" : ""}`}
                  />
                  <strong>{connected ? status.state : "等待设备连接"}</strong>
                  <button
                    className="icon-button"
                    title="通信日志"
                    onClick={() => setModal("logs")}
                  >
                    <Terminal size={14} />
                  </button>
                </div>
                <div className="coordinates">
                  {["X", "Y", "Z"].map((axis, i) => (
                    <span key={axis}>
                      <small>{axis}</small>
                      <b>{status.position?.[i]?.toFixed(2) || "—"}</b>
                    </span>
                  ))}
                  <small>mm</small>
                </div>
              </div>
            </aside>
          </main>
          <footer className="statusbar">
            <div className={error ? "status-message error" : "status-message"}>
              {busy ? (
                <LoaderCircle size={13} className="spin" />
              ) : error ? (
                <HelpCircle size={13} />
              ) : (
                <Check size={13} />
              )}
              <span>{busy ? `${busy}…` : message}</span>
            </div>
            <div>
              <span className="privacy-dot" />
              本地处理 <span className="footer-divider" /> v0.4.3
            </div>
          </footer>
        </div>
        {files.confirmation}
        {layoutDialog && <LayoutPagesDialog pages={snapshotLayoutPages()} layout={currentLayout} currentPage={canvasPage} disabled={machineBusy || !!busy || registrationLocked} onClose={() => setLayoutDialog(false)} onApply={async selected => {
        if (await changeLayout(currentLayout, selected)) { setLayoutDialog(false); notify(`已将版面与比例应用到 ${selected.length} 页`); }
      }} />}
      {modal && (
          <div
            className="modal-overlay"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setModal(null);
            }}
          >
            <div
              className={`modal ${modal === "code" || modal === "logs" || modal === "comparison" || modal === "route-comparison" || modal === "legacy" ? "wide" : ""}`}
              role="dialog"
              aria-modal="true"
            >
              <div className="modal-heading">
                <div>
                  <span className="eyebrow">OPENINK STUDIO</span>
                  <h2>
                    {modal === "route-comparison" ? "优化书写对照" : modal === "code"
                      ? "CNC / G-code 源码"
                      : modal === "logs"
                        ? "通信日志"
                        : modal === "settings"
                          ? "转换工具设置"
                          : modal === "templates"
                            ? "我的模板库"
                            : modal === "comparison"
                              ? "AutoTrace 参数对照"
                              : modal === "legacy"
                                ? "选择原版 gfont 字体"
                                : "使用说明"}
                  </h2>
                </div>
                <button
                  className="icon-button"
                  title="关闭"
                  onClick={() => setModal(null)}
                >
                  <X size={20} />
                </button>
              </div>
              <fieldset
                className="modal-fieldset"
                disabled={
                  machineBusy && !["logs", "code", "help"].includes(modal)
                }
              >
                {modal === "route-comparison" && <RouteComparison
                  result={routeComparison?.result || null} pending={routeComparisonPending}
                  error={routeComparisonError} stale={!!routeComparison && routeComparison.key !== routeComparisonKey}
                  locked={machineBusy} onRefresh={compareRouteOptions} onApply={applyRouteVariant}
                  options={{ trajectoryEnabled: optimizeTrajectory, allowGap: allowWritingGap, maxGap: maxWritingGap, deduplicate: deduplicateWriting, onAllowGap: setAllowWritingGap, onMaxGap: setMaxWritingGap, onDeduplicate: setDeduplicateWriting }}
                />}
                {modal === "comparison" && (
                  <>
                    <p className="modal-description">
                      按当前上传的 PDF、第 {options.page}{" "}
                      页实际生成四组中心线轨迹，不使用历史样本图片。更改文件、页码或参数后需重新生成。
                    </p>
                    <div className="comparison-source">
                      <FileText size={17} />
                      <div>
                        <strong>
                          {source && /\.pdf$/i.test(source)
                            ? fileName(source)
                            : "尚未选择 PDF"}
                        </strong>
                        <span>
                          第 {options.page} 页 · {options.dpi} dpi · 展平容差{" "}
                          {options.tolerance_mm} mm
                        </span>
                      </div>
                      <button
                        className="button primary"
                        disabled={
                          comparing || !source || !/\.pdf$/i.test(source)
                        }
                        onClick={compareCurrentPdf}
                      >
                        {comparing ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <RefreshCw size={15} />
                        )}{" "}
                        {comparing ? "正在生成真实走线…" : "生成当前页面对照"}
                      </button>
                    </div>
                    {comparisonError && (
                      <div className="inline-error">{comparisonError}</div>
                    )}
                    {!comparisonVariants.length && !comparing && (
                      <div className="comparison-empty">
                        <Layers3 size={30} />
                        <strong>
                          {source && /\.pdf$/i.test(source)
                            ? "当前参数尚未生成对照"
                            : "请先上传 PDF"}
                        </strong>
                        <p>
                          {source && /\.pdf$/i.test(source)
                            ? "点击生成后，显示同源、同页的实际拟合路径。"
                            : "在左侧导入区打开 PDF 后，再查看这一页的参数差异。"}
                        </p>
                      </div>
                    )}
                    {comparing && (
                      <div className="comparison-empty">
                        <LoaderCircle className="spin" size={30} />
                        <strong>后台生成中心线轨迹</strong>
                        <p>
                          将分别运行 128 默认、180 默认、180
                          保守及当前参数，完成后显示真实路径。
                        </p>
                      </div>
                    )}
                    <div className="variant-grid">
                      {comparisonVariants.map((v, i) => (
                        <article
                          className="variant-card"
                          key={`${v.source}-${v.page}-${i}`}
                        >
                          <header>
                            <div>
                              <small>
                                第 {v.page} 页 · {fileName(v.source)}
                              </small>
                              <h3>{v.label}</h3>
                            </div>
                            <button
                              className="text-button"
                              onClick={() => {
                                setOptions(v.options);
                                setCustomFit(i === 3);
                                setDocument(v.document);
                                setScale(1);
                                setRotation(0);
                                setModal(null);
                                notify(`已采用 ${v.label} 的实际走线路径`);
                              }}
                            >
                              采用此路径 <ArrowRight size={12} />
                            </button>
                          </header>
                          <TrajectoryPreview document={v.document} />
                          <div className="variant-parameters">
                            <span>阈值 {v.options.threshold}</span>
                            <span>预平滑 {v.options.filter_iterations} 次</span>
                            <span>拟合 {v.options.error_threshold} px</span>
                            <span>直线 {v.options.line_threshold} px</span>
                            <span>去斑 {v.options.despeckle_level}</span>
                          </div>
                        </article>
                      ))}
                    </div>
                    <details className="parameter-notes">
                      <summary>这些参数如何影响走线</summary>
                      <p>
                        128 默认和 180 默认均采用预平滑 4 次、曲线拟合 2
                        px、直线判定 1 px。180
                        保守采用无预平滑、曲线与直线误差均为 0.5
                        px。阈值增大可能保留浅墨，也可能引入噪声；更平滑不代表没有漏笔。拟合误差以
                        px 计，路径展平误差以 mm 计。2026-10-25
                        实写中用户评价阈值 180
                        较好，但默认与保守拟合仍同时保留。
                      </p>
                    </details>
                  </>
                )}
                {privateGfont && modal === "legacy" && (
                  <>
                    {error && <div className="inline-error">{message}</div>}
                    <p className="modal-description">
                      直接读取原版 gfont
                      字形与笔顺。可以选择多种字体，按可覆盖字符的权重组合；实际预览生成后冻结选字方案。
                    </p>
                    <div className="legacy-modal-toolbar">
                      <input
                        className="text-input"
                        placeholder="搜索字体名称、作者或文件名"
                        value={legacySearch}
                        onChange={(e) => setLegacySearch(e.target.value)}
                      />
                      <button
                        className="button"
                        disabled={!!busy}
                        onClick={importLegacyFonts}
                      >
                        <Upload size={15} />
                        导入 .gfont
                      </button>
                      <button
                        className="icon-button bordered"
                        title="刷新原版字体"
                        onClick={() =>
                          work("读取原版字体", async () =>
                            setLegacyFonts(
                              await call<LegacyFont[]>("list_legacy_fonts"),
                            ),
                          )
                        }
                      >
                        <RefreshCw size={16} />
                      </button>
                    </div>
                    <div className="legacy-browser">
                      <div className="legacy-font-list">
                        {legacyFonts
                          .filter((f) =>
                            `${f.display} ${f.author} ${f.path}`
                              .toLowerCase()
                              .includes(legacySearch.toLowerCase()),
                          )
                          .map((f) => {
                            const selected = draftLegacySelection.find(
                              (s) => s.path === f.path,
                            );
  return (
    <div
                                key={f.path}
                                className={`legacy-font-row ${legacyFocus === f.path ? "focused" : ""}`}
                                onClick={() => setLegacyFocus(f.path)}
                              >
                                <input
                                  type="checkbox"
                                  aria-label={`选中${f.display}`}
                                  checked={!!selected}
                                  onChange={(e) =>
                                    setDraftLegacySelection((v) =>
                                      e.target.checked
                                        ? [...v, { path: f.path, weight: 1 }]
                                        : v.filter((s) => s.path !== f.path),
                                    )
                                  }
                                />
                                <div>
                                  <strong>
                                    {f.display || fileName(f.path)}
                                  </strong>
                                  <small>
                                    {f.count.toLocaleString()} 字 ·{" "}
                                    {f.author || "作者未提供"}
                                  </small>
                                </div>
                                {selected && (
                                  <label className="legacy-weight">
                                    <span>权重</span>
                                    <DraftNumberInput
                                      type="number"
                                      min={0.01}
                                      max={1000}
                                      step={0.1}
                                      value={selected.weight}
                                      onChange={(e) =>
                                        setDraftLegacySelection((v) =>
                                          v.map((s) =>
                                            s.path === f.path
                                              ? {
                                                  ...s,
                                                  weight: Math.min(
                                                    1000,
                                                    Math.max(
                                                      0.01,
                                                      Number(e.target.value) ||
                                                        0.01,
                                                    ),
                                                  ),
                                                }
                                              : s,
                                          ),
                                        )
                                      }
                                    />
                                  </label>
                                )}
                              </div>
                            );
                          })}
                        {!legacyFonts.length && (
                          <div className="comparison-empty">
                            <BookOpen size={25} />
                            <strong>尚未读取到原版字体</strong>
                            <p>导入本地 .gfont，或刷新字体目录。</p>
                          </div>
                        )}
                      </div>
                      <div className="legacy-font-detail">
                        {focusedLegacy ? (
                          <>
                            <h3>
                              {focusedLegacy.display ||
                                fileName(focusedLegacy.path)}
                            </h3>
                            <p>
                              {focusedLegacy.description || "此字体未提供描述"}
                            </p>
                            <div className="legacy-metadata">
                              <span>
                                格式版本<strong>{focusedLegacy.version}</strong>
                              </span>
                              <span>
                                字形数量
                                <strong>
                                  {focusedLegacy.count.toLocaleString()}
                                </strong>
                              </span>
                              <span>
                                原始字框<strong>{focusedLegacy.size}</strong>
                              </span>
                              <span>
                                作者
                                <strong>
                                  {focusedLegacy.author || "未提供"}
                                </strong>
                              </span>
                            </div>
                            {legacyPreview ? (
                              <TrajectoryPreview
                                key={focusedLegacy.path}
                                document={legacyPreview}
                                height={220}
                              />
                            ) : (
                              <div className="legacy-preview-empty">
                                原字体没有预览路径
                              </div>
                            )}
                            <p className="legacy-path">{focusedLegacy.path}</p>
                          </>
                        ) : (
                          <div className="comparison-empty">
                            <Type size={27} />
                            <p>点击字体查看真实元数据和路径预览</p>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="legacy-confirm">
                      <span>
                        已选择 <strong>{draftLegacySelection.length}</strong>{" "}
                        种字体 · 权重合计{" "}
                        {draftLegacySelection
                          .reduce((sum, f) => sum + f.weight, 0)
                          .toFixed(2)}
                      </span>
                      <button className="button" onClick={() => setModal(null)}>
                        取消
                      </button>
                      <button
                        className="button primary"
                        disabled={!draftLegacySelection.length || !!busy}
                        onClick={() => {
                          setLegacySelection(
                            draftLegacySelection.map((s) => ({ ...s })),
                          );
                          setFontMode("legacy");
                          setDocument(null);
                          setLegacyMissing([]);
                          setLegacyChoices([]);
                          setModal(null);
                          notify(
                            `已选择 ${draftLegacySelection.length} 种原版字体，请生成真实文字预览`,
                          );
                        }}
                      >
                        <Check size={16} />
                        确认选择
                      </button>
                    </div>
                  </>
                )}
                {modal === "code" && (
                  <>
                    <p className="modal-description">
                      源码对应当前路径与速率。未进行纸面校准时从当前笔尖起写；完成两点/三点校准后按固定画布位置书写。Z 使用绝对坐标。
                    </p>
                    <div className="modal-actions">
                      <button
                        className="button"
                        onClick={() =>
                          navigator.clipboard
                            .writeText(code)
                            .then(() => notify("源码已复制"))
                            .catch((e) => notify(String(e), true))
                        }
                      >
                        <Copy size={15} />
                        复制源码
                      </button>
                      <button
                        className="button"
                        onClick={() => exportFile("gcode")}
                      >
                        <Download size={15} />
                        导出 .gcode
                      </button>
                      <button
                        className="button"
                        onClick={() => exportFile("json")}
                      >
                        <FileText size={15} />
                        导出轨迹 JSON
                      </button>
                      <button className="button" onClick={sourceCode}>
                        <RefreshCw size={15} />
                        刷新
                      </button>
                    </div>
                    <pre className="code-view">{code}</pre>
                    <p className="field-note">
                      只读预览；不提供任意 G-code 编辑发送。
                    </p>
                  </>
                )}
                {modal === "logs" && (
                  <>
                    <p className="modal-description">
                      真实串口通信和操作记录；浏览器预览不会产生设备数据。
                    </p>
                    <div className="modal-actions">
                      <button
                        className="button"
                        disabled={!logs.length}
                        onClick={() =>
                          navigator.clipboard
                            .writeText(logs.join("\n"))
                            .then(() => {
                              setMessage("通信日志已复制");
                              setError(false);
                            })
                            .catch((e) => notify(String(e), true))
                        }
                      >
                        <Copy size={15} />
                        复制通信日志
                      </button>
                    </div>
                    <pre className="code-view log-view">
                      {logs.length ? logs.join("\n") : "暂无通信记录"}
                    </pre>
                  </>
                )}
                {modal === "settings" && (
                  <>
                    <p className="modal-description">
                      SVG 原生解析。PDF / 图片与字体中心线转换使用本机 Python 和
                      AutoTrace。
                    </p>
                    <Field label="Python 可执行文件">
                      <input
                        className="text-input"
                        value={options.python_path}
                        onChange={(e) =>
                          setOptions((o) => ({
                            ...o,
                            python_path: e.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field label="AutoTrace 可执行文件">
                      <div className="path-input">
                        <input
                          value={options.autotrace_path}
                          placeholder="选择 autotrace.exe"
                          onChange={(e) =>
                            setOptions((o) => ({
                              ...o,
                              autotrace_path: e.target.value,
                            }))
                          }
                        />
                        <button
                          className="icon-button"
                          onClick={async () => {
                            try {
                              const p = await open({
                                multiple: false,
                                filters: [
                                  { name: "可执行文件", extensions: ["exe"] },
                                ],
                              });
                              if (typeof p === "string")
                                setOptions((o) => ({
                                  ...o,
                                  autotrace_path: p,
                                }));
                            } catch (e) {
                              notify(String(e), true);
                            }
                          }}
                        >
                          <FolderOpen size={17} />
                        </button>
                      </div>
                    </Field>
                    <div className="field-grid">
                      <NumberField
                        label="转换分辨率"
                        value={options.dpi}
                        onChange={(v) => setOptions((o) => ({ ...o, dpi: v }))}
                        min={36}
                        max={1200}
                        unit="dpi"
                      />
                      <NumberField
                        label="曲线误差"
                        value={options.tolerance_mm}
                        onChange={(v) =>
                          setOptions((o) => ({ ...o, tolerance_mm: v }))
                        }
                        min={0.005}
                        max={1}
                        step={0.005}
                      />
                    </div>
                    <p className="settings-note">
                      路径仅用于本机转换，不上传文件，也不更改机器固件。
                    </p>
                  </>
                )}
                {modal === "templates" && (
                  <>
                    <p className="modal-description">
                      选择版面，或保存你的自定义设置。模板通过开放 JSON
                      格式导入。
                    </p>
                    <div className="template-list">
                      {[
                        initialTemplate,
                        ...templates.filter((t) => t.id !== "custom"),
                      ].map((t) => (
                        <button
                          key={t.id}
                          className={`template-item ${selectedTemplateId === t.id ? "active" : ""}`}
                          onClick={() => {
                            void changeLayout({ ...t, id: currentLayout.id, source: "template" }, sharedPages).then(ok => { if (ok) { setSelectedTemplateId(t.id); setModal(null); } });
                          }}
                        >
                          <div className="mini-page">
                            <span />
                            <span />
                            <span />
                            <span />
                          </div>
                          <div>
                            <strong>{t.name}</strong>
                            <small>
                              {t.width_mm} × {t.height_mm} mm · {t.lines} 行
                            </small>
                            <p>{t.description}</p>
                          </div>
                          {selectedTemplateId === t.id ? (
                            <Check size={18} />
                          ) : (
                            <ChevronRight size={17} />
                          )}
                        </button>
                      ))}
                    </div>
                    <Field label="新模板名称">
                      <input
                        className="text-input"
                        value={template.name}
                        onChange={(e) => updateTemplate("name", e.target.value)}
                      />
                    </Field>
                    <div className="modal-actions">
                      <button className="button" onClick={importTemplate}>
                        <Upload size={15} />
                        导入 JSON
                      </button>
                      <button className="button" onClick={exportTemplate}>
                        <Download size={15} />
                        导出 JSON
                      </button>
                      {selectedTemplateId && !selectedTemplateId.startsWith("builtin-") &&
                        selectedTemplateId !== "custom" && templates.some(t => t.id === selectedTemplateId) && (
                          <button
                            className="button danger"
                            onClick={deleteTemplate}
                          >
                            删除选中
                          </button>
                        )}
                      <button
                        className="button primary"
                        disabled={!!busy}
                        onClick={saveTemplate}
                      >
                        <Save size={15} />
                        保存当前版面
                      </button>
                    </div>
                  </>
                )}
                {modal === "help" && (
                  <div className="help-content">
                    <h3>1. 准备书写路径</h3>
                    <p>
                      选择普通 TTF / OTF 字体并生成文字，或导入
                      SVG、PDF、图片、轨迹 JSON。每次插入都会保留已有素材，在同一画布编辑。
                    </p>
                    <h3>2. 调整版面与笔尖</h3>
                    <p>
                      在画布框选后移动、调整尺寸和旋转；素材列表可删除整份素材，撤销可恢复。轨迹优化默认开启，可关闭以保留原笔顺；优化书写可单独比较并选择合并方案。在右侧按笔序定位，可查看选中笔画及书写方向。
                    </p>
                    <h3>3. 连接并书写</h3>
                    <p>
                      扫描并选择串口，等待
                      Idle。开始时自动抬笔；两点或三点纸面校准会自动建立工作原点并保留抬笔状态。停止会终止旧任务并保留连接；恢复连接会清除旧任务并抬笔。
                    </p>
                    <div className="settings-note">
                      浏览器模式仅预览界面。文件转换和机器操作请在 Tauri
                      桌面应用中完成。
                    </div>
                  </div>
                )}
              </fieldset>
            </div>
          </div>
        )}
      </fieldset>
      {recovering && (
        <div className="recovery-progress" role="status">
          <LoaderCircle className="spin" size={20} />
          <strong>正在清除旧任务并恢复连接</strong>
          <span>等待控制器恢复并抬笔完成</span>
        </div>
      )}
    </div>
    </DocumentEditLock.Provider>
  );
}
