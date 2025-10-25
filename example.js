const BundleDiffReporter = require('./src/index');

const reporter = new BundleDiffReporter({
  buildFolder: 'dist',
  outputFolder: 'bundle-diff-reporter',
  masterFile: 'master-bundle-stats.json',
  currentFile: 'current-bundle-stats.json',
  outputFile: 'bundle-size-report.md',
  failureFile: 'bundle-diff-stage-failed.txt',
  changeThreshold: 5,
  splittingUpperLimit: 250,
  splittingLowerLimit: 20,
  aboveAverageFiles: [],
  belowAverageFiles: [],
});

reporter.generateBundleStats();
reporter.generateReport();


