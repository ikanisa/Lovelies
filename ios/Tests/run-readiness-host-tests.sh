#!/bin/bash
set -euo pipefail
LOVELIES_REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$LOVELIES_REPO_ROOT"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Native readiness host tests require macOS with Xcode/Apple SDKs." >&2
  exit 2
fi
LOVELIES_HOST_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/lovelies-readiness-host.XXXXXX")"
LOVELIES_SOURCES=(
  ios/Lovelies/Native/CoreWire.swift
  ios/Lovelies/Native/NativeLocalAuthentication.swift
  ios/Lovelies/Native/DeviceIdentity.swift
  ios/Lovelies/Native/CameraRecovery.swift
  ios/Lovelies/Native/UploadRecovery.swift
  ios/Lovelies/Native/UploadFileTransport.swift
  ios/Lovelies/Native/BackendRepository.swift
)
xcrun --sdk macosx swiftc --version
for LOVELIES_SUITE in NativeProtocolTests NativeReleaseReadinessTests NativeReadinessRecoveryTests NativeStoreDeletionRecoveryTests NativeAudienceRenewalTests; do
  xcrun --sdk macosx swiftc -j 1 "${LOVELIES_SOURCES[@]}" "ios/Tests/$LOVELIES_SUITE.swift" -o "$LOVELIES_HOST_BUILD/$LOVELIES_SUITE"
  "$LOVELIES_HOST_BUILD/$LOVELIES_SUITE"
done
python3 ios/Tests/test_release_policy_urls.py
python3 ios/Tests/test_release_origin.py
echo "Host test executables retained at $LOVELIES_HOST_BUILD. These controlled tests do not establish native device/provider/store acceptance."
