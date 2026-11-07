import type { InkVariant } from "./inkfont";

export type InkImportOptions = {page:number; dpi:number; threshold:number; conservative:boolean; python_path:string; autotrace_path:string; tolerance_mm:number; filter_iterations:number; error_threshold:number; line_threshold:number; despeckle_level:number};
export type Bounds = [number, number, number, number];
export type Candidate = InkVariant & {confidence:number; bounds:Bounds; touching:boolean; crossing?:boolean; needs_review:boolean; svg:string; crop_data_url?:string; error?:string; confirmed?:boolean; dirty?:boolean; excluded?:boolean};
export type Source = {path:string;options:InkImportOptions;models:string};
export type Page = {width:number;height:number;page:number;page_count:number;image_data_url:string};
export type Result = Page & {candidates:Candidate[]};
export type Snapshot = {source:Source;result:Result};
export type ImportHistory = {past:Snapshot[];present:Snapshot|null;future:Snapshot[]};
export const emptyImportHistory = ():ImportHistory => ({past:[],present:null,future:[]});
export const sourceKey = (source:Source) => JSON.stringify([source.path,source.models,...Object.keys(source.options).sort().map(key=>[key,source.options[key as keyof InkImportOptions]])]);
export function recordImport(history:ImportHistory, next:Snapshot):ImportHistory {
  if (next===history.present) return history;
  return {past:history.present?[...history.past,history.present].slice(-100):history.past,present:next,future:[]};
}
export function travelImport(history:ImportHistory, redo=false):ImportHistory {
  if (!history.present) return history;
  if (redo) return history.future.length?{past:[...history.past,history.present],present:history.future[0],future:history.future.slice(1)}:history;
  return history.past.length?{past:history.past.slice(0,-1),present:history.past[history.past.length-1],future:[history.present,...history.future]}:history;
}
export function clampCrop(bounds:Bounds,width:number,height:number):Bounds {
  const x=Math.max(0,Math.min(width-1,bounds[0])),y=Math.max(0,Math.min(height-1,bounds[1]));
  return [x,y,Math.max(1,Math.min(width-x,bounds[2])),Math.max(1,Math.min(height-y,bounds[3]))];
}
export function neighborhood(bounds:Bounds,width:number,height:number):Bounds {
  const size=Math.max(bounds[2],bounds[3])*2.4;
  const w=Math.min(width,size),h=Math.min(height,size);
  return [Math.max(0,Math.min(width-w,bounds[0]+bounds[2]/2-w/2)),Math.max(0,Math.min(height-h,bounds[1]+bounds[3]/2-h/2)),w,h];
}
/** Inverse of the trace helper's six-pixel guard and square normalization. */
export function glyphPageTransform(bounds:Bounds) {
  const x=Math.floor(bounds[0]),y=Math.floor(bounds[1]);
  const w=Math.ceil(bounds[0]+bounds[2])-x+12,h=Math.ceil(bounds[1]+bounds[3])-y+12,size=Math.max(w,h);
  return `translate(${x-6-(size-w)/2} ${y-6-(size-h)/2}) scale(${size/1000})`;
}
