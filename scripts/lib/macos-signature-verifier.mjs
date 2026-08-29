export const REQUIRED_MACOS_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.network.client",
  "com.apple.security.device.audio-input",
];

function hasEnabledEntitlement(output, entitlement) {
  const escaped = entitlement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<true\\s*/>`).test(output);
}

export function macosSignatureErrors(output, { requireDeveloperId = false } = {}) {
  const errors = [];
  const missingEntitlements = REQUIRED_MACOS_ENTITLEMENTS.filter(
    (entitlement) => !hasEnabledEntitlement(output, entitlement),
  );

  if (missingEntitlements.length > 0) {
    errors.push(`Missing signed entitlements: ${missingEntitlements.join(", ")}`);
  }
  if (/invalid entitlements blob/i.test(output)) {
    errors.push("The signed executable contains an invalid entitlements blob.");
  }
  if (!/^CodeDirectory .*flags=.*\bruntime\b/m.test(output)) {
    errors.push("The hardened runtime flag is missing from the code signature.");
  }

  if (requireDeveloperId) {
    if (!/^Authority=Developer ID Application:/m.test(output)) {
      errors.push("The Developer ID Application authority is missing.");
    }
    if (!/^Authority=Developer ID Certification Authority$/m.test(output)) {
      errors.push("The Developer ID intermediate authority is missing.");
    }
    if (!/^Authority=Apple Root CA$/m.test(output)) {
      errors.push("The Apple Root CA authority is missing.");
    }
    if (!/^TeamIdentifier=(?!not set$)\S+$/m.test(output)) {
      errors.push("The Developer ID team identifier is missing.");
    }
    if (!/^Timestamp=.+$/m.test(output)) {
      errors.push("The secure signing timestamp is missing.");
    }
    if (!/^Notarization Ticket=stapled$/m.test(output)) {
      errors.push("The notarization ticket is not stapled to the app.");
    }
    if (/^Signature=adhoc$/m.test(output)) {
      errors.push("The release app is ad-hoc signed instead of Developer ID signed.");
    }
  }

  return errors;
}
