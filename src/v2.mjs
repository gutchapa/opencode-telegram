// OpenCode V2 plugin entry.
//
// @opencode/plugin is ESM-only, so this file (copied to dist/v2.mjs by the build)
// is the ESM default export. All runtime logic stays in the CJS build and is
// reached through dist/v2-setup.js.
import { Plugin } from '@opencode/plugin';
import cjs from './v2-setup.js';

const setup = cjs && cjs.setupV2 ? cjs.setupV2 : cjs && cjs.default && cjs.default.setupV2;

export default Plugin.define({
  id: 'gutchapa-opencode-telegram',
  setup,
});
