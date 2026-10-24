// Full runs take turns on this machine (DIC-2436; see lock.js). The returned function is
// Playwright's teardown and releases the lock.
const { acquire, isFullRun } = require('./lock');

module.exports = async (config) => {
  if (process.env.CI || !isFullRun()) return undefined;
  const baseURL = config.projects[0]?.use?.baseURL;
  return acquire({ baseURL });
};
