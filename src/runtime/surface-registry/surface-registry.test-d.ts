import type { UiLayout } from "@yorishiro/sdk";
import { assertType, type Equals } from "../../test-utils/type-assert";
import type { SurfaceName } from "./types";

// SDK UiLayout.presence.target と runtime layout surface が完全一致していることを
// コンパイル時に固定する。terminal は Loop Reel 用の host-internal surface なので除外する。
assertType<Equals<NonNullable<UiLayout["presence"]>["target"], Exclude<SurfaceName, "terminal">>>(
  true,
);
