import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const common = {
  manifest_version: 3,
  name: 'YTM Lyrics Following',
  version,
  description: 'Follow synced lyrics inside the YouTube Music lyrics tab, powered by LRCLIB.',
  permissions: ['storage'],
  host_permissions: ['https://lrclib.net/*'],
  content_scripts: [{
    matches: ['https://music.youtube.com/*'],
    js: ['content.js'],
    run_at: 'document_idle',
  }],
};

for (const browser of ['firefox', 'chromium']) {
  const outdir = path.join(root, 'dist', browser);
  await mkdir(outdir, { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints: ['src/content.js', 'src/background.js'],
    bundle: true,
    format: 'iife',
    target: browser === 'firefox' ? 'firefox142' : 'chrome121',
    outdir,
    legalComments: 'none',
  });
  const manifest = {
    ...common,
    ...(browser === 'firefox' ? {
      background: { scripts: ['background.js'] },
      browser_specific_settings: { gecko: {
        id: 'ytm-lyrics-following@local.extension',
        strict_min_version: '142.0',
        data_collection_permissions: { required: ['websiteContent'] },
      } },
    } : {
      minimum_chrome_version: '121',
      background: { service_worker: 'background.js' },
    }),
  };
  await writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Built dist/${browser}`);
}
