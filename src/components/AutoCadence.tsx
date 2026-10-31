import { ChevronDown, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { AUTO_WORKSPACE_COPY } from "../i18n/auto-workspace";
import type { AutonomyContract } from "../runtime/autonomy/types";

export type AutoCadenceValue = Pick<AutonomyContract, "intervalMinutes" | "maxRunsPerDay">;

const INTERVALS = [5, 15, 30, 60, 120, 180, 360, 720, 1440];
function duration(minutes: number, language: "ja" | "en") {
  if (minutes % 60 === 0) return language === "ja" ? `${minutes / 60}時間` : `${minutes / 60} hr`;
  return language === "ja" ? `${minutes}分` : `${minutes} min`;
}

/** One inline control for the execution interval and its rolling 24-hour limit. */
export function AutoCadence({
  value,
  revisionKey,
  language,
  disabled = false,
  optimistic = false,
  onSave,
  onExpandedChange,
}: {
  readonly value: AutoCadenceValue;
  readonly revisionKey: string;
  readonly language: "ja" | "en";
  readonly disabled?: boolean;
  readonly optimistic?: boolean;
  readonly onSave: (value: AutoCadenceValue) => Promise<void>;
  readonly onExpandedChange?: (expanded: boolean) => void;
}) {
  const copy = AUTO_WORKSPACE_COPY[language];
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const limitInput = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(false);
  const [invalidLimit, setInvalidLimit] = useState(false);
  const [edit, setEdit] = useState<{
    baseline: string;
    baselineValue: string;
    submittedValue: string | null;
    interval: number;
    limit: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const valueKey = `${value.intervalMinutes}:${value.maxRunsPerDay}`;
  const stale =
    edit !== null &&
    (edit.baseline !== revisionKey ||
      (edit.baselineValue !== valueKey && !(optimistic && edit.submittedValue === valueKey)));
  const label =
    language === "ja"
      ? `${duration(value.intervalMinutes, language)}間隔 · 24時間で${value.maxRunsPerDay}回まで`
      : `${duration(value.intervalMinutes, language)} intervals · up to ${value.maxRunsPerDay} runs / 24h`;

  useEffect(() => {
    if (restoreFocus.current && !edit && !saving) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [edit, saving]);

  function close() {
    restoreFocus.current = true;
    setEdit(null);
    setError(null);
    setInvalidLimit(false);
    onExpandedChange?.(false);
  }
  async function save() {
    if (!edit || stale || savingRef.current || disabled) return;
    const limit = Number(edit.limit);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      setInvalidLimit(true);
      setError(copy.invalidCadence);
      limitInput.current?.focus();
      return;
    }
    setInvalidLimit(false);
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setEdit({ ...edit, submittedValue: `${edit.interval}:${limit}` });
    try {
      await onSave({ intervalMinutes: edit.interval, maxRunsPerDay: limit });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="auto-cadence">
      <button
        ref={trigger}
        type="button"
        className="auto-cadence-toggle"
        aria-label={`${copy.frequency}: ${label}`}
        aria-expanded={edit !== null}
        aria-controls={id}
        disabled={disabled || saving}
        onClick={() => {
          if (edit) close();
          else {
            setEdit({
              baseline: revisionKey,
              baselineValue: valueKey,
              submittedValue: null,
              interval: value.intervalMinutes,
              limit: String(value.maxRunsPerDay),
            });
            setError(null);
            setInvalidLimit(false);
            onExpandedChange?.(true);
          }
        }}
      >
        {label}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {edit && (
        <fieldset
          id={id}
          aria-label={copy.frequency}
          className="auto-cadence-editor"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
              event.preventDefault();
              void save();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (!saving) close();
            }
          }}
        >
          <div className="auto-cadence-fields">
            <label>
              {copy.interval}
              <select
                value={edit.interval}
                disabled={disabled || saving}
                onChange={(event) => setEdit({ ...edit, interval: Number(event.target.value) })}
              >
                {[...new Set([...INTERVALS, value.intervalMinutes, edit.interval])]
                  .sort((a, b) => a - b)
                  .map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {duration(minutes, language)}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {copy.runLimit}
              <input
                ref={limitInput}
                aria-invalid={invalidLimit || undefined}
                aria-describedby={invalidLimit ? `${id}-error` : undefined}
                type="number"
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                value={edit.limit}
                disabled={disabled || saving}
                onChange={(event) => {
                  setEdit({ ...edit, limit: event.target.value });
                  if (invalidLimit) {
                    setInvalidLimit(false);
                    setError(null);
                  }
                }}
              />
            </label>
            <div className="auto-actions">
              <button
                type="button"
                disabled={disabled || saving || stale}
                aria-busy={saving}
                onClick={() => void save()}
              >
                {saving && <LoaderCircle size={14} className="auto-spinner" aria-hidden="true" />}
                {copy.applyCadence}
              </button>
              <button type="button" className="auto-text-button" disabled={saving} onClick={close}>
                {copy.cancel}
              </button>
            </div>
          </div>
          {(error || (stale && !saving)) && (
            <p id={`${id}-error`} className="auto-cadence-error" role="alert">
              {stale ? copy.cadenceChanged : error}
            </p>
          )}
        </fieldset>
      )}
    </div>
  );
}
