// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
import { renderAsync } from '@resvg/resvg-js'
import {
  readdirSync,
  lstatSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { every } from 'modern-async'
import { dirname, extname, join } from 'node:path'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import asyncIcns from 'async-icns';

// @ts-ignore
import text2Svg from 'text-svg'

import { config } from '../..'
import { CONFIGS_DIR, ENGINE_DIR, MELON_TMP_DIR } from '../../constants'
import { log } from '../../log'
import {
  addHash,
  defaultBrandsConfig,
  ensureEmpty,
  filesExist,
  mkdirpSync,
  stringTemplate,
  walkDirectory,
  windowsPathToUnix,
} from '../../utils'
import { templateDirectory } from '../setup-project'
import { IMelonPatch } from './command'

// =============================================================================
// Pure constants

export const BRANDING_DIR = join(CONFIGS_DIR, 'branding')
const BRANDING_STORE = join(ENGINE_DIR, 'browser', 'branding')
const BRANDING_FF = join(BRANDING_STORE, 'unofficial')

const REQUIRED_FILES = ['logo.png']
const BRANDING_NSIS = 'branding.nsi';

const CSS_REPLACE_REGEX = new RegExp(
  '#130829|hsla\\(235, 43%, 10%, .5\\)',
  'gm'
)

// =============================================================================
// Utility Functions

function checkForFaults(name: string, configPath: string) {
  if (!existsSync(configPath)) {
    throw new Error(`Branding ${name} does not exist`)
  }

  const requiredFiles = REQUIRED_FILES.map((file) => join(configPath, file))
  const requiredFilesExist = filesExist(requiredFiles)

  if (!requiredFilesExist) {
    throw new Error(
      `Missing some of the required files: ${requiredFiles
        .filter((file) => !existsSync(file))
        .join(', ')}`
    )
  }
}

function constructConfig(name: string) {
  return {
    brandingGenericName: config.name,
    brandingVendor: config.vendor,

    ...defaultBrandsConfig,
    ...config.brands[name],
  }
}

// =============================================================================
// Main code

async function setupImages(configPath: string, outputPath: string, brandingConfig: {
  backgroundColor: string
  brandShorterName: string
  brandShortName: string
  brandFullName: string
  brandingGenericName: string
  brandingVendor: string
}) {
  log.debug('Generating icons')

  // Firefox doesn't use 512 by 512, but we need it to generate ico files later
  await every([16, 22, 24, 32, 48, 64, 128, 256, 512], async (size) => {
    await sharp(join(configPath, 'logo.png'))
      .resize(size, size)
      .toFile(join(outputPath, `default${size}.png`))

    await copyFile(
      join(outputPath, `default${size}.png`),
      join(configPath, `logo${size}.png`)
    )

    return true
  })

  log.debug('Generating Windows Icons')
  writeFileSync(
    join(outputPath, 'firefox.ico'),
    await pngToIco([join(configPath, 'logo512.png')])
  )
  writeFileSync(
    join(outputPath, 'firefox64.ico'),
    await pngToIco([join(configPath, 'logo64.png')])
  )

  // TODO: Custom MacOS icon support
  if ((process as any).surferPlatform == 'darwin') {
    log.debug('Generating Mac Icons')
    const temporary = join(MELON_TMP_DIR, 'macos_icon_info.iconset')

    if (existsSync(temporary)) await rm(temporary, { recursive: true })

    asyncIcns.convert({
      input: join(configPath, 'logo.png'),
      output: join(outputPath, 'firefox.icns'),
      sizes: [16, 32, 64, 128, 256, 512],
      tmpDirectory: temporary,
    })
  }

  mkdirSync(join(outputPath, 'content'), { recursive: true })

  await sharp(join(configPath, 'logo.png'))
    .resize(512, 512)
    .toFile(join(outputPath, 'content', 'about-logo.png'))
  await sharp(join(configPath, 'logo.png'))
    .resize(1024, 1024)
    .toFile(join(outputPath, 'content', 'about-logo@2x.png'))
  
  await writeFile(join(outputPath, 'content', 'firefox-wordmark.svg'), text2Svg(brandingConfig.brandShorterName, {
    font: '80px Futura',
  }))

  // Register logo in cache
  await addHash(join(configPath, 'logo.png'))

  log.debug('Generating macos install')
  const macosInstall = await renderAsync(
    await readFile(join(configPath, 'MacOSInstaller.svg'))
  )
  await writeFile(join(outputPath, 'content', 'background.png'), macosInstall)

  await addHash(join(configPath, 'MacOSInstaller.svg'))
}

async function setupLocale(
  outputPath: string,
  brandingConfig: {
    backgroundColor: string
    brandShorterName: string
    brandShortName: string
    brandFullName: string
    brandingGenericName: string
    brandingVendor: string
  }
) {
  for (const file of await walkDirectory(
    join(templateDirectory, 'branding.optional')
  )) {
    const fileContents = await readFile(windowsPathToUnix(file), {
      encoding: 'utf8',
    })

    const universalPath =
      // We want to avoid the pain that windows is going to throw at us with its
      // weird paths
      windowsPathToUnix(file)
        // We want to remove all of the extra folders that surround this from the
        // template folder
        .replace(
          windowsPathToUnix(join(templateDirectory, 'branding.optional') + '/'),
          ''
        )

    const sourceFolderPath = join(outputPath, universalPath)

    await mkdir(dirname(sourceFolderPath), { recursive: true })
    await writeFile(
      sourceFolderPath,
      stringTemplate(fileContents, brandingConfig)
    )
  }
}

async function copyMozFiles(
  outputPath: string,
  brandingConfig: {
    backgroundColor: string
    brandShorterName: string
    brandShortName: string
    brandFullName: string
    brandingGenericName: string
    brandingVendor: string
  }
) {
  const firefoxBrandingDirectoryContents = await walkDirectory(BRANDING_FF)
  const files = firefoxBrandingDirectoryContents.filter(
    (file) => !existsSync(join(outputPath, file.replace(BRANDING_FF, '')))
  )

  const css = files.filter((file) => extname(file).includes('css'));

  const everythingElse = files.filter((file) => !css.includes(file) && !file.includes(BRANDING_NSIS));

  for (const [contents, path] of css
    .map((filePath) => [
      readFileSync(filePath).toString(),
      join(outputPath, filePath.replace(BRANDING_FF, '')),
    ])
    .map(([contents, path]) => [
      contents.replace(CSS_REPLACE_REGEX, 'var(--theme-bg)') +
        `:root { --theme-bg: ${brandingConfig.backgroundColor} }`,
      path,
    ])) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }

  const brandingNsis = files.filter((file) => file.includes(BRANDING_NSIS));
  console.assert(brandingNsis.length == 1, 'There should only be one branding.nsi file');
  const outputBrandingNsis = join(outputPath, brandingNsis[0].replace(BRANDING_FF, ''));
  log.debug('Configuring branding.nsi into ' + outputBrandingNsis);
  configureBrandingNsis(outputBrandingNsis, brandingConfig);

  // Copy everything else from the default firefox branding directory
  for (const file of everythingElse) {
    mkdirpSync(dirname(join(outputPath, file.replace(BRANDING_FF, ''))))
    copyFileSync(file, join(outputPath, file.replace(BRANDING_FF, '')))
  }
}

// =============================================================================
// Exports

export interface IBrandingPatch extends IMelonPatch {
  value: unknown
}

export function get(): string[] {
  if (!existsSync(BRANDING_DIR)) return []

  return readdirSync(BRANDING_DIR).filter((file) =>
    lstatSync(join(BRANDING_DIR, file)).isDirectory()
  )
}

export async function apply(name: string): Promise<void> {
  const configPath = join(BRANDING_DIR, name)
  const outputPath = join(BRANDING_STORE, name)

  checkForFaults(name, configPath)

  const brandingConfig = constructConfig(name)

  // Remove the output path if it exists and recreate it
  ensureEmpty(outputPath)

  await setupImages(configPath, outputPath, brandingConfig);
  await setupLocale(outputPath, brandingConfig)
  await copyMozFiles(outputPath, brandingConfig)
}

function configureBrandingNsis(brandingNsis: string, brandingConfig: {
  backgroundColor: string
  brandShorterName: string
  brandShortName: string
  brandFullName: string
  brandingGenericName: string
  brandingVendor: string
}) {
  writeFileSync(brandingNsis, `
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# NSIS branding defines for official release builds.
# The nightly build branding.nsi is located in browser/installer/windows/nsis/
# The unofficial build branding.nsi is located in browser/branding/unofficial/

# BrandFullNameInternal is used for some registry and file system values
# instead of BrandFullName and typically should not be modified.
!define BrandFullNameInternal "${brandingConfig.brandFullName}"
!define BrandFullName         "${brandingConfig.brandFullName}"
!define CompanyName           "${brandingConfig.brandingVendor}"
!define URLInfoAbout          "https://get-zen.vercel.app"
!define URLUpdateInfo         "https://get-zen.vercel.app/release-notes/\${AppVersion}"
!define HelpLink              "https://github.com/zen-browser/desktop/issues"

; The OFFICIAL define is a workaround to support different urls for Release and
; Beta since they share the same branding when building with other branches that
; set the update channel to beta.
!define OFFICIAL
!define URLStubDownloadX86 "https://download.mozilla.org/?os=win&lang=\${AB_CD}&product=firefox-latest"
!define URLStubDownloadAMD64 "https://download.mozilla.org/?os=win64&lang=\${AB_CD}&product=firefox-latest"
!define URLStubDownloadAArch64 "https://download.mozilla.org/?os=win64-aarch64&lang=\${AB_CD}&product=firefox-latest"
!define URLManualDownload "https://get-zen.vercel.app/download"
!define URLSystemRequirements "https://www.mozilla.org/firefox/system-requirements/"
!define Channel "release"

# The installer's certificate name and issuer expected by the stub installer
!define CertNameDownload   "${brandingConfig.brandFullName}"
!define CertIssuerDownload "DigiCert SHA2 Assured ID Code Signing CA"

# Dialog units are used so the UI displays correctly with the system's DPI
# settings. These are tweaked to look good with the en-US strings; ideally
# we would customize them for each locale but we don't really have a way to
# implement that and it would be a ton of work for the localizers.
!define PROFILE_CLEANUP_LABEL_TOP "50u"
!define PROFILE_CLEANUP_LABEL_LEFT "22u"
!define PROFILE_CLEANUP_LABEL_WIDTH "175u"
!define PROFILE_CLEANUP_LABEL_HEIGHT "100u"
!define PROFILE_CLEANUP_LABEL_ALIGN "left"
!define PROFILE_CLEANUP_CHECKBOX_LEFT "22u"
!define PROFILE_CLEANUP_CHECKBOX_WIDTH "175u"
!define PROFILE_CLEANUP_BUTTON_LEFT "22u"
!define INSTALL_HEADER_TOP "70u"
!define INSTALL_HEADER_LEFT "22u"
!define INSTALL_HEADER_WIDTH "180u"
!define INSTALL_HEADER_HEIGHT "100u"
!define INSTALL_BODY_LEFT "22u"
!define INSTALL_BODY_WIDTH "180u"
!define INSTALL_INSTALLING_TOP "115u"
!define INSTALL_INSTALLING_LEFT "270u"
!define INSTALL_INSTALLING_WIDTH "150u"
!define INSTALL_PROGRESS_BAR_TOP "100u"
!define INSTALL_PROGRESS_BAR_LEFT "270u"
!define INSTALL_PROGRESS_BAR_WIDTH "150u"
!define INSTALL_PROGRESS_BAR_HEIGHT "12u"

!define PROFILE_CLEANUP_CHECKBOX_TOP_MARGIN "12u"
!define PROFILE_CLEANUP_BUTTON_TOP_MARGIN "12u"
!define PROFILE_CLEANUP_BUTTON_X_PADDING "80u"
!define PROFILE_CLEANUP_BUTTON_Y_PADDING "8u"
!define INSTALL_BODY_TOP_MARGIN "20u"

# Font settings that can be customized for each channel
!define INSTALL_HEADER_FONT_SIZE 20
!define INSTALL_HEADER_FONT_WEIGHT 600
!define INSTALL_INSTALLING_FONT_SIZE 15
!define INSTALL_INSTALLING_FONT_WEIGHT 600

# UI Colors that can be customized for each channel
!define COMMON_TEXT_COLOR 0x000000
!define COMMON_BACKGROUND_COLOR 0xFFFFFF
!define INSTALL_INSTALLING_TEXT_COLOR 0xFFFFFF
# This color is written as 0x00BBGGRR because it's actually a COLORREF value.
!define PROGRESS_BAR_BACKGROUND_COLOR 0xFFAA00
`);
}
