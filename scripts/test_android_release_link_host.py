#!/usr/bin/env python3
"""Exercise Android release host preflight with an isolated synthetic key.

This runs an offline Gradle build in a temporary copy of the Android project.
It does not sign an application, contact a provider, or use the upload key.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
HOST = "lovelies.ikanisa.com"
ANDROID_NS = "{http://schemas.android.com/apk/res/android}"


def run(argv: list[str], *, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)


def require_success(result: subprocess.CompletedProcess[str], label: str) -> None:
    if result.returncode:
        raise RuntimeError(f"{label} failed ({result.returncode}):\n{result.stdout}")


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="lovelies-release-host-") as scratch:
        work = Path(scratch)
        project = work / "android"
        shutil.copytree(ROOT / "android", project, ignore=shutil.ignore_patterns("build", ".gradle", ".kotlin"))
        env = os.environ.copy()
        env["LOVELIES_TEST_KEY_PASSWORD"] = "local-test-key-only"
        key = work / "test-upload.p12"
        generated = run([
            "keytool", "-genkeypair", "-alias", "local-test", "-keyalg", "EC", "-validity", "1",
            "-dname", "CN=Lovelies local test", "-keystore", str(key), "-storetype", "PKCS12",
            "-storepass:env", "LOVELIES_TEST_KEY_PASSWORD", "-keypass:env", "LOVELIES_TEST_KEY_PASSWORD",
        ], cwd=work, env=env)
        require_success(generated, "Generate synthetic signing key")
        exported = subprocess.run([
            "keytool", "-exportcert", "-alias", "local-test", "-keystore", str(key),
            "-storepass:env", "LOVELIES_TEST_KEY_PASSWORD",
        ], cwd=work, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout
        fingerprint = hashlib.sha256(exported).hexdigest().upper()
        signing = work / "signing.properties"
        signing.write_text(f"storeFile={key}\nstorePassword=local-test-key-only\nkeyAlias=local-test\nkeyPassword=local-test-key-only\n")
        properties = {
            "loveliesSigningPropertiesFile": str(signing),
            "loveliesExpectedUploadCertificateSha256": fingerprint,
            "loveliesKnownHighestPlayVersionCode": "17",
            "loveliesApiUrl": "https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api",
            "loveliesPrivacyPolicyUrl": "https://example.invalid/privacy",
            "loveliesTermsUrl": "https://example.invalid/terms",
            "loveliesDeletionUrl": "https://example.invalid/deletion",
            "loveliesPlayProduct": "local.test.product",
            "loveliesFirebaseProjectId": "local-test",
            "loveliesFirebaseAppId": "local-test-app",
            "loveliesFirebaseApiKey": "local-test-key",
            "loveliesFirebaseSenderId": "123456789",
        }
        common = [str(project / "gradlew"), "--offline", "--no-daemon", "--max-workers=2", "--project-cache-dir", str(work / "project-cache")]
        args = [f"-P{name}={value}" for name, value in properties.items()]
        positive = run(common + [":app:validateLoveliesRelease", ":app:generateReleaseBuildConfig", ":app:processReleaseMainManifest", *args, f"-PloveliesLinkHost={HOST}"], cwd=project, env=env)
        require_success(positive, "Verified host preflight and generated release metadata")

        configs = list((project / "app" / "build").glob("generated/**/release/**/BuildConfig.java"))
        if len(configs) != 1 or f'LINK_HOST = "{HOST}"' not in configs[0].read_text():
            raise RuntimeError("Generated release BuildConfig does not contain exactly the verified host")
        manifests = list((project / "app" / "build").glob("intermediates/merged_manifest/release/**/AndroidManifest.xml"))
        if len(manifests) != 1:
            raise RuntimeError("Expected one generated release manifest")
        data = ET.parse(manifests[0]).getroot().iter("data")
        links = {(item.get(ANDROID_NS + "scheme"), item.get(ANDROID_NS + "host"), item.get(ANDROID_NS + "pathPrefix")) for item in data}
        if not {("https", HOST, "/requests/"), ("https", HOST, "/notifications/")} <= links:
            raise RuntimeError("Generated release manifest does not contain both verified HTTPS link paths")
        print("PASS: verified host preflight, release BuildConfig and both manifest paths")

        for host, expected in [
            ("unverified.example", "The release App Links host must match the published Lovelies association host."),
            ("", "Missing Lovelies release configuration:"),
        ]:
            negative = run(common + [":app:validateLoveliesRelease", *args, f"-PloveliesLinkHost={host}"], cwd=project, env=env)
            if negative.returncode == 0 or expected not in negative.stdout:
                raise RuntimeError(f"Preflight did not reject host {host!r} as expected:\n{negative.stdout}")
            print(f"PASS: rejected {'unverified' if host else 'blank'} host")


if __name__ == "__main__":
    main()
