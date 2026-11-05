/**
 * 底层文件系统能力（纯 Node.js，不依赖 utools 全局对象）。
 *
 * 合并来源：
 * - utools-extract-folder/utils.js：readDirFiles、toAbsoluteDir、customMoveFile、customCopyFile
 * - utools-file-to-folder/utils.js：uniquePath、同名的移动/复制实现
 * 两个插件里的 customMoveFile / customCopyFile 实现完全一致，此处只保留一份。
 */

const fs = require('fs');
const path = require('path');

/**
 * 读取目录下的直接子项。原两个插件各自内联了同样的 readdir + stat 逻辑，此处统一。
 * 用 lstat 而非 stat：符号链接/junction 不再被当成目录递归，避免自引用形成环。
 * @param {string} dirPath
 * @returns {{name: string, path: string, isDirectory: boolean, isFile: boolean, isSymbolicLink: boolean}[]}
 */
function readDirEntries(dirPath) {
  let names;
  try {
    names = fs.readdirSync(dirPath);
  } catch (e) {
    throw toReadableError(e);
  }
  return names.map(name => {
    const childPath = path.join(dirPath, name);
    let stat;
    try {
      stat = fs.lstatSync(childPath);
    } catch (e) {
      throw toReadableError(e);
    }
    return {
      name,
      path: childPath,
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      isSymbolicLink: stat.isSymbolicLink()
    };
  });
}

/**
 * 判断是否为「可用的绝对路径」。
 * Windows 下 path.isAbsolute('/foo') 也为 true，但会落到当前盘符根目录；
 * 单个前导斜杠按相对名处理，避免用户输入 /foo 时越界写到盘根。
 * UNC（\\server\share）以双斜杠开头，仍按绝对路径处理。
 * @param {string} value
 * @returns {boolean}
 */
function isUsableAbsolute(value) {
  const text = (value || '').trim();
  if (/^[\\/](?![\\/])/.test(text)) {
    return false;
  }
  return path.isAbsolute(text);
}

/**
 * 校验用户输入的目录名/路径片段，阻止路径穿越与非法字符。
 * 允许：空值（由调用方按语义处理）、相对多级名、绝对路径、盘符前缀、UNC 路径。
 * @param {string} value
 * @param {string} label
 */
function assertSafePathInput(value, label) {
  const text = (value || '').trim();
  if (!text) {
    return;
  }
  if (/[\u0000-\u001f]/.test(text)) {
    throw new Error(`${label}包含非法控制字符`);
  }
  // 文件对话框返回值 / 构建产物绝对路径可能很长，仅限制用户输入的相对片段
  if (text.length > 240 && !isUsableAbsolute(text)) {
    throw new Error(`${label}过长（最多 240 字符）`);
  }
  const segments = text.split(/[\\/]+/).filter(Boolean);
  if (segments.includes('..')) {
    throw new Error(`${label}不能使用「..」跳出目标范围`);
  }
  for (const segment of segments) {
    // Windows 保留设备名与尾随空格/点会被系统规范化，导致路径与实际不符
    if (process.platform === 'win32' && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment)) {
      throw new Error(`${label}包含 Windows 保留名称：${segment}`);
    }
    // 「.」是合法的相对路径片段（当前目录），不算尾随点
    if (process.platform === 'win32' && segment !== '.' && /[ .]$/.test(segment)) {
      throw new Error(`${label}的路径段不能以空格或点结尾：${segment}`);
    }
  }
  // 盘符前缀的冒号合法（C:\...），其余位置的冒号与 Windows 保留字符一律拒绝
  const rest = text.replace(/^[a-zA-Z]:(?=[\\/]|$)/, '');
  if (process.platform === 'win32' && (/[<>"|?*]/.test(rest) || rest.includes(':'))) {
    throw new Error(`${label}包含非法字符`);
  }
}

/**
 * 把「用户输入的目录」解析成绝对目录。
 * 空值 → baseDir；相对路径 → baseDir 下的子目录；绝对路径 → 原样返回。
 * 等价于原 toAbsoluteDir(dir, filePath)（baseDir = path.dirname(filePath)）。
 * @param {string} dir
 * @param {string} baseDir
 * @returns {string}
 */
function resolveTargetDir(dir, baseDir) {
  const value = (dir || '').trim();
  assertSafePathInput(value, '目标目录');
  if (!value) {
    return baseDir;
  }
  if (isUsableAbsolute(value)) {
    return value;
  }
  return path.join(baseDir, value);
}

/**
 * child 是否等于 parent 或位于 parent 内部（含同盘同目录的规范化比较）。
 * Windows 文件系统大小写不敏感，必须归一后比较，否则「...\BOX\inner」会绕过保护。
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isSameOrInside(child, parent) {
  const normalize = value => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const resolvedChild = normalize(child);
  const resolvedParent = normalize(parent);
  if (resolvedChild === resolvedParent) {
    return true;
  }
  const withSep = resolvedParent.endsWith(path.sep) ? resolvedParent : resolvedParent + path.sep;
  return resolvedChild.startsWith(withSep);
}

/**
 * 目标已存在时生成「名称 (1).扩展名」形式的新路径，最多尝试 1000 次。
 * 原样保留 utools-file-to-folder 的实现。
 * @param {string} targetPath
 * @returns {string}
 */
function uniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return targetPath;
  }
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const baseName = path.basename(targetPath, ext);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${baseName} (${i})${ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`重名项过多，无法生成新名称：${targetPath}`);
}

/**
 * 把 Node 的原始错误翻译成可读中文，同时保留 code 便于上层判断。
 * 文案沿用两个插件原有的提示。
 * @param {NodeJS.ErrnoException} e
 * @returns {Error}
 */
function toReadableError(e) {
  const code = e && e.code;
  let message = e && e.message ? e.message : String(e);
  if (code === 'EBUSY') {
    message = `文件正在使用中，${message}`;
  } else if (code === 'EXDEV') {
    message = `不支持跨盘移动文件，${message}`;
  } else if (code === 'EPERM' || code === 'EACCES') {
    message = `没有权限操作该文件，${message}`;
  } else if (code === 'ENOENT') {
    message = `文件或文件夹不存在，${message}`;
  } else if (code === 'EEXIST' || code === 'ENOTEMPTY') {
    message = `目标位置已存在或文件夹非空，${message}`;
  } else if (code === 'ENOTDIR') {
    message = `目标路径不是文件夹，${message}`;
  } else if (code === 'ENOSPC') {
    message = `磁盘空间不足，${message}`;
  } else if (code === 'EROFS') {
    message = `目标位置是只读的，${message}`;
  }
  const error = new Error(message);
  error.code = code;
  error.cause = e;
  return error;
}

/**
 * 确保目录存在。
 * @param {string} dirPath
 */
function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (e) {
    throw toReadableError(e);
  }
}

/**
 * 移动文件或文件夹（renameSync，跨盘会抛 EXDEV）。
 * 原实现的 mkdirSync(path.resolve(toPath, '..')) 即 dirname，此处语义一致。
 * 目标为已存在文件时 renameSync 是原子替换：移动失败则原文件保持不变。
 * @param {string} fromPath
 * @param {string} toPath
 */
function moveFile(fromPath, toPath) {
  ensureDir(path.dirname(toPath));
  try {
    fs.renameSync(fromPath, toPath);
  } catch (e) {
    throw toReadableError(e);
  }
}

/**
 * 复制单个文件。目标必须不存在（COPYFILE_EXCL），避免 uniquePath 检查后
 * 到写入之间被其他进程创建时把已有文件覆盖掉。
 * @param {string} fromPath
 * @param {string} toPath
 */
function copyFile(fromPath, toPath) {
  ensureDir(path.dirname(toPath));
  try {
    fs.copyFileSync(fromPath, toPath, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    throw toReadableError(e);
  }
}

/** 判断路径是否为符号链接（含 Windows junction）；读取失败按非链接处理 */
function isSymbolicLinkSafe(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch (e) {
    return false;
  }
}

/** 复制符号链接本身而不跟随目标；Windows 用 junction 类型重建目录链接 */
function copyLink(fromPath, toPath) {
  ensureDir(path.dirname(toPath));
  try {
    let target = fs.readlinkSync(fromPath);
    if (process.platform === 'win32') {
      target = path.isAbsolute(target) ? target : path.resolve(path.dirname(fromPath), target);
      // junction 只能指向目录；文件符号链接必须用 'file'，否则复制出的是打不开的坏链接
      let isDir = false;
      try {
        isDir = fs.statSync(fromPath).isDirectory();
      } catch (e) {
        // 断链或目标不可读：按文件链接处理，由 symlinkSync 的结果决定成败
      }
      fs.symlinkSync(target, toPath, isDir ? 'junction' : 'file');
    } else {
      fs.symlinkSync(target, toPath);
    }
  } catch (e) {
    throw toReadableError(e);
  }
}

module.exports = {
  readDirEntries,
  isUsableAbsolute,
  assertSafePathInput,
  resolveTargetDir,
  isSameOrInside,
  uniquePath,
  toReadableError,
  ensureDir,
  moveFile,
  copyFile,
  isSymbolicLinkSafe,
  copyLink
};
