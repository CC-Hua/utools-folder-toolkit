/**
 * preload 桥接层（CommonJS，源码可读，不压缩、不打包）。
 * 把 utils 里的文件操作能力以单一命名空间暴露给渲染进程：
 *   window.folderToolkit.createFolder / moveOrCopyFile / dissolveFolders / ...
 * 只暴露界面真正用到的函数，遵循最小权限。
 */

const utils = require('./utils');

// 新版 Electron 移除了 File.path，需通过 webUtils 取拖拽文件的真实路径；旧版回退到 file.path
let webUtils = null;
try {
  webUtils = require('electron').webUtils || null;
} catch (e) {
  webUtils = null;
}

window.folderToolkit = {
  // 新建文件夹
  createFolder: utils.createFolder,
  moveOrCopyFile: utils.moveOrCopyFile,
  // 解散文件夹
  dissolveFolders: utils.dissolveFolders,
  // 界面辅助
  checkDragFile: utils.checkDragFile,
  getBaseName: utils.getBaseName,
  isAbsolutePath: utils.isAbsolutePath,
  getDragFilePath(file) {
    if (!file || typeof file !== 'object') {
      return '';
    }
    if (typeof file.path === 'string' && file.path) {
      return file.path;
    }
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      try {
        return webUtils.getPathForFile(file) || '';
      } catch (e) {
        return '';
      }
    }
    return '';
  }
};
