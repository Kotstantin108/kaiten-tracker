#!/usr/bin/env node
// Точка входа `kaiten` для npm link (так её кладёт в PATH scripts/install.mjs): подключает tsx и запускает src/kaiten.ts.
import { register } from 'tsx/esm/api';

register();
await import(new URL('../src/kaiten.ts', import.meta.url).href);
