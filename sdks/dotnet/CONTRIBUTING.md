# Changing the .NET SDK's public API

The public API of `Logbird` and `Logbird.AspNetCore` is checked in three layers. Read this before a change that adds,
removes or alters anything public, and read by hand what no layer catches.

## The layers

1. **The public API analyzer** (`Microsoft.CodeAnalysis.PublicApiAnalyzers`, build-time only).
   - **What it records:** every public and protected symbol in `src/<package>/PublicAPI.Shipped.txt` (what a published
     version contains) and `PublicAPI.Unshipped.txt` (what was added since).
   - **When it fails:** the build fails (RS0016, RS0017) when a public symbol is missing from those files or a recorded
     symbol is gone.
   - **What it catches:** added, removed or renamed types and members; parameter and return types; parameter names,
     ref kinds and defaults; constants and enum values; nullability annotations (`?` and `!`); extension receivers
     (`this`); and accessors (`get`, `set`, `init`).
   - **To change the API on purpose:** add or remove the lines the build error names, in `PublicAPI.Unshipped.txt`.
2. **The defaults record** (`src/<package>/PublicAPI.Defaults.txt`, checked by `OptionDefaultsTests`).
   - **What it records:** the default value of every public property of the audited option types (`LogbirdOptions`,
     `RedactionOptions`, `LogbirdReadOptions`, `EventSearch`, `LogbirdRequestOptions`), with nested options, regex
     pattern, options and timeout, and collection mutability.
   - **Why it exists:** defaults are behaviour, and neither Microsoft tool records them.
   - **To change a default on purpose:** run the tests with `LOGBIRD_UPDATE_PUBLIC_API=1` (never in CI) and commit the
     file.
3. **Package validation** (`EnablePackageValidation`, the SDK's ApiCompat, at pack time).
   - **Today:** it checks that the targets inside each package (net8.0 and netstandard2.0 for `Logbird`) are
     compatible.
   - **From the first publication on:** `PackageValidationBaselineVersion` names the latest version on nuget.org.
     Validation then compares each new package with that published one and fails on a breaking change, including all
     the ones the analyzer does not record (listed below).
   - **Safeguard:** the release job refuses to publish while the baseline is unset or older than the latest published
     version.

## What only package validation catches (after the first publication)

The analyzer does not record these, so before the first publication only a reader catches them:

- a class's base type, or a class becoming `sealed` or `abstract`;
- an enum's underlying type;
- generic constraints and variance;
- `required` members, `readonly`/`ref` structs, and `ref readonly` returns;
- `protected internal` becoming `protected`, or a protected accessor becoming public;
- an implemented interface removed;
- an event replaced by a field.

## What no layer catches

Read these by hand in every API change:

- nullability attributes such as `[AllowNull]` and `[NotNullWhen]`, and other attributes (`[Obsolete]`,
  `[EditorBrowsable]`);
- an implemented interface added (not breaking, so package validation allows it, but still a change to the surface);
- XML documentation, and what a member does: a behaviour change behind an unchanged signature;
- defaults of types outside the audited list, such as read models filled from the server (`StoredEvent`).
