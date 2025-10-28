const fs = require('fs');
const path = require('path');

/**
 * A utility class for analyzing and comparing JavaScript bundle sizes between branches.
 * Generates detailed reports about bundle size changes, identifies files that exceed size thresholds,
 * and provides markdown-formatted output for easy integration with CI/CD pipelines.
 * 
 * @class BundleDiffReporter
 * @example
 * const reporter = new BundleDiffReporter({
 *   buildFolder: 'dist',
 *   changeThreshold: 5,
 *   splittingUpperLimit: 250,
 *   splittingLowerLimit: 20
 * });
 * reporter.generateBundleStats();
 * const result = reporter.generateReport();
 */
class BundleDiffReporter {

 
  /**
   * Creates an instance of BundleDiffReporter.
   * 
   * @param {Object} [options={}] - Configuration options for the reporter
   * @param {string} [options.buildFolder='dist'] - Path to the build folder containing bundle files
   * @param {string} [options.outputFolder='bundle-analyzer'] - Path to output folder for reports
   * @param {number} [options.changeThreshold=5] - Minimum percentage change to report (default: 5%)
   * @param {number} [options.splittingUpperLimit=250] - Maximum recommended file size in KB
   * @param {number} [options.splittingLowerLimit=20] - Minimum recommended file size in KB
   * @param {string} [options.masterFile='master-bundle-stats.json'] - Filename for master branch stats
   * @param {string} [options.currentFile='current-bundle-stats.json'] - Filename for current branch stats
   * @param {string} [options.outputFile='bundle-size-report.md'] - Filename for markdown report
   * @param {string} [options.failureFile='bundle-diff-stage-failed.txt'] - Filename for failure flag
   * @param {string[]} [options.aboveAverageFiles=[]] - Files exempt from upper limit check
   * @param {string[]} [options.belowAverageFiles=[]] - Files exempt from lower limit check
   */
  constructor(options = {}) {
    this.config = {
      buildFolder: options.buildFolder || 'dist',
      outputFolder: options.outputFolder || 'bundle-analyzer',
      changeThreshold: options.changeThreshold || 5, // Percentage
      splittingUpperLimit: options.splittingUpperLimit || 250, // KB
      splittingLowerLimit: options.splittingLowerLimit || 20, // KB
      masterFile: options.masterFile || 'master-bundle-stats.json',
      currentFile: options.currentFile || 'current-bundle-stats.json',
      outputFile: options.outputFile || 'bundle-size-report.md',
      failureFile: options.failureFile || 'bundle-diff-stage-failed.txt',
      aboveAverageFiles: options.aboveAverageFiles || [],
      belowAverageFiles: options.belowAverageFiles || [],
    };

    this.diff = null;
    this.failedFiles = null;
    // create output folder if it doesn't exist
    try {
      if (!fs.existsSync(path.join(process.cwd(), this.config.outputFolder))) {
        fs.mkdirSync(path.join(process.cwd(), this.config.outputFolder));
      }
    } catch (error) {
      console.error('Error creating output folder:', error.message);
      throw error;
    }
  }

  /**
   * Generates bundle statistics by analyzing JavaScript files in the build folder.
   * Reads all .js files, removes hash patterns from filenames, calculates sizes,
   * and writes sorted results to a JSON file.
   * 
   * @throws {Error} If build folder cannot be read or output file cannot be written
   * @returns {void}
   */
  generateBundleStats() {
    const distFolder = path.join(process.cwd(), this.config.buildFolder);
    const result = {};

    try {
      // Get all top-level JS files
      fs.readdirSync(distFolder)
        .filter(file => {
          const fullPath = path.join(distFolder, file);
          return fs.statSync(fullPath).isFile() && path.extname(file) === '.js';
        })
        .forEach(file => {
          // Clean filename by removing hash
          const cleanName = file
            .replace(/\.[0-9a-f]{8,}\.js$/i, '.js') // Remove standard content hash
            .replace(/-[0-9a-f]{10,}\.js$/i, '.js') // Remove chunk hashes
            .replace(/\.chunk\.js$/i, '.js'); // Remove chunk identifiers

          // Get file size in KB with 2 decimal places
          const sizeKB = parseFloat((fs.statSync(path.join(distFolder, file)).size / 1024).toFixed(2));

          result[cleanName] = { size: sizeKB };
        });
    } catch (error) {
      console.error('Error reading build folder:', error.message);
      throw error;
    }

    // Sort entries by size descending
    const sortedEntries = Object.entries(result).sort(([, a], [, b]) => b.size - a.size);

    // Create new sorted object
    const sortedResult = {};
    sortedEntries.forEach(([key, value]) => {
      sortedResult[key] = value;
    });

    // Clear large objects from memory
    Object.keys(result).forEach(key => delete result[key]);
    sortedEntries.length = 0;

    // Write to JSON file
    const outputPath = path.join(process.cwd(), this.config.outputFolder, this.config.currentFile);
    try {
      fs.writeFileSync(outputPath, JSON.stringify(sortedResult, null, 2));
    } catch (error) {
      console.error('Error writing bundle stats file:', error.message);
      throw error;
    }
  }

  /**
   * Main entry point - generates complete bundle report.
   * Compares bundle sizes, checks file sizes against thresholds,
   * writes failure flags if needed, and generates markdown report.
   * 
   * @returns {{success: boolean, diff: Object, failedFiles: Object}} Report results
   * @returns {boolean} return.success - Whether all checks passed
   * @returns {Object} return.diff - Detailed diff information
   * @returns {Object} return.failedFiles - Files that failed size checks
   * @throws {Error} Exits process if any critical error occurs
   */
  generateReport() {
    try {
      this.diff = this.compareBundleSizes();
      this.failedFiles = this.checkFileSize(this.diff);
      this.writeFailureFlag();
      this.generateMarkdownReport();

      return {
        success: this.isSuccess(),
        diff: this.diff,
        failedFiles: this.failedFiles,
      };
    } catch (error) {
      console.error('Error generating bundle report:', error);
      process.exit(1);
    }
  }

  /**
   * Compares bundle sizes between master and current branch.
   * Reads both master and current bundle stats files, calculates differences,
   * and categorizes files as added, removed, changed, or unchanged.
   * 
   * @returns {Object} Diff object with detailed comparison
   * @returns {Object} return.added - Files added in current branch
   * @returns {Object} return.removed - Files removed in current branch
   * @returns {Object} return.changed - Files with significant size changes
   * @returns {Object} return.same - Files with insignificant changes
   * @returns {Object} return.summary - Aggregate statistics
   * @returns {number} return.summary.totalAdded - Total size of added files (KB)
   * @returns {number} return.summary.totalRemoved - Total size of removed files (KB)
   * @returns {number} return.summary.sizeIncrease - Total size increase (KB)
   * @returns {number} return.summary.sizeDecrease - Total size decrease (KB)
   * @returns {number} return.summary.countChanged - Number of changed files
   * @throws {Error} Exits process if stats files are missing or unreadable
   */
  compareBundleSizes() {
    const masterPath = path.join(process.cwd(), this.config.outputFolder, this.config.masterFile);
    const currentPath = path.join(process.cwd(), this.config.outputFolder, this.config.currentFile);

    // Check if master and current stats files exist
    if (!fs.existsSync(masterPath)) {
      console.error(`Error: ${this.config.masterFile} bundle stats file not found at: ${masterPath}`);
      process.exit(1);
    }
    if (!fs.existsSync(currentPath)) {
      console.error(`Error: ${this.config.currentFile} bundle stats file not found at: ${currentPath}`);
      process.exit(1);
    }

    try {
      const master = this.readJsonFile(masterPath);
      const current = this.readJsonFile(currentPath);

      const diff = this.initializeDiff();

      this.processAddedAndChangedFiles(master, current, diff);
      this.processRemovedFiles(master, current, diff);
      this.finalizeDiff(diff);

      // Clean up large objects from memory
      this.clearObject(master);
      this.clearObject(current);

      return diff;
    } catch (error) {
      console.error('Error comparing bundle sizes:', error);
      process.exit(1);
    }
  }

  /**
   * Checks if files meet size requirements
   * @param {Object} diff - The diff object from compareBundleSizes
   * @returns {Object} Object containing arrays of above and below average files
   */
  checkFileSize(diff) {
    const files = this.extractFileSizes(diff);
    const aboveAverageFiles = [];
    const belowAverageFiles = [];

    Object.entries(files).forEach(([fileName, fileSize]) => {
      if (this.isAboveAverageFile(fileName, fileSize)) {
        aboveAverageFiles.push({ fileName, fileSize });
      } else if (this.isBelowAverageFile(fileName, fileSize)) {
        belowAverageFiles.push({ fileName, fileSize });
      }
    });

    return { aboveAverageFiles, belowAverageFiles };
  }

  /**
   * Generates markdown report
   */
  generateMarkdownReport() {
    let md = this.generateHeader();
    md += this.generateFeedbackMessage();
    md += '<details>\n<summary><strong>Read full report</strong></summary>\n\n';
    md += this.generateSummarySection();
    md += this.generateChangedFilesSection();
    md += this.generateAboveAverageSection();
    md += this.generateBelowAverageSection();
    md += this.generateAddedFilesSection();
    md += this.generateRemovedFilesSection();
    md += '\n</details>\n\n';
    md += this.generateNotesSection();

    try {
      fs.writeFileSync(path.join(process.cwd(), this.config.outputFolder, this.config.outputFile), md);
    } catch (error) {
      console.error('Error writing markdown report file:', error.message);
      throw error;
    }
  }

  // ============= Private Helper Methods =============

  readJsonFile(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      console.error(`Error reading JSON file (${filePath}):`, error.message);
      throw error;
    }
  }

  initializeDiff() {
    return {
      added: {},
      removed: {},
      changed: {},
      same: {},
      summary: {
        totalAdded: 0,
        totalRemoved: 0,
        sizeIncrease: 0,
        sizeDecrease: 0,
        countChanged: 0,
      },
    };
  }

  processAddedAndChangedFiles(master, current, diff) {
    Object.entries(current).forEach(([file, fileData]) => {
      if (!master[file]) {
        this.addNewFile(diff, file, fileData);
      } else {
        this.processChangedFile(diff, file, fileData, master[file]);
      }
    });

    // Sort changed files by size difference
    if (Object.keys(diff.changed).length) {
      diff.changed = this.sortChangedFiles(diff.changed);
    }
  }

  addNewFile(diff, file, fileData) {
    diff.added[file] = fileData;
    diff.summary.totalAdded += fileData.size;
  }

  processChangedFile(diff, file, currentData, masterData) {
    const sizeDiff = currentData.size - masterData.size;
    const sizeDiffPercent = Math.abs((sizeDiff / masterData.size) * 100);

    if (sizeDiffPercent >= this.config.changeThreshold) {
      diff.changed[file] = {
        current: currentData.size,
        master: masterData.size,
        difference: parseFloat(sizeDiff.toFixed(2)),
      };
      diff.summary.countChanged++;

      if (sizeDiff > 0) {
        diff.summary.sizeIncrease += sizeDiff;
      } else {
        diff.summary.sizeDecrease += Math.abs(sizeDiff);
      }
    } else {
      diff.same[file] = currentData.size;
    }
  }

  sortChangedFiles(changedFiles) {
    return Object.entries(changedFiles)
      .sort(([, a], [, b]) => b.difference - a.difference)
      .reduce((sorted, [key, value]) => {
        sorted[key] = value;
        return sorted;
      }, {});
  }

  processRemovedFiles(master, current, diff) {
    Object.entries(master).forEach(([file, fileData]) => {
      if (!current[file]) {
        diff.removed[file] = fileData;
        diff.summary.totalRemoved += fileData.size;
      }
    });
  }

  finalizeDiff(diff) {
    diff.summary = {
      totalAdded: parseFloat(diff.summary.totalAdded.toFixed(2)),
      totalRemoved: parseFloat(diff.summary.totalRemoved.toFixed(2)),
      sizeIncrease: parseFloat(diff.summary.sizeIncrease.toFixed(2)),
      sizeDecrease: parseFloat(diff.summary.sizeDecrease.toFixed(2)),
      countChanged: diff.summary.countChanged,
    };
  }

  clearObject(obj) {
    Object.keys(obj).forEach(key => delete obj[key]);
  }

  extractFileSizes(diff) {
    const addedFiles = Object.fromEntries(Object.entries(diff.added).map(([fileName, fileData]) => [
      fileName,
      fileData.size,
    ]));

    const changedFiles = Object.fromEntries(Object.entries(diff.changed).map(([fileName, fileData]) => [
      fileName,
      fileData.current,
    ]));

    return { ...addedFiles, ...changedFiles };
  }

  isAboveAverageFile(fileName, fileSize) {
    return (
      fileSize > this.config.splittingUpperLimit &&
      !this.config.aboveAverageFiles.includes(fileName)
    );
  }

  isBelowAverageFile(fileName, fileSize) {
    return (
      fileSize < this.config.splittingLowerLimit &&
      !this.config.belowAverageFiles.includes(fileName) &&
      !fileName.includes('resolver')
    );
  }

  isSuccess() {
    return (
      this.failedFiles.belowAverageFiles.length === 0 &&
      this.failedFiles.aboveAverageFiles.length === 0
    );
  }

  writeFailureFlag() {
    if (!this.isSuccess()) {
      try {
        fs.writeFileSync(
          path.join(process.cwd(), this.config.outputFolder, this.config.failureFile),
          '🔴 Failed to pass bundle size check'
        );
      } catch (error) {
        console.error('Error writing failure flag file:', error.message);
        throw error;
      }
    }
  }

  // ============= Markdown Generation Methods =============

  generateHeader() {
    return '## 📦 Bundle Size Comparison Report\n\n';
  }

  generateFeedbackMessage() {
    if (this.isSuccess()) {
      return '### 🎉 Congrats! Bundle stage has been passed, Great job! 👏\n';
    }
    return '### 🤯 Bundle stage has been failed, please check the report below to see the details.\n';
  }

  generateSummarySection() {
    const { summary, added, removed } = this.diff;
    const netChange = summary.sizeIncrease - summary.sizeDecrease;

    return (
      '### 📊 Summary\n' +
      '| **Metric**               | **Value**         |\n' +
      '|--------------------------|-------------------|\n' +
      `| 🚀 Files Added           | ${
        Object.keys(added).length
      } (+${summary.totalAdded.toFixed(2)} KB) |\n` +
      `| ❌ Files Removed         | ${
        Object.keys(removed).length
      } (-${summary.totalRemoved.toFixed(2)} KB) |\n` +
      `| 🔄 Files Changed         | ${summary.countChanged} files |\n` +
      `| 📈 Total Size Increase   | +${summary.sizeIncrease.toFixed(2)} KB |\n` +
      `| 📉 Total Size Decrease   | -${summary.sizeDecrease.toFixed(2)} KB |\n` +
      `| 💰 Net Change            | ${netChange.toFixed(2)} KB |\n\n`
    );
  }

  generateChangedFilesSection() {
    if (Object.keys(this.diff.changed).length === 0) {
      return '';
    }

    let md =
      '<details>\n<summary><strong>🔄 Changed Files</strong></summary>\n\n';
    md += '| File | Master (KB) | PR (KB) | Change | Change % |\n';
    md += '|------|-------------|---------|--------|----------|\n';

    Object.entries(this.diff.changed).forEach(([file, data]) => {
      md += this.formatChangedFileRow(file, data);
    });

    md += '\n</details>\n\n';

    return md;
  }

  formatChangedFileRow(file, data) {
    const change = data.difference;
    const changePercent = ((change / data.master) * 100).toFixed(2);
    const arrow = change > 0 ? '🔺' : '▼';

    return (
      `| \`${file}\` | ${data.master.toFixed(2)} | ${data.current.toFixed(2)} | ` +
      `${change > 0 ? '+' : ''}${change.toFixed(2)} KB ${arrow} | ` +
      `${changePercent}% |\n`
    );
  }

  generateAboveAverageSection() {
    const { aboveAverageFiles } = this.failedFiles;
    if (aboveAverageFiles.length === 0) {
      return '';
    }

    let md = `### 🔴 Above Average Files(${this.config.splittingUpperLimit}KB): ${aboveAverageFiles.length} files \n`;
    md += '<details>\n<summary><strong>details</strong></summary>\n\n';
    md += '| File | Size (KB) |\n|------|-----------|\n';

    aboveAverageFiles.forEach(file => {
      md += `| \`${file.fileName}\` | ${file.fileSize.toFixed(2)} |\n`;
    });

    md += '\n</details>\n\n';
    return md;
  }

  generateBelowAverageSection() {
    const { belowAverageFiles } = this.failedFiles;
    if (belowAverageFiles.length === 0) {
      return '';
    }

    let md = `### 🔴 Below Average Files(${this.config.splittingLowerLimit}KB): ${belowAverageFiles.length} files \n`;
    md += '<details>\n<summary><strong>details</strong></summary>\n\n';
    md += '| File | Size (KB) |\n|------|-----------|\n';

    belowAverageFiles.forEach(file => {
      md += `| \`${file.fileName}\` | ${file.fileSize.toFixed(2)} |\n`;
    });

    md += '\n</details>\n\n';
    return md;
  }

  generateAddedFilesSection() {
    if (Object.keys(this.diff.added).length === 0) {
      return '';
    }

    let md = '### 🎉 New Files\n';
    md += '<details>\n<summary><strong>details</strong></summary>\n\n';
    md += '| File | Size (KB) |\n|------|-----------|\n';

    Object.entries(this.diff.added).forEach(([file, data]) => {
      md += `| \`${file}\` | ${data.size.toFixed(2)} |\n`;
    });

    md += '\n\n</details>\n\n';

    return md;
  }

  generateRemovedFilesSection() {
    if (Object.keys(this.diff.removed).length === 0) {
      return '';
    }

    let md = '### 🗑️ Removed Files\n';
    md += '<details>\n<summary><strong>details</strong></summary>\n\n';
    md += '| File | Size (KB) |\n|------|-----------|\n';

    Object.entries(this.diff.removed).forEach(([file, data]) => {
      md += `| ~~${file}~~ | ${data.size.toFixed(2)} |\n`;
    });

    md += '\n</details>\n\n';
    return md;
  }
  generateNotesSection() {
    let md = '';
    if (Object.keys(this.diff.changed).length !== 0) {
      md += '> [!NOTE]\n';
      md += `> We use a threshold of ±${this.config.changeThreshold}% to determine if a change is significant.\n\n`;
     
      md += '\n> [!IMPORTANT]\n';
      md += `> Keep each chunk under ${this.config.splittingUpperLimit}KB raw size to maintain optimal load.\n\n`;
      
    }

    if (Object.keys(this.diff.added).length !== 0) {
      md += '> [!IMPORTANT]\n';
      md += `> Split chunks should be larger than ${this.config.splittingLowerLimit}KB; otherwise, it's recommended not to split them to avoid unnecessary overhead.\n`;
    }
   
    return md;
  }
}

// Export the class
module.exports = BundleDiffReporter;
