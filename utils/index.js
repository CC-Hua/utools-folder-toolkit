/**
 * 渲染进程可用能力的统一出口（CommonJS）。
 * 合并后渲染层只需要 window.folderToolkit 一个命名空间，不再像原来那样往 window 上挂一堆平铺函数。
 */

const fs = require('fs');
const path = require('path');
const fsCore = require('./fs-core');
const pack = require('./pack');
const dissolve = require('./dissolve');

/** 补齐拖拽进来的文件/文件夹的类型信息（原 utools-file-to-folder 的 checkDragFile） */
function checkDragFile(file) {
  // stat 跟随链接：junction / 目录 symlink 在界面上仍应显示为「目录」，否则解散模式会直接退出
  // lstat 单独记录链接标记；底层递归各自用 lstat，不会因此跟进链接目标
  const stat = fs.statSync(file.path);
  let link = false;
  try {
    link = fs.lstatSync(file.path).isSymbolicLink();
  } catch (e) {
    link = false;
  }
  file.isDirectory = stat.isDirectory();
  file.isFile = stat.isFile();
  file.isSymbolicLink = link;
  return file;
}

/** 取路径最后一段（原 utools-file-to-folder 的 getBaseName） */
function getBaseName(filePath) {
  return path.basename(filePath);
}

/** 判断是否绝对路径，供界面决定要不要依赖「当前文件夹」 */
function isAbsolutePath(filePath) {
  const value = (filePath || '').trim();
  return !!value && fsCore.isUsableAbsolute(value);
}

module.exports = {
  // fs-core
  ...fsCore,
  // 新建文件夹
  ...pack,
  // 解散文件夹
  ...dissolve,
  // 界面辅助
  checkDragFile,
  getBaseName,
  isAbsolutePath
};
