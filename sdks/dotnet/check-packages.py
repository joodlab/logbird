"""Checks the packed .NET packages before they are uploaded or published (issue #208).

Usage: python3 check-packages.py <folder with the .nupkg files> [expected version]

It requires, reading each package's manifest as XML:
- exactly one Logbird and one Logbird.AspNetCore package in the folder, each with a non-empty version that matches its
  file name, both with the same version (and the expected version, when given);
- for every target framework Logbird.AspNetCore ships (its lib/<tfm>/ folders), a dependency group for that framework
  with exactly one Logbird dependency, at exactly that version ([x.y.z]) and with exclude="Build,Analyzers".

Logbird.AspNetCore calls Logbird's internal members, so a version range could bind to a Logbird build without them.
"""

import sys
import xml.etree.ElementTree as ElementTree
import zipfile
from pathlib import Path

EXCLUDE = {"Build", "Analyzers"}


def local(tag):
    return tag.rsplit("}", 1)[-1]


def children(element, name):
    return [child for child in element if local(child.tag) == name]


def manifest(package):
    with zipfile.ZipFile(package) as archive:
        nuspecs = [name for name in archive.namelist() if "/" not in name and name.endswith(".nuspec")]
        if len(nuspecs) != 1:
            raise SystemExit(f"{package.name}: expected one .nuspec at the root, found {len(nuspecs)}")
        root = ElementTree.fromstring(archive.read(nuspecs[0]))
        frameworks = sorted({name.split("/")[1] for name in archive.namelist() if name.startswith("lib/") and name.count("/") >= 2})
    metadata = children(root, "metadata")
    if len(metadata) != 1:
        raise SystemExit(f"{package.name}: expected one <metadata> element")
    return metadata[0], frameworks


def text(metadata, name, package):
    found = children(metadata, name)
    value = (found[0].text or "").strip() if len(found) == 1 else ""
    if not value:
        raise SystemExit(f"{package.name}: <{name}> is missing or empty")
    return value


def main():
    folder = Path(sys.argv[1])
    expected = sys.argv[2] if len(sys.argv) > 2 else None
    packages = {}
    for package in sorted(folder.glob("*.nupkg")):
        metadata, frameworks = manifest(package)
        package_id = text(metadata, "id", package)
        version = text(metadata, "version", package)
        if package.name != f"{package_id}.{version}.nupkg":
            raise SystemExit(f"{package.name}: the file name does not match its manifest ({package_id} {version})")
        packages.setdefault(package_id, []).append((package, metadata, frameworks, version))

    for package_id in ("Logbird", "Logbird.AspNetCore"):
        found = packages.get(package_id, [])
        if len(found) != 1:
            raise SystemExit(f"expected exactly one {package_id} package in {folder}, found {len(found)}: {[p.name for p, *_ in found]}")

    _, _, _, logbird_version = packages["Logbird"][0]
    aspnet, metadata, frameworks, aspnet_version = packages["Logbird.AspNetCore"][0]
    if aspnet_version != logbird_version:
        raise SystemExit(f"Logbird is {logbird_version} but Logbird.AspNetCore is {aspnet_version}")
    if expected is not None and logbird_version != expected:
        raise SystemExit(f"the packages are {logbird_version}, not the expected {expected}")
    if not frameworks:
        raise SystemExit(f"{aspnet.name}: ships no lib/<framework>/ folder")

    groups = {}
    for dependencies in children(metadata, "dependencies"):
        if [child for child in dependencies if local(child.tag) == "dependency"]:
            raise SystemExit(f"{aspnet.name}: dependencies outside a target framework group")
        for group in children(dependencies, "group"):
            groups.setdefault(group.get("targetFramework", ""), []).append(group)

    pinned = f"[{logbird_version}]"
    for framework in frameworks:
        matching = [group for name, found in groups.items() for group in found if name.lower().replace(".", "") == framework.lower().replace(".", "")]
        if len(matching) != 1:
            raise SystemExit(f"{aspnet.name}: expected one dependency group for {framework}, found {len(matching)}")
        logbird = [d for d in children(matching[0], "dependency") if d.get("id") == "Logbird"]
        if len(logbird) != 1:
            raise SystemExit(f"{aspnet.name}: the {framework} group has {len(logbird)} Logbird dependencies, expected one")
        version = logbird[0].get("version")
        exclude = {part.strip() for part in (logbird[0].get("exclude") or "").split(",") if part.strip()}
        if version != pinned:
            raise SystemExit(f"{aspnet.name}: the {framework} group depends on Logbird {version}, not exactly {pinned}")
        if exclude != EXCLUDE:
            raise SystemExit(f"{aspnet.name}: the {framework} Logbird dependency excludes {sorted(exclude)}, expected {sorted(EXCLUDE)}")

    print(f"Logbird {logbird_version} and Logbird.AspNetCore {aspnet_version}: Logbird.AspNetCore depends on exactly Logbird {pinned} for {', '.join(frameworks)}")


if __name__ == "__main__":
    main()
