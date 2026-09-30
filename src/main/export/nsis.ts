/** NSIS installer script for an exported flow app: per-user install, no admin prompt, Start menu + desktop shortcuts. */
export interface InstallerSpec {
  name: string
  appId: string
  version: string
  description: string
  /** Staged app folder (everything in it is installed). */
  sourceDir: string
  /** The app's executable file name, inside sourceDir. */
  exe: string
  icon: string
  outFile: string
}

/** Escape text for use inside an NSIS "string": $ starts a variable and " ends the string. */
export function esc(s: string): string {
  return s.replace(/\$/g, '$$$$').replace(/"/g, '$\\"').replace(/[\r\n]+/g, ' ')
}

/** File and folder names: no characters Windows rejects. */
export function safeFileName(s: string): string {
  return (
    s
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '') || 'Flow app'
  )
}

/** "1.2" → "1.2.0.0" (VIProductVersion needs four numbers). */
export function fourPartVersion(v: string): string {
  const parts = v
    .split(/[.+-]/)
    .map((p) => parseInt(p, 10))
    .filter((n) => Number.isFinite(n))
  return [...parts, 0, 0, 0, 0].slice(0, 4).join('.')
}

export function installerScript(s: InstallerSpec): string {
  const dir = esc(safeFileName(s.name))
  const name = esc(s.name)
  const exe = esc(s.exe)
  const key = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${esc(s.appId)}`
  const appKey = `Software\\${esc(s.appId)}`
  const uninstaller = `Uninstall ${dir}.exe`
  return [
    'Unicode true',
    'ManifestDPIAware true',
    '!include "MUI2.nsh"',
    `Name "${name}"`,
    `OutFile "${esc(s.outFile)}"`,
    `InstallDir "$LOCALAPPDATA\\Programs\\${dir}"`,
    `InstallDirRegKey HKCU "${appKey}" "InstallDir"`,
    'RequestExecutionLevel user',
    'SetCompressor /SOLID lzma',
    `BrandingText "${name} ${esc(s.version)}"`,
    `!define MUI_ICON "${esc(s.icon)}"`,
    `!define MUI_UNICON "${esc(s.icon)}"`,
    '!define MUI_ABORTWARNING',
    `!define MUI_FINISHPAGE_RUN "$INSTDIR\\${exe}"`,
    `!define MUI_FINISHPAGE_RUN_TEXT "Open ${name}"`,
    '!insertmacro MUI_PAGE_DIRECTORY',
    '!insertmacro MUI_PAGE_INSTFILES',
    '!insertmacro MUI_PAGE_FINISH',
    '!insertmacro MUI_UNPAGE_CONFIRM',
    '!insertmacro MUI_UNPAGE_INSTFILES',
    '!insertmacro MUI_LANGUAGE "English"',
    `VIProductVersion "${fourPartVersion(s.version)}"`,
    `VIAddVersionKey "ProductName" "${name}"`,
    `VIAddVersionKey "FileDescription" "${esc(s.description || s.name)}"`,
    `VIAddVersionKey "FileVersion" "${esc(s.version)}"`,
    `VIAddVersionKey "ProductVersion" "${esc(s.version)}"`,
    'VIAddVersionKey "LegalCopyright" ""',
    '',
    'Section "Install"',
    '  SetOutPath "$INSTDIR"',
    // Installing over an older version: its bundled files must not linger.
    '  RMDir /r "$INSTDIR\\resources"',
    `  File /r "${esc(s.sourceDir)}\\*.*"`,
    `  WriteUninstaller "$INSTDIR\\${uninstaller}"`,
    `  CreateShortcut "$SMPROGRAMS\\${dir}.lnk" "$INSTDIR\\${exe}"`,
    `  CreateShortcut "$DESKTOP\\${dir}.lnk" "$INSTDIR\\${exe}"`,
    `  WriteRegStr HKCU "${appKey}" "InstallDir" "$INSTDIR"`,
    `  WriteRegStr HKCU "${key}" "DisplayName" "${name}"`,
    `  WriteRegStr HKCU "${key}" "DisplayVersion" "${esc(s.version)}"`,
    `  WriteRegStr HKCU "${key}" "Publisher" "Made with Cloth"`,
    `  WriteRegStr HKCU "${key}" "InstallLocation" "$INSTDIR"`,
    `  WriteRegStr HKCU "${key}" "DisplayIcon" "$INSTDIR\\${exe}"`,
    `  WriteRegStr HKCU "${key}" "UninstallString" "$\\"$INSTDIR\\${uninstaller}$\\""`,
    `  WriteRegDWORD HKCU "${key}" "NoModify" 1`,
    `  WriteRegDWORD HKCU "${key}" "NoRepair" 1`,
    'SectionEnd',
    '',
    'Section "Uninstall"',
    `  Delete "$SMPROGRAMS\\${dir}.lnk"`,
    `  Delete "$DESKTOP\\${dir}.lnk"`,
    '  RMDir /r "$INSTDIR"',
    `  DeleteRegKey HKCU "${key}"`,
    `  DeleteRegKey HKCU "${appKey}"`,
    'SectionEnd',
    ''
  ].join('\r\n')
}

/** A Windows .ico holding one PNG image (Vista and later read PNG entries). The PNG should be at most 256×256. */
export function pngToIco(png: Buffer, size: number): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size >= 256 ? 0 : size, 0)
  entry.writeUInt8(size >= 256 ? 0 : size, 1)
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([header, entry, png])
}
