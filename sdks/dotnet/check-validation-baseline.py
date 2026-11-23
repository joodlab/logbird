"""Fails a release whose packages could break the last published version unseen.

Usage: python3 check-validation-baseline.py <baseline version from the build, may be empty> [<package id> ...]

Package validation (EnablePackageValidation) compares each packed package with PackageValidationBaselineVersion and
fails on any breaking change, including the ones the public API analyzer does not record (base types, sealed,
interfaces, generic constraints, an enum's underlying type and more). That only works if the baseline is the latest
version actually on nuget.org, so this check asks nuget.org before packing:

- no version of the packages is published yet: a notice, and the check passes;
- a version is published and the baseline is unset or older than the latest published version: the check fails.
"""

import json
import sys
import urllib.error
import urllib.request

INDEX = "https://api.nuget.org/v3-flatcontainer/{id}/index.json"


def key(version):
    """A sort key for a NuGet version: numbers first, a pre-release before its release."""
    release, _, prerelease = version.partition("-")
    numbers = tuple(int(part) for part in release.split("+")[0].split("."))
    numbers = numbers + (0,) * (4 - len(numbers))
    labels = tuple((0, int(p)) if p.isdigit() else (1, p) for p in prerelease.split(".")) if prerelease else ()
    return numbers, 0 if prerelease else 1, labels


def published(package_id):
    try:
        with urllib.request.urlopen(INDEX.format(id=package_id.lower()), timeout=30) as response:
            return json.load(response).get("versions", [])
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return []
        raise


def main():
    baseline = sys.argv[1].strip() if len(sys.argv) > 1 else ""
    ids = sys.argv[2:] or ["Logbird", "Logbird.AspNetCore"]
    latest = {}
    for package_id in ids:
        versions = published(package_id)
        if versions:
            latest[package_id] = max(versions, key=key)

    if not latest:
        print(f"::notice::No version of {', '.join(ids)} is published on nuget.org yet; package validation has no baseline to compare with.")
        return

    for package_id, version in sorted(latest.items()):
        if not baseline:
            raise SystemExit(f"::error::{package_id} {version} is published, but PackageValidationBaselineVersion is not set. "
                             f"Set it to {version} (sdks/dotnet/Directory.Build.props) so this release is compared with it.")
        if key(baseline) < key(version):
            raise SystemExit(f"::error::PackageValidationBaselineVersion is {baseline}, older than the published {package_id} {version}. "
                             f"Set it to {version} (sdks/dotnet/Directory.Build.props).")
    print(f"PackageValidationBaselineVersion {baseline} is not older than the latest published versions: {latest}")


if __name__ == "__main__":
    main()
