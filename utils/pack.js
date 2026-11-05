/**
 * 「新建文件夹」能力：把选中的文件/文件夹移动或复制到一个新建（或已存在）的文件夹。
 *
 * 来源：utools-file-to-folder/utils.js 的 createCurrentFolder + moveOrCopyFile。
 * 与合并前相比只有两点差异（均为把 utools 调用从工具层剥离，行为不变）：
 * 1. createCurrentFolder 的「当前文件夹」由调用方（UI 层）传入，不再直接读 utools API；
 * 2. 错误改为抛出带中文说明的 Error，由 UI 层统一 showNotification，而不是在工具层直接弹通知。
 */

const fs = require('fs');
const path = require('path');
const {
  readDirEntries,
  assertSafePathInput,
  resolveTargetDir,
  isUsableAbsolute,
  isSameOrInside,
  isSymbolicLinkSafe,
  uniquePath,
  toReadableError,
  ensureDir,
  moveFile,
  copyFile,
  copyLink
} = require('./fs-core');

/** 盘符/挂载点归一，用于提前判断是否跨盘移动 */
function rootOf(value) {
  const root = path.parse(path.resolve(value)).root;
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

function norm(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 兼容没有 name 的调用方：用路径最后一段兜底，避免 path.join 收到 undefined */
function itemName(file) {
  return typeof file.name === 'string' && file.name ? file.name : path.basename(file.path);
}

/**
 * 新建文件夹。
 * @param {string} folderName 文件夹名（相对名或绝对路径）
 * @param {string} baseDir 相对名的基准目录，通常是文件管理器当前路径
 * @returns {string} 创建后的绝对路径
 */
function createFolder(folderName, baseDir) {
  const name = (folderName || '').trim();
  if (!name) {
    throw new Error('请输入文件夹名称');
  }
  assertSafePathInput(name, '文件夹名称');
  let folderPath = name;
  // 单个前导斜杠在 Windows 会被 path.isAbsolute 判为绝对，落到当前盘根；统一按相对名处理
  if (!isUsableAbsolute(name)) {
    if (!baseDir) {
      throw new Error('未能获取当前文件夹路径，请直接输入完整路径');
    }
    folderPath = path.join(baseDir, name);
  }
  ensureDir(folderPath);
  return folderPath;
}

/**
 * 移动或复制一组文件/文件夹到目标目录。
 *
 * 保持原实现的两个关键语义：
 * 1. 目标目录可写相对名，基准是第一个选中项的上一级目录；
 * 2. 选中项是文件夹时，是把它的「内容」搬到 目标目录/文件夹名，再删掉空壳，
 *    所以净效果等于把整个文件夹挪到目标目录下（而不是套一层同名目录）。
 *
 * checkFileFunc 现在也向子层传递，构建脚本才能把子目录里的说明文档和点文件排除掉。
 *
 * @param {{name: string, path: string, isDirectory: boolean}[]} files
 * @param {string} dir 目标目录（相对或绝对）
 * @param {boolean} copy true=复制，false=移动
 * @param {(file: object) => boolean} [checkFileFunc] 返回 false 的项跳过
 */
function moveOrCopyFile(files, dir, copy, checkFileFunc) {
  if (!files || !files.length) {
    return;
  }
  if (!files[0] || typeof files[0].path !== 'string' || !files[0].path) {
    throw new Error('存在路径为空的文件项');
  }
  const targetDir = resolveTargetDir(dir, path.resolve(files[0].path, '..'));

  // 只处理有效且不被其他选中目录包含的项：父子同时选中时，避免先搬父目录
  // 导致子项路径失效、出现「源已删、目标已生成」却报错的不一致状态
  const selected = files.filter(file => file && (!checkFileFunc || checkFileFunc(file)));
  const dirPaths = selected
    .filter(file => file.isDirectory && !isSymbolicLinkSafe(file.path))
    .map(file => norm(file.path));
  const effective = selected.filter(file => {
    const resolved = norm(file.path);
    return !dirPaths.some(dirPath => dirPath !== resolved && isSameOrInside(resolved, dirPath));
  });

  // 全量预检：任一项无效或目标落在选中项自身内部时直接拒绝，避免搬了一半才报错
  effective.forEach(file => {
    if (typeof file.path !== 'string' || !file.path) {
      throw new Error('存在路径为空的文件项');
    }
    if (!fs.existsSync(file.path)) {
      throw new Error(`文件或文件夹不存在：${file.path}`);
    }
    // 目标位置（目录项的内容目录 / 文件项的目标文件）不能等于选中项或落在它内部，
    // 否则会自我嵌套，或经 uniquePath 在原地生成「 (1)」副本
    if (isSameOrInside(path.join(targetDir, itemName(file)), file.path)) {
      throw new Error(`目标目录不能与选中项相同或位于其内部：${file.path}`);
    }
    if (file.isDirectory && !isSymbolicLinkSafe(file.path)) {
      const target = path.join(targetDir, itemName(file));
      // 目标同名项是文件时 ensureDir 会在中途抛错，提前拒绝以保证零变更
      if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
        throw new Error(`目标位置已被同名文件占用：${target}`);
      }
    }
    if (!copy && rootOf(file.path) !== rootOf(targetDir)) {
      throw new Error(`不支持跨盘移动文件（${file.path} → ${targetDir}），请改用「复制到新文件夹」`);
    }
  });

  const failures = [];
  let completed = 0;
  effective.forEach(file => {
    try {
      // 预检后仍可能被其他进程改动，保留兜底校验
      if (!fs.existsSync(file.path)) {
        throw new Error(`文件或文件夹不存在：${file.path}`);
      }
      const link = isSymbolicLinkSafe(file.path);
      const target = path.join(targetDir, itemName(file));
      if (file.isDirectory && !link) {
        const subFiles = readDirEntries(file.path);
        moveOrCopyFile(subFiles, target, copy, checkFileFunc);
        if (!subFiles.length) { // 空文件夹没有复制和移动的问题
          ensureDir(target);
        }
        if (!copy) { // 处理移动完还有个文件夹残留问题
          try {
            fs.rmdirSync(file.path);
          } catch (e) {
            throw toReadableError(e);
          }
        }
      } else {
        // 不覆盖目标同名文件：自动追加序号，与解散功能的 number 策略一致
        const destination = uniquePath(target);
        if (link) {
          // 符号链接/junction 只搬链接本身，不跟随目标，避免递归成环
          if (copy) {
            copyLink(file.path, destination);
          } else {
            moveFile(file.path, destination);
          }
        } else if (copy) {
          copyFile(file.path, destination);
        } else {
          moveFile(file.path, destination);
        }
      }
      completed++;
    } catch (e) {
      // 逐项容错：某一项失败不阻断其余项，最后明确告知「部分完成」而不是笼统报错
      failures.push(`${file.path}：${e.message}`);
    }
  });
  if (failures.length) {
    throw new Error(`部分完成：成功 ${completed} 项，失败 ${failures.length} 项（源目录可能已变化）\n${failures[0]}`);
  }
}

module.exports = {
  createFolder,
  moveOrCopyFile
};
