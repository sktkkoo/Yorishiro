import type { UiLayout } from "@yorishiro/sdk";
import { assertType, type Equals } from "../../test-utils/type-assert";
import type { SurfaceName } from "./types";

// SDK UiLayout.presence.target と runtime SurfaceName が完全一致していることを
// コンパイル時に固定する。片方だけ surface を増減すると tsc が落ちる。
assertType<Equals<NonNullable<UiLayout["presence"]>["target"], SurfaceName>>(true);
