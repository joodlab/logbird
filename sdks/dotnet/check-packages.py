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
  starting with a valid filter type 0 to 4);
- the build paths mapped as a CI build maps them (issue #322): each package has its .snupkg next to it; every DLL a
  package carries, wherever it is in the package, names its PDB under "/_/" in its one CodeView debug record (read
  through the PE debug directory, bounded by each record's declared size) and does not embed its PDB; the symbol
  package has exactly one portable PDB per DLL, the one whose PDB id matches that DLL's CodeView GUID, and that PDB's
  one Source Link record (found by its custom debug information kind, not by searching bytes) maps only "/_/" paths,
  each to https://raw.githubusercontent.com/joodlab/logbird/ at a commit. A package packed without
  ContinuousIntegrationBuild (any build outside CI, unless it passes
  -p:ContinuousIntegrationBuild=true to build and pack) embeds the machine's own paths and fails here. This checks the
  path mapping, not where the packages were built: publication evidence is the CI artifact.

NuGet package ids are case-insensitive, so ids are compared case-insensitively everywhere.

Logbird.AspNetCore calls Logbird's internal members, so a version range could bind to a Logbird build without them.
"""

import json
import re
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


SOURCE_LINK = re.compile(r"https://raw\.githubusercontent\.com/joodlab/logbird/[0-9a-f]{40}/\*")
CI_BUILD = "packed outside CI? ContinuousIntegrationBuild must be on"


def unpack(fmt, data, offset, label, what):
    """struct.unpack_from that refuses to read past the end of the data."""
    if offset < 0 or offset + struct.calcsize(fmt) > len(data):
        raise SystemExit(f"{label}: {what} runs past the end of the file")
    return struct.unpack_from(fmt, data, offset)


def codeview(data, label):
    """The PE file's one CodeView (RSDS) debug record, as (PDB GUID bytes, PDB path), read through its debug directory.

    Every record is bounded by the size its directory entry declares. A file that embeds its PDB (an
    EmbeddedPortablePdb entry, type 17) is refused, since this check reads the PDB from the symbol package."""
    if data[:2] != b"MZ":
        raise SystemExit(f"{label}: not a PE file")
    (pe,) = unpack("<I", data, 0x3C, label, "the DOS header")
    if data[pe:pe + 4] != b"PE\x00\x00":
        raise SystemExit(f"{label}: no PE signature")
    sections, optional_size = unpack("<H12xH", data, pe + 6, label, "the COFF header")
    optional = pe + 24
    (magic,) = unpack("<H", data, optional, label, "the optional header")
    if magic not in (0x10B, 0x20B):
        raise SystemExit(f"{label}: unknown optional header magic {magic:#x}")
    # The fixed part of the optional header is 96 bytes for PE32 and 112 for PE32+; NumberOfRvaAndSizes is its last field,
    # and the data directories follow. The debug directory is entry 6.
    fixed = 96 if magic == 0x10B else 112
    (count,) = unpack("<I", data, optional + fixed - 4, label, "the optional header")
    if count <= 6 or fixed + count * 8 > optional_size:
        raise SystemExit(f"{label}: the optional header has no debug directory entry")
    debug_rva, debug_size = unpack("<II", data, optional + fixed + 6 * 8, label, "the data directories")
    if debug_size == 0 or debug_size % 28:
        raise SystemExit(f"{label}: the debug directory size {debug_size} is not a whole number of entries")
    table = optional + optional_size
    for index in range(sections):
        virtual_size, virtual_address, raw_size, raw_pointer = unpack(
            "<IIII", data, table + index * 40 + 8, label, "the section table")
        if virtual_address <= debug_rva and debug_rva + debug_size <= virtual_address + min(virtual_size or raw_size, raw_size):
            start = debug_rva - virtual_address + raw_pointer
            break
    else:
        raise SystemExit(f"{label}: the debug directory lies in no section's raw data")
    records = []
    for entry in range(start, start + debug_size, 28):
        kind, size, _, pointer = unpack("<12xIIII", data, entry, label, "a debug directory entry")
        if kind == 17:
            raise SystemExit(f"{label}: embeds its PDB, which this check does not read; ship it in the symbol package")
        if kind != 2:
            continue
        record = data[pointer:pointer + size]
        if size < 25 or len(record) != size or record[:4] != b"RSDS" or record[-1:] != b"\x00":
            raise SystemExit(f"{label}: a CodeView debug record is malformed or cut short")
        path = record[24:-1]
        if b"\x00" in path:
            raise SystemExit(f"{label}: the CodeView PDB path has an embedded NUL")
        records.append((record[4:20], path.decode("utf-8")))
    if len(records) != 1:
        raise SystemExit(f"{label}: expected one CodeView debug record, found {len(records)}")
    return records[0]


# Portable PDB format: https://github.com/dotnet/runtime/blob/main/docs/design/specs/PortablePdb-Metadata.md
SOURCE_LINK_KIND = bytes.fromhex("560511CC91A0384D9FEC25AB9A351A6A")  # {CC110556-A091-4D38-9FEC-25AB9A351A6A}, as stored
# The type-system tables a HasCustomDebugInformation coded index can name, then the debug tables it can name.
HAS_CDI = [0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0A, 0x00, 0x0E, 0x17, 0x14, 0x11, 0x1A, 0x1B, 0x20, 0x23, 0x26,
           0x27, 0x28, 0x2A, 0x2C, 0x2B, 0x30, 0x32, 0x33, 0x34, 0x35]


def blob(heap, index, label):
    """One blob from the #Blob heap: a compressed length, then that many bytes."""
    if index >= len(heap):
        raise SystemExit(f"{label}: a blob index is outside the #Blob heap")
    first = heap[index]
    if first & 0x80 == 0:
        length, start = first, index + 1
    elif first & 0xC0 == 0x80 and index + 2 <= len(heap):
        length, start = ((first & 0x3F) << 8) | heap[index + 1], index + 2
    elif first & 0xE0 == 0xC0 and index + 4 <= len(heap):
        length, start = int.from_bytes(bytes([first & 0x1F]) + heap[index + 1:index + 4], "big"), index + 4
    else:
        raise SystemExit(f"{label}: a blob length is malformed")
    if start + length > len(heap):
        raise SystemExit(f"{label}: a blob runs past the #Blob heap")
    return heap[start:start + length]


def portable_pdb(data, label):
    """A portable PDB's id GUID and the Source Link JSON of its one Source Link custom debug information record."""
    if data[:4] != b"BSJB":
        raise SystemExit(f"{label}: not a portable PDB (no metadata signature)")
    (length,) = unpack("<I", data, 12, label, "the metadata root")
    offset = 16 + ((length + 3) & ~3)
    (stream_count,) = unpack("<2xH", data, offset, label, "the metadata root")
    offset += 4
    streams = {}
    for _ in range(stream_count):
        start, size = unpack("<II", data, offset, label, "a stream header")
        end = data.find(b"\x00", offset + 8, offset + 8 + 32)
        if end < 0:
            raise SystemExit(f"{label}: a stream name is not terminated")
        name = data[offset + 8:end].decode("ascii", "replace")
        if start + size > len(data):
            raise SystemExit(f"{label}: the {name} stream runs past the end of the file")
        streams[name] = data[start:start + size]
        offset = (end + 4) & ~3
    for required in ("#Pdb", "#~", "#Blob", "#GUID"):
        if required not in streams:
            raise SystemExit(f"{label}: the PDB has no {required} stream")
    pdb, tables, heap, guids = streams["#Pdb"], streams["#~"], streams["#Blob"], streams["#GUID"]

    # #Pdb: the 20-byte PDB id (its first 16 bytes are the GUID a DLL's CodeView record names), the entry point, then
    # the row counts of the type-system tables this PDB's rows refer to.
    pdb_id = pdb[:16]
    (referenced,) = unpack("<Q", pdb, 24, label, "the #Pdb stream")
    rows, at = {}, 32
    for table in range(64):
        if referenced >> table & 1:
            (rows[table],) = unpack("<I", pdb, at, label, "the #Pdb stream")
            at += 4

    # #~: heap index sizes, then the row count of each present table, then the rows.
    heap_sizes, valid = unpack("<6xB1xQ", tables, 0, label, "the #~ stream")
    at = 24
    present = [table for table in range(64) if valid >> table & 1]
    for table in present:
        (rows[table],) = unpack("<I", tables, at, label, "the #~ stream")
        at += 4
    if any(table < 0x30 or table > 0x37 for table in present):
        raise SystemExit(f"{label}: the #~ stream has tables a portable PDB does not define")
    string = 4 if heap_sizes & 1 else 2
    guid = 4 if heap_sizes & 2 else 2
    blob_index = 4 if heap_sizes & 4 else 2

    def rid(table):
        return 2 if rows.get(table, 0) < 1 << 16 else 4

    coded = 2 if max(rows.get(table, 0) for table in HAS_CDI) < 1 << (16 - 5) else 4
    widths = {
        0x30: blob_index + guid + blob_index + guid,                        # Document
        0x31: rid(0x30) + blob_index,                                       # MethodDebugInformation
        0x32: rid(0x06) + rid(0x35) + rid(0x33) + rid(0x34) + 4 + 4,        # LocalScope
        0x33: 2 + 2 + string,                                               # LocalVariable
        0x34: string + blob_index,                                          # LocalConstant
        0x35: rid(0x35) + blob_index,                                       # ImportScope
        0x36: rid(0x06) + rid(0x06),                                        # StateMachineMethod
        0x37: coded + guid + blob_index,                                    # CustomDebugInformation
    }
    for table in present:
        if table == 0x37:
            break
        at += rows[table] * widths[table]
    else:
        raise SystemExit(f"{label}: the PDB has no custom debug information, so no Source Link")

    def read(offset, size):
        return int.from_bytes(tables[offset:offset + size], "little")

    found = []
    if at + rows[0x37] * widths[0x37] > len(tables):
        raise SystemExit(f"{label}: the CustomDebugInformation table runs past the #~ stream")
    for row in range(rows[0x37]):
        start = at + row * widths[0x37]
        kind = read(start + coded, guid)
        if not 1 <= kind <= len(guids) // 16:
            raise SystemExit(f"{label}: a custom debug information kind is outside the #GUID heap")
        if guids[(kind - 1) * 16:kind * 16] == SOURCE_LINK_KIND:
            found.append(blob(heap, read(start + coded + guid, blob_index), label))
    if len(found) != 1:
        raise SystemExit(f"{label}: expected one Source Link record, found {len(found)}")
    return pdb_id, found[0]


def source_link(data, label):
    """The PDB id and the Source Link document map of a portable PDB, from its Source Link record."""
    pdb_id, raw = portable_pdb(data, label)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise SystemExit(f"{label}: the Source Link record is not JSON ({error})") from error
    documents = value.get("documents") if isinstance(value, dict) else None
    if not isinstance(documents, dict) or not documents:
        raise SystemExit(f"{label}: Source Link has no documents")
    return pdb_id, documents


def check_paths(package):
    """Every DLL names its PDB under /_/; its PDB, matched by GUID, maps only /_/ paths to this repository at a commit."""
    with zipfile.ZipFile(package) as archive:
        dlls = sorted(name for name in archive.namelist() if name.lower().endswith(".dll"))
        if not dlls:
            raise SystemExit(f"{package.name}: carries no DLL")
        named = {}
        for name in dlls:
            pdb_guid, path = codeview(archive.read(name), f"{package.name} {name}")
            if not path.startswith("/_/"):
                raise SystemExit(f"{package.name} {name}: names its PDB at {path!r}, not under the CI path map /_/ ({CI_BUILD})")
            named[name[:-4] + ".pdb"] = pdb_guid
    symbols = package.with_suffix(".snupkg")
    if not symbols.exists():
        raise SystemExit(f"{package.name}: its symbol package {symbols.name} is missing")
    with zipfile.ZipFile(symbols) as archive:
        pdbs = sorted(name for name in archive.namelist() if name.lower().endswith(".pdb"))
        if pdbs != sorted(named):
            raise SystemExit(f"{symbols.name}: carries PDBs {pdbs}, expected exactly one for each DLL: {sorted(named)}")
        for name in pdbs:
            label = f"{symbols.name} {name}"
            pdb_id, documents = source_link(archive.read(name), label)
            if pdb_id != named[name]:
                raise SystemExit(f"{label}: is not the PDB its DLL names (the PDB id does not match the DLL's CodeView GUID)")
            for mapped, target in documents.items():
                if not mapped.startswith("/_/"):
                    raise SystemExit(f"{label}: Source Link maps {mapped!r}, not a /_/ path ({CI_BUILD})")
                if not isinstance(target, str) or not SOURCE_LINK.fullmatch(target):
                    raise SystemExit(f"{label}: Source Link points at {target!r}, not this repository at a commit")
    return len(dlls)


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

    dlls = sum(check_paths(package) for package, *_ in (packages["logbird"][0], packages["logbird.aspnetcore"][0]))

    print(f"Logbird {logbird_version} and Logbird.AspNetCore {aspnet_version}: Logbird.AspNetCore depends on exactly Logbird {pinned} for {', '.join(frameworks)}; both carry their 128x128 PNG icon ({', '.join(icons)}); all {dlls} DLLs and their PDBs carry CI-mapped /_/ paths")


if __name__ == "__main__":
    main()
