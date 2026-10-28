import { useContext, useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { DocumentEditLock } from "./documentEditPolicy";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: number;
  onChange: (event: { target: { value: string } }) => void;
  positive?: boolean;
};

/** Keep incomplete edits local; publish only a complete finite number on blur. */
export function DraftNumberInput({ value, onChange, positive = false, min, max, onFocus, onBlur, onKeyDown, ...props }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const edited = useRef(false);
  const editLocked = useContext(DocumentEditLock);
  useEffect(() => {
    if (editLocked || props.disabled) {
      edited.current = false;
      setDraft(null);
    }
  }, [editLocked, props.disabled]);
  return <input {...props} min={min} max={max} value={draft ?? String(value)}
    onFocus={(event) => {
      edited.current = false;
      setDraft(event.currentTarget.value);
      onFocus?.(event);
    }}
    onChange={(event) => {
      edited.current = true;
      setDraft(event.currentTarget.value);
    }}
    onBlur={(event) => {
      const text = event.currentTarget.value.trim();
      let number = Number(text);
      if (!editLocked && !event.currentTarget.matches(":disabled") && edited.current && text !== "" && Number.isFinite(number) && (!positive || number > 0)) {
        if (min !== undefined) number = Math.max(Number(min), number);
        if (max !== undefined) number = Math.min(Number(max), number);
        if (number !== value) onChange({ target: { value: String(number) } });
      }
      edited.current = false;
      setDraft(null);
      onBlur?.(event);
    }}
    onKeyDown={(event) => {
      onKeyDown?.(event);
      if (!event.defaultPrevented && event.key === "Enter") event.currentTarget.blur();
    }} />;
}
