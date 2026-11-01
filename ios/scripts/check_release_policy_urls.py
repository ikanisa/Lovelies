#!/usr/bin/env python3
"""Fail Release distribution when the processed app lacks qualified URL inputs.

This checks artifact configuration only. Content, hosting, support handling and
store acceptance still require the release owner's published-page qualification.
It never contacts a host and never supplies placeholder production defaults.
"""
import argparse
import ipaddress
import plistlib
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

KEYS = (
    "LoveliesPrivacyPolicyURL",
    "LoveliesTermsURL",
    "LoveliesSupportURL",
    "LoveliesAccountDeletionURL",
)


def valid_url(raw):
    if not isinstance(raw, str) or not raw or raw != raw.strip():
        return False
    if any(ord(char) <= 32 for char in raw) or "$(" in raw or "${" in raw:
        return False
    try:
        value = urlsplit(raw)
        host = (value.hostname or "").lower()
        reserved = ("example.com", "example.org", "example.net")
        if (value.scheme != "https" or not host or "." not in host
                or value.username is not None or value.password is not None
                or value.query or value.fragment or value.port not in (None, 443)
                or host == "localhost" or any(host == item or host.endswith("." + item) for item in reserved)
                or host.endswith((".localhost", ".local", ".invalid", ".test", ".example"))):
            return False
        if len(host) > 253 or any(
                not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                for label in host.split(".")):
            return False
        try:
            ipaddress.ip_address(host)
        except ValueError:
            return True
        return False  # Public policies use their qualified HTTPS DNS identity.
    except ValueError:
        return False


def valid_api_origin(raw):
    """Require the explicit public base for the locally operated Edge Function."""
    if not isinstance(raw, str) or raw != raw.strip() or not raw or any(ord(c) <= 32 for c in raw):
        return False
    try:
        value = urlsplit(raw)
        return (value.scheme == "https" and bool(value.hostname)
                and value.username is None and value.password is None
                and value.port in (None, 443) and not value.query and not value.fragment
                and value.path in ("/functions/v1/lovelies-api", "/functions/v1/lovelies-api/")
                and "$(" not in raw and "${" not in raw and "\\" not in raw)
    except ValueError:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plist", required=True, type=Path)
    parser.add_argument("--configuration", default="Release")
    args = parser.parse_args()
    if args.configuration != "Release":
        return 0
    try:
        with args.plist.open("rb") as file:
            values = plistlib.load(file)
    except (OSError, ValueError, plistlib.InvalidFileException):
        print("error: Cannot inspect the processed Release Info.plist.", file=sys.stderr)
        return 1
    if not valid_api_origin(values.get("LoveliesAPIOrigin")):
        print("error: Release requires an explicit HTTPS local Supabase origin ending /functions/v1/lovelies-api.", file=sys.stderr)
        return 1
    missing = [key for key in KEYS if not valid_url(values.get(key))]
    if missing:
        print("error: Release requires qualified public HTTPS policy/support URL inputs: "
              + ", ".join(missing)
              + ". Supply the approved values and rebuild; no placeholder is accepted.", file=sys.stderr)
        return 1
    print("Release policy URL configuration passed; published content and device link acceptance remain separate.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
