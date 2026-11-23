"""Fails a release whose packages could break the last published version unseen.

Usage: python3 check-validation-baseline.py <release version> <baseline version from the build, may be empty> <package id> [...]

Package validation (EnablePackageValidation) compares each packed package with PackageValidationBaselineVersion and
fails on breaking changes, including several the public API analyzer does not record (a base type or an interface
removed, sealed, generic constraints, an enum's underlying type and more). That only works if the baseline is the latest
version published before this release, so this check asks nuget.org before packing:

- no version below the release version is published yet: a notice, and the check passes;
- such a version is published and the baseline is unset or older than the latest of them: the check fails.

Versions at or above the release version are ignored, so rerunning the same release after a partial publication (one
package pushed, the other not yet) still passes. Build metadata (+...) is ignored when versions are compared, as NuGet does.
"""

import json
import sys
import urllib.error
import urllib.request

INDEX = "https://api.nuget.org/v3-flatcontainer/{id}/index.json"


def key(version):
    """A NuGet version sort key: build metadata ignored, numbers first, a pre-release before its release."""
    version = version.strip().split("+", 1)[0]
    release, _, prerelease = version.partition("-")
    numbers = tuple(int(part) for part in release.split("."))
    numbers = numbers + (0,) * (4 - len(numbers))
    labels = tuple((0, int(p), "") if p.isdigit() else (1, 0, p.lower()) for p in prerelease.split(".")) if prerelease else ()
    return numbers, 0 if prerelease else 1, labels


def published(package_id):
    """Every version nuget.org has for the id (unlisted ones included); an empty list only for an unknown id (404)."""
    try:
        with urllib.request.urlopen(INDEX.format(id=package_id.lower()), timeout=30) as response:
            document = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return []
        raise
    versions = document.get("versions") if isinstance(document, dict) else None
    if not isinstance(versions, list) or not all(isinstance(v, str) for v in versions):
        raise SystemExit(f"::error::nuget.org answered for {package_id} without a version list; refusing to treat it as unpublished.")
    return versions


def main():
    if len(sys.argv) < 4:
        raise SystemExit("usage: check-validation-baseline.py <release version> <baseline version or empty> <package id> [...]")
    release = sys.argv[1].strip()
    baseline = sys.argv[2].strip()
    ids = sys.argv[3:]
    latest = {}
    for package_id in ids:
        earlier = [v for v in published(package_id) if key(v) < key(release)]
        if earlier:
            latest[package_id] = max(earlier, key=key)

    if not latest:
        print(f"::notice::No version of {', '.join(ids)} below {release} is published on nuget.org; package validation has no baseline to compare with.")
        return

    for package_id, version in sorted(latest.items()):
        if not baseline:
            raise SystemExit(f"::error::{package_id} {version} is published, but PackageValidationBaselineVersion is not set. "
                             f"Set it to {version} (sdks/dotnet/Directory.Build.props) so this release is compared with it.")
        if key(baseline) < key(version):
            raise SystemExit(f"::error::PackageValidationBaselineVersion is {baseline}, older than the published {package_id} {version}. "
                             f"Set it to {version} (sdks/dotnet/Directory.Build.props).")
    print(f"PackageValidationBaselineVersion {baseline} is not older than the latest versions published before {release}: {latest}")


if __name__ == "__main__":
    main()
