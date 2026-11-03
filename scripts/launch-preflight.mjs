import { readCloudBuildConfig } from './cloud-build-config.mjs'

try {
  readCloudBuildConfig(process.env.FAANGIN_CLOUD_CONFIG_FILE || new URL('../config/cloud.supabase.json', import.meta.url), { required: true })
  console.log('Public Supabase release configuration is valid. Run npm run verify:launch for desktop, Postgres, Edge Function and gateway checks. Deployed checkout, live inference/audio, and signed installer acceptance remain release gates.')
} catch (error) {
  console.error(`Launch preflight blocked: ${error.message}`)
  process.exitCode = 1
}
