import { useEffect, useRef, useState } from "react";
import { registrationMatrix, validRegistrationPoints, type Registration } from "./coordinateGeometry";
import { DraftNumberInput } from "./DraftNumberInput";
import Toggle from "./Toggle";

export type RegistrationProfile = Registration & { id: string; name: string; width_mm: number; height_mm: number; point1: number[]; point2: number[]; point3?: number[] };
export type RegistrationSetup = { points: number[][]; point3?: number[]; show_points: boolean; selected_profile: string };
export function RegistrationPanel({ width, height, travelFeed, origin, registration, ready, positioning, calibrationVersion, sessionVersion, onCommand, onLock, onPointsChange, errorVersion = 0, pointEdit, editLocked = false, restoreSetup, onSetupChange, onComplete, secondPointVersion = 0, onPositioningStarted, preserveScale = false }: {
  width: number; height: number; travelFeed: number; origin: number[] | null; registration: Registration;
  ready: boolean; positioning: boolean; calibrationVersion: number; sessionVersion: number;
  onCommand: (command: Record<string, unknown>) => Promise<boolean>; onLock: (locked: boolean) => void;
  onPointsChange?: (points: number[][] | null) => void;
  errorVersion?: number;
  pointEdit?: { index: number; point: number[] } | null;
  editLocked?: boolean;
  restoreSetup?: { version: number; value: RegistrationSetup } | null;
  onSetupChange?: (setup: RegistrationSetup) => void;
  onComplete?: () => void;
  secondPointVersion?: number;
  onPositioningStarted?: () => void;
  preserveScale?: boolean;
}) {
  const [point1, setPoint1] = useState(origin || [width, 0]);
  const [point2, setPoint2] = useState(() => {
    const first = origin || [width, 0];
    return [[15, 15], [width - 15, 15], [15, height - 15], [width - 15, height - 15]].sort((a, b) => Math.hypot(b[0] - first[0], b[1] - first[1]) - Math.hypot(a[0] - first[0], a[1] - first[1]))[0];
  });
  const [point3, setPoint3] = useState([width - 15, height - 15]);
  const [threePoints, setThreePoints] = useState(false);
  const [stage, setStage] = useState<"idle" | "first" | "moving" | "second" | "capturing" | "movingThird" | "third" | "finishing" | "done">("idle");
  const selected = restoreSetup?.value.selected_profile || "";
  const [showPoints, setShowPoints] = useState(true);
  const baseline = useRef(0);
  const captureBaseline = useRef(0);
  const epoch = useRef(0);
  const sending = useRef(false);
  const pointsEdited = useRef(false);
  const points = threePoints ? [point1, point2, point3] : [point1, point2];
  const valid = validRegistrationPoints(points, width, height);
  const [a, b, c, d] = registrationMatrix(registration);
  const active = !["idle", "done"].includes(stage);
  useEffect(() => {
    if (!active) return;
    epoch.current++;
    sending.current = false;
    if (stage === "first") { setStage("idle"); onLock(false); }
    else setStage(threePoints && ["movingThird", "third", "finishing"].includes(stage) ? "third" : "second");
  }, [errorVersion]);
  useEffect(() => {
    if (!pointEdit || active || editLocked) return;
    pointsEdited.current = true;
    [setPoint1, setPoint2, setPoint3][pointEdit.index]?.([...pointEdit.point]);
    setStage("idle");
  }, [pointEdit]);
  useEffect(() => { onPointsChange?.(showPoints ? points : null); }, [point1, point2, point3, threePoints, showPoints, onPointsChange]);
  useEffect(() => () => onPointsChange?.(null), [onPointsChange]);
  useEffect(() => { epoch.current++; setStage("idle"); sending.current = false; onLock(false); }, [sessionVersion, width, height]);
  useEffect(() => () => { epoch.current++; }, []);
  useEffect(() => {
    if (pointsEdited.current || active) return;
    const first = origin || [width, 0];
    const corners = [[15, 15], [width - 15, 15], [15, height - 15], [width - 15, height - 15]];
    setPoint1(first);
    setPoint2(corners.sort((a, b) => Math.hypot(b[0] - first[0], b[1] - first[1]) - Math.hypot(a[0] - first[0], a[1] - first[1]))[0]);
    setPoint3([width - 15, height - 15]);
  }, [width, height, origin?.[0], origin?.[1]]);
  useEffect(() => {
    if (!restoreSetup) return;
    pointsEdited.current = true;
    setPoint1([...restoreSetup.value.points[0]]); setPoint2([...restoreSetup.value.points[1]]);
    setThreePoints(!!restoreSetup.value.point3); if (restoreSetup.value.point3) setPoint3([...restoreSetup.value.point3]);
    setShowPoints(restoreSetup.value.show_points);
    epoch.current++; setStage("idle"); sending.current = false; onLock(false);
  }, [restoreSetup?.version]);
  useEffect(() => { onSetupChange?.({ points: [point1, point2], ...(threePoints ? { point3 } : {}), show_points: showPoints, selected_profile: selected }); }, [point1, point2, point3, threePoints, showPoints, selected, onSetupChange]);
  useEffect(() => {
    if (stage === "first" && calibrationVersion > baseline.current && !positioning && ready && !sending.current) {
      sending.current = true;
      const ticket = epoch.current;
      setStage("moving");
      void onCommand({ type: "move_to", canvas_x: point2[0], canvas_y: point2[1], feed: travelFeed }).then(ok => {
        if (ticket !== epoch.current) return;
        sending.current = false;
        setStage(ok ? "second" : "idle");
        if (ok) onPositioningStarted?.();
        if (!ok) onLock(false);
      });
    }
    if (stage === "capturing" && secondPointVersion > captureBaseline.current && !positioning && ready && !sending.current) {
      sending.current = true; setStage("movingThird"); const ticket = epoch.current;
      void onCommand({ type: "move_to", canvas_x: point3[0], canvas_y: point3[1], feed: travelFeed }).then(ok => {
        if (ticket !== epoch.current) return;
        sending.current = false; setStage("third");
        if (ok) onPositioningStarted?.();
      });
    }
    if (stage === "finishing" && calibrationVersion > baseline.current && !positioning) { baseline.current = calibrationVersion; setStage("done"); onLock(false); onComplete?.(); }
    if (stage === "done" && calibrationVersion > baseline.current) setStage("idle");
  }, [stage, calibrationVersion, secondPointVersion, positioning, ready]);
  async function first() {
    const ticket = epoch.current;
    baseline.current = calibrationVersion;
    setStage("first"); onLock(true);
    const ok = await onCommand({
      type: "begin_registration",
      canvas_x: point1[0],
      canvas_y: point1[1],
      ...(preserveScale && !threePoints ? { preserve_scale: [Math.hypot(a, c), Math.hypot(b, d)] } : {}),
    });
    if (ticket !== epoch.current) return;
    if (!ok) { setStage("idle"); onLock(false); }
    else onPositioningStarted?.();
  }
  async function finish() {
    const ticket = epoch.current;
    baseline.current = calibrationVersion;
    setStage("finishing");
    const target = threePoints ? point3 : point2;
    const ok = await onCommand({ type: threePoints ? "finish_registration_third" : "finish_registration", canvas_x: target[0], canvas_y: target[1] });
    if (ticket === epoch.current && !ok) setStage(threePoints ? "third" : "second");
  }
  async function captureSecond() {
    const ticket = epoch.current; captureBaseline.current = secondPointVersion; setStage("capturing");
    const ok = await onCommand({ type: "capture_registration_second", canvas_x: point2[0], canvas_y: point2[1] });
    if (ticket === epoch.current && !ok) setStage("second");
  }
  return <div className="calibration-controls registration-panel">
    <strong>纸面校准</strong>
    <label className="paper-field">校准方式<select className="text-input" aria-label="校准方式" value={threePoints ? "three" : "two"} disabled={active || editLocked} onChange={e => { setThreePoints(e.target.value === "three"); setStage("idle"); }}><option value="two">{preserveScale ? "两点 · 保留比例，校正旋转" : "两点 · 等比缩放与旋转"}</option><option value="three">三点 · 横纵独立缩放与旋转</option></select></label>
    <Toggle label="显示校准点" checked={showPoints} onChange={setShowPoints} />
    <p className="field-note">{threePoints ? "在画布上拖动定位点 1、2、3，选择分散的三个特征。依次对准并确认，修正横纵比例与旋转。" : "在画布上拖动定位点 1、2，分别对准底稿特征。对齐第一点后确认，再微调第二点。"}</p>
    <div className={`registration-distance ${valid ? "" : "invalid"}`}>两点间距 <strong>{Math.hypot(point2[0] - point1[0], point2[1] - point1[1]).toFixed(1)} mm</strong><span>至少 100 mm</span></div>
    <details className="registration-coordinate-details">
    <summary>定位点坐标 <span>精确输入</span></summary>
    <fieldset disabled={active || editLocked} className="calibration-grid">
      {points.map((point, index) => point.map((value, axis) => <label key={`${index}-${axis}`}>第{index + 1}点 {axis === 0 ? "X" : "Y"}<DraftNumberInput className="text-input" aria-label={`第${index + 1}点${axis === 0 ? "X" : "Y"}`} type="number" step="0.1" min="0" max={axis === 0 ? width : height} value={value} onChange={e => { pointsEdited.current = true; const next = [...point]; next[axis] = Number(e.target.value); [setPoint1, setPoint2, setPoint3][index](next); setStage("idle"); }} /></label>))}
    </fieldset>
    </details>
    {!valid && <p role="alert" className="field-note">{threePoints ? "三点须在纸面内，第 2、3 点距第 1 点至少 100 mm，夹角须远离共线（正弦至少 0.15）。" : "两点须位于纸面内，间距至少 100 mm。"}</p>}
    <button className="button" disabled={!ready || !valid || active} onClick={first}>已对齐第一点，确认并移向第二点</button>
    {active && <p role="status">{stage === "second" ? "请点动对齐第二点，然后确认。" : stage === "third" ? "请点动对齐第三点，然后确认。" : "等待设备完成定位与抬笔…"}</p>}
    {stage === "second" && <button className="button" disabled={!ready || positioning} onClick={threePoints ? captureSecond : finish}>{threePoints ? "已对齐第二点，确认并移向第三点" : "已对齐第二点，完成校准"}</button>}
    {stage === "third" && <button className="button" disabled={!ready || positioning} onClick={finish}>已对齐第三点，完成校准</button>}
    {active && <button className="button" disabled={positioning} onClick={async () => { if (await onCommand({ type: "cancel_registration" })) { setStage("idle"); onLock(false); } }}>退出校准</button>}
    <p className="field-note">{registration.matrix ? `横向比例 ${Math.hypot(a, c).toFixed(6)} · 纵向比例 ${Math.hypot(b, d).toFixed(6)}` : `当前比例 ${registration.scale.toFixed(6)}`} · 旋转 {registration.rotation_deg.toFixed(3)}°</p>
  </div>;
}
