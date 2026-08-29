import { describe, expect, it } from "vitest";
import { macosSignatureErrors, REQUIRED_MACOS_ENTITLEMENTS } from "./macos-signature-verifier.mjs";

const entitlements = REQUIRED_MACOS_ENTITLEMENTS.map(
  (entitlement) => `<key>${entitlement}</key><true/>`,
).join("");
const validReleaseSignature = `
CodeDirectory v=20500 flags=0x10000(runtime)
Authority=Developer ID Application: Example (TEAM123)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Aug 26, 2026 at 0:32:11
Notarization Ticket=stapled
TeamIdentifier=TEAM123
<plist><dict>${entitlements}</dict></plist>
`;

describe("macosSignatureErrors", () => {
  it("accepts a hardened, notarized Developer ID signature", () => {
    expect(macosSignatureErrors(validReleaseSignature, { requireDeveloperId: true })).toEqual([]);
  });

  it("rejects an ad-hoc signature in release mode", () => {
    const output = `
CodeDirectory v=20500 flags=0x10002(adhoc,runtime)
Signature=adhoc
TeamIdentifier=not set
<plist><dict>${entitlements}</dict></plist>
`;

    expect(macosSignatureErrors(output, { requireDeveloperId: true })).toEqual(
      expect.arrayContaining([
        "The Developer ID Application authority is missing.",
        "The Developer ID team identifier is missing.",
        "The release app is ad-hoc signed instead of Developer ID signed.",
      ]),
    );
  });

  it("rejects malformed or incomplete entitlements", () => {
    const output = validReleaseSignature
      .replace("<key>com.apple.security.device.audio-input</key><true/>", "")
      .concat("\nwarning: binary contains an invalid entitlements blob");

    expect(macosSignatureErrors(output, { requireDeveloperId: true })).toEqual(
      expect.arrayContaining([
        "Missing signed entitlements: com.apple.security.device.audio-input",
        "The signed executable contains an invalid entitlements blob.",
      ]),
    );
  });

  it("keeps local ad-hoc verification compatible", () => {
    const output = `
CodeDirectory v=20500 flags=0x10002(adhoc,runtime)
Signature=adhoc
TeamIdentifier=not set
<plist><dict>${entitlements}</dict></plist>
`;

    expect(macosSignatureErrors(output)).toEqual([]);
  });
});
