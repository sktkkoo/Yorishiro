import { openUrl } from "@tauri-apps/plugin-opener";
import { type MouseEvent, useId, useRef, useState } from "react";
import { CONTINUITY_COPY } from "../i18n/continuity";
import { resultTextParts } from "./result-link";

export function ResultText({
  text,
  language,
}: {
  readonly text: string;
  readonly language: "ja" | "en";
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const errorId = useId();
  let offset = 0;
  const parts = resultTextParts(text).map((part) => {
    const key = `${offset}:${part.text}`;
    offset += part.text.length;
    return { ...part, key };
  });

  async function activate(event: MouseEvent<HTMLAnchorElement>, key: string, url: string) {
    // Enter 由来の click も同じ経路に通し、WebView 内の遷移を防ぐ。
    event.preventDefault();
    if (
      (event.type === "click" ? event.button !== 0 : event.button !== 1) ||
      inFlight.current.has(key)
    )
      return;
    inFlight.current.add(key);
    setFailed((previous) => {
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
    try {
      await openUrl(url);
    } catch {
      setFailed((previous) => new Set([...previous, key]));
    } finally {
      inFlight.current.delete(key);
    }
  }
  return (
    <>
      {parts.map((part) => {
        const url = part.url;
        return url ? (
          <a
            key={part.key}
            className="continuity-result-link"
            href={url}
            aria-describedby={failed.has(part.key) ? errorId : undefined}
            onClick={(event) => void activate(event, part.key, url)}
            onAuxClick={(event) => void activate(event, part.key, url)}
          >
            {part.text}
          </a>
        ) : (
          part.text
        );
      })}
      {parts.some((part) => part.url && failed.has(part.key)) ? (
        <span className="continuity-result-link-error" id={errorId} role="alert">
          {CONTINUITY_COPY[language].resultLinkFailed}
        </span>
      ) : null}
    </>
  );
}
