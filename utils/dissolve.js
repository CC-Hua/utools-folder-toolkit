/**
 * 「解散文件夹」能力：把文件夹里的内容移出来，再删掉清空后的文件夹。
 *
 * 合并来源：
 * - utools-extract-folder/utils.js → releaseFolderFile（可选目标目录、递归解散子目录、按文件夹名重命名重复文件）
 * - utools-file-to-folder/utils.js → dissolveFolders（上移一级、重名追加序号、逐项容错）
 * 两者本质是同一个操作的不同参数组合，此处合并为一个引擎，用 3 个选项覆盖原有全部行为：
 *   targetDir  目标目录（空 = 各自上一级目录）   ← A 的「解散到：」输入框
 *   subFolder  recursive(递归提取所有文件) / keep(子目录整体移出)  ← A 的「解散所有子目录」开关
 *   duplicate  number(名称 (1).ext) / prefix(文件夹__文件名) / overwrite(覆盖同名文件)
 *   renameAll  仅 prefix 时生效：所有文件都重命名，而不只是重名的  ← A 的「重命名全部文件」开关
 */

const fs = require('fs');
const path = require('path');
const {
  readDirEntries,
  resolveTargetDir,
  isSameOrInside,
  uniquePath,
  toReadableError,
  ensureDir,
  moveFile
} = require('./fs-core');

/** 子目录处理方式 */
const SUB_FOLDER = {
  /** 递归解散所有子目录，把里面的文件全部提取到目标目录（utools-extract-folder 默认） */
  RECURSIVE: 'recursive',
  /** 子目录整体移出，保持原有结构（utools-file-to-folder 的行为） */
  KEEP: 'keep'
};

/** 重名处理方式 */
const DUPLICATE = {
  /** 自动追加序号：报告 (1).pdf */
  NUMBER: 'number',
  /** 重命名为「文件夹__文件名」，仍重名则追加 __extracted */
  PREFIX: 'prefix',
  /** 覆盖同名文件（目标为文件夹或本批已移入的文件时退回编号，避免误删） */
  OVERWRITE: 'overwrite'
};

/** 目标路径归一，Windows 大小写不敏感 */
function destinationKey(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeOptions(options) {
  const source = options || {};
  return {
    targetDir: typeof source.targetDir === 'string' ? source.targetDir : '',
    subFolder: source.subFolder === SUB_FOLDER.KEEP ? SUB_FOLDER.KEEP : SUB_FOLDER.RECURSIVE,
    duplicate: Object.values(DUPLICATE).includes(source.duplicate) ? source.duplicate : DUPLICATE.NUMBER,
    renameAll: !!source.renameAll
  };
}

/**
 * 生成「文件夹__文件名」形式的目标路径。
 * 以被解散文件夹的「上一级」为基准取相对路径，因此结果必然带上该文件夹名，
 * 嵌套层级之间同样用 __ 连接：box/sub/b.txt → box__sub__b.txt，box/a.txt → box__a.txt。
 *
 * 基准为什么是「上一级」而不是文件夹本身：后者对顶层文件取到的相对路径就是文件名本身，
 * 拼不出任何前缀（旧实现因此只能退回 __extracted，白白丢掉来源信息）；
 * 而且界面文案写的就是「文件夹__文件名」，前缀理应是被解散的那个文件夹。
 */
function prefixedPath(entryPath, rootFolderPath, targetDir) {
  const relative = path.relative(path.dirname(rootFolderPath), entryPath);
  const flatName = relative.split(/[\\/]+/).filter(Boolean).join('__');
  return path.join(targetDir, flatName || path.basename(entryPath));
}

/** 仍重名时不断追加 __extracted（与原 customCheckAndMoveFile 的递归改名一致，后缀加在扩展名之前） */
function withExtractedSuffix(targetPath) {
  const parsed = path.parse(targetPath);
  for (let i = 1; i <= 1000; i++) {
    const candidate = path.join(parsed.dir, parsed.name + '__extracted'.repeat(i) + parsed.ext);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`重名项过多，无法生成新名称：${targetPath}`);
}

/**
 * 决定某一项最终要移动到哪里，并累计重命名次数。
 * reserved 记录本次解散「已经成功移入」的目标，overwrite 策略不得覆盖它们，
 * 否则同一批里的同名文件（box/a.txt 与 box/sub/a.txt）会互相覆盖、静默丢数据。
 * @returns {string} 目标路径
 */
function pickDestination(entry, targetDir, rootFolderPath, options, result, reserved) {
  const direct = path.join(targetDir, entry.name);
  const conflict = fs.existsSync(direct);

  // 目录只在 keep 模式下出现，给目录加 __ 前缀只会得到「box__sub」这种怪名字，一律走编号
  if (options.duplicate === DUPLICATE.PREFIX && entry.isFile) {
    if (!conflict && !options.renameAll) {
      return direct;
    }
    let candidate = prefixedPath(entry.path, rootFolderPath, targetDir);
    if (candidate === direct && conflict) {
      // 被解散的是盘符根目录等极端情况，相对路径取不出前缀，只能退回后缀
      candidate = withExtractedSuffix(candidate);
    } else if (fs.existsSync(candidate)) {
      candidate = withExtractedSuffix(candidate);
    }
    if (candidate !== direct) {
      result.renamed++;
    }
    return candidate;
  }

  if (!conflict) {
    return direct;
  }

  if (options.duplicate === DUPLICATE.OVERWRITE && !reserved.has(destinationKey(direct))) {
    // 只有当目标确实是文件、且不是本批刚移入的文件时才真覆盖；目标是文件夹时退回编号。
    // 这里不预先删除目标：moveFile 的 renameSync 是原子替换，移动失败时原文件仍完整保留，
    // 避免「先删后移」在跨盘/占用/权限失败时造成目标原文件永久丢失。
    if (entry.isFile) {
      let targetIsFile = false;
      try {
        targetIsFile = fs.statSync(direct).isFile();
      } catch (e) {
        throw toReadableError(e);
      }
      if (targetIsFile) {
        return direct;
      }
    }
  }

  result.renamed++;
  return uniquePath(direct);
}

/** 文件夹清空后删除，非空则记录并保留 */
function removeFolderIfEmpty(folderPath, result) {
  let rest;
  try {
    rest = fs.readdirSync(folderPath);
  } catch (e) {
    result.errors.push(`${folderPath}：${toReadableError(e).message}`);
    return;
  }
  if (rest.length) {
    result.skipped.push(`${folderPath}（仍有 ${rest.length} 项未移出，文件夹保留）`);
    return;
  }
  try {
    fs.rmdirSync(folderPath);
    result.dissolved++;
  } catch (e) {
    result.errors.push(`${folderPath}：${toReadableError(e).message}`);
  }
}

/** 递归解散单个文件夹。rootFolderPath 始终是最外层被解散的那个文件夹，重命名前缀以它为基准 */
function dissolveOne(folderPath, targetDir, options, result, rootFolderPath, reserved) {
  const root = rootFolderPath || folderPath;
  readDirEntries(folderPath).forEach(entry => {
    try {
      // lstat 保证符号链接不会是 isDirectory，天然不会进入递归形成环
      if (entry.isDirectory && options.subFolder === SUB_FOLDER.RECURSIVE) {
        dissolveOne(entry.path, targetDir, options, result, root, reserved);
        return;
      }
      const destination = pickDestination(entry, targetDir, root, options, result, reserved);
      moveFile(entry.path, destination);
      reserved.add(destinationKey(destination));
      result.moved++;
    } catch (e) {
      result.errors.push(`${entry.path}：${e.message}`);
    }
  });
  removeFolderIfEmpty(folderPath, result);
}

function itemPath(item) {
  return typeof item === 'string' ? item : (item && item.path) || '';
}

/** 路径深度，用于让嵌套文件夹按「先内后外」处理，结果不再依赖选中顺序 */
function pathDepth(value) {
  if (!value) {
    return 0;
  }
  return path.resolve(value).split(/[\\/]+/).filter(Boolean).length;
}

/**
 * 解散一组文件夹。
 * @param {({path: string}|string)[]} folders
 * @param {object} [options] 见文件头注释
 * @returns {{dissolved: number, moved: number, renamed: number, skipped: string[], errors: string[]}}
 */
function dissolveFolders(folders, options) {
  const opts = normalizeOptions(options);
  const result = { dissolved: 0, moved: 0, renamed: 0, skipped: [], errors: [] };
  const list = (Array.isArray(folders) ? folders.filter(Boolean) : []).slice()
    .sort((a, b) => pathDepth(itemPath(b)) - pathDepth(itemPath(a)));
  if (!list.length) {
    return result;
  }
  const reserved = new Set();

  // 先对整批做无副作用预检：任一项不合法就零执行，避免前面的文件夹已被删除、后面才报错
  const plans = [];
  const folderPaths = [];
  for (const item of list) {
    const folderPath = itemPath(item);
    if (!folderPath) {
      result.skipped.push('（空路径）');
      continue;
    }
    try {
      let stat;
      try {
        // 用 lstat：符号链接/junction 指向别处时不解散其目标目录
        stat = fs.lstatSync(folderPath);
      } catch (e) {
        result.skipped.push(`${folderPath}（不存在）`);
        continue;
      }
      if (stat.isSymbolicLink()) {
        result.skipped.push(`${folderPath}（是符号链接，不支持解散）`);
        continue;
      }
      if (!stat.isDirectory()) {
        result.skipped.push(`${folderPath}（不是文件夹）`);
        continue;
      }
      const resolvedFolder = path.resolve(folderPath);
      if (path.parse(resolvedFolder).root === resolvedFolder) {
        result.errors.push(`${folderPath}：不能解散盘符根目录`);
        return result;
      }
      // 空目标目录 → 各自解散到自己的上一级目录（utools-file-to-folder 的行为）；
      // 填了相对名 → 各文件夹上一级目录下的同名子目录；填了绝对路径 → 所有文件夹统一到这里
      const targetDir = resolveTargetDir(opts.targetDir, path.dirname(folderPath));
      if (path.parse(path.resolve(targetDir)).root === path.resolve(targetDir)) {
        result.errors.push(`${folderPath}：不能把内容直接解散到盘符根目录（${targetDir}）`);
        return result;
      }
      if (isSameOrInside(targetDir, folderPath)) {
        result.errors.push(`${folderPath}：目标目录不能是它自己或它的子目录（${targetDir}）`);
        return result;
      }
      folderPaths.push(resolvedFolder);
      plans.push({ folderPath, targetDir });
    } catch (e) {
      result.errors.push(`${folderPath}：${e.message}`);
      return result;
    }
  }
  // 显式指定目标时，若它落在任一待解散文件夹内部，执行顺序会把已移出的内容再搬一次；整批拒绝。
  // 默认空目标（各自上一级）不检查：嵌套文件夹的上一级本来就是另一个待解散文件夹，属正常用法。
  if (opts.targetDir.trim()) {
    for (const plan of plans) {
      if (folderPaths.some(dir => isSameOrInside(path.resolve(plan.targetDir), dir))) {
        result.errors.push(`${plan.folderPath}：目标目录不能是任一待解散文件夹或其子目录（${plan.targetDir}）`);
        return result;
      }
    }
  }
  if (result.errors.length) {
    return result;
  }

  plans.forEach(({ folderPath, targetDir }) => {
    try {
      ensureDir(targetDir);
      dissolveOne(folderPath, targetDir, opts, result, folderPath, reserved);
    } catch (e) {
      result.errors.push(`${folderPath}：${e.message}`);
    }
  });

  return result;
}

module.exports = {
  SUB_FOLDER,
  DUPLICATE,
  dissolveFolders
};
