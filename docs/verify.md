# How to verify what you downloaded

Monomem ships three ways: the standalone download (a zip or tar.gz from the GitHub release), the npm package `monomem`,
and the source. This page shows what you can check for each, with the exact commands, and says what these checks do **not** prove.

## What is signed, and what is not

| Thing | Signed or attested? | Who can check it |
|---|---|---|
| Release archives (`monomem-<version>-<target>.zip` / `.tar.gz`) | **GitHub build attestation** (SLSA build provenance): says this repository's workflow built these exact bytes | `gh attestation verify` (below) |
| Release archives | **SHA-256 listed in `SHA256SUMS`** | any computer, no extra tools (below) |
| SBOM `monomem-<version>-sbom.cdx.json` | Listed in `SHA256SUMS` and covered by the same attestation | same commands |
| npm package `monomem` | **npm provenance**: a signed statement linking the tarball to the GitHub workflow run and commit | `npm audit signatures` (below) |
| Node runtime inside the download | Signed by its makers (OpenJS Foundation on Windows, Apple Developer ID on Mac). Monomem does not change the bytes | Windows: right-click `runtime\monomem-node.exe`, Properties, Digital Signatures. Mac: `codesign --verify --strict runtime/node` |
| **Monomem's own program files (`dist/`, `monomem.cmd`)** | **NOT code-signed.** Windows code signing needs a paid certificate, and Apple notarization needs a paid developer account. Neither has been bought | nothing to check; use the attestation instead |

An attestation and a checksum prove **where the file came from and that it was not changed afterwards**. They do not prove the
code is free of bugs, and a checksum alone does not stop someone who could change the release from changing both files.
That is why the attestation matters: it is signed by GitHub, not by a file next to the download.

## 1. The standalone download

Put the archive and `SHA256SUMS` from the same release into one new, empty folder, and open a terminal there.

**Check the hash**

- Windows (PowerShell):
  ```powershell
  (Get-FileHash .\monomem-<version>-win-x64.zip -Algorithm SHA256).Hash.ToLower()
  Select-String -Path .\SHA256SUMS -Pattern 'win-x64.zip'
  ```
  The two hashes must be identical.
- Mac:
  ```bash
  shasum -a 256 -c SHA256SUMS --ignore-missing
  ```
- Linux:
  ```bash
  sha256sum -c SHA256SUMS --ignore-missing
  ```
  Expect `monomem-<version>-<target>...: OK`. Anything else: delete the file and download again.

**Check who built it** (needs the free [GitHub CLI](https://cli.github.com), version 2.49 or newer; no login is needed for a public repository)

```bash
gh attestation verify monomem-<version>-<target>.zip --repo calasdan-sketch/monomem
```
(use `.tar.gz` on Mac and Linux). A good result says `Verification succeeded` and names the workflow
`calasdan-sketch/monomem/.github/workflows/bundle.yml`. If it fails, do not run the file. To be strict about which workflow built it, add
`--signer-workflow calasdan-sketch/monomem/.github/workflows/bundle.yml`.

**Look inside the SBOM**

`monomem-<version>-sbom.cdx.json` is a CycloneDX 1.5 list of every package Monomem depends on at runtime (development tools are
left out). Check it like the archives, then open it with any CycloneDX viewer, or list the names:
```bash
node -e "for (const c of require('./monomem-<version>-sbom.cdx.json').components) console.log(c.name + '@' + c.version)"
```
Make your own, from a checkout of the matching tag: `npm run sbom` (writes `build/sbom.cdx.json`).

## 2. The npm package

In a new empty folder:
```bash
npm init -y
npm install monomem
npm audit signatures
```
Expect `verified registry signatures` and `verified attestations` (npm 9.5 or newer). The attestation names the GitHub repository and
workflow run that published the package. If `monomem` is missing from the attestation count, that version was published without
provenance: treat it with the same caution as an unsigned download. The npm package page also shows a "Built and signed on
GitHub Actions" line when provenance exists.

## 3. Windows: what you will see (SmartScreen, Smart App Control)

Because the program files are not code-signed, Windows may show a blue **"Windows protected your PC"** box (SmartScreen) the first
time you run a downloaded file, with **Run anyway** under "More info". Right-click the zip, **Properties**, tick **Unblock**, and
only then extract: the box usually does not appear. Windows 11 **Smart App Control**, if switched on, blocks unsigned programs with
no override. The launcher is a `.cmd` file and the only `.exe` is Node's own signed program, which Microsoft's documentation says is
allowed, but this has not been tested on a machine with Smart App Control on. [INSTALL.md](../INSTALL.md) shows the screens. Installing
through npm (`npm install -g monomem`) avoids the question: the program is plain JavaScript run by a Node you installed.

A warning from Windows is not evidence of a problem, and a missing warning is not evidence of safety. The checks above are the evidence.

## 4. Not done yet

- Windows Authenticode signing (needs a certificate from a commercial authority, or an approved free open-source programme; an
  application is being prepared and has not been sent).
- Apple notarization (paid developer account).
- Reproducible builds: you cannot rebuild a tag and get the same hash.
- An SBOM for the Node runtime itself (the SBOM covers Monomem's npm dependencies).

To report a problem, see "Reporting a vulnerability" in [SECURITY.md](../SECURITY.md).
