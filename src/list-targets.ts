import { env } from './config.js';
import { Platform } from './platform.js';

const platform = new Platform(env('PLATFORM_ORIGIN', 'https://de-agents.kore.ai'), env('VM_BEARER_TOKEN'));
const projectId = env('PROJECT_ID');
const cfg = await platform.softphoneConfig();
console.log(`softphone ok: sipDomain=${cfg.sipDomain} ws=${cfg.wsServers.join(',')}`);
const rows = await platform.targets(projectId);
if (!rows.length) console.log('No test-call targets for this project (is a voice channel deployed?)');
for (const r of rows) console.log(`${r.kind}\tconnectionId=${r.connectionId}\ttarget=${r.number}`);
console.log('\nPut the connectionId of the channel you want into CONNECTION_ID in .env');
