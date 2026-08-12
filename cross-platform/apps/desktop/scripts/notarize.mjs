import { notarize } from '@electron/notarize'
import { join } from 'node:path'

export default async function notarizeAfterSign(context) {
  // Official releases are intentionally unsigned because this project has no
  // Apple Developer account. CI sets SKIP_NOTARIZE explicitly and publishes a
  // deterministic dmg/zip that users can locally de-quarantine with xattr.
  if (context.electronPlatformName !== 'darwin' || process.env.SKIP_NOTARIZE === 'true') return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const keyCredentials = process.env.APPLE_API_KEY
    && process.env.APPLE_API_KEY_ID
    && process.env.APPLE_API_ISSUER
  const idCredentials = process.env.APPLE_ID
    && process.env.APPLE_APP_SPECIFIC_PASSWORD
    && process.env.APPLE_TEAM_ID

  if (keyCredentials) {
    await notarize({
      appPath,
      appleApiKey: process.env.APPLE_API_KEY,
      appleApiKeyId: process.env.APPLE_API_KEY_ID,
      appleApiIssuer: process.env.APPLE_API_ISSUER,
    })
    return
  }
  if (idCredentials) {
    await notarize({
      appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    })
    return
  }
  console.warn('Skipping macOS notarization: Apple credentials are not configured.')
}
