"""Checks the packed .NET packages before they are uploaded or published (issue #208).

Usage: python3 check-packages.py <folder with the .nupkg files> [expected version]

It requires, reading each package's manifest as XML:
- exactly one Logbird and one Logbird.AspNetCore package in the folder, each with a non-empty version that matches its
  file name, both with the same version (and the expected version, when given);
- dependency groups for exactly the target frameworks Logbird.AspNetCore ships (its lib/<tfm>/ folders, matched by exact
  name), each with exactly one Logbird dependency, at exactly that version ([x.y.z]) and with exclude="Build,Analyzers";
- in both packages, exactly one <icon> element anywhere in the nuspec, a direct child of <metadata> in the nuspec
  namespace, naming by its exact relative path (case included; no drive, root, empty, "." or ".." segment) a file the
  package carries, whose bytes are those of the repository's logbird-icon.png; that file itself must be a complete,
  valid 128x128 PNG (every chunk's CRC, IHDR first, IEND last, image data that inflates to exactly 128 rows, each row
  starting with a valid filter type 0 to 4).

NuGet package ids are case-insensitive, so ids are compared case-insensitively everywhere.

Logbird.AspNetCore calls Logbird's internal members, so a version range could bind to a Logbird build without them.
"""

import struct
import sys
import xml.etree.ElementTree as ElementTree
import zlib
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
    return root, metadata[0], frameworks


ICON = Path(__file__).resolve().parent / "logbird-icon.png"
CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
DEPTHS = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}


def check_png(data, label):
    """A complete, valid 128x128 PNG: signature, every chunk's CRC, IHDR first, IEND last, inflating to 128 full rows."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{label}: not a PNG")
    chunks, offset = [], 8
    while offset < len(data):
        if offset + 12 > len(data):
            raise SystemExit(f"{label}: a PNG chunk is cut short")
        length, kind = struct.unpack(">I4s", data[offset:offset + 8])
        end = offset + 12 + length
        if end > len(data):
            raise SystemExit(f"{label}: a PNG chunk is cut short")
        body = data[offset + 8:offset + 8 + length]
        if struct.unpack(">I", data[end - 4:end])[0] != zlib.crc32(kind + body) & 0xFFFFFFFF:
            raise SystemExit(f"{label}: the {kind.decode('latin-1')} chunk fails its CRC")
        chunks.append((kind, body))
        offset = end
    if not chunks or chunks[0][0] != b"IHDR" or len(chunks[0][1]) != 13 or chunks[-1][0] != b"IEND":
        raise SystemExit(f"{label}: not a complete PNG (IHDR first and IEND last)")
    width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", chunks[0][1])
    if compression != 0 or filtering != 0:
        raise SystemExit(f"{label}: compression method {compression} or filter method {filtering} is not the PNG standard's 0")
    if (width, height) != (128, 128):
        raise SystemExit(f"{label}: {width}x{height}, not 128x128")
    if color not in CHANNELS or interlace != 0:
        raise SystemExit(f"{label}: unsupported PNG colour type {color} or interlaced")
    if depth not in DEPTHS[color]:
        raise SystemExit(f"{label}: bit depth {depth} is not allowed for colour type {color}")
    kinds = [kind for kind, _ in chunks]
    if b"IDAT" not in kinds:
        raise SystemExit(f"{label}: no image data")
    if color == 3 and (b"PLTE" not in kinds or kinds.index(b"PLTE") > kinds.index(b"IDAT")):
        raise SystemExit(f"{label}: an indexed-colour PNG needs a PLTE chunk before its image data")
    try:
        pixels = zlib.decompress(b"".join(body for kind, body in chunks if kind == b"IDAT"))
    except zlib.error as error:
        raise SystemExit(f"{label}: the image data does not inflate ({error})") from error
    row = 1 + (width * CHANNELS[color] * depth + 7) // 8
    if len(pixels) != row * height:
        raise SystemExit(f"{label}: the image data holds {len(pixels)} bytes, not {height} rows of {row}")
    # Filter method 0 defines filter types 0 to 4 at the start of every row; anything else cannot be decoded.
    bad = [line for line in range(height) if pixels[line * row] > 4]
    if bad:
        raise SystemExit(f"{label}: row {bad[0]} has filter type {pixels[bad[0] * row]}, not 0 to 4")


def check_icon(package, root, metadata):
    """Exactly one <icon> in the nuspec namespace names, exactly, a file whose bytes are the repository icon's."""
    namespace = root.tag[: root.tag.index("}") + 1] if root.tag.startswith("{") else ""
    icons = [child for child in metadata if child.tag == f"{namespace}icon"]
    everywhere = [element for element in root.iter() if local(element.tag) == "icon"]
    if len(icons) != 1 or len(everywhere) != 1:
        raise SystemExit(
            f"{package.name}: expected exactly one <icon> element in the nuspec, a child of <metadata> in its namespace; "
            f"found {len(icons)} there and {len(everywhere)} in all")
    # NuGet resolves the icon by its exact relative path; only the directory separator may differ (NU5046 for case).
    icon = (icons[0].text or "").strip().replace("\\", "/")
    segments = icon.split("/")
    if not icon or icon.startswith("/") or ":" in icon or any(part in ("", ".", "..") for part in segments):
        raise SystemExit(f"{package.name}: <icon> must name a plain relative path inside the package, not {icon!r}")
    with zipfile.ZipFile(package) as archive:
        if icon not in archive.namelist():
            raise SystemExit(f"{package.name}: <icon> names {icon}, which the package does not carry under that exact name")
        data = archive.read(icon)
    if data != ICON.read_bytes():
        raise SystemExit(f"{package.name}: the icon {icon} is not the repository's {ICON.name}")
    return icon


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
        root, metadata, frameworks = manifest(package)
        package_id = text(metadata, "id", package)
        version = text(metadata, "version", package)
        if package.name != f"{package_id}.{version}.nupkg":
            raise SystemExit(f"{package.name}: the file name does not match its manifest ({package_id} {version})")
        packages.setdefault(package_id.lower(), []).append((package, metadata, frameworks, version, root))

    for package_id in ("Logbird", "Logbird.AspNetCore"):
        found = packages.get(package_id.lower(), [])
        if len(found) != 1:
            raise SystemExit(f"expected exactly one {package_id} package (any casing) in {folder}, found {len(found)}: {[p.name for p, *_ in found]}")

    check_png(ICON.read_bytes(), f"the repository icon {ICON.name}")
    icons = [check_icon(package, root, metadata) for package, metadata, _, _, root in (packages["logbird"][0], packages["logbird.aspnetcore"][0])]

    _, _, _, logbird_version, _ = packages["logbird"][0]
    aspnet, metadata, frameworks, aspnet_version, _ = packages["logbird.aspnetcore"][0]
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
            groups.setdefault((group.get("targetFramework") or "").lower(), []).append(group)

    # The declared groups must be exactly the shipped frameworks, by exact name: no group a consumer could select that
    # this check does not see, and no shipped framework without its group.
    shipped = {framework.lower() for framework in frameworks}
    if set(groups) != shipped:
        raise SystemExit(f"{aspnet.name}: dependency groups {sorted(groups)} do not match the shipped frameworks {sorted(shipped)}")

    pinned = f"[{logbird_version}]"
    for framework in frameworks:
        matching = groups[framework.lower()]
        if len(matching) != 1:
            raise SystemExit(f"{aspnet.name}: expected one dependency group for {framework}, found {len(matching)}")
        logbird = [d for d in children(matching[0], "dependency") if (d.get("id") or "").lower() == "logbird"]
        if len(logbird) != 1:
            raise SystemExit(f"{aspnet.name}: the {framework} group has {len(logbird)} Logbird dependencies, expected one")
        version = logbird[0].get("version")
        exclude = {part.strip() for part in (logbird[0].get("exclude") or "").split(",") if part.strip()}
        if version != pinned:
            raise SystemExit(f"{aspnet.name}: the {framework} group depends on Logbird {version}, not exactly {pinned}")
        if exclude != EXCLUDE:
            raise SystemExit(f"{aspnet.name}: the {framework} Logbird dependency excludes {sorted(exclude)}, expected {sorted(EXCLUDE)}")

    print(f"Logbird {logbird_version} and Logbird.AspNetCore {aspnet_version}: Logbird.AspNetCore depends on exactly Logbird {pinned} for {', '.join(frameworks)}; both carry their 128x128 PNG icon ({', '.join(icons)})")


if __name__ == "__main__":
    main()
