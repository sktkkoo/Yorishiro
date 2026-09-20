import type { IParser } from "@xterm/xterm";

/** DEC mode 2031: only applications that opt in receive palette notifications.
 * https://contour-terminal.org/vt-extensions/color-palette-update-notifications/
 */
export class TerminalColorScheme {
  private enabled = false;
  private background = "";
  private mode = 1;
  private revision = 0;
  private resetRevision = 0;
  private readonly handlers;

  constructor(
    parser: Pick<IParser, "registerCsiHandler" | "registerEscHandler">,
    private readonly reply: (data: string, isCurrent: () => boolean) => void,
  ) {
    this.handlers = [
      ...(["h", "l"] as const).map((final) =>
        parser.registerCsiHandler({ prefix: "?", final }, (params) => {
          if (params.includes(2031)) {
            this.revision++;
            this.enabled = final === "h";
          }
          // Let xterm process other modes in a combined DECSET/DECRST.
          return params.length === 1 && params[0] === 2031;
        }),
      ),
      parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, (params) => {
        if (params.length !== 1 || params[0] !== 2031) return false;
        this.send(`\x1b[?2031;${this.enabled ? 1 : 2}$y`);
        return true;
      }),
      parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
        if (params.length !== 1 || params[0] !== 996) return false;
        this.report();
        return true;
      }),
      parser.registerEscHandler({ final: "c" }, () => {
        this.reset();
        return false;
      }),
    ];
  }

  /** Opaque, normalized rgb/rgba from the scene, independent of terminal opacity. */
  update(background: string): void {
    if (background === this.background) return;
    this.background = background;
    const channels = background
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number);
    if (!channels || channels.length !== 3) return;
    const [r, g, b] = channels;
    this.mode = (r * 299 + g * 587 + b * 114) / 1000 < 128 ? 1 : 2;
    if (this.enabled) this.report(true);
  }

  reset(): void {
    this.revision++;
    this.resetRevision++;
    this.enabled = false;
  }

  dispose(): void {
    this.reset();
    for (const handler of this.handlers) handler.dispose();
  }

  private report(notification = false): void {
    this.send(`\x1b[?997;${this.mode}n`, notification);
  }

  private send(data: string, notification = false): void {
    const revision = this.revision;
    const resetRevision = this.resetRevision;
    this.reply(
      data,
      () => resetRevision === this.resetRevision && (!notification || revision === this.revision),
    );
  }
}
