const { copyFileSync } = require('node:fs');
copyFileSync('packages/adapters/src/engine-supervisor.cjs', 'dist/host/engine-supervisor.cjs');
