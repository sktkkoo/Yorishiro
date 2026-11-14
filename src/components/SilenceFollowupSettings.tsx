import { useEffect, useState } from "react";
import { isRealtimeDebugEnabled } from "../runtime/codex-realtime/realtime-debug";
import {
  readSilenceFollowupSettings,
  type SilenceFollowupSettings as Settings,
  subscribeSilenceFollowupSettings,
  writeSilenceFollowupSettings,
} from "../runtime/codex-realtime/silence-followup-settings";

/** 開発者がローカルの実験表示を有効にした環境だけに表示する。 */
export function SilenceFollowupSettings({ language }: { readonly language: string }) {
  const [settings, setSettings] = useState(readSilenceFollowupSettings);
  const [visible, setVisible] = useState(isRealtimeDebugEnabled);
  const [error, setError] = useState(false);
  useEffect(
    () =>
      subscribeSilenceFollowupSettings(() => {
        setSettings(readSilenceFollowupSettings());
        setVisible(isRealtimeDebugEnabled());
      }),
    [],
  );
  if (!visible) return null;
  const en = language === "en";
  const update = (next: Settings) => {
    try {
      writeSilenceFollowupSettings(next);
      setError(false);
    } catch {
      setError(true);
    }
  };
  return (
    <fieldset>
      <legend>{en ? "Experimental voice follow-up" : "実験: 無音後の声かけ"}</legend>
      <p>
        {en
          ? "Requires Codex 0.169.0; inactive on other versions. When enabled, recent voice transcript parts are held in memory and sent to a separate, tool-free request on your current Codex provider. Provider usage may be billed. It may choose to stay silent. Live audio behavior is still experimental."
          : "Codex 0.169.0 専用で、他の版では動作しません。有効にすると、直近の音声会話を一時メモリーに保持し、現在のCodexプロバイダーへ道具のない独立した推論要求を送ります。プロバイダーの利用料金が発生する場合があります。話さない判断もできます。実際の発話動作は実験段階です。"}
      </p>
      <label>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => update({ ...settings, enabled: event.currentTarget.checked })}
        />
        {en ? "Enable occasional follow-up on this device" : "この端末で無音後の声かけを有効にする"}
      </label>
      <label>
        {en ? "Silence before a follow-up (seconds)" : "声かけまでの無音時間（秒）"}
        <input
          type="number"
          min={30}
          max={600}
          value={settings.silenceSeconds}
          disabled={!settings.enabled}
          onChange={(event) =>
            update({ ...settings, silenceSeconds: event.currentTarget.valueAsNumber })
          }
        />
      </label>
      <label>
        {en ? "Minimum interval (seconds)" : "声かけの最短間隔（秒）"}
        <input
          type="number"
          min={60}
          max={3600}
          value={settings.cooldownSeconds}
          disabled={!settings.enabled}
          onChange={(event) =>
            update({ ...settings, cooldownSeconds: event.currentTarget.valueAsNumber })
          }
        />
      </label>
      {error ? (
        <p role="alert">
          {en ? "Could not save this local setting." : "端末の設定を保存できませんでした。"}
        </p>
      ) : null}
    </fieldset>
  );
}
